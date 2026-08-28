import test from "node:test";
import assert from "node:assert/strict";
import type { RunMeasurement, RunOutcome, SandboxOpts } from "../../src/types";
import type { CheckerRun, RunCheckerOpts } from "../../src/checker";
import { compare } from "../../src/compare";
import type { Workspace } from "../../src/workspace";
import {
  judgeAllCases,
  type CaseInput,
  type Grading,
  type JudgeDeps,
  type Program,
} from "../../src/judge/judgeCase";

/**
 * Running and grading the cases of one submission, with the sandbox and
 * the checker scripted and the real comparator.
 *
 * Every case here is one of the four defects `56b986e` closed, or the
 * rule that closed it: a judge fault must never be graded (it is a 500,
 * not `RE` and not `IE`), a checker that could not answer must be `IE`
 * on that case ALONE, an empty input must stay empty, and no case may
 * still be running when this function resolves — that is what the
 * workspace lease's teardown relies on.
 */

/** Marker for "this promise has not settled yet". */
const PENDING = Symbol("pending");

function raceToPending<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    p,
    new Promise<typeof PENDING>((resolve) => {
      setImmediate(() => resolve(PENDING));
    }),
  ]);
}

/**
 * A workspace that is only ever asked for its `dir`, `label` and paths:
 * a scripted sandbox writes nothing, and the checker fake stands in for
 * the one collaborator that does.
 */
const ws: Workspace = {
  dir: "/tmp/judge-fake",
  label: "submit",
  write: () => Promise.reject(new Error("write must not be called per case")),
  copyIn: () => Promise.reject(new Error("copyIn must not be called per case")),
  remove: () => Promise.resolve(),
  path: (name) => `/tmp/judge-fake/${name}`,
};

const PROGRAM: Program = {
  argv: ["./a.out"],
  limits: { timeLimitMs: 1000, memLimitMb: 256 },
};

/** A run that finished cleanly, well inside both limits. */
function measurement(overrides: Partial<RunMeasurement> = {}): RunMeasurement {
  return {
    exitCode: 0,
    runnerSignal: null,
    cpuMs: 5,
    maxRssKb: 2048,
    jailWallMs: 6,
    nsjailExit: 0,
    nsjailSignal: 0,
    parentWallMs: 9,
    nodeTimerFired: false,
    stdout: "",
    stderr: "",
    truncated: false,
    ...overrides,
  };
}

function ran(overrides: Partial<RunMeasurement> = {}): RunOutcome {
  return { ok: true, run: measurement(overrides) };
}

/** `submit:case3` → 3. The label is how a case identifies itself downstream. */
function caseIndexOf(label: string): number {
  const m = /:case(\d+)$/.exec(label);
  assert.notEqual(m, null, `unexpected sandbox label: ${label}`);
  return Number(m?.[1]);
}

interface Sandbox {
  fn: JudgeDeps["runSandboxed"];
  calls: SandboxOpts[];
}

function sandbox(
  script: (index: number, opts: SandboxOpts) => Promise<RunOutcome>,
): Sandbox {
  const calls: SandboxOpts[] = [];
  return {
    calls,
    fn: (opts) => {
      calls.push(opts);
      return script(caseIndexOf(opts.label), opts);
    },
  };
}

interface Checker {
  fn: JudgeDeps["runChecker"];
  calls: RunCheckerOpts[];
}

function checker(
  script: (index: number, opts: RunCheckerOpts) => Promise<CheckerRun>,
): Checker {
  const calls: RunCheckerOpts[] = [];
  return {
    calls,
    fn: (opts) => {
      calls.push(opts);
      return script(opts.index, opts);
    },
  };
}

/** An accepting checker, so a case's outcome is the sandbox's alone. */
function accepts(message = ""): Promise<CheckerRun> {
  return Promise.resolve({
    ok: true,
    verdict: { outcome: "accepted", message, exitCode: 0 },
  });
}

function depsOf(sb: Sandbox, ck?: Checker): JudgeDeps {
  return {
    runSandboxed: sb.fn,
    runChecker:
      ck?.fn ??
      ((): Promise<CheckerRun> => {
        throw new Error("the checker must not run for this submission");
      }),
    compare,
  };
}

