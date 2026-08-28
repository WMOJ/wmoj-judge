import test from "node:test";
import assert from "node:assert/strict";
import { createUidPool } from "../../src/sandbox/uidPool";
import { logger } from "../../src/util/logger";

/**
 * The UID pool is the judge's true concurrency ceiling — it is the only
 * throttle that covers BOTH gated endpoints — so an accounting drift here
 * shrinks the judge permanently with no other symptom. These tests pin
 * the two properties that keep the count honest: hand-off is FIFO, and a
 * release of a UID that is not checked out changes nothing but a log line.
 *
 * The UIDs themselves are not asserted beyond their identity: nsjail is
 * invoked without `--user`, so every submission runs as UID 1000 whatever
 * the pool hands out, and the numbers are a concurrency token today.
 */

/** Marker for "this promise has not settled yet". */
const PENDING = Symbol("pending");

/**
 * Resolve to the promise's value if it settles within one macrotask, or
 * to `PENDING`. `setImmediate` fires after the microtask queue drains, so
 * an `acquire()` that resolved from the available list has always won the
 * race by then.
 */
function raceToPending<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    p,
    new Promise<typeof PENDING>((resolve) => {
      setImmediate(() => resolve(PENDING));
    }),
  ]);
}

interface WarnSpy {
  calls: number;
  restore(): void;
}

/**
 * Temporarily replace `logger.warn`. The pool's only observable reaction
 * to a bogus release is that warning, so a test that did not assert it
 * could not tell "ignored" from "silently corrupted".
 */
function spyOnWarn(): WarnSpy {
  const original = logger.warn;
  const spy: WarnSpy = {
    calls: 0,
    restore(): void {
      logger.warn = original;
    },
  };
  logger.warn = ((): void => {
    spy.calls += 1;
  }) as typeof logger.warn;
  return spy;
}

test("size must be a positive integer", () => {
  assert.throws(() => createUidPool(0), /uidPool size must be a positive integer, got 0/);
  assert.throws(() => createUidPool(-1), /uidPool size must be a positive integer, got -1/);
  assert.throws(() => createUidPool(1.5), /uidPool size must be a positive integer, got 1.5/);
  assert.throws(() => createUidPool(Number.NaN), /uidPool size must be a positive integer/);
});

test("a pool of size n hands out n distinct UIDs before it blocks", async () => {
  const pool = createUidPool(3);
  const uids = [await pool.acquire(), await pool.acquire(), await pool.acquire()];

  assert.deepEqual(uids, [1000, 1001, 1002]);
  assert.equal(new Set(uids).size, 3);
  assert.equal(await raceToPending(pool.acquire()), PENDING);
});

test("a second acquire resolves only after a release", async () => {
  const pool = createUidPool(1);
  const first = await pool.acquire();
  assert.equal(first, 1000);

  const second = pool.acquire();
  assert.equal(await raceToPending(second), PENDING);

  pool.release(first);
  assert.equal(await second, 1000);
});

test("waiters are served in FIFO order", async () => {
  const pool = createUidPool(1);
  const held = await pool.acquire();

  const served: string[] = [];
  const first = pool.acquire().then((uid) => {
    served.push("first");
    return uid;
  });
  const second = pool.acquire().then((uid) => {
    served.push("second");
    return uid;
  });
  const third = pool.acquire().then((uid) => {
    served.push("third");
    return uid;
  });

  // Each step uses `raceToPending` so a LIFO pool FAILS here rather than
  // leaving `await first` unresolved forever — node:test has no default
  // timeout, and a hung suite is a worse signal than a red one.
  pool.release(held);
  assert.equal(await raceToPending(first), held);
  assert.deepEqual(served, ["first"]);

  pool.release(held);
  assert.equal(await raceToPending(second), held);
  assert.deepEqual(served, ["first", "second"]);

  pool.release(held);
  assert.equal(await raceToPending(third), held);
  assert.deepEqual(served, ["first", "second", "third"]);
});

test("releasing an idle UID twice is ignored, warns, and does not duplicate it", async () => {
  const spy = spyOnWarn();
  try {
    const pool = createUidPool(1);
    const uid = await pool.acquire();
    pool.release(uid);
    assert.equal(spy.calls, 0, "the first release is legitimate");

    pool.release(uid);
    assert.equal(spy.calls, 1, "the second release is the tripwire");

    // The corruption this guards against is the UID being handed to two
    // holders at once: if the double release had pushed it back onto
    // `available` a second time, both acquires below would resolve.
    assert.equal(await pool.acquire(), uid);
    assert.equal(await raceToPending(pool.acquire()), PENDING);
  } finally {
    spy.restore();
  }
});

test("releasing a UID the pool never issued is ignored and warns", async () => {
  const spy = spyOnWarn();
  try {
    const pool = createUidPool(1);
    pool.release(4242);
    assert.equal(spy.calls, 1);

    // Occupancy is untouched: the pool still has exactly its one UID.
    assert.equal(await pool.acquire(), 1000);
    assert.equal(await raceToPending(pool.acquire()), PENDING);
  } finally {
    spy.restore();
  }
});

test("a released UID is reusable once the pool is idle again", async () => {
  const pool = createUidPool(2);
  const a = await pool.acquire();
  const b = await pool.acquire();
  pool.release(a);
  pool.release(b);

  // Order is the release order, not the original issue order — the pool
  // is a queue, and nothing depends on which number comes back first.
  const reissued = [await pool.acquire(), await pool.acquire()];
  assert.deepEqual(reissued.sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
});
