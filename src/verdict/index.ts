import type { RunMeasurement, TestResult, Verdict } from "../types";
import { decodeJailExit, SIGKILL, SIGXCPU } from "../sandbox/exitStatus";

/**
 * Grading one case, from raw measurements and the limits the route
 * enforced. **This module is the only place in the judge that decides a
 * verdict.** The sandbox measures and says nothing about what the numbers
 * mean; every threshold, every ordering and every "was it a timeout"
 * question lives here, over plain data, with no Linux kernel and no
 * `config` involved — which is what lets the whole ladder be replayed
 * from JSON (`test/fixtures/measurements`, `test/unit/verdict.test.ts`).
 *
 * A judge fault never reaches this module: `runSandboxed` reports it as
 * `RunOutcome.ok === false`, the caller throws, and the route's `catch`
 * returns `500 {error}`. Grading one would bill the judge's own breakage
 * to the student.
 */

/**
 * Fraction of the memory cap at which peak RSS counts as "hit the limit".
 *
 * **The only copy.** It used to be declared and exported in
 * `sandbox/nsjail.ts`, applied there by the ladder's RSS step, and
 * imported by `submit.ts` to re-apply the same threshold to the same
 * number — two call sites that had to be changed together and nothing
 * that said so. See the RSS step in `classifyKill` for why it is not 1.0.
 */
const MEM_LIMIT_RSS_RATIO = 0.98;

export interface CaseLimits {
  /** The limit the route enforced — already clamped to the host ceiling. */
  readonly timeLimitMs: number;
  readonly memLimitMb: number;
}

/**
 * The answer to "is this output acceptable?", from a comparator or a
 * checker. `checkerFailed` is the checker being unable to answer (exit 3,
 * crashed, could not be exec'd) — a problem fault that grades `IE`.
 */
export type Judgement =
  | { readonly passed: boolean; readonly checkerMessage?: string }
  | { readonly checkerFailed: true; readonly checkerMessage?: string };

/**
 * Invoked ONLY when the run finished cleanly (exit 0, no kill class), with
 * the program's stdout. A comparator judge is synchronous logic wrapped in
 * a promise; a checker judge runs a second sandbox. A judge that throws
 * aborts the case — that is the checker-sandbox judge fault path.
 */
export type Judge = (received: string) => Promise<Judgement>;

export interface GradeCaseInput {
  readonly index: number;
  readonly expected: string;
  readonly run: RunMeasurement;
  readonly limits: CaseLimits;
}

/** What ended a run. Internal: it is an input to a verdict, not a result. */
type KillClass = "TO" | "OOM" | "SIG" | null;

/**
 * Decide the kill class. CPU time is the authoritative measure of program
 * cost -- parent-measured wall time includes Node's spawn, nsjail's
 * fork/exec, kafel parse, BPF compile, V8 GC, and event-loop jitter, none
 * of which is user work, and all of which vary run-to-run under load. The
 * old "wallMs >= timeLimitMs" check produced flaky TLE on identical
 * submissions; this ladder decides from CPU time and uses wall only as a
 * loose liveness backstop.
 *
 * Order of checks:
 *   1. Node's last-resort SIGKILL timer fired     -> TO  (stuck nsjail/kernel)
 *   2. CPU time consumed >= user's timeLimitMs    -> TO  (authoritative)
 *   3. Clean exit (0, no signal) && CPU in budget -> null (AC/WA)
 *   4. Jail wall >= 3 * timeLimitMs               -> TO  (sleepy/blocked)
 *   5. Peak RSS at >=98% of the memory cap        -> OOM
 *   6. nsjail's 128+signal status                 -> TO for SIGXCPU (and
 *      for a SIGKILL that already overran the budget), else SIG
 *   7. A signal on the runner itself              -> SIG
 *   8. Null exit code (spawn failure)             -> SIG
 *   9. Otherwise                                  -> null
 *
 * Step 3 sitting after step 2 is what keeps a program that finished but
 * overspent its budget a TLE. Step 5 sitting after step 3 is what keeps
 * a solution that used its whole budget and exited cleanly an AC.
 * Reordering either reintroduces a bug that has already been fixed once.
 *
 * The two steps that used to sit at #2 and #3 -- "nsjail reported
 * RLIMIT_CPU" and "nsjail reported a memory limit exceeded" -- are gone
 * with the log scraper that fed them. nsjail 3.3 never emitted either
 * phrase, so neither had ever fired; step 2 and step 5 now do that work
 * from real measurements, and step 6 catches the kernel's signal kill
 * directly out of the exit status.
 *
 * This ladder ran inside `sandbox/nsjail.ts` until the sandbox was
 * reduced to measuring. Nothing about the steps changed in the move; what
 * changed is that its inputs are now a plain record, so every branch is
 * reachable from a fixture instead of only from a real kernel.
 */
