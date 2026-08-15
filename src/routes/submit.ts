import { Router, type Request, type Response } from "express";
import { promises as fs } from "fs";
import type {
  SubmitRequest,
  SubmitResponse,
  TestResult,
  CompareMode,
  Language,
  Verdict,
  SandboxResult,
} from "../types";
import { config } from "../config";
import { submitSemaphore } from "../queue/globalSemaphore";
import { createPool } from "../queue/workerPool";
import { compileCache, cacheKey } from "../cache/compileCache";
import { runSandboxed, MEM_LIMIT_RSS_RATIO } from "../sandbox/nsjail";
import { acquireUid, releaseUid } from "../queue/uidPoolSingleton";
import { createWorkdir, cleanupWorkdir } from "../util/workdir";
import { executorFor } from "../executors";
import { compare } from "../compare";
import { compileChecker, runChecker } from "../checker";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import languagesJson from "../../languages.json";

const ALL_LANGUAGES: readonly (Language | "python" | "cpp")[] = [
  "python3",
  "pypy3",
  "cpp14",
  "cpp17",
  "cpp20",
  "cpp23",
  "python",
  "cpp",
];

const ALL_COMPARE_MODES: readonly CompareMode[] = [
  "exact",
  "trim-trailing",
  "whitespace",
  "float-epsilon",
];

/**
 * Shape-check a /submit payload. Returns a validated SubmitRequest or
 * an error message. No field coercion happens here — the body must
 * already match the contract.
 */
function validateSubmit(body: unknown): { ok: true; value: SubmitRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid payload: body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.language !== "string") {
    return { ok: false, error: "Invalid payload: 'language' must be a string" };
  }
  if (!ALL_LANGUAGES.includes(b.language as Language | "python" | "cpp")) {
    return { ok: false, error: `Unsupported language: ${b.language}` };
  }
  if (typeof b.code !== "string") {
    return { ok: false, error: "Invalid payload: 'code' must be a string" };
  }
  if (!Array.isArray(b.input) || !b.input.every((x) => typeof x === "string")) {
    return { ok: false, error: "Invalid payload: 'input' must be string[]" };
  }
  if (!Array.isArray(b.output) || !b.output.every((x) => typeof x === "string")) {
    return { ok: false, error: "Invalid payload: 'output' must be string[]" };
  }
  if (b.input.length !== b.output.length) {
    return { ok: false, error: "'input' and 'output' arrays must be the same length" };
  }
  if (b.timeLimit !== undefined && (typeof b.timeLimit !== "number" || !Number.isFinite(b.timeLimit) || b.timeLimit <= 0)) {
    return { ok: false, error: "'timeLimit' must be a positive number (ms)" };
  }
  if (b.memoryLimit !== undefined && (typeof b.memoryLimit !== "number" || !Number.isFinite(b.memoryLimit) || b.memoryLimit <= 0)) {
    return { ok: false, error: "'memoryLimit' must be a positive number (MB)" };
  }
  if (b.compareMode !== undefined) {
    if (typeof b.compareMode !== "string" || !ALL_COMPARE_MODES.includes(b.compareMode as CompareMode)) {
      return { ok: false, error: `'compareMode' must be one of ${ALL_COMPARE_MODES.join(", ")}` };
    }
  }
  // `checker` is optional and backwards compatible: absent, null, or
  // blank all mean "no checker", i.e. exactly the pre-checker byte
  // comparison. Only a wrong TYPE is a 400.
  if (b.checker !== undefined && b.checker !== null && typeof b.checker !== "string") {
    return { ok: false, error: "'checker' must be a string (C++ source) when provided" };
  }
  const checker =
    typeof b.checker === "string" && b.checker.trim().length > 0
      ? b.checker
      : undefined;

  return {
    ok: true,
    value: {
      language: b.language as Language | "python" | "cpp",
      code: b.code,
      input: b.input as string[],
      output: b.output as string[],
      timeLimit: b.timeLimit as number | undefined,
      memoryLimit: b.memoryLimit as number | undefined,
      compareMode: b.compareMode as CompareMode | undefined,
      checker,
    },
  };
}