const CHECKER_GRADING: Grading = { kind: "checker" };
const TRIM_TRAILING: Grading = { kind: "compare", mode: "trim-trailing" };

function cases(inputs: readonly string[], expected: readonly string[]): CaseInput[] {
  return inputs.map((input, index) => ({
    index,
    input,
    expected: expected[index] ?? "",
  }));
}

test("a checker's exit 3 is IE on that case alone, and every other case still grades", async () => {
  // `IE` is the checker saying it could not answer. It counts as failed,
  // it carries the checker's message, and it must not spread: the whole
  // point of not throwing on it is that six good verdicts survive one
  // bad case.
  const sb = sandbox(() => Promise.resolve(ran({ stdout: "answer\n" })));
  const ck = checker((index) =>
    index === 4
      ? Promise.resolve({
          ok: true,
          verdict: {
            outcome: "internal-error",
            message: "bad test data",
            exitCode: 3,
          },
        })
      : accepts(),
  );

  const out = await judgeAllCases(
    depsOf(sb, ck),
    ws,
    PROGRAM,
    CHECKER_GRADING,
    cases(Array<string>(7).fill("1 2"), Array<string>(7).fill("answer\n")),
    1,
  );

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.results.length, 7);
  assert.equal(out.results[4]?.verdict, "IE");
  assert.equal(out.results[4]?.passed, false);
  assert.equal(out.results[4]?.checkerMessage, "bad test data");
  assert.deepEqual(
    out.results.filter((r) => r.verdict !== "AC").map((r) => r.index),
    [4],
  );
  // What the route reports as `summary`: an IE case is a failed case.
  assert.equal(out.results.filter((r) => !r.passed).length, 1);
});

test("a sandbox fault aborts the submission, names its case, and settles every sibling first", async () => {
  // The fault is a JUDGE fault: `ok: false`, which the route rethrows as
  // a 500. Grading it would bill the judge's own breakage to the
  // student — with an uncompilable seccomp policy that graded every case
  // of every submission `RE` on a clean HTTP 200.
  let releaseCase1 = (): void => {};
  const case1Settles = new Promise<RunOutcome>((resolve) => {
    releaseCase1 = () => resolve(ran({ stdout: "answer\n" }));
  });

  const sb = sandbox((index) => {
    if (index === 1) return case1Settles;
    if (index === 2) {
      return Promise.resolve({
        ok: false,
        sandboxError: "nsjail exited 255: could not parse seccomp policy",
      });
    }
    return Promise.resolve(ran({ stdout: "answer\n" }));
  });

  const pending = judgeAllCases(
    depsOf(sb),
    ws,
    PROGRAM,
    TRIM_TRAILING,
    cases(Array<string>(7).fill("1 2"), Array<string>(7).fill("answer\n")),
    2,
  );

  // Case 1 is still inside the sandbox. Resolving now would hand the
  // route back its workspace while a jailed process is still using it —
  // p-limit has no cancellation, so nothing would stop that run.
  assert.equal(await raceToPending(pending), PENDING);

  releaseCase1();
  const out = await pending;

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(
    out.error.message,
    /^sandbox failure on test case 2: nsjail exited 255/,
  );
  // Abort-on-first-fault: cases 3+ never spawned anything.
  assert.deepEqual(
    sb.calls.map((c) => c.label).sort(),
    ["submit:case0", "submit:case1", "submit:case2"],
  );
});

test("a checker's own sandbox failing is a judge fault, never IE", async () => {
  // One layer down, the same rule: `IE` means the problem is broken, and
  // the judge's machinery breaking is not the problem's fault.
  const sb = sandbox(() => Promise.resolve(ran({ stdout: "answer\n" })));
  const ck = checker((index) =>
    index === 1
      ? Promise.resolve({ ok: false, sandboxError: "spawn ENOMEM" })
      : accepts(),
  );

  const out = await judgeAllCases(
    depsOf(sb, ck),
    ws,
    PROGRAM,
    CHECKER_GRADING,
    cases(["a", "b", "c"], ["answer\n", "answer\n", "answer\n"]),
    1,
  );

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(
    out.error.message,
    "checker sandbox failure on test case 1: spawn ENOMEM",
  );
});

