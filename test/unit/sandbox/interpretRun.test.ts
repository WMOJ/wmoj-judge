import test from "node:test";
import assert from "node:assert/strict";
import type { RunMeasurement } from "../../../src/types";
import {
  interpretRun,
  parseJailRunReport,
  type CappedStream,
  type RawRun,
} from "../../../src/sandbox/nsjail";

/**
 * `interpretRun` is everything `runSandboxed` does after the child has
 * settled: decode the streams, parse the runner's report, and decide
 * whether the JUDGE failed. Splitting it out is what makes the five
 * judge-fault branches reachable without a Linux kernel — and they need
 * to be reachable, because every one of them is a path on which nothing
 * of the user's code ran and grading it would blame a student for the
 * judge's own breakage. One of them (an uncompilable `policy.kafel`)
 * shipped, and graded every case of every submission `RE` on a clean
 * HTTP 200 while `/health` said "ok".
 *
 * The ORDER of the branches is pinned as well as their presence: a spawn
 * failure must not be re-described by a later branch as a missing report.
 */

function stream(text: string, truncated = false): CappedStream {
  const buf = Buffer.from(text, "utf8");
  return { chunks: [buf], bytes: buf.length, truncated };
}

const REPORT = "WMOJ-JAILRUN v1 exit=0 signal=0 cpu_us=12500 maxrss_kb=4096 wall_us=31200\n";

function rawRun(overrides: Partial<RawRun> = {}): RawRun {
  return {
    code: 0,
    signal: null,
    spawnError: null,
    deadlineExceeded: false,
    out: stream(""),
    err: stream(""),
    log: stream(""),
    report: stream(REPORT),
    wallMs: 40,
    forcedKill: false,
    killedByTimer: false,
    label: "test:case0",
    argv: ["./a.out"],
    cwd: "/tmp/judge-test",
    timeLimitMs: 2000,
    ...overrides,
  };
}

/** Narrow to the measurement arm, failing with the fault text if it is not. */
function runOf(raw: RawRun): RunMeasurement {
  const outcome = interpretRun(raw);
  if (!outcome.ok) {
    assert.fail(`expected a measurement, got a judge fault: ${outcome.sandboxError}`);
  }
  return outcome.run;
}

function faultOf(raw: RawRun): string {
  const outcome = interpretRun(raw);
  if (outcome.ok) {
    assert.fail("expected a judge fault, got a measurement");
  }
  return outcome.sandboxError;
}

// ---------------------------------------------------------------------
// The five judge-fault branches, in order
// ---------------------------------------------------------------------

test("branch 1: a spawn failure is a judge fault naming the errno message", () => {
  assert.equal(
    faultOf(rawRun({ spawnError: "spawn ENOENT", code: null, report: stream("") })),
    "sandbox could not be started: spawn ENOENT",
  );
});

test("branch 1 wins over branch 4: a spawn failure is not 'no resource report'", () => {
  // Both conditions hold on this record — nothing spawned, so nothing
  // reported. Reporting the later one would send a maintainer looking at
  // the jail runner for a problem that is Node failing to fork.
  const fault = faultOf(
    rawRun({ spawnError: "spawn EMFILE", code: null, report: stream("") }),
  );
  assert.equal(fault, "sandbox could not be started: spawn EMFILE");
});

test("branch 2: the absolute deadline is a judge fault, not a timeout verdict", () => {
  // A wedged run must never be graded: it held a pool slot and a
  // semaphore permit, and the outcome says nothing about the program.
  assert.equal(
    faultOf(
      rawRun({ deadlineExceeded: true, code: null, forcedKill: true, report: stream("") }),
    ),
    "sandbox exceeded its absolute deadline and was force-killed",
  );
});

test("branch 2 wins over branch 3: a deadline is not the runner's own error", () => {
  const fault = faultOf(
    rawRun({
      deadlineExceeded: true,
      code: null,
      forcedKill: true,
      report: stream("WMOJ-JAILRUN v1 error=wait4 errno=4\n"),
    }),
  );
  assert.equal(fault, "sandbox exceeded its absolute deadline and was force-killed");
});

test("branch 3: the runner reporting its own failure names the step and errno", () => {
  assert.equal(
    faultOf(rawRun({ code: 126, report: stream("WMOJ-JAILRUN v1 error=fork errno=11\n") })),
    "jail runner failed at fork (errno 11)",
  );
});

test("branch 4: no report and no forced kill is a judge fault", () => {
  // This is the /health bug's shape: exit 0, empty streams, everything
  // looks healthy, and the ONLY thing that says the reporter is dead is
  // this branch.
  assert.equal(
    faultOf(rawRun({ code: 0, report: stream("") })),
    "sandbox produced no resource report -- the jail runner did not complete",
  );
});

test("branch 5: nsjail's [F] fatal on exit 255 with empty stdout is a judge fault", () => {
  // An uncompilable policy.kafel: nsjail writes its diagnostic to fd 3
  // and exits 255 without running anything, so the child's streams are
  // both empty. Left undetected this graded every case `RE`.
  assert.equal(
    faultOf(
      rawRun({
        code: 255,
        log: stream("[F] main():360 Couldn't prepare sandboxing policy\n"),
        report: stream("WMOJ-JAILRUN v1 exit=255 signal=0 cpu_us=900 maxrss_kb=3000 wall_us=4000\n"),
      }),
    ),
    "nsjail failed to start the jail (exit 255)",
  );
});

