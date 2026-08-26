import { Router, type Request, type Response } from "express";
import { promises as fs } from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { runSandboxed } from "../sandbox/nsjail";
import { acquireUid, releaseUid } from "../queue/uidPoolSingleton";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { createWorkdir, cleanupWorkdir } from "../util/workdir";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import {
  MAX_INPUT_BYTES_PER_CASE,
  MAX_INPUT_CASES,
  MAX_TOTAL_REQUEST_BYTES,
} from "../middleware/requestCaps";

/**
 * Looser resource limits for the generator: it runs trusted admin code
 * whose whole job is to produce a batch of test cases. Still no network
 * and still sandboxed via nsjail — cheap insurance.
 */
const GENERATOR_TIME_LIMIT_MS = 60_000;
const GENERATOR_MEM_LIMIT_MB = 1024;

/**
 * Cap on what a generator may write to either stream, sized deliberately
 * ABOVE what the per-case caps below will accept.
 *
 * `runSandboxed` defaults to 1 MiB stdout / 64 KiB stderr, which is right for
 * `/submit` (where both streams are a program's incidental chatter) and wrong
 * here (where stdout is the JSON array of inputs and stderr is the expected
 * outputs). Truncating either mid-array yields a JSON parse failure that reads
 * like a bug in the admin's generator.
 *
 * Sitting above `MAX_INPUT_CASES * MAX_INPUT_BYTES_PER_CASE` means an
 * over-large generator is rejected by the explicit 400 below, which names the
 * limit it broke, rather than silently losing bytes. It is still a hard bound:
 * an infinite `puts` loop cannot exhaust the 512 MB container.
 */
const GENERATOR_MAX_OUTPUT_BYTES = MAX_INPUT_CASES * MAX_INPUT_BYTES_PER_CASE + 16 * 1024 * 1024;

/**
 * Language codes this route accepts. It validates the field and then
 * ignores it — the compile line below is hardcoded C++17 — but the set
 * is part of the published contract, so keep it as-is.
 */
const ACCEPTED_LANGUAGES: readonly string[] = ["cpp", "cpp14", "cpp17"];
const ACCEPTED_LANGUAGES_TEXT = ACCEPTED_LANGUAGES.join("/");

/**
 * The caps `/submit` enforces on exactly the arrays this route
 * produces. Everything emitted here is posted straight back to
 * `/submit` by the admin create form, so a generator that overruns them
 * makes the problem unsolvable by *everyone*: `/submit` 413s with
 * "too many test cases (max 200)", `wmoj-app` surfaces
 * `413 payload too large`, and the error blames the student's payload
 * for data the judge itself handed the admin. The judge knows at
 * generation time; it should say so then.
 *
 * Every bound here is imported from `middleware/requestCaps` rather
 * than restated, so the caps this route enforces on generated data and
 * the caps `/submit` will later enforce on that same data cannot drift
 * apart. A generator that produced output this route accepted but
 * `/submit` rejected would strand an admin with test data the judge
 * refuses to grade.
 */

/**
 * Bytes reserved out of `MAX_TOTAL_REQUEST_BYTES` for the parts of a
 * future `/submit` body that are *not* test data: the student's source
 * (100 KB) plus an optional custom checker (100 KB). Generated data
 * that fills the whole aggregate budget would leave no room for them
 * and 413 on the first real submission.
 */
const SUBMISSION_SOURCE_HEADROOM_BYTES = 200_000;

/**
 * Cap on how much of the compiler's stdout/stderr we keep, per stream.
 *
 * The text goes into the 400's `error` string with no truncation of its
 * own. A generator engineered for diagnostic volume — deep template
 * instantiation, repeated `_Pragma("message(…)")` — makes g++ exit
 * quickly and cheaply while emitting hundreds of MB of stderr, and past
 * V8's max string length `stderr += …` throws `RangeError`
 * synchronously inside a stream `'data'` handler: an uncaught
 * exception, not a rejected promise. A compile timeout would not help;
 * it is the judge's heap that grows, not g++'s.
 */
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** Appended when a stream hit `MAX_DIAGNOSTIC_BYTES`. */
const DIAGNOSTICS_TRUNCATED = "\n[diagnostics truncated by the judge]\n";