/**
 * Map a legacy language code to its current equivalent. Deprecation
 * warnings are emitted once per process by `executorFor` in
 * `src/executors/index.ts` -- the single entry point for language
 * dispatch -- so this function stays silent to avoid double-logging.
 *
 * Legacy cutover mapping:
 *   "python" -> "python3"
 *   "cpp"    -> "cpp17"
 */
function normalizeLanguage(
  lang: Language | "python" | "cpp",
): Language {
  if (lang === "python") return "python3";
  if (lang === "cpp") return "cpp17";
  return lang;
}

/**
 * Return the compile argv for a canonical language, or an empty array for
 * interpreted languages (python3, pypy3) which have no compile step. Used
 * as input to the compile-cache key so artifacts are invalidated whenever
 * compiler flags change — and so python/pypy submissions with identical
 * source share a cache entry.
 */
function compileArgvFor(language: Language): readonly string[] {
  const spec = languagesJson[language];
  if (spec && spec.compile && Array.isArray(spec.compile.argv)) {
    return spec.compile.argv;
  }
  return [];
}

/**
 * Per-language default memoryLimitMb (e.g. pypy3 → 384) from
 * languages.json. Returns undefined when the entry doesn't set one;
 * callers then fall back to the global 256 MB default. PyPy baseline
 * RSS is ~60 MB vs CPython's ~14 MB, so PyPy submissions need more
 * headroom under a 256 MB cap — see the pypy-investigator writeup.
 */
function languageMemoryDefaultMb(language: Language): number | undefined {
  const spec = languagesJson[language] as { memoryLimitMb?: number };
  return typeof spec.memoryLimitMb === "number" ? spec.memoryLimitMb : undefined;
}

/**
 * Clamp a submission's requested memory cap to what the host can
 * actually back. A problem may legitimately DECLARE 1024 MB; on a
 * 512 MB box that limit could never be enforced — the container's OOM
 * killer would fire first and produce a confusing crash. Enforcing
 * `min(requested, HOST_MEMORY_CEILING_MB)` means the judge's own
 * accounting stays authoritative and the failure is a clean MLE.
 */
export function effectiveMemLimitMb(requestedMb: number): number {
  return Math.max(1, Math.min(requestedMb, config.HOST_MEMORY_CEILING_MB));
}

/**
 * Signatures a program emits when an allocation was REFUSED rather than
 * the process being killed. This is the common case on this host:
 * limits are enforced with `--rlimit_as`, which caps virtual address
 * space, so `malloc`/`new` return failure instead of the kernel killing
 * anything. The program then throws, aborts, and exits non-zero — which
 * looks exactly like a runtime error unless we read its stderr.
 *
 *   std::bad_alloc         uncaught C++ `new` failure
 *   bad_array_new_length   C++ `new T[n]` with an absurd n
 *   Cannot allocate memory strerror(ENOMEM), printed by many runtimes
 *   MemoryError            CPython / PyPy
 *   Killed                 an OOM-killer message that reached stderr
 */
const ALLOCATION_FAILURE_RE =
  /std::bad_alloc|bad_array_new_length|Cannot allocate memory|MemoryError|\bKilled\b/;

/**
 * Decide whether a case blew its memory budget. True when ANY of:
 *
 *   1. the sandbox already classified the kill as OOM (nsjail reported a
 *      memory limit exceeded, or peak RSS reached the cap);
 *   2. peak RSS reached >=98% of the ENFORCED cap;
 *   3. the program exited non-zero and its stderr carries an
 *      allocation-failure signature (the RLIMIT_AS case, where RSS stays
 *      *below* the cap precisely because the allocation was refused).
 *
 * Rules 2 and 3 are gated on the run not having finished cleanly: a
 * program that exit(0)'d fit inside its budget by definition, however
 * close to the ceiling it got, and must never be downgraded from AC.
 * A plain SIGSEGV from a null-pointer bug has low RSS and no allocation
 * signature on stderr, so it stays RE.
 */
