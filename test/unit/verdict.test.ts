import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { RunMeasurement } from "../../src/types";
import { compare } from "../../src/compare";
import { gradeCase, type CaseLimits, type Judge } from "../../src/verdict";

/**
 * The kill ladder and the verdict ordering, exercised without a kernel.
 *
 * Every branch of the ladder is a fact about Linux — what `RLIMIT_CPU`
 * does when soft equals hard, what `RLIMIT_AS` does to a `new[]` too big
 * to satisfy, what nsjail puts in its exit status when the child dies by
 * a signal. Inventing those numbers in a test would be inventing the
 * answer along with them, so they come from
 * `test/fixtures/measurements/`, captured by `dist/tools/
 * captureMeasurements.js` inside the image on the x86_64 CI runner where
 * RLIMIT_AS and seccomp are real.
 *
 * Two kinds of case here, and they cover different things:
 *
 *  - **Fixture replay** proves `gradeCase` still produces exactly the
 *    `TestResult` a real run produced. It is the regression net.
 *  - **Ladder ordering** proves the STEPS are in the right order, by
 *    taking a captured fixture and changing one field. The order is
 *    load-bearing twice over — step 3 after step 2 keeps a program that
 *    finished but overspent a TLE, step 5 after step 3 keeps a solution
 *    that used its whole budget and exited cleanly an AC — and both are
 *    bugs that have already been fixed once. A replay alone cannot catch
 *    a reordering, because no real program sits on the boundary.
 */

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "measurements");
const DERIVED_DIR = path.join(FIXTURES_DIR, "derived");

/**
 * One captured (or derived) measurement fixture, narrowed to the fields
 * this suite reads. The file also carries `intended`, `note` and
 * `requires` for a human; the assertion here is `result`.
 */
interface MeasurementFixture {
  name: string;
  limits: CaseLimits;
  expected: string;
  run: RunMeasurement;
  /**
   * The recorded `TestResult`, kept as a plain record: it is only ever
   * deep-equalled against a freshly graded one, and typing it as
   * `TestResult` would need a cast that asserts the very shape this
   * suite exists to verify.
   */
  result: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one required number, naming the field when it is not one. */
function num(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`${where}: '${key}' must be a number`);
  }
  return value;
}

/** Read one optional number. Absent stays absent — that is the fact. */
function optionalNum(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number | undefined {
  if (!(key in source)) return undefined;
  return num(source, key, where);
}

/**
 * Build a `RunMeasurement` from parsed JSON, field by field.
 *
 * Deliberately not a cast. A fixture whose `run` lost its `exitCode`
 * would replay as `exitCode: undefined` and grade something that never
 * happened, on a suite that looked green; naming each field is what turns
 * a corrupt file into a message that says which field and which file.
 * `runnerSignal` is the one narrowing that cannot be exhaustive —
 * `NodeJS.Signals` is a literal union of every signal name — so it is
 * checked as a string and asserted, which is as far as JSON can be
 * validated without restating the kernel's signal table here.
 */
function narrowRun(value: unknown, where: string): RunMeasurement {
  if (!isRecord(value)) throw new Error(`${where}: 'outcome.run' is not an object`);
  const exitCode = value.exitCode;
  if (!(typeof exitCode === "number" || exitCode === null)) {
    throw new Error(`${where}: 'exitCode' must be a number or null`);
  }
  const rawSignal = value.runnerSignal;
  if (!(typeof rawSignal === "string" || rawSignal === null)) {
    throw new Error(`${where}: 'runnerSignal' must be a string or null`);
  }
  const stdout = value.stdout;
  const stderr = value.stderr;
  const truncated = value.truncated;
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new Error(`${where}: 'stdout'/'stderr' must be strings`);
  }
  if (typeof truncated !== "boolean") {
    throw new Error(`${where}: 'truncated' must be a boolean`);
  }
  const nodeTimerFired = value.nodeTimerFired;
  if (typeof nodeTimerFired !== "boolean") {
    throw new Error(`${where}: 'nodeTimerFired' must be a boolean`);
  }

  const run: RunMeasurement = {
    exitCode,
    runnerSignal: rawSignal === null ? null : (rawSignal as NodeJS.Signals),
    parentWallMs: num(value, "parentWallMs", where),
    nodeTimerFired,
    stdout,
    stderr,
    truncated,
  };
  // Assigned only when present: an absent `cpuMs` means no resource
  // report survived, and writing `undefined` into the key would make
  // `"cpuMs" in run` answer that question wrong.
  const cpuMs = optionalNum(value, "cpuMs", where);
  if (cpuMs !== undefined) run.cpuMs = cpuMs;
  const maxRssKb = optionalNum(value, "maxRssKb", where);
  if (maxRssKb !== undefined) run.maxRssKb = maxRssKb;
  const jailWallMs = optionalNum(value, "jailWallMs", where);
  if (jailWallMs !== undefined) run.jailWallMs = jailWallMs;
  const nsjailExit = optionalNum(value, "nsjailExit", where);
  if (nsjailExit !== undefined) run.nsjailExit = nsjailExit;
  const nsjailSignal = optionalNum(value, "nsjailSignal", where);
  if (nsjailSignal !== undefined) run.nsjailSignal = nsjailSignal;
  return run;
}