test("branch 5 does not fire when the program produced output", () => {
  // The fd-3 log is not trusted: it is not settled whether a jailed
  // process can write there, so a submission that forged a `[F]` prefix
  // could otherwise turn its own run into a judge-fault 500. Real stdout
  // proves the child ran.
  const run = runOf(
    rawRun({
      code: 255,
      out: stream("hello\n"),
      log: stream("[F] main():360 Couldn't prepare sandboxing policy\n"),
      report: stream("WMOJ-JAILRUN v1 exit=255 signal=0 cpu_us=900 maxrss_kb=3000 wall_us=4000\n"),
    }),
  );
  assert.equal(run.exitCode, 255);
  assert.equal(run.stdout, "hello\n");
});

test("branch 5 does not fire on a non-fatal nsjail log line", () => {
  const run = runOf(
    rawRun({ code: 255, log: stream("[W] preparePolicy():121 something noisy\n") }),
  );
  assert.equal(run.exitCode, 255);
});

// ---------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------

test("a well-formed report parses to the right numbers, microseconds rounded to ms", () => {
  const run = runOf(
    rawRun({
      report: stream(
        "WMOJ-JAILRUN v1 exit=3 signal=6 cpu_us=12500 maxrss_kb=4096 wall_us=31700\n",
      ),
    }),
  );
  // 12500us -> 13ms and 31700us -> 32ms: rounded, not truncated. A
  // sub-millisecond program must not report 0ms of CPU, because `cpuMs`
  // being 0 everywhere is the signature of the accounting regression.
  assert.equal(run.cpuMs, 13);
  assert.equal(run.maxRssKb, 4096);
  assert.equal(run.jailWallMs, 32);
  assert.equal(run.nsjailExit, 3);
  assert.equal(run.nsjailSignal, 6);
  assert.equal(run.parentWallMs, 40);
});

test("a missing report after a forced kill is a measurement with the report fields ABSENT", () => {
  // Not zeroed. `cpuMs: 0` and "we never measured cpuMs" are different
  // facts, and collapsing them is exactly how the nsjail-3.3 accounting
  // regression stayed invisible for the life of the pin.
  const run = runOf(
    rawRun({ code: null, report: stream(""), forcedKill: true, killedByTimer: true }),
  );
  assert.equal("cpuMs" in run, false);
  assert.equal("maxRssKb" in run, false);
  assert.equal("jailWallMs" in run, false);
  assert.equal("nsjailExit" in run, false);
  assert.equal("nsjailSignal" in run, false);
  assert.equal(run.cpuMs, undefined);
  assert.equal(run.nodeTimerFired, true);
  assert.equal(run.parentWallMs, 40);
});

test("the node timer and the runner's signal are carried through verbatim", () => {
  const run = runOf(rawRun({ signal: "SIGKILL", code: null }));
  assert.equal(run.runnerSignal, "SIGKILL");
  assert.equal(run.exitCode, null);
  assert.equal(run.nodeTimerFired, false);
});

test("NUL bytes in the child's output become U+FFFD on both streams", () => {
  // U+0000 is valid UTF-8 and survives `toString`, and `wmoj-app` stores
  // these strings in a PostgreSQL jsonb column that cannot represent a
  // NUL escape — so the row is silently never persisted and the student
  // gets no history, no points and no error.
  const nul = String.fromCharCode(0);
  const run = runOf(
    rawRun({ out: stream(`a${nul}b`), err: stream(`c${nul}`) }),
  );
  assert.equal(run.stdout, "a�b");
  assert.equal(run.stderr, "c�");
  assert.equal(run.stdout.includes(nul), false);
});

test("a malformed UTF-8 sequence becomes U+FFFD rather than throwing", () => {
  const run = runOf(
    rawRun({ out: { chunks: [Buffer.from([0xe2, 0x82])], bytes: 2, truncated: false } }),
  );
  assert.equal(run.stdout, "�");
});

test("truncation on either stream sets the single truncated flag", () => {
  assert.equal(runOf(rawRun()).truncated, false);
  assert.equal(runOf(rawRun({ out: stream("x", true) })).truncated, true);
  assert.equal(runOf(rawRun({ err: stream("x", true) })).truncated, true);
  assert.equal(
    runOf(rawRun({ out: stream("x", true), err: stream("y", true) })).truncated,
    true,
  );
});

test("the streams are decoded once, across chunk boundaries", () => {
  // Decoding per chunk turns a multi-byte sequence straddling a boundary
  // into U+FFFD on both sides. `é` is 0xC3 0xA9.
  const run = runOf(
    rawRun({
      out: { chunks: [Buffer.from([0xc3]), Buffer.from([0xa9])], bytes: 2, truncated: false },
    }),
  );
  assert.equal(run.stdout, "é");
});

// ---------------------------------------------------------------------
// The report parser itself
// ---------------------------------------------------------------------

test("parseJailRunReport returns undefined when nothing was written", () => {
  assert.equal(parseJailRunReport(""), undefined);
  assert.equal(parseJailRunReport("unrelated noise\n"), undefined);
});

test("parseJailRunReport reads a negative nsjail exit (nsjail itself was signalled)", () => {
  const parsed = parseJailRunReport(
    "WMOJ-JAILRUN v1 exit=-1 signal=9 cpu_us=0 maxrss_kb=1 wall_us=0\n",
  );
  assert.ok(parsed !== undefined && parsed.ok);
  assert.equal(parsed.value.exit, -1);
  assert.equal(parsed.value.signal, 9);
  assert.equal(parsed.value.cpuMs, 0);
});

test("parseJailRunReport surfaces the runner's own error form", () => {
  const parsed = parseJailRunReport("WMOJ-JAILRUN v1 error=exec errno=2\n");
  assert.ok(parsed !== undefined && !parsed.ok);
  assert.equal(parsed.error, "jail runner failed at exec (errno 2)");
});
