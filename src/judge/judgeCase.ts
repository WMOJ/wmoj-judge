import pLimit from "p-limit";
import type { CompareMode, TestResult } from "../types";
import { runSandboxed } from "../sandbox/nsjail";
import { runChecker } from "../checker";
import { compare } from "../compare";
import { gradeCase, type CaseLimits, type Judge } from "../verdict";
import type { Workspace } from "../workspace";
import { logger } from "../util/logger";

/**
 * Running and grading the cases of one submission.
 *
 * This is where every one of `56b986e`'s four defects lived, as a
 * 300-line closure inside the route with hard imports: the stdin rule
 * that rewrote "no input" into a blank line, the judge fault that was
 * graded `RE`, the checker sandbox failure that became `IE`, and the
 * `Promise.all` that let 199 cases keep running against a deleted
 * workdir. Behind this interface they are reachable from a unit test
 * with no Linux kernel involved: the sandbox and the checker are
 * parameters, the concurrency is a parameter, and nothing here imports
 * `config` or Express.
 */

/**
 * The collaborators one case needs. `productionJudgeDeps` is the only
 * value the judge itself ever constructs; a test scripts them.
 *
 * Typed as `typeof` the real functions rather than as hand-written
 * signatures so a change to `runSandboxed` or `runChecker` breaks this
 * file at compile time instead of leaving a fake that no longer
 * resembles what production calls.
 */
export interface JudgeDeps {
  readonly runSandboxed: typeof runSandboxed;
  readonly runChecker: typeof runChecker;
  readonly compare: typeof compare;
}

export const productionJudgeDeps: JudgeDeps = {
  runSandboxed,
  runChecker,
  compare,
};

/** What to run, and under which already-clamped limits. Built once per submission. */
export interface Program {
  readonly argv: readonly string[];
  readonly limits: CaseLimits;
}

/**
 * How this submission's output is judged. A checker REPLACES
 * `compareMode` — the byte comparison is not run at all when one was
 * supplied — so the two are alternatives, not a mode plus a flag.
 * `{kind: "checker"}` carries no source: the compiled `checker.out`
 * already sits in the workspace by the time a case runs.
 */
export type Grading =
  | { readonly kind: "compare"; readonly mode: CompareMode }
  | { readonly kind: "checker" };

export interface CaseInput {
  readonly index: number;
  readonly input: string;
  readonly expected: string;
}

/** Narrow an unknown thrown value to an Error without a custom class. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Exactly the bytes the program gets on stdin.
 *
 * An EMPTY input stays empty. `"".endsWith("\n")` is false, so the
 * obvious form silently rewrites "no input at all" into a single blank
 * line — a real difference to `sys.stdin.read()` and to `scanf`, and the
 * mutated string is also what `runChecker` writes to the checker's input
 * file, so the checker would be shown input the program never received.
 */
function stdinFor(input: string): string {
  return input.length === 0 || input.endsWith("\n") ? input : `${input}\n`;
}

/**
 * Run and grade one case. Throws on a judge fault (the sandbox, or the
 * checker's sandbox); never converts one into a verdict.
 *
 * The label is `<workspace label>:case<index>` — "submit:case3" — which
 * is what ties a sandbox log line back to the case that produced it.
 */
export async function judgeCase(
  deps: JudgeDeps,
  ws: Workspace,
  program: Program,
  grading: Grading,
  c: CaseInput,
): Promise<TestResult> {
  const stdin = stdinFor(c.input);
  const outcome = await deps.runSandboxed({
    argv: [...program.argv],
    cwd: ws.dir,
    label: `${ws.label}:case${String(c.index)}`,
    timeLimitMs: program.limits.timeLimitMs,
    memLimitMb: program.limits.memLimitMb,
    stdin,
  });

  // A JUDGE fault: nsjail or the runner could not be spawned, nsjail
  // bailed before executing anything (an unreadable or uncompilable
  // `--seccomp_policy`, a missing `--cwd`), or no resource report
  // survived. NOTHING of the user's code ran, so there is nothing to
  // grade — throwing hands it to the route's `catch`, which returns the
  // documented `500 {error}` "the judge is wrong" channel.
  //
  // This is the case that reproduced live: with an uncompilable seccomp
  // policy nsjail exits 255 with its diagnostic on fd 3, so the child's
  // stdout and stderr are both empty, `exitCode !== 0` held, and the
  // judge graded EVERY case of EVERY submission `RE` on a clean HTTP 200
  // while `/health` still reported `ok`. Deliberately not `IE`: `IE` is
  // documented as checker-only.
  if (!outcome.ok) {
    throw new Error(
      `sandbox failure on test case ${String(c.index)}: ${outcome.sandboxError}`,
    );
  }

  // How this case's output is judged. `gradeCase` calls it ONLY when the
  // program itself finished cleanly, which is what keeps a crashed or
  // timed-out run from ever reaching the comparator or the checker —
  // unchanged from before checkers existed.
  const judge: Judge =
    grading.kind === "compare"
      ? // No checker: the byte comparison the request selected.
        async (received) => ({
          passed: deps.compare(grading.mode, c.expected, received),
        })
      : async (received) => {
          const checkerRun = await deps.runChecker({
            ws,
            index: c.index,
            input: stdin,
            expected: c.expected,
            received,
          });
          // Same rule as above, one layer down: the checker's own
          // sandbox failing is the judge breaking, not the problem being
          // misconfigured, so it must not become `IE` either. Throwing
          // here rejects `gradeCase` and propagates out of this case.
          if (!checkerRun.ok) {
            throw new Error(
              `checker sandbox failure on test case ${String(c.index)}: ${checkerRun.sandboxError}`,
            );
          }
          const checkerVerdict = checkerRun.verdict;
          if (checkerVerdict.outcome === "internal-error") {
            logger.error(
              {
                index: c.index,
                exitCode: checkerVerdict.exitCode,
                message: checkerVerdict.message,
              },
              "judge: checker reported an internal error",
            );
            return {
              checkerFailed: true,
              checkerMessage: checkerVerdict.message,
            };
          }
          return {
            passed: checkerVerdict.outcome === "accepted",
            checkerMessage: checkerVerdict.message,
          };
        };

  return gradeCase(
    { index: c.index, expected: c.expected, run: outcome.run, limits: program.limits },
    judge,
  );
}

