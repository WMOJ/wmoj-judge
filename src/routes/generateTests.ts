import { Router, type Request, type Response } from "express";
import { promises as fs } from "fs";
import * as path from "path";
import { runSandboxed } from "../sandbox/nsjail";
import { acquireUid, releaseUid } from "../queue/uidPoolSingleton";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { runCompile, type CompileResult } from "../util/compile";
import { createWorkdir, cleanupWorkdir, isRootNode } from "../util/workdir";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import {
  MAX_INPUT_BYTES_PER_CASE,
  MAX_OUTPUT_BYTES_PER_CASE,
  MAX_INPUT_CASES,
  MAX_TOTAL_REQUEST_BYTES,
  formatCap,
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
 * Compile a generator's C++ source. Compilation runs OUTSIDE nsjail
 * (it's a trusted `g++` invocation on admin-submitted source, same
 * trust boundary as the existing /generate-tests endpoint) but uses
 * `minimalEnv` to scrub the child environment.
 */
function compileGenerator(
  workDir: string,
  srcPath: string,
  outPath: string,
): Promise<CompileResult> {
  return runCompile(
    // -fmax-errors bounds the diagnostics at the source. runCompile's capped
    // collectors bound what the judge *keeps*; this bounds what g++ spends CPU
    // producing, on the one endpoint whose compile is neither sandboxed nor
    // timed.
    ["/usr/bin/g++", "-O2", "-std=gnu++17", "-fmax-errors=50", srcPath, "-o", outPath],
    workDir,
    buildChildEnv(),
  );
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
          reason: `input[${i}] exceeds ${formatCap(MAX_INPUT_BYTES_PER_CASE)}`,
          limit: MAX_INPUT_BYTES_PER_CASE,
        });
        return;
      }
      // The OUTPUT cap, not the input one: this block's whole purpose is to
      // reject here exactly what /submit would reject, and requestCaps measures
      // `output` against MAX_OUTPUT_BYTES_PER_CASE. They are equal today, so
      // using the wrong one changed nothing — right up until one of them moves.
      if (outBytes > MAX_OUTPUT_BYTES_PER_CASE) {
        res.status(400).json({
          error: "generated test data exceeds the limits /submit enforces",
          reason: `output[${i}] exceeds ${formatCap(MAX_OUTPUT_BYTES_PER_CASE)}`,
          limit: MAX_OUTPUT_BYTES_PER_CASE,
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