/**
 * Attach a capped, decode-once collector to a compiler's stdio stream
 * and return a function that decodes everything collected.
 *
 * Same shape as `executors/cpp.ts` and `sandbox/nsjail.ts`: buffers are
 * accumulated and decoded **once**, at close. Decoding per chunk
 * (`stderr += chunk.toString()`) decodes each 64 KB pipe chunk in
 * isolation, so a multi-byte sequence straddling a chunk boundary
 * becomes U+FFFD on both sides — and `buildChildEnv` sets
 * `LC_ALL=C.UTF-8` while g++ quotes every identifier with
 * U+2018/U+2019, so that happens about once per diagnostic line.
 *
 * `stream` is nullable because `ChildProcess.prototype.spawn` returns
 * early on UV_EMFILE/UV_ENFILE *before* assigning `stdout`/`stderr`; a
 * bare `child.stderr.on(…)` would then throw a TypeError synchronously
 * inside the `new Promise` executor, rejecting where the caller expects
 * a discriminated `{ok:false}` — a 500 instead of the 400 the contract
 * promises for a failed compile. The `'error'` event still fires.
 */
function collectCapped(stream: NodeJS.ReadableStream | null): () => string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  stream?.on("data", (chunk: Buffer) => {
    const room = MAX_DIAGNOSTIC_BYTES - bytes;
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      bytes = MAX_DIAGNOSTIC_BYTES;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  });

  return () => {
    const text = Buffer.concat(chunks).toString("utf8");
    return truncated ? `${text}${DIAGNOSTICS_TRUNCATED}` : text;
  };
}

/**
 * True when Node is running as root. On Render we run as UID 1000 so
 * this is false and every chown below becomes a no-op -- same rationale
 * as in routes/submit.ts. Saves a syscall and avoids spamming EPERM.
 */
const isRootNode: boolean =
  typeof process.geteuid === "function" && process.geteuid() === 0;

/**
 * Compile a generator's C++ source. Compilation runs OUTSIDE nsjail
 * (it's a trusted `g++` invocation on admin-submitted source, same
 * trust boundary as the existing /generate-tests endpoint) but uses
 * `minimalEnv` to scrub the child environment.
 */