function classifyKill(run: RunMeasurement, limits: CaseLimits): KillClass {
  const { timeLimitMs, memLimitMb } = limits;

  if (run.nodeTimerFired) return "TO";

  // CPU-time TLE (authoritative). This is `wait4()`'s rusage for nsjail
  // and every descendant it reaped -- actual CPU work consumed by the
  // program, independent of host scheduling or judge overhead, which is
  // what makes verdicts deterministic across runs and across hosts.
  if (run.cpuMs !== undefined && run.cpuMs >= timeLimitMs) return "TO";

  // Clean-exit guard. A normal exit(0) with no signal and no node-side
  // kill means the program actually finished -- never downgrade it to
  // TLE on wall noise. (The CPU-time check above has already rejected
  // programs that finished but exceeded their budget.)
  if (run.exitCode === 0 && run.runnerSignal === null) return null;

  // Wall-clock liveness backstop. Catches programs that block on
  // syscalls (sleep, I/O wait) without consuming CPU. Uses the runner's
  // inner wall clock when available (excludes Node's spawn latency);
  // 3x cushion keeps the threshold far from legitimate-run noise while
  // still bounding wedged submissions. Node's SIGKILL timer (fired at
  // timeLimitMs + KILL_GRACE_MS) is the tighter of the two in practice.
  const innerWallMs = run.jailWallMs ?? run.parentWallMs;
  if (innerWallMs >= timeLimitMs * 3) return "TO";

  // Peak RSS at (or within 2% of) the cap on a run that did NOT exit
  // cleanly -- the clean-exit guard above has already returned for those.
  // The 2% band exists because RSS is sampled by the kernel at page
  // granularity and a process that is being torn down for exceeding its
  // limit rarely reports the round number exactly. Note this is the peak
  // of the whole jail tree, so it includes nsjail's own few MB; that
  // cannot manufacture a false MLE at any realistic cap, and it can only
  // ever over-report, never hide a real one.
  const memLimitKb = memLimitMb * 1024;
  if (
    run.maxRssKb !== undefined &&
    run.maxRssKb >= memLimitKb * MEM_LIMIT_RSS_RATIO
  ) {
    return "OOM";
  }

  // In --mode o nsjail's own exit status IS the jailed child's fate:
  // `128 + WTERMSIG` when a signal killed it. Node's `runnerSignal`
  // describes what killed the RUNNER, which is null in every one of
  // these cases, so before this decode existed the ladder fell all the
  // way through to `null` and a SIGXCPU kill came back as `RE` with
  // `timedOut: false` -- neither a TLE verdict nor a timeout flag -- on
  // any host fast enough for RLIMIT_CPU to beat the wall timers.
  const exit = decodeJailExit(run.exitCode);
  if (exit.kind === "signalled") {
    // SIGXCPU is RLIMIT_CPU firing: unambiguously a timeout.
    if (exit.signal === SIGXCPU) return "TO";
    // SIGKILL is nsjail's own --time_limit wall backstop when the run
    // has already outlived its budget; a program that SIGKILLs itself
    // inside its budget stays a runtime error. It is also what the
    // kernel sends for RLIMIT_CPU when the soft and hard limits are
    // equal, as nsjail sets them, so this arm carries most real TLEs.
    if (exit.signal === SIGKILL && innerWallMs >= timeLimitMs) return "TO";
    return "SIG";
  }

  if (run.runnerSignal !== null) return "SIG";
  if (exit.kind === "none") return "SIG";

  return null;
}