export function isMemoryLimitExceeded(
  sb: SandboxResult,
  enforcedMemLimitMb: number,
): boolean {
  if (sb.killedBy === "OOM") return true;
  if (sb.exitCode === 0 && sb.killedBy === null) return false;

  const limitKb = Math.floor(enforcedMemLimitMb * 1024);
  if (limitKb > 0 && sb.memKb >= limitKb * MEM_LIMIT_RSS_RATIO) return true;

  return ALLOCATION_FAILURE_RE.test(sb.stderr);
}

/**
 * Derive the competitive-programming verdict from a sandbox result plus
 * the compare()/checker outcome.
 *
 * Order is load-bearing: **TLE -> MLE -> RE -> IE -> WA/AC**. A memory
 * failure must be tested before the `exitCode !== 0` branch, or every
 * refused allocation is mislabelled `RE` — the bug this ordering exists
 * to prevent.
 *
 * `checkerFailed` is set when a custom checker could not answer for this
 * case (exit 3, or the checker itself crashed/timed out). That is a
 * problem-configuration fault, so it surfaces as `IE` — but only after
 * the program's own failures, which are more specific.
 */
export function deriveVerdict(
  sb: SandboxResult,
  passed: boolean,
  enforcedMemLimitMb: number,
  checkerFailed = false,
): Verdict {
  if (sb.killedBy === "TO") return "TLE";
  if (isMemoryLimitExceeded(sb, enforcedMemLimitMb)) return "MLE";
  if (sb.exitCode !== 0 || sb.killedBy === "SIG") return "RE";
  if (checkerFailed) return "IE";
  return passed ? "AC" : "WA";
}

/**
 * Build the TestResult for one test case from the sandbox result.
 * Centralizes the "shape" of a result so it can't drift between cases.
 */
function buildResult(
  index: number,
  expected: string,
  sb: SandboxResult,
  passed: boolean,
  verdict: Verdict,
  checkerMessage?: string,
): TestResult {
  const result: TestResult = {
    index,
    exitCode: sb.exitCode,
    passed,
    expected,
    received: sb.stdout,
    stderr: sb.stderr,
    stdout: sb.stdout,
    timedOut: sb.killedBy === "TO",
    verdict,
    timeMs: sb.timeMs,
    cpuMs: sb.cpuMs,
    memKb: sb.memKb,
  };
  // Omit the key entirely when the checker said nothing (or never ran),
  // so no-checker responses stay byte-identical to today's.
  if (checkerMessage !== undefined && checkerMessage.length > 0) {
    result.checkerMessage = checkerMessage;
  }
  return result;
}

export const submitRouter: Router = Router();

/**
 * POST /submit — main judging endpoint. Flow:
 *  1. validate payload  2. normalize legacy lang
 *  3. acquire global semaphore slot  4. acquire UID + workdir
 *  5. check compile cache → compile if miss (compile fail → HTTP 200 with compileError)
 *  6. put artifact in cache
 *  7. compile the custom checker once, if one was supplied
 *     (checker compile fail → HTTP 200 with checkerError)
 *  8. per-submission worker pool runs each test
 *  9. each test: nsjail → checker OR compare → verdict
 * 10. sort by index, summarize, cleanup, return 200.
 */