test("results come back sorted by index, whatever order the cases arrive or finish in", async () => {
  // Completion order stops being index order the moment concurrency
  // exceeds 1, and `wmoj-app` renders `results` positionally. The cases
  // are handed over out of order too, so this fails if the sort is
  // dropped and not merely if `Promise.allSettled` stops preserving
  // input order.
  const sb = sandbox(
    (index) =>
      new Promise<RunOutcome>((resolve) => {
        setTimeout(() => resolve(ran({ stdout: "answer\n" })), (3 - index) * 10);
      }),
  );

  const shuffled: CaseInput[] = [2, 0, 1].map((index) => ({
    index,
    input: "a",
    expected: "answer\n",
  }));

  const out = await judgeAllCases(depsOf(sb), ws, PROGRAM, TRIM_TRAILING, shuffled, 3);

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(
    out.results.map((r) => r.index),
    [0, 1, 2],
  );
  // Arrival order really was 2, 0, 1 and completion order really was
  // 2, 1, 0 — or this proves nothing.
  assert.deepEqual(
    sb.calls.map((c) => c.label),
    ["submit:case2", "submit:case0", "submit:case1"],
  );
});

test("stdin gets exactly one trailing newline, and an empty input stays empty", async () => {
  // `"".endsWith("\n")` is false, so the obvious form rewrites "no input
  // at all" into a blank line — a real difference to `sys.stdin.read()`
  // and to `scanf`.
  const sb = sandbox(() => Promise.resolve(ran({ stdout: "answer\n" })));
  const ck = checker(() => accepts());

  const out = await judgeAllCases(
    depsOf(sb, ck),
    ws,
    PROGRAM,
    CHECKER_GRADING,
    cases(["", "1 2", "1 2\n"], ["answer\n", "answer\n", "answer\n"]),
    1,
  );

  assert.equal(out.ok, true);
  assert.deepEqual(
    sb.calls.map((c) => c.stdin),
    ["", "1 2\n", "1 2\n"],
  );
  // The checker is shown exactly what the program was given: the
  // mutated string, not the raw request field.
  assert.deepEqual(
    ck.calls.map((c) => c.input),
    ["", "1 2\n", "1 2\n"],
  );
  assert.deepEqual(
    sb.calls.map((c) => c.cwd),
    [ws.dir, ws.dir, ws.dir],
  );
  assert.deepEqual(
    sb.calls.map((c) => c.argv),
    [["./a.out"], ["./a.out"], ["./a.out"]],
  );
});

test("a crashed run never reaches the checker", async () => {
  // The judge callback runs only when the program exited cleanly. A
  // checker handed a crashed run's empty stdout would answer about
  // nothing.
  const sb = sandbox((index) =>
    Promise.resolve(ran({ exitCode: index === 1 ? 1 : 0, stdout: "answer\n" })),
  );
  const ck = checker(() => accepts());

  const out = await judgeAllCases(
    depsOf(sb, ck),
    ws,
    PROGRAM,
    CHECKER_GRADING,
    cases(["a", "b", "c"], ["answer\n", "answer\n", "answer\n"]),
    1,
  );

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.results[1]?.verdict, "RE");
  assert.deepEqual(
    ck.calls.map((c) => c.index),
    [0, 2],
  );
});

test("a failed case never stops the ones after it, and the comparator decides", async () => {
  // No early exit, by contract with wmoj-app: a student sees every case.
  // The comparator is the real one — `trim-trailing` ignores trailing
  // whitespace on a line and nothing else.
  const outputs = ["5 \n", "6\n", "5\n"];
  const sb = sandbox((index) =>
    Promise.resolve(ran({ stdout: outputs[index] ?? "" })),
  );

  const out = await judgeAllCases(
    depsOf(sb),
    ws,
    PROGRAM,
    TRIM_TRAILING,
    cases(["a", "b", "c"], ["5\n", "5\n", "5\n"]),
    1,
  );

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(
    out.results.map((r) => r.verdict),
    ["AC", "WA", "AC"],
  );
  assert.equal(sb.calls.length, 3, "a WA must not abort the submission");
});
