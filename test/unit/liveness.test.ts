import test from "node:test";
import assert from "node:assert/strict";
import { createLiveness, type LivenessCheck } from "../../src/liveness";

/**
 * The scheduling half of liveness, with fake checks and an injected clock:
 * which cadence runs when, that concurrent refreshes share one round, that
 * a slow failure outlives fast refreshes, and that boot runs everything
 * and names every failure. The production checks themselves need a
 * container and are exercised end to end, not here.
 */

const FAST = 30_000;
const SLOW = 300_000;

interface FakeCheck extends LivenessCheck {
  calls: number;
  /** What the next run answers; reassign to change the answer. */
  answer: string | null;
}

function fake(name: string, cadence: "fast" | "slow", answer: string | null = null): FakeCheck {
  const check: FakeCheck = {
    name,
    cadence,
    calls: 0,
    answer,
    async run(): Promise<string | null> {
      check.calls += 1;
      return check.answer;
    },
  };
  return check;
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test("before the first refresh there is no snapshot", () => {
  const live = createLiveness([fake("a", "fast")], { now: clock().now });
  assert.equal(live.snapshot(), null);
});

test("the first refresh runs both cadences; a second one inside the fast TTL runs nothing", async () => {
  const c = clock();
  const fastCheck = fake("tool", "fast");
  const slowCheck = fake("measure", "slow");
  const live = createLiveness([fastCheck, slowCheck], { now: c.now });

  const first = await live.refresh();
  assert.deepEqual(first, { ok: true, failures: [], checkedAt: { fast: c.now(), slow: c.now() } });
  assert.equal(fastCheck.calls, 1);
  assert.equal(slowCheck.calls, 1);

  c.advance(FAST - 1);
  await live.refresh();
  assert.equal(fastCheck.calls, 1, "inside the fast TTL nothing re-runs");
  assert.equal(slowCheck.calls, 1);
});

test("after the fast TTL only fast checks re-run; after the slow TTL both do", async () => {
  const c = clock();
  const fastCheck = fake("tool", "fast");
  const slowCheck = fake("measure", "slow");
  const live = createLiveness([fastCheck, slowCheck], { now: c.now });
  await live.refresh();

  c.advance(FAST);
  const afterFast = await live.refresh();
  assert.equal(fastCheck.calls, 2);
  assert.equal(slowCheck.calls, 1, "the slow cadence is not due yet");
  assert.equal(afterFast.checkedAt.fast, c.now());
  assert.equal(afterFast.checkedAt.slow, c.now() - FAST);

  c.advance(SLOW - FAST);
  const afterSlow = await live.refresh();
  assert.equal(fastCheck.calls, 3);
  assert.equal(slowCheck.calls, 2);
  assert.equal(afterSlow.checkedAt.slow, c.now());
});

test("the TTLs are configurable", async () => {
  const c = clock();
  const fastCheck = fake("tool", "fast");
  const slowCheck = fake("measure", "slow");
  const live = createLiveness([fastCheck, slowCheck], { now: c.now, fastTtlMs: 10, slowTtlMs: 100 });
  await live.refresh();
  c.advance(10);
  await live.refresh();
  assert.deepEqual([fastCheck.calls, slowCheck.calls], [2, 1]);
  c.advance(90);
  await live.refresh();
  assert.deepEqual([fastCheck.calls, slowCheck.calls], [3, 2]);
});

test("two concurrent refreshes share one round per cadence", async () => {
  const c = clock();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fastCheck = fake("tool", "fast");
  fastCheck.run = async (): Promise<string | null> => {
    fastCheck.calls += 1;
    await gate;
    return null;
  };
  const slowCheck = fake("measure", "slow");
  const live = createLiveness([fastCheck, slowCheck], { now: c.now });

  const a = live.refresh();
  const b = live.refresh();
  assert.equal(fastCheck.calls, 1, "the second caller joined the round in flight");
  assert.equal(slowCheck.calls, 1);
  release?.();
  const [snapA, snapB] = await Promise.all([a, b]);
  assert.deepEqual(snapA, snapB);
  assert.equal(fastCheck.calls, 1);
});

test("a slow failure persists across fast refreshes until the slow cadence re-runs", async () => {
  const c = clock();
  const fastCheck = fake("tool", "fast");
  const slowCheck = fake("measure", "slow", "cpuMs=0 -- resource accounting is broken");
  const live = createLiveness([fastCheck, slowCheck], { now: c.now });

  const first = await live.refresh();
  assert.equal(first.ok, false);
  assert.deepEqual(first.failures, ["measure: cpuMs=0 -- resource accounting is broken"]);

  slowCheck.answer = null; // the reporter recovers…
  c.advance(FAST);
  const stillDegraded = await live.refresh();
  assert.equal(stillDegraded.ok, false, "…but only the fast cadence was due");
  assert.equal(slowCheck.calls, 1);

  c.advance(SLOW);
  const recovered = await live.refresh();
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.failures, []);
  assert.equal(slowCheck.calls, 2);
});

test("failures are merged fast-first with 'name: reason' wording", async () => {
  const live = createLiveness(
    [fake("g++", "fast", "exit 127"), fake("sandbox-measures", "slow", "graded AC instead of TLE")],
    { now: clock().now },
  );
  const snapshot = await live.refresh();
  assert.deepEqual(snapshot.failures, ["g++: exit 127", "sandbox-measures: graded AC instead of TLE"]);
});

test("assertAtBoot runs every check regardless of TTL and throws naming every failure", async () => {
  const c = clock();
  const fastOk = fake("python3", "fast");
  const fastBad = fake("pypy3", "fast", "timeout");
  const slowBad = fake("sandbox-measures", "slow", "cpuMs=0");
  const live = createLiveness([fastOk, fastBad, slowBad], { now: c.now });

  await live.refresh(); // nothing is due after this…
  await assert.rejects(
    () => live.assertAtBoot(), // …and boot must run everything anyway
    { message: "runtime degraded: pypy3: timeout, sandbox-measures: cpuMs=0" },
  );
  assert.deepEqual([fastOk.calls, fastBad.calls, slowBad.calls], [2, 2, 2]);
  assert.equal(live.snapshot()?.ok, false);
});

test("assertAtBoot resolves and leaves a healthy snapshot when every check passes", async () => {
  const live = createLiveness([fake("a", "fast"), fake("b", "slow")], { now: clock().now });
  await live.assertAtBoot();
  assert.equal(live.snapshot()?.ok, true);
});

test("a check that rejects is reported as a failure with its message, never propagated", async () => {
  const live = createLiveness(
    [
      fake("ok", "fast"),
      {
        name: "spawn",
        cadence: "fast",
        run: (): Promise<string | null> => Promise.reject(new Error("ENOMEM")),
      },
    ],
    { now: clock().now },
  );
  const snapshot = await live.refresh();
  assert.deepEqual(snapshot, {
    ok: false,
    failures: ["spawn: ENOMEM"],
    checkedAt: snapshot.checkedAt,
  });
});