submitRouter.post("/", async (req: Request, res: Response) => {
  // Refuse new work during drain. Must run BEFORE any resource acquisition
  // (semaphore / UID / workdir / sandbox spawn) so SIGTERM can actually
  // quiesce the judge within the drain window.
  if (isDraining()) {
    res.status(503).json({ error: "shutting down" });
    return;
  }

  const validation = validateSubmit(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const payload = validation.value;

  const language = normalizeLanguage(payload.language);
  const compareMode: CompareMode = payload.compareMode ?? "trim-trailing";
  const checkerSource = payload.checker;
  const timeLimitMs = payload.timeLimit ?? 5000;
  // Requested memory cap precedence: request override → per-language
  // default (e.g. pypy3 → 384 MB) → global default 256 MB. What is
  // actually applied to the sandbox is that value clamped to the host
  // ceiling; it is reported back as `effectiveMemoryLimitMb`.
  const requestedMemLimitMb =
    payload.memoryLimit ?? languageMemoryDefaultMb(language) ?? 256;
  const memLimitMb = effectiveMemLimitMb(requestedMemLimitMb);

  logger.info(
    {
      language,
      codeLen: payload.code.length,
      cases: payload.input.length,
      timeLimitMs,
      requestedMemLimitMb,
      memLimitMb,
      // A checker REPLACES compareMode; log which one is in force.
      compareMode: checkerSource ? "custom-checker" : compareMode,
      checkerLen: checkerSource?.length ?? 0,
    },
    "submit: received",
  );

  // Whole /submit runs under the global semaphore. No work should happen
  // outside this closure (validation excepted) — it's what bounds load.
  await submitSemaphore(async () => {
    let uid: number | null = null;
    let workDir: string | null = null;
    try {
      const executor = executorFor(language);
      const filename = executor.filename(payload.code);

      uid = await acquireUid();
      workDir = await createWorkdir(uid);

      await executor.prepare(workDir, payload.code);
      // The files the executor just wrote are owned by root; hand them to the pool UID.
      await chownTree(workDir, uid).catch((err) => {
        logger.warn({ err, workDir }, "submit: chown tree failed; continuing");
      });

      const runCmd = executor.buildRunCommand(workDir, filename);

      // Cache key covers (language, source, compile argv) per the plan.
      // Interpreted languages (python3/pypy3) have no compile step, so we
      // key on the empty array — matches the "no compile argv" semantics.
      const compileArgv = compileArgvFor(language);
      const key = cacheKey(language, payload.code, compileArgv);

      const cachedDir = await compileCache.get(key);
      if (cachedDir) {
        // Copy cached artifact into workdir; re-chown to pool UID.
        await fs.cp(cachedDir, workDir, { recursive: true, force: true });
        await chownTree(workDir, uid).catch(() => {});
      } else {
        const compileRes = await executor.compile(workDir);
        if (!compileRes.ok) {
          // Compile fail → HTTP 200 with compileError per contract.
          const response: SubmitResponse = {
            summary: { total: 0, passed: 0, failed: 0 },
            results: [],
            effectiveMemoryLimitMb: memLimitMb,
            compileError: compileRes.stderr,
          };
          res.status(200).json(response);
          return;
        }
        // Successful compile → store in cache. Cache errors must not fail the submission.
        await compileCache
          .put(key, workDir)
          .catch((err) => logger.warn({ err }, "submit: compile cache put failed"));
        await chownTree(workDir, uid).catch(() => {});
      }

      // Custom checker: compiled ONCE per submission, never per case.
      //
      // Deliberately AFTER the compile-cache interaction above. The cache
      // stores the whole workdir keyed on (language, user code, compile
      // argv) — a checker binary present at `put()` time would be handed
      // to a different problem whose contestant submitted the same
      // source. Compiling here also means we skip the g++ run entirely
      // when the user's own code already failed to compile.
      if (checkerSource !== undefined) {
        const checkerCompile = await compileChecker(workDir, checkerSource);
        if (!checkerCompile.ok) {
          // A broken checker is a PROBLEM-CONFIGURATION fault, not the
          // user's. Same HTTP 200 + empty-summary shape as compileError,
          // but a distinct field: wmoj-app turns `compileError` into a
          // user-facing CE and must never blame the student for this.
          logger.error(
            { stderr: checkerCompile.stderr.slice(0, 2000) },
            "submit: checker failed to compile",
          );
          const response: SubmitResponse = {
            summary: { total: 0, passed: 0, failed: 0 },
            results: [],
            effectiveMemoryLimitMb: memLimitMb,
            checkerError: checkerCompile.stderr,
          };
          res.status(200).json(response);
          return;
        }
      }

      // Per-submission pool: bound test-case parallelism within this submission.
      const pool = createPool(config.PER_SUBMISSION_CONCURRENCY);

      const resultPromises = payload.input.map((rawInput, i) =>
        pool.run(async (): Promise<TestResult> => {
          const stdin = rawInput.endsWith("\n") ? rawInput : rawInput + "\n";
          const expected = payload.output[i] ?? "";
          const sandboxRes = await runSandboxed({
            argv: runCmd.argv,
            cwd: workDir as string,
            uid: uid as number,
            gid: uid as number,
            timeLimitMs,
            memLimitMb,
            stdin,
          });

          // A case can only pass if the program itself finished cleanly.
          // Unchanged from before checkers existed — and it means a
          // crashed/TLE'd run never invokes the checker at all.
          const ranCleanly =
            sandboxRes.exitCode === 0 && sandboxRes.killedBy === null;

          let passed = false;
          let checkerFailed = false;
          let checkerMessage: string | undefined;

          if (ranCleanly) {
            if (checkerSource !== undefined) {
              // Checker REPLACES compareMode — the string comparison is
              // not run at all when a checker is supplied.
              const verdictFromChecker = await runChecker({
                workDir: workDir as string,
                uid: uid as number,
                index: i,
                input: stdin,
                expected,
                received: sandboxRes.stdout,
              });
              passed = verdictFromChecker.outcome === "accepted";
              checkerFailed = verdictFromChecker.outcome === "internal-error";
              checkerMessage = verdictFromChecker.message;
              if (checkerFailed) {
                logger.error(
                  {
                    index: i,
                    exitCode: verdictFromChecker.exitCode,
                    message: checkerMessage,
                  },
                  "submit: checker reported an internal error",
                );
              }
            } else {
              passed = compare(compareMode, expected, sandboxRes.stdout);
            }
          }

          const verdict = deriveVerdict(
            sandboxRes,
            passed,
            memLimitMb,
            checkerFailed,
          );
          return buildResult(
            i,
            expected,
            sandboxRes,
            passed,
            verdict,
            checkerMessage,
          );
        }),
      );

      const results = (await Promise.all(resultPromises)).sort(
        (a, b) => a.index - b.index,
      );

      const summary = {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
      };

      const response: SubmitResponse = {
        summary,
        results,
        effectiveMemoryLimitMb: memLimitMb,
      };
      res.status(200).json(response);
    } catch (err) {
      logger.error({ err }, "submit: unexpected failure");
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      }
    } finally {
      if (workDir) await cleanupWorkdir(workDir);
      if (uid !== null) releaseUid(uid);
    }
  });
});

/**
 * True when Node is running as root (effective UID 0). Captured once at
 * module load. On Render we run Node as UID 1000 so this is false, and
 * every chownTree below becomes a no-op -- a non-root process cannot
 * chown to a foreign UID, and even chowning to our own UID would just
 * spam EPERM (fs.chown only succeeds for CAP_CHOWN or matching UID).
 * Because the workdir was mkdtemp'd by us and the sandbox inherits our
 * UID (no --user flag), files are already owned by the process that
 * will execute them -- no chown needed.
 */
const isRootNode: boolean =
  typeof process.geteuid === "function" && process.geteuid() === 0;

/**
 * Recursively chown every entry under `dir` to `uid:uid`. Used after
 * `executor.prepare()` so the sandboxed pool UID can read/execute what
 * Node (running as root) just wrote. No-op when Node is unprivileged
 * (see `isRootNode`).
 */
async function chownTree(dir: string, uid: number): Promise<void> {
  if (!isRootNode) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await fs.chown(dir, uid, uid).catch(() => {});
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    await fs.chown(full, uid, uid).catch(() => {});
    if (entry.isDirectory()) {
      await chownTree(full, uid);
    }
  }
}
