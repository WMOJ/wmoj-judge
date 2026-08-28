import { Router, type Request, type Response } from "express";
import { runSandboxed } from "../sandbox/nsjail";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { setterCompileArgv } from "../languages";
import { runCompile, type CompileResult } from "../util/compile";
import { withWorkspace } from "../workspace";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import {
  MAX_INPUT_BYTES_PER_CASE,
  MAX_INPUT_CASES,
  SUBMISSION_SOURCE_HEADROOM_BYTES,
  describeViolation,
  fitsTestDataBudget,
  type BudgetViolation,
} from "../budget";

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
 * ignores it — every generator is built with the problem-setter compile
 * line — but the set is part of the published contract, so keep it as-is.
 *
 * Deliberately DIFFERENT from `/submit`'s, which is now exactly the
 * `languages.json` keys: bare `cpp` is gone from `/submit` and stays
 * here, because `wmoj-app`'s
 * `.agents/skills/add-problem/scripts/judge.sh:95` sends `"cpp"` to this
 * endpoint and nothing else. The reverse difference is just as
 * deliberate: `cpp20`/`cpp23` are accepted by `/submit` and refused here.
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
 * The decision is `src/budget`'s `fitsTestDataBudget` — the SAME walk
 * `requestCaps` runs on the way into `/submit`, not a second copy of it.
 * The copy that used to live here measured `output` against the input
 * cap; equal today, so it changed nothing, right up until one of them
 * moved. This route reserves `SUBMISSION_SOURCE_HEADROOM_BYTES` out of
 * the aggregate so the data it hands back can always be submitted with
 * any legal program and checker against it.
 */

/**
 * Render a budget violation as this route's 400. The wording for the
 * count and per-case kinds is the canonical one `/submit`'s 413 uses,
 * so an admin reading either sees the same complaint; the aggregate is
 * re-phrased in this route's terms (its `limit` and `bytes` exclude the
 * reserved headroom, which is not the generator's data), and `count` is
 * carried for the count kind as it always was.
 */
function budgetViolationBody(v: BudgetViolation): Record<string, unknown> {
  const error = "generated test data exceeds the limits /submit enforces";
  switch (v.kind) {
    case "count":
      return { error, reason: describeViolation(v), limit: v.limit, count: v.count };
    case "per-case":
      return { error, reason: describeViolation(v), limit: v.limit };
    case "aggregate":
      return {
        error,
        reason: "total test data leaves no room for a submission's source",
        limit: v.limit - SUBMISSION_SOURCE_HEADROOM_BYTES,
        bytes: v.bytes - SUBMISSION_SOURCE_HEADROOM_BYTES,
      };
  }
}

/** The generator's source and binary inside the workspace. */
const GENERATOR_SOURCE_FILENAME = "Generator.cpp";
const GENERATOR_BINARY_FILENAME = "gen.out";

/**
 * Compile a generator's C++ source with the problem-setter compile line
 * from `src/languages` — the same one a custom checker gets, and the same
 * dialect a `cpp17` submission gets. Compilation runs OUTSIDE nsjail
 * (it's a trusted `g++` invocation on admin-submitted source, same trust
 * boundary as the checker's) but uses `minimalEnv` to scrub the child
 * environment.
 *
 * The names are relative to the workspace, which is the child's cwd, so a
 * diagnostic in the 400 below reads `Generator.cpp:3:1: error:` rather
 * than naming the judge's `/tmp/judge-<nanoid>` path back to the admin.
 */
function compileGenerator(workDir: string): Promise<CompileResult> {
  return runCompile(
    setterCompileArgv(GENERATOR_SOURCE_FILENAME, GENERATOR_BINARY_FILENAME),
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

  try {
    await withWorkspace("generator", async (ws) => {
      await ws.write(GENERATOR_SOURCE_FILENAME, code);

      const compileRes = await compileGenerator(ws.dir);
      if (!compileRes.ok) {
        res.status(400).json({ error: `Compilation failed\n${compileRes.stderr}` });
        return;
      }

      const outcome = await runSandboxed({
        argv: [`./${GENERATOR_BINARY_FILENAME}`],
        cwd: ws.dir,
        label: ws.label,
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

      if (!outcome.ok) {
        // Nothing of the generator's code ran — this is a judge fault, not a
        // problem with the admin's source, so it must not surface as a 400
        // blaming the generator.
        throw new Error(`sandbox failure: ${outcome.sandboxError}`);
      }
      const run = outcome.run;

      // "Did the generator finish?", spelled from raw facts rather than
      // from a kill class. The verdict module's ladder is about grading a
      // SUBMISSION against a problem's limits; this route has neither, and
      // asking it would import a threshold that means nothing here. A
      // generator either exited 0 under its own power or it did not.
      if (run.exitCode !== 0 || run.runnerSignal !== null || run.nodeTimerFired) {
        // CONTRACT NOTE. This text changed with the verdict refactor: it was
        // `Generator exited with code N (TO|SIG|ok)`, where the parenthesis
        // was the sandbox's kill class, and it is now the code plus a plain
        // clause for each thing that could have ended the run. `wmoj-app`
        // displays this string verbatim to an admin and does not parse it,
        // so the change is cosmetic there — but it IS the response body of a
        // documented 400, so it is pinned by a golden transcript and must
        // not drift again without saying so here.
        const killNote = run.nodeTimerFired
          ? " (killed by the judge after the time limit)"
          : run.runnerSignal !== null
            ? ` (signal ${run.runnerSignal})`
            : "";
        res.status(400).json({
          error: `Generator exited with code ${run.exitCode}${killNote}`,
          inputJson: run.stdout,
          outputJson: run.stderr,
        });
        return;
      }

      const inputRaw = run.stdout;
      const outputRaw = run.stderr;

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
      const budget = fitsTestDataBudget(input, output, SUBMISSION_SOURCE_HEADROOM_BYTES);
      if (!budget.ok) {
        res.status(400).json(budgetViolationBody(budget.violation));
        return;
      }

      res.json({ inputJson: inputRaw, outputJson: outputRaw, input, output });
    });
  } catch (err) {
    logger.error({ err }, "generate-tests: unexpected failure");
    // `headersSent` because the only throw that can reach here after a
    // response has gone out is the workspace teardown's, and a second
    // `res.status()` on a sent response throws again — out of an async
    // Express handler with no error middleware, which is an unhandled
    // rejection, not a 500.
    if (!res.headersSent) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});