/**
 * Shape-check one parsed fixture. A hand-edited or half-written file must
 * name itself here rather than surface as a `Cannot read properties of
 * undefined` in the middle of an unrelated-looking assertion.
 */
function narrow(value: unknown, where: string): MeasurementFixture {
  if (!isRecord(value)) throw new Error(`${where}: not an object`);
  const { name, limits, expected, outcome, result } = value;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${where}: missing a string 'name'`);
  }
  if (!isRecord(limits)) throw new Error(`${where}: missing a 'limits' object`);
  if (typeof expected !== "string") {
    throw new Error(`${where}: missing a string 'expected'`);
  }
  // A judge fault is never a fixture: nothing of the program ran, so
  // there is no verdict to pin. `captureMeasurements` refuses to record
  // one, and a file carrying one is corrupt.
  if (!isRecord(outcome) || outcome.ok !== true) {
    throw new Error(`${where}: 'outcome' must be an ok:true run measurement`);
  }
  if (!isRecord(result) || typeof result.verdict !== "string") {
    throw new Error(`${where}: missing a 'result' with a verdict`);
  }
  return {
    name,
    limits: {
      timeLimitMs: num(limits, "timeLimitMs", where),
      memLimitMb: num(limits, "memLimitMb", where),
    },
    expected,
    run: narrowRun(outcome.run, where),
    result,
  };
}

function loadFrom(dir: string): MeasurementFixture[] {
  if (!existsSync(dir)) {
    throw new Error(
      `${dir} does not exist. The measurement fixtures are captured inside the ` +
        "image by dist/tools/captureMeasurements.js on the x86_64 CI runner; " +
        "the derived ones are hand-made from them. Without both directories " +
        "the kill ladder is not covered at all, so this suite fails rather " +
        "than passing on nothing.",
    );
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`${dir} contains no fixtures — see the message above.`);
  }
  return files.map((file) => {
    const full = path.join(dir, file);
    return narrow(JSON.parse(readFileSync(full, "utf8")), full);
  });
}

/** Captured fixtures only, keyed by name, for the ladder cases below. */
function captured(): Map<string, MeasurementFixture> {
  return new Map(loadFrom(FIXTURES_DIR).map((f) => [f.name, f]));
}

/**
 * The comparator every real WMOJ submission is graded with, and the one
 * `captureMeasurements` used, so a replay reproduces the recorded result.
 */
function trimTrailingJudge(expected: string): Judge {
  return async (received) => ({
    passed: compare("trim-trailing", expected, received),
  });
}

/** The measured numbers, which no two runs agree on. */
const MEASURED: readonly string[] = ["timeMs", "cpuMs", "memKb"];

function withoutMeasured(result: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...result };
  for (const key of MEASURED) delete copy[key];
  return copy;
}

/** A fixture's measurement, copied so a ladder case can mutate one field. */
function runOf(fixture: MeasurementFixture): RunMeasurement {
  return { ...fixture.run };
}

// ---------------------------------------------------------------------
// Fixture replay
// ---------------------------------------------------------------------

for (const dir of [FIXTURES_DIR, DERIVED_DIR]) {
  for (const fixture of loadFrom(dir)) {
    const kind = dir === DERIVED_DIR ? "derived" : "captured";
    test(`replay (${kind}): ${fixture.name} grades to its recorded TestResult`, async () => {
      const result = await gradeCase(
        {
          index: 0,
          expected: fixture.expected,
          run: fixture.run,
          limits: fixture.limits,
        },
        trimTrailingJudge(fixture.expected),
      );
      assert.deepEqual(withoutMeasured(result), withoutMeasured(fixture.result));

      // The measured numbers are not compared against the recording, but
      // they ARE compared against the measurement they must be copied
      // from. A `cpuMs` that silently became 0 for every case is the
      // regression that shipped and survived for the life of the nsjail
      // 3.3 pin, and it is invisible to a deep-equal that skips the field.
      const run = fixture.run;
      assert.equal(result.cpuMs, run.cpuMs ?? 0, "cpuMs");
      assert.equal(result.memKb, run.maxRssKb ?? 0, "memKb");
      assert.equal(result.timeMs, run.jailWallMs ?? run.parentWallMs, "timeMs");
    });
  }
}

// ---------------------------------------------------------------------
// Ladder ordering — one case per step, built by changing one field
// ---------------------------------------------------------------------

test("step 2 before step 3: exit 0 with cpuMs >= the limit is TO", async () => {
  // The program FINISHED, cleanly, and is still a TLE because it
  // overspent. If step 3 (the clean-exit guard) moved above step 2 this
  // would come back AC and every over-budget-but-correct solution would
  // pass.
  const fixture = captured().get("clean-exit");
  assert.ok(fixture, "the clean-exit fixture must exist");
  const run = runOf(fixture);
  run.cpuMs = fixture.limits.timeLimitMs;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "TLE");
  assert.equal(result.timedOut, true);
  assert.equal(result.passed, false);
});

test("step 2 is a floor, not a ceiling: one ms under the limit is not TO", async () => {
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.cpuMs = fixture.limits.timeLimitMs - 1;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "AC");
  assert.equal(result.timedOut, false);
});

test("step 3 before step 4: a clean exit with jailWall >= 3x the limit is not TO", async () => {
  // Wall time includes sleeping and blocked I/O, which is not the
  // program's cost. A correct solution that slept must stay AC.
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.cpuMs = 1;
  run.jailWallMs = fixture.limits.timeLimitMs * 3;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "AC");
  assert.equal(result.timedOut, false);
});

test("step 4: exit 1 with jailWall >= 3x the limit is TO", async () => {
  // The same wall backstop on a run the clean-exit guard does not catch:
  // a program blocked on syscalls burns no CPU, so only wall can see it.
  const fixture = captured().get("nonzero-exit");
  assert.ok(fixture, "the nonzero-exit fixture must exist");
  const run = runOf(fixture);
  run.exitCode = 1;
  run.cpuMs = 1;
  run.jailWallMs = fixture.limits.timeLimitMs * 3;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "TLE");
  assert.equal(result.timedOut, true);
});

test("step 5 after step 3: RSS at 99% of the cap on a clean exit is not OOM", async () => {
  // A solution that used its whole memory budget and exited cleanly fit
  // inside it by definition. Moving step 5 above step 3 makes every
  // tight-but-correct submission MLE.
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.maxRssKb = Math.floor(fixture.limits.memLimitMb * 1024 * 0.99);
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "AC");
});

test("step 5: RSS at 99% of the cap on a NON-clean exit is OOM, and therefore MLE", async () => {
  const fixture = captured().get("nonzero-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.maxRssKb = Math.floor(fixture.limits.memLimitMb * 1024 * 0.99);
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "MLE");
});

test("step 6: exit 152 with no report is TO — SIGXCPU is RLIMIT_CPU firing", async () => {
  // Nothing else to go on: no CPU number, no wall number, no runner
  // signal. Without the 128+n decode the ladder fell through to `null`
  // and a kernel SIGXCPU came back RE with `timedOut: false`.
  const fixture = captured().get("segfault");
  assert.ok(fixture, "the segfault fixture must exist");
  const run = runOf(fixture);
  run.exitCode = 128 + 24;
  delete run.cpuMs;
  delete run.maxRssKb;
  delete run.jailWallMs;
  run.parentWallMs = 10;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "TLE");
  assert.equal(result.timedOut, true);
  assert.equal(result.cpuMs, 0, "an absent cpuMs still reports 0 on the wire");
});

test("step 6: exit 137 inside budget is SIG, over budget is TO", async () => {
  // SIGKILL is ambiguous: it is nsjail's own wall backstop on a run that
  // already outlived its budget, and it is also what a program that
  // kills itself gets. The wall clock is what separates them.
  const fixture = captured().get("segfault");
  assert.ok(fixture);
  const limits = fixture.limits;

  const inside = runOf(fixture);
  inside.exitCode = 128 + 9;
  inside.cpuMs = 1;
  inside.jailWallMs = Math.floor(limits.timeLimitMs / 2);
  const insideResult = await gradeCase(
    { index: 0, expected: fixture.expected, run: inside, limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(insideResult.verdict, "RE");
  assert.equal(insideResult.timedOut, false);

  const over = runOf(fixture);
  over.exitCode = 128 + 9;
  over.cpuMs = 1;
  // Below 3x the limit, so step 4 cannot be what decides this.
  over.jailWallMs = limits.timeLimitMs * 2;
  const overResult = await gradeCase(
    { index: 0, expected: fixture.expected, run: over, limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(overResult.verdict, "TLE");
  assert.equal(overResult.timedOut, true);
});

test("step 6: any other signal is SIG, so RE with no timeout flag", async () => {
  const fixture = captured().get("segfault");
  assert.ok(fixture);
  for (const signal of [11, 6, 31]) {
    const run = runOf(fixture);
    run.exitCode = 128 + signal;
    run.cpuMs = 1;
    run.jailWallMs = 5;
    const result = await gradeCase(
      { index: 0, expected: fixture.expected, run, limits: fixture.limits },
      trimTrailingJudge(fixture.expected),
    );
    assert.equal(result.verdict, "RE", `signal ${String(signal)}`);
    assert.equal(result.timedOut, false);
  }
});

test("step 7: a signalled runner is SIG, and that is what stops it grading AC", async () => {
  // exitCode 0 WITH a runner signal is the only shape where step 7 changes
  // an answer: step 3's guard requires both, so this falls through to step
  // 7, and `SIG` is what makes `deriveVerdict` return RE instead of
  // grading the output of a process the kernel killed. Written with the
  // correct output on stdout so that without step 7 it would come back AC.
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.exitCode = 0;
  run.runnerSignal = "SIGTERM";
  run.cpuMs = 1;
  run.jailWallMs = 5;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.stdout, fixture.expected, "the output really does match");
  assert.equal(result.verdict, "RE");
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, false);
});

test("step 8: a null exit code grades RE and reports a null exitCode", async () => {
  // Honest about what this covers. Step 8 (`exitCode === null` -> SIG) is
  // currently REDUNDANT through `gradeCase`: `deriveVerdict`'s RE branch
  // already fires on `exitCode !== 0`, so removing step 8 changes no
  // verdict. It is kept because the kill class is the ladder's own output
  // and the liveness module reads it directly, and because "nothing ran"
  // being classified as nothing at all is a trap for the next reader. What
  // this case does pin is that a null exit survives the decoder and is
  // reported as `null` rather than coerced to a number.
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.exitCode = null;
  run.cpuMs = 1;
  run.jailWallMs = 5;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "RE");
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
});

test("step 1: the node timer wins over everything, including a clean exit", async () => {
  const fixture = captured().get("clean-exit");
  assert.ok(fixture);
  const run = runOf(fixture);
  run.nodeTimerFired = true;
  const result = await gradeCase(
    { index: 0, expected: fixture.expected, run, limits: fixture.limits },
    trimTrailingJudge(fixture.expected),
  );
  assert.equal(result.verdict, "TLE");
  assert.equal(result.timedOut, true);
});

// ---------------------------------------------------------------------
// Verdict ordering
// ---------------------------------------------------------------------

/** A measurement built from nothing, for the ordering cases. */
function measurement(overrides: Partial<RunMeasurement> = {}): RunMeasurement {
  return {
    exitCode: 0,
    runnerSignal: null,
    cpuMs: 1,
    maxRssKb: 1024,
    jailWallMs: 2,
    nsjailExit: 0,
    nsjailSignal: 0,
    parentWallMs: 5,
    nodeTimerFired: false,
    stdout: "",
    stderr: "",
    truncated: false,
    ...overrides,
  };
}

const LIMITS: CaseLimits = { timeLimitMs: 1000, memLimitMb: 256 };

/** A judge that records whether it was called, and with what. */
function spyJudge(
  answer: Awaited<ReturnType<Judge>> = { passed: true },
): { judge: Judge; calls: string[] } {
  const calls: string[] = [];
  return {
    judge: async (received) => {
      calls.push(received);
      return answer;
    },
    calls,
  };
}

test("TLE beats MLE: a timed-out run that also ran out of memory is TLE", async () => {
  const run = measurement({
    nodeTimerFired: true,
    exitCode: 134,
    stderr: "terminate called after throwing an instance of 'std::bad_alloc'\n",
    maxRssKb: 256 * 1024,
  });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.verdict, "TLE");
});

test("MLE beats RE: a refused allocation is not a runtime error", async () => {
  // The bug this ordering exists to prevent. `--rlimit_as` caps address
  // space, so `new` FAILS rather than the process being killed: the
  // program aborts by itself and exits non-zero, which is
  // indistinguishable from a crash unless stderr is read first.
  const run = measurement({
    exitCode: 134,
    stderr: "terminate called after throwing an instance of 'std::bad_alloc'\n",
  });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.verdict, "MLE");
});

test("RE beats IE: a crashed program never reaches the checker", async () => {
  const { judge, calls } = spyJudge({ checkerFailed: true });
  const run = measurement({ exitCode: 139 });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    judge,
  );
  assert.equal(result.verdict, "RE");
  assert.deepEqual(calls, [], "the judge must not be invoked on a crashed run");
});

test("IE beats WA/AC: a checker that could not answer on a clean run is IE", async () => {
  const run = measurement({ stdout: "anything\n" });
  const result = await gradeCase(
    { index: 0, expected: "expected\n", run, limits: LIMITS },
    async () => ({ checkerFailed: true, checkerMessage: "bad test data" }),
  );
  assert.equal(result.verdict, "IE");
  assert.equal(result.passed, false);
  assert.equal(result.checkerMessage, "bad test data");
});

test("a non-zero exit with matching output is RE and does not pass", async () => {
  // Correct output is not enough: `passed` requires the program to have
  // finished cleanly, and the judge is never asked.
  const { judge, calls } = spyJudge({ passed: true });
  const run = measurement({ exitCode: 7, stdout: "42\n" });
  const result = await gradeCase(
    { index: 0, expected: "42\n", run, limits: LIMITS },
    judge,
  );
  assert.equal(result.verdict, "RE");
  assert.equal(result.passed, false);
  assert.equal(result.received, "42\n");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------
// Judge invocation
// ---------------------------------------------------------------------

test("the judge is called exactly once, with the program's stdout, on a clean run", async () => {
  const { judge, calls } = spyJudge({ passed: false });
  const run = measurement({ stdout: "hello\n" });
  const result = await gradeCase(
    { index: 3, expected: "world\n", run, limits: LIMITS },
    judge,
  );
  assert.deepEqual(calls, ["hello\n"]);
  assert.equal(result.verdict, "WA");
  assert.equal(result.index, 3);
});

test("the judge is not called on a timed-out run", async () => {
  const { judge, calls } = spyJudge();
  const run = measurement({ nodeTimerFired: true });
  await gradeCase({ index: 0, expected: "", run, limits: LIMITS }, judge);
  assert.deepEqual(calls, []);
});

test("a throwing judge rejects gradeCase — the checker-sandbox judge fault path", async () => {
  // The route lets this propagate to its `catch`, which returns
  // `500 {error}`. Swallowing it here would turn the judge's own sandbox
  // breaking into a verdict billed to the problem or the student.
  const run = measurement({ stdout: "x\n" });
  await assert.rejects(
    gradeCase({ index: 0, expected: "x\n", run, limits: LIMITS }, async () => {
      throw new Error("checker sandbox failure on test case 0: boom");
    }),
    /checker sandbox failure on test case 0: boom/,
  );
});

// ---------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------

test("bad_alloc on stderr with exit 134 is MLE", async () => {
  const run = measurement({
    exitCode: 134,
    stderr: "terminate called after throwing an instance of 'std::bad_alloc'\n",
  });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.verdict, "MLE");
});

test("the same stderr with exit 0 is graded by the judge and is never MLE", async () => {
  // The clean-exit gate. A program that exit(0)'d fit inside its budget
  // however close it got — and it can legitimately print the word
  // "MemoryError" while doing so. Remove the gate and every such
  // submission starts failing MLE.
  for (const stderr of [
    "terminate called after throwing an instance of 'std::bad_alloc'\n",
    "MemoryError\n",
    "Killed\n",
  ]) {
    const run = measurement({ exitCode: 0, stderr, stdout: "42\n" });
    const result = await gradeCase(
      { index: 0, expected: "42\n", run, limits: LIMITS },
      trimTrailingJudge("42\n"),
    );
    assert.equal(result.verdict, "AC", stderr.trim());
  }
});

test("an OOM kill class is MLE regardless of stderr", async () => {
  // Reached through the ladder's RSS step, which is the only producer of
  // `OOM` — the kill class is internal, so this is how a test states it.
  const run = measurement({
    exitCode: 1,
    maxRssKb: Math.ceil(LIMITS.memLimitMb * 1024 * 0.98),
    stderr: "nothing about memory at all\n",
  });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.verdict, "MLE");
});

test("a plain segfault with low RSS and a quiet stderr stays RE", async () => {
  const run = measurement({ exitCode: 139, maxRssKb: 2048, stderr: "" });
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.verdict, "RE");
});

// ---------------------------------------------------------------------
// The TestResult shape
// ---------------------------------------------------------------------

test("truncated and checkerMessage are OMITTED, not falsy, when they do not apply", async () => {
  // An ordinary submission's response must stay byte-identical to what it
  // was before either field existed.
  const run = measurement({ stdout: "42\n" });
  const result = await gradeCase(
    { index: 0, expected: "42\n", run, limits: LIMITS },
    trimTrailingJudge("42\n"),
  );
  assert.equal("truncated" in result, false);
  assert.equal("checkerMessage" in result, false);
});

test("an empty checker message is omitted; a non-empty one is kept", async () => {
  const run = measurement({ stdout: "42\n" });
  const quiet = await gradeCase(
    { index: 0, expected: "42\n", run, limits: LIMITS },
    async () => ({ passed: true, checkerMessage: "" }),
  );
  assert.equal("checkerMessage" in quiet, false);

  const loud = await gradeCase(
    { index: 0, expected: "42\n", run, limits: LIMITS },
    async () => ({ passed: true, checkerMessage: "ok" }),
  );
  assert.equal(loud.checkerMessage, "ok");
});

test("truncated is carried through and does not change the verdict path", async () => {
  const run = measurement({ stdout: "42", truncated: true });
  const result = await gradeCase(
    { index: 0, expected: "42", run, limits: LIMITS },
    trimTrailingJudge("42"),
  );
  assert.equal(result.truncated, true);
  assert.equal(result.verdict, "AC");
});

test("a missing report reports zeros on the wire but never grades as if measured", async () => {
  const run = measurement({ nodeTimerFired: true, exitCode: null });
  delete run.cpuMs;
  delete run.maxRssKb;
  delete run.jailWallMs;
  const result = await gradeCase(
    { index: 0, expected: "", run, limits: LIMITS },
    trimTrailingJudge(""),
  );
  assert.equal(result.cpuMs, 0);
  assert.equal(result.memKb, 0);
  assert.equal(result.timeMs, run.parentWallMs);
  assert.equal(result.verdict, "TLE");
});
