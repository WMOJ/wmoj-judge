import { logger } from "../util/logger";

/**
 * First UID in the judge-user pool.
 *
 * These numbers are **not** currently used as real UIDs. nsjail is
 * invoked without `--user`/`--group` (it cannot drop privileges in a
 * container with no CAP_SETUID), so every submission runs as UID 1000 —
 * the same UID as the Node process — and the pool is purely a
 * concurrency gate. See `sandbox-changes` before that changes.
 *
 * The Dockerfile's `useradd` loop is meant to create `judge-1000` …
 * `judge-1000+size-1`, but `node:20-trixie-slim` already owns UID 1000
 * as its `node` user, so the first iteration fails "UID 1000 is not
 * unique" and `judge-1000` — the account `BASE_UID` names — does not
 * exist. Nothing depends on it today. `UID_POOL_SIZE` above 16 likewise
 * hands out numbers with no matching accounts.
 */
const BASE_UID = 1000;

type Waiter = (uid: number) => void;

/**
 * Create a UID pool of `size` unprivileged judge UIDs, starting at
 * `BASE_UID`. `acquire()` hands out a UID; `release(uid)` returns it.
 * When every UID is busy, `acquire()` awaits a FIFO waiter queue and
 * resolves once another caller releases a UID.
 *
 * The pool is purely in-process: it tracks which UIDs are marked busy
 * in a Set and does not perform any kernel-level locking. Two processes
 * sharing the same host would collide, but the judge runs one Node
 * process per container so that is not a concern.
 */
export function createUidPool(size: number): {
  acquire: () => Promise<number>;
  release: (uid: number) => void;
} {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`uidPool size must be a positive integer, got ${size}`);
  }

  const all: number[] = [];
  for (let i = 0; i < size; i += 1) all.push(BASE_UID + i);

  const available: number[] = [...all];
  const busy = new Set<number>();
  const waiters: Waiter[] = [];

  function acquire(): Promise<number> {
    const next = available.shift();
    if (next !== undefined) {
      busy.add(next);
      return Promise.resolve(next);
    }
    return new Promise<number>((resolve) => {
      waiters.push(resolve);
    });
  }

  /**
   * Return a UID to the pool, handing it straight to the longest-waiting
   * `acquire()` if there is one.
   *
   * The `busy` check catches a release of a UID this pool never issued,
   * and a double-release that happens while the UID is **idle**. It does
   * NOT catch a double-release once the UID has been handed to a waiter:
   * the hand-off re-adds it to `busy` for the new holder, so a second
   * `release(uid)` from the previous holder passes the check and issues
   * the same UID to a third caller — two holders of one UID, and a pool
   * whose occupancy count is corrupt for the life of the process. The
   * check is value-based and there is nothing in a bare `number` to
   * identify *who* is releasing; closing that gap means `acquire()`
   * returning an opaque lease (`{uid, release()}`) so a stale release is
   * identity-checked, which is a change to the shape this factory
   * returns.
   *
   * Not reachable today: both call sites (`routes/submit.ts`,
   * `routes/generateTests.ts`) release exactly once, in a `finally`. The
   * `warn` below is the tripwire for the half that *is* detectable —
   * this pool is the judge's true concurrency ceiling, so a silent
   * accounting drift here shrinks it permanently with no other symptom.
   */
  function release(uid: number): void {
    if (!busy.has(uid)) {
      logger.warn(
        { uid },
        "uidPool: release of a UID that is not checked out — ignoring",
      );
      return;
    }
    busy.delete(uid);

    const next = waiters.shift();
    if (next !== undefined) {
      busy.add(uid);
      next(uid);
      return;
    }
    available.push(uid);
  }

  return { acquire, release };
}