/**
 * The settled outcome of grading one case.
 *
 * Per-case tasks resolve one of these instead of rejecting. `Promise.all`
 * rejects on the FIRST rejection, so a single throwing case used to
 * return 500 while p-limit — which has no cancellation; its runner is
 * `try { await result } catch {}` then `next()` — kept dequeuing up to
 * 199 more. Those ran with `--cwd` pointing at a directory the lease's
 * teardown had already removed, under a UID already handed to another
 * submission, each arming a `timeLimitMs + 5000` timer, all of it
 * outside the global semaphore the closure had released — and with
 * `exitRequest()` already fired, so a concurrent SIGTERM saw
 * `inFlight === 0`. Settling every case before returning is what closes
 * that window.
 */
type CaseOutcome =
  | { ok: true; result: TestResult }
  | { ok: false; error: Error };

export type JudgeAllOutcome =
  | { ok: true; results: TestResult[] }
  | { ok: false; error: Error };

/**
 * Every case, through a p-limit of `concurrency`, with
 * abort-on-first-fault: a case queued behind a judge fault returns
 * immediately instead of spawning against a workspace that is about to
 * be torn down. Resolves only after every case has settled — the
 * guarantee `withWorkspace`'s teardown relies on.
 *
 * **Only a judge fault aborts.** A WA, TLE, MLE or RE case is a verdict,
 * and every remaining case still runs: there is no early exit on a
 * failed case, by contract with `wmoj-app`, which shows the student all
 * of them.
 *
 * `ok: false` carries the fault of the lowest-index case that saw one —
 * with the abort above, that is the case that actually failed, and every
 * case after it carries a copy of the same error.
 */
export async function judgeAllCases(
  deps: JudgeDeps,
  ws: Workspace,
  program: Program,
  grading: Grading,
  cases: readonly CaseInput[],
  concurrency: number,
): Promise<JudgeAllOutcome> {
  const limit = pLimit(concurrency);

  // First judge fault seen by any case. Set once, read by every case
  // still queued behind it.
  let abortReason: Error | null = null;

  const tasks = cases.map((c) =>
    limit(async (): Promise<CaseOutcome> => {
      if (abortReason !== null) {
        return { ok: false, error: abortReason };
      }
      try {
        return { ok: true, result: await judgeCase(deps, ws, program, grading, c) };
      } catch (err) {
        // Everything reaching here is the harness failing, never a
        // verdict: a judge-fault throw from `judgeCase`, or an
        // unexpected rejection (EMFILE, ENOSPC). It is deliberately NOT
        // synthesised into a verdict — `RE` would blame the student for
        // the judge, and `IE` is checker-only — so it aborts the
        // submission instead. Resolving rather than rejecting is what
        // guarantees every sibling task has settled before this
        // function returns.
        const error = asError(err);
        if (abortReason === null) abortReason = error;
        return { ok: false, error };
      }
    }),
  );

  const settled = await Promise.allSettled(tasks);
  const results: TestResult[] = [];
  let failure: Error | null = null;
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      // Unreachable while the task above catches everything; kept so the
      // settle-before-teardown guarantee does not depend on that.
      failure ??= asError(outcome.reason);
    } else if (outcome.value.ok) {
      results.push(outcome.value.result);
    } else {
      failure ??= outcome.value.error;
    }
  }
  if (failure !== null) return { ok: false, error: failure };

  // Completion order is not index order the moment `concurrency > 1`.
  results.sort((a, b) => a.index - b.index);
  return { ok: true, results };
}
