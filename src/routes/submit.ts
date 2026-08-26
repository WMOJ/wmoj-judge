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
  // A submission with nothing to run is a malformed REQUEST, not a
  // gradeable submission. Accepting it returned `{summary:{0,0,0},
  // results:[]}` — the compile-error shape minus `compileError` — and
  // `wmoj-app`'s `isPassed` requires `total > 0`, so every solution to a
  // problem saved with no test data, including correct ones, was
  // recorded as a non-passing submission with nothing anywhere to
  // explain why. `judge.sh` already guards `n >= 1`; the judge did not.
  if (b.input.length === 0) {
    return { ok: false, error: "'input' must contain at least one test case" };
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

// Process-lifetime flags so legacy-code warnings fire at most once per
// language per judge instance rather than on every request.
let warnedLegacyPython = false;
let warnedLegacyCpp = false;

/**
 * Map a legacy language code to its current equivalent, warning once per
 * process per alias.
 *
 * Legacy cutover mapping:
 *   "python" -> "python3"
 *   "cpp"    -> "cpp17"
 *
 * The warning lives HERE, not in `executorFor`, because this is the only
 * function that ever sees the raw request value. `executorFor` used to
 * own it and its legacy branches were unreachable: this call runs first
 * and hands it the already-normalised code, so the deprecation warning
 * had never once been emitted — while this file, `executors/index.ts`
 * and the `add-language` skill all documented it as firing. Nothing told
 * anyone whether the wmoj-app cutover was finished, and `AGENTS.md`
 * lists removing the aliases as a decision that needs that answer.
 */
function normalizeLanguage(
  lang: Language | "python" | "cpp",
): Language {
  if (lang === "python") {
    if (!warnedLegacyPython) {
      warnedLegacyPython = true;
      logger.warn(
        'deprecation: language code "python" is legacy; map to "python3"',
      );
    }
    return "python3";
  }
  if (lang === "cpp") {
    if (!warnedLegacyCpp) {
      warnedLegacyCpp = true;
      logger.warn(
        'deprecation: language code "cpp" is legacy; map to "cpp17"',
      );
    }
    return "cpp17";
  }
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
 * Per-language FLOOR on memoryLimitMb (e.g. pypy3 → 384) from
 * languages.json. Returns undefined when the entry doesn't set one.
 *
 * PyPy baseline RSS is ~60 MB vs CPython's ~14 MB, so a PyPy submission
 * under a 256 MB cap spends a quarter of its budget before running a
 * line of user code — which is why this knob exists.
 *
 * It is a floor rather than a default because a default never applied:
 * `wmoj-app` sends `problem.memory_limit || 256`, which is ALWAYS a
 * number even when the column is null or 0, and `judge.sh` takes
 * `memLimitMb` as a required positional argument. So `payload.memoryLimit
 * ?? languageMemoryDefaultMb(...)` short-circuited on its first term for
 * every request either client has ever made, and every PyPy submission
 * ran at the problem's cap. A PyPy solution that fits comfortably in
 * 256 MB of *user* data would hit `--rlimit_as 256`, raise `MemoryError`,
 * match `ALLOCATION_FAILURE_RE`, and be graded `MLE` while the
 * equivalent CPython submission passed.
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
 *
 * The result is floored to a whole MB because that is what the sandbox
 * enforces (`Math.max(1, Math.floor(memLimitMb))` in `nsjail.ts`).
 * Without the floor a `memoryLimit` of 300.75 was advertised back as
 * `effectiveMemoryLimitMb: 300.75` — a field both `types.ts` and
 * `AGENTS.md` define as "the cap actually enforced" — while 300 MB was
 * applied, and MLE rule 2 computed its RSS threshold against a cap that
 * had never existed. `memoryLimit` is deliberately still accepted as any
 * positive finite number: rounding it makes the two agree, and rejecting
 * it would be a contract change for a shape no client sends.
 */
export function effectiveMemLimitMb(requestedMb: number): number {
  return Math.max(
    1,
    Math.floor(Math.min(requestedMb, config.HOST_MEMORY_CEILING_MB)),
  );
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
 *
 * NOTE ON MATURITY: rules 1 and 2 read `sb.memKb`, which was `0` on
 * every single run for the entire life of the nsjail 3.3 pin — the old
 * code scraped it out of nsjail's log and nsjail 3.3 emits no such line.
 * 3,457 stored test cases carry `memKb: 0`, and no submission has ever
 * been graded `MLE` by either rule. They now measure real `ru_maxrss`
 * from the jail runner and will fire for the first time, so treat them
 * as unproven rather than battle-tested. Two consequences worth knowing:
 * `memKb` is the peak of the whole jail tree (nsjail's own few MB
 * included), so it can only ever over-report; and rule 2 duplicates
 * `classifyKill`'s own RSS step, which is why an over-cap run usually
 * arrives already carrying `killedBy === "OOM"`.
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
  // Both optional keys are omitted rather than set false/empty, so a
  // response for an ordinary submission stays byte-identical to what it
  // was before either field existed.
  //
  // `truncated` says the strings above are a PREFIX: the sandbox now
  // drains-and-discards past 1 MiB of stdout / 64 KiB of stderr instead
  // of accumulating an unbounded `for(;;) puts("x")` in the Node heap of
  // a 512 MB container. Without this flag `received` would silently
  // disagree with what the program actually printed and a `WA` would be
  // unexplainable to the student. The cap sits above the largest
  // expected output `requestCaps` accepts, so a truncated run could not
  // have been AC anyway — the verdict itself is unaffected.
  if (sb.truncated) {
    result.truncated = true;
  }
  // Omitted when the checker said nothing (or never ran).
  if (checkerMessage !== undefined && checkerMessage.length > 0) {
    result.checkerMessage = checkerMessage;
  }
  return result;
}

/**
 * The settled outcome of grading one test case.
 *
 * Per-case tasks resolve one of these instead of rejecting. `Promise.all`
 * rejects on the FIRST rejection, so a single throwing case used to
 * return 500 while p-limit — which has no cancellation; its runner is
 * `try { await result } catch {}` then `next()` — kept dequeuing up to
 * 199 more. Those ran with `--cwd` pointing at a directory the route's
 * `finally` had already removed, under a UID already handed to another
 * submission, each arming a `timeLimitMs + 5000` timer, all of it
 * outside the global semaphore the closure had released — and with
 * `exitRequest()` already fired, so a concurrent SIGTERM saw
 * `inFlight === 0`. Settling every case before teardown is what closes
 * that window.
 */
type CaseOutcome =
  | { ok: true; result: TestResult }
  | { ok: false; error: Error };

/** Narrow an unknown thrown value to an Error without a custom class. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
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
 * 10. every case settles (none may still be running), then sort by
 *     index, summarize, cleanup, return 200.
 *
 * A judge-side sandbox failure at step 9 aborts the whole submission
 * with `500 {error}` rather than being graded — see the `sandboxError`
 * handling inside the per-case task.
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
  // Requested memory cap: the LARGER of what the request asked for and
  // the language's floor (e.g. pypy3 → 384 MB), falling back to 256 MB
  // when neither is set. `max` rather than `??` because both real
  // clients always send a number, which made the language floor dead —
  // see `languageMemoryDefaultMb`. What is actually applied to the
  // sandbox is that value clamped to the host ceiling; it is reported
  // back as `effectiveMemoryLimitMb`.
  const requestedMemLimitMb =
    Math.max(payload.memoryLimit ?? 0, languageMemoryDefaultMb(language) ?? 0) ||
    256;
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

      // First judge fault seen by any case. Set once, read by every case
      // still queued behind it so they return immediately instead of
      // spawning against a workdir that is about to be deleted.
      let abortReason: Error | null = null;

      const resultPromises = payload.input.map((rawInput, i) =>
        pool.run(async (): Promise<CaseOutcome> => {
          if (abortReason !== null) {
            return { ok: false, error: abortReason };
          }
          try {
            // An EMPTY input stays empty. `"".endsWith("\n")` is false,
            // so the old form silently rewrote "no input at all" into a
            // single blank line — a real difference to `sys.stdin.read()`
            // and to `scanf`, and the mutated string is also what
            // `runChecker` writes to the checker's input file.
            const stdin =
              rawInput.length === 0 || rawInput.endsWith("\n")
                ? rawInput
                : rawInput + "\n";
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

            // A JUDGE fault: nsjail or the runner could not be spawned,
            // nsjail bailed before executing anything (an unreadable or
            // uncompilable `--seccomp_policy`, a missing `--cwd`), or no
            // resource report survived. NOTHING of the user's code ran,
            // so there is nothing to grade — throwing hands it to the
            // route's `catch`, which returns the documented
            // `500 {error}` "the judge is wrong" channel.
            //
            // This is the case that reproduced live: with an
            // uncompilable seccomp policy nsjail exits 255 with its
            // diagnostic on fd 3, so the child's stdout and stderr are
            // both empty, `exitCode !== 0` held, and the judge graded
            // EVERY case of EVERY submission `RE` on a clean HTTP 200
            // while `/health` still reported `ok`. Deliberately not
            // `IE`: `IE` is documented as checker-only.
            if (sandboxRes.sandboxError !== undefined) {
              throw new Error(
                `sandbox failure on test case ${i}: ${sandboxRes.sandboxError}`,
              );
            }

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
                // Same rule as above, one layer down: the checker's own
                // sandbox failing is the judge breaking, not the problem
                // being misconfigured, so it must not become `IE` either.
                if (verdictFromChecker.sandboxError !== undefined) {
                  throw new Error(
                    `checker sandbox failure on test case ${i}: ${verdictFromChecker.sandboxError}`,
                  );
                }
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
            return {
              ok: true,
              result: buildResult(
                i,
                expected,
                sandboxRes,
                passed,
                verdict,
                checkerMessage,
              ),
            };
          } catch (err) {
            // Everything reaching here is the harness failing, never a
            // verdict: a judge-fault throw from above, or an unexpected
            // rejection (EMFILE, ENOSPC). It is deliberately NOT
            // synthesised into a verdict — `RE` would blame the student
            // for the judge, and `IE` is checker-only — so it aborts the
            // submission instead. Resolving rather than rejecting is
            // what guarantees every sibling task has settled before the
            // route's `finally` removes the workdir and releases the UID.
            const error = asError(err);
            if (abortReason === null) abortReason = error;
            return { ok: false, error };
          }
        }),
      );

      const settled = await Promise.allSettled(resultPromises);
      const results: TestResult[] = [];
      let caseFailure: Error | null = null;
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          // Unreachable while the task above catches everything; kept so
          // the settle-before-teardown guarantee does not depend on that.
          caseFailure ??= asError(outcome.reason);
        } else if (outcome.value.ok) {
          results.push(outcome.value.result);
        } else {
          caseFailure ??= outcome.value.error;
        }
      }
      if (caseFailure !== null) throw caseFailure;
      results.sort((a, b) => a.index - b.index);

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
        res.status(500).json({ error: asError(err).message });
      }
    } finally {
      // Safe to tear down unconditionally: the only thing that can still
      // be in flight at this point is nothing. Every per-case task
      // resolves rather than rejects, and the route awaits all of them
      // before it can reach here by any path.
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