/**
 * Signatures a program emits when an allocation was REFUSED rather than
 * the process being killed. This is the common case on this host:
 * limits are enforced with `--rlimit_as`, which caps virtual address
 * space, so `malloc`/`new` return failure instead of the kernel killing
 * anything. The program then throws, aborts, and exits non-zero -- which
 * looks exactly like a runtime error unless we read its stderr.
 *
 *   std::bad_alloc         uncaught C++ `new` failure
 *   bad_array_new_length   C++ `new T[n]` with an absurd n
 *   Cannot allocate memory strerror(ENOMEM), printed by many runtimes
 *   MemoryError            CPython / PyPy
 *   Killed                 an OOM-killer message that reached stderr
 *
 * `\bKilled\b` is the fragile one: a program that legitimately prints the
 * word and then exits non-zero is misreported as MLE. It is a deliberate
 * trade -- the OOM killer's message is the only signal available in that
 * case -- so do not widen the pattern and do not drop the word boundary.
 */
const ALLOCATION_FAILURE_RE =
  /std::bad_alloc|bad_array_new_length|Cannot allocate memory|MemoryError|\bKilled\b/;

/**
 * Decide whether a case blew its memory budget. True when EITHER:
 *
 *   1. the ladder already classified the kill as `OOM` (peak RSS reached
 *      the cap);
 *   2. the run did not finish cleanly AND its stderr carries an
 *      allocation-failure signature -- the `RLIMIT_AS` case, where RSS
 *      stays *below* the cap precisely because the allocation was
 *      refused.
 *
 * Rule 2 is gated on the run not having finished cleanly: a program that
 * exit(0)'d fit inside its budget by definition, however close to the
 * ceiling it got, and must never be downgraded from AC. A plain SIGSEGV
 * from a null-pointer bug has low RSS and no allocation signature on
 * stderr, so it stays RE.
 *
 * **There used to be a third rule between these two** -- "peak RSS at
 * >= 98% of the enforced cap" -- and it is gone because it could never
 * add an answer. It was evaluated only on a non-clean run, which is
 * exactly the condition under which the ladder had already run its own
 * RSS step against the same number and the same ratio: every case that
 * rule could have matched arrives here already carrying `OOM`, and every
 * case where the ladder returned `TO` first is a TLE before memory is
 * even consulted. `submit.ts` already described it as a duplicate of the
 * ladder's step; deleting it changes no verdict and removes the second
 * copy of `MEM_LIMIT_RSS_RATIO` that made the two able to drift.
 *
 * NOTE ON MATURITY: `maxRssKb` was `0` on every single run for the entire
 * life of the nsjail 3.3 pin -- the old code scraped it out of nsjail's
 * log and nsjail 3.3 emits no such line. 3,457 stored test cases carry
 * `memKb: 0`, and no submission has ever been graded `MLE` by the RSS
 * path. It now measures real `ru_maxrss`, so treat rule 1 as unproven
 * rather than battle-tested.
 */
function isMemoryLimitExceeded(
  run: RunMeasurement,
  killClass: KillClass,
): boolean {
  if (killClass === "OOM") return true;
  if (run.exitCode === 0 && killClass === null) return false;
  return ALLOCATION_FAILURE_RE.test(run.stderr);
}

/**
 * Derive the competitive-programming verdict from a measurement, its kill
 * class and the judgement.
 *
 * Order is load-bearing: **TLE -> MLE -> RE -> IE -> WA/AC**. A memory
 * failure must be tested before the `exitCode !== 0` branch, or every
 * refused allocation is mislabelled `RE` -- the bug this ordering exists
 * to prevent.
 *
 * `checkerFailed` is set when a custom checker could not answer for this
 * case (exit 3, or the checker itself crashed/timed out). That is a
 * problem-configuration fault, so it surfaces as `IE` -- but only after
 * the program's own failures, which are more specific.
 *
 * `CE` is in the `Verdict` union and is never produced here: a compile
 * failure leaves the route early as `compileError`/`checkerError` on an
 * HTTP 200 and `wmoj-app` synthesizes its own `CE`.
 */