function compileGenerator(
  workDir: string,
  srcPath: string,
  outPath: string,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  return new Promise((resolve) => {
    const env = buildChildEnv("cpp17");
    const child = spawn(
      "/usr/bin/g++",
      // -fmax-errors bounds the diagnostics at the source. The capped
      // collectors below bound what the judge *keeps*; this bounds what
      // g++ spends CPU producing, on the one endpoint whose compile is
      // neither sandboxed nor timed.
      ["-O2", "-std=gnu++17", "-fmax-errors=50", srcPath, "-o", outPath],
      { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    // stdout is piped, so it MUST be drained: with `stdio: [.., "pipe", ..]`
    // and no listener the pipe fills at 64 KB and g++ blocks on write
    // forever, hanging the request with a UID-pool slot held.
    const readStdout = collectCapped(child.stdout);
    const readStderr = collectCapped(child.stderr);
    child.on("error", (err) => {
      resolve({ ok: false, stderr: `spawn error: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const stdout = readStdout();
      const combined = readStderr() + (stdout ? `\n${stdout}` : "");
      if (combined.trim().length > 0) {
        resolve({ ok: false, stderr: combined });
        return;
      }
      resolve({
        ok: false,
        stderr:
          signal !== null
            ? `g++ was killed by ${signal}`
            : `g++ exited ${code} with no diagnostics`,
      });
    });
  });
}

/**
 * Coerce an arbitrary JSON value to a string. Matches the existing
 * server.js behavior so the response is byte-identical to today.
 */
function coerceToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v ?? "");
  }
}

export const generateTestsRouter: Router = Router();

/**
 * POST /generate-tests — admin-only: compile a C++ generator, run it
 * inside nsjail with generous limits, parse stdout as the input JSON
 * array and stderr as the output JSON array, coerce to strings.
 *
 * Response shape is byte-identical to the previous server.js version:
 * { inputJson, outputJson, input: string[], output: string[] }.
 */
generateTestsRouter.post("/", async (req: Request, res: Response) => {
  // Refuse new work during drain. Must run BEFORE any resource acquisition
  // (UID / workdir / compile / sandbox spawn) so SIGTERM can actually
  // quiesce the judge within the drain window.
  if (isDraining()) {
    res.status(503).json({ error: "shutting down" });
    return;
  }

  // `req.body` is `unknown` in practice — narrow every field by hand
  // before it is used. The previous `as { code?: string }` cast was a
  // lie: `!code` is a truthiness test, not a type test, so a non-string
  // sailed through. That mattered because `requestCaps` gates the
  // 100 KB `MAX_CODE_BYTES` on `typeof body.code === "string"`, so a
  // non-string `code` skipped the size cap entirely — and
  // `fs.writeFile` accepts an `Iterable<string>`, so
  // `{"code": ["<100 MB of C++>"]}` wrote a 100 MB Generator.cpp and
  // handed it to an unsandboxed, untimed g++ on a 512 MB box. A number
  // or object instead threw `ERR_INVALID_ARG_TYPE` inside `writeFile`
  // and came back as HTTP 500 — a malformed request reported as a judge
  // fault, where the contract says 400.
  const body = (req.body ?? {}) as { language?: unknown; code?: unknown };
  const { language, code } = body;

  if (typeof code !== "string" || code.trim().length === 0) {
    res.status(400).json({
      error: "Invalid payload. Required: code (C++) as a non-empty string.",
    });
    return;
  }
  if (
    language !== undefined &&
    (typeof language !== "string" || !ACCEPTED_LANGUAGES.includes(language))
  ) {
    res.status(400).json({
      error: `Invalid payload. language must be ${ACCEPTED_LANGUAGES_TEXT} if provided.`,
    });
    return;
  }

  // This route compiles and runs code outside the global semaphore and
  // outside the host memory clamp, at 60 s / 1024 MB. It is the one
  // endpoint that can take the box down, and until now it logged
  // nothing but its own 500s.
  logger.info(
    { language: language ?? "cpp17", codeBytes: Buffer.byteLength(code, "utf8") },
    "generate-tests: start",
  );

  let uid: number | null = null;
  let workDir: string | null = null;

  try {
    uid = await acquireUid();
    workDir = await createWorkdir(uid);

    const srcPath = path.join(workDir, "Generator.cpp");
    const outPath = path.join(workDir, "gen.out");
    await fs.writeFile(srcPath, code, "utf8");
    // Make sure the pool UID can read the source and write the binary.
    // Only meaningful when Node runs as root; under unprivileged Node
    // (Render) the files are already owned by the running UID.
    if (isRootNode) await fs.chown(srcPath, uid, uid).catch(() => {});

    const compileRes = await compileGenerator(workDir, srcPath, outPath);
    if (!compileRes.ok) {
      res.status(400).json({ error: `Compilation failed\n${compileRes.stderr}` });
      return;
    }
    if (isRootNode) await fs.chown(outPath, uid, uid).catch(() => {});

    const sandboxRes = await runSandboxed({
      argv: ["./gen.out"],
      cwd: workDir,
      uid,
      gid: uid,
      timeLimitMs: GENERATOR_TIME_LIMIT_MS,
      memLimitMb: GENERATOR_MEM_LIMIT_MB,
      stdin: "",
      // A generator's stdout IS the payload (the JSON array of inputs) and its
      // stderr IS the expected outputs — unlike /submit, where both are just a
      // program's incidental chatter. `runSandboxed`'s defaults are sized for
      // /submit (1 MiB stdout, 64 KiB stderr) and would silently TRUNCATE a
      // legitimate generator mid-array, producing a JSON parse failure that
      // looks like a bug in the admin's generator rather than a judge cap.
      //
      // These are sized above what the caps below will accept anyway
      // (MAX_INPUT_CASES x MAX_INPUT_BYTES_PER_CASE), so a generator that
      // overshoots is rejected by an explicit 400 naming the limit it broke
      // rather than by silent truncation.
      maxStdoutBytes: GENERATOR_MAX_OUTPUT_BYTES,
      maxStderrBytes: GENERATOR_MAX_OUTPUT_BYTES,
    });

    if (sandboxRes.sandboxError !== undefined) {
      // Nothing of the generator's code ran — this is a judge fault, not a
      // problem with the admin's source, so it must not surface as a 400
      // blaming the generator.
      throw new Error(`sandbox failure: ${sandboxRes.sandboxError}`);
    }

    if (sandboxRes.exitCode !== 0 || sandboxRes.killedBy !== null) {
      res.status(400).json({
        error: `Generator exited with code ${sandboxRes.exitCode} (${sandboxRes.killedBy ?? "ok"})`,
        inputJson: sandboxRes.stdout,
        outputJson: sandboxRes.stderr,
      });
      return;
    }

    const inputRaw = sandboxRes.stdout;
    const outputRaw = sandboxRes.stderr;

    let inputArr: unknown;
    let outputArr: unknown;
    try {
      inputArr = JSON.parse(inputRaw);
    } catch (e) {
      res.status(400).json({
        error: `Invalid JSON on stdout: ${(e as Error).message}`,
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }
    try {
      outputArr = JSON.parse(outputRaw);
    } catch (e) {
      res.status(400).json({
        error: `Invalid JSON on stderr: ${(e as Error).message}`,
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }

    if (!Array.isArray(inputArr) || !Array.isArray(outputArr)) {
      res.status(400).json({
        error: "Both stdout and stderr must be JSON arrays",
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }
    if (inputArr.length !== outputArr.length) {
      res.status(400).json({
        error: "Input and output arrays must be the same length",
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }

    const input = inputArr.map(coerceToString);
    const output = outputArr.map(coerceToString);

    // Enforce the caps /submit will enforce on this same data, on the
    // coerced strings that are what actually goes back over the wire.
    // A size complaint deliberately does NOT echo inputJson/outputJson
    // the way the parse failures above do: those need the raw text to
    // be diagnosable, this one is already too big by definition.
    if (input.length > MAX_INPUT_CASES) {
      res.status(400).json({
        error: "generated test data exceeds the limits /submit enforces",
        reason: `too many test cases (max ${MAX_INPUT_CASES})`,
        limit: MAX_INPUT_CASES,
        count: input.length,
      });
      return;
    }

    let totalBytes = 0;
    for (let i = 0; i < input.length; i += 1) {
      const inBytes = Buffer.byteLength(input[i] ?? "", "utf8");
      const outBytes = Buffer.byteLength(output[i] ?? "", "utf8");
      if (inBytes > MAX_INPUT_BYTES_PER_CASE) {
        res.status(400).json({
          error: "generated test data exceeds the limits /submit enforces",
          reason: `input[${i}] exceeds 1MB`,
          limit: MAX_INPUT_BYTES_PER_CASE,
        });
        return;
      }
      if (outBytes > MAX_INPUT_BYTES_PER_CASE) {
        res.status(400).json({
          error: "generated test data exceeds the limits /submit enforces",
          reason: `output[${i}] exceeds 1MB`,
          limit: MAX_INPUT_BYTES_PER_CASE,
        });
        return;
      }
      totalBytes += inBytes + outBytes;
    }

    const aggregateBudget =
      MAX_TOTAL_REQUEST_BYTES - SUBMISSION_SOURCE_HEADROOM_BYTES;
    if (totalBytes > aggregateBudget) {
      res.status(400).json({
        error: "generated test data exceeds the limits /submit enforces",
        reason: "total test data leaves no room for a submission's source",
        limit: aggregateBudget,
        bytes: totalBytes,
      });
      return;
    }

    res.json({ inputJson: inputRaw, outputJson: outputRaw, input, output });
  } catch (err) {
    logger.error({ err }, "generate-tests: unexpected failure");
    res.status(500).json({ error: (err as Error).message });
  } finally {
    if (workDir) await cleanupWorkdir(workDir);
    if (uid !== null) releaseUid(uid);
  }
});