function deriveVerdict(
  run: RunMeasurement,
  killClass: KillClass,
  passed: boolean,
  checkerFailed: boolean,
): Verdict {
  if (killClass === "TO") return "TLE";
  if (isMemoryLimitExceeded(run, killClass)) return "MLE";
  if (run.exitCode !== 0 || killClass === "SIG") return "RE";
  if (checkerFailed) return "IE";
  return passed ? "AC" : "WA";
}

/**
 * Build the TestResult for one case. Centralizes the "shape" of a result
 * so it cannot drift between cases.
 */
function buildResult(args: {
  index: number;
  expected: string;
  run: RunMeasurement;
  killClass: KillClass;
  passed: boolean;
  verdict: Verdict;
  checkerMessage: string | undefined;
}): TestResult {
  const { index, expected, run, killClass, passed, verdict, checkerMessage } =
    args;
  const result: TestResult = {
    index,
    exitCode: run.exitCode,
    passed,
    expected,
    received: run.stdout,
    stderr: run.stderr,
    stdout: run.stdout,
    timedOut: killClass === "TO",
    verdict,
    // The runner's own fork()->wait4() wall when a report survived, which
    // excludes Node's spawn latency and V8 pauses; the parent's
    // measurement is the fallback for exactly the runs we force-killed,
    // where no report could be written.
    timeMs: run.jailWallMs ?? run.parentWallMs,
    cpuMs: run.cpuMs ?? 0,
    memKb: run.maxRssKb ?? 0,
  };
  // Both optional keys are omitted rather than set false/empty, so a
  // response for an ordinary submission stays byte-identical to what it
  // was before either field existed.
  //
  // `truncated` says the strings above are a PREFIX: the sandbox drains
  // and discards past 1 MiB of stdout / 64 KiB of stderr instead of
  // accumulating an unbounded `for(;;) puts("x")` in the Node heap of a
  // 512 MB container. Without this flag `received` would silently
  // disagree with what the program actually printed and a `WA` would be
  // unexplainable to the student. The cap sits above the largest
  // expected output `requestCaps` accepts, so a truncated run could not
  // have been AC anyway -- the verdict itself is unaffected.
  if (run.truncated) {
    result.truncated = true;
  }
  // Omitted when the checker said nothing (or never ran).
  if (checkerMessage !== undefined && checkerMessage.length > 0) {
    result.checkerMessage = checkerMessage;
  }
  return result;
}

/**
 * Grade one case. Absorbs, in this order and for the reasons the old
 * comments gave: the kill ladder (was `classifyKill`, in the sandbox),
 * the memory rules (was `isMemoryLimitExceeded`, in the route), the
 * verdict ordering TLE -> MLE -> RE -> IE -> WA/AC (was `deriveVerdict`)
 * and the TestResult shape (was `buildResult`). The interface is the test
 * surface: every fixture in `test/fixtures/measurements` goes through
 * exactly this call.
 *
 * **The judge is invoked only when the run finished cleanly** -- exit 0
 * with no kill class. That is unchanged from before custom checkers
 * existed and it is what stops a crashed or timed-out program from ever
 * reaching a comparator or a checker. A judge that throws rejects this
 * promise, which is the checker-sandbox judge-fault path: the caller lets
 * it propagate to the route's `catch` and it becomes a 500, never a
 * verdict.
 */
export async function gradeCase(
  input: GradeCaseInput,
  judge: Judge,
): Promise<TestResult> {
  const { index, expected, run, limits } = input;
  const killClass = classifyKill(run, limits);
  const ranCleanly = run.exitCode === 0 && killClass === null;

  let passed = false;
  let checkerFailed = false;
  let checkerMessage: string | undefined;

  if (ranCleanly) {
    const judgement = await judge(run.stdout);
    if ("checkerFailed" in judgement) {
      checkerFailed = true;
    } else {
      passed = judgement.passed;
    }
    checkerMessage = judgement.checkerMessage;
  }

  const verdict = deriveVerdict(run, killClass, passed, checkerFailed);
  return buildResult({
    index,
    expected,
    run,
    killClass,
    passed,
    verdict,
    checkerMessage,
  });
}
