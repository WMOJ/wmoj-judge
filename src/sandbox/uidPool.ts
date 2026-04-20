import type { UidPool } from "../types";

/**
 * First UID in the judge-user pool. The Dockerfile creates system users
 * `judge-1000`..`judge-1000+size-1` with matching numeric UIDs. Kept in
 * sync with the Dockerfile's `useradd` loop.
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
export function createUidPool(size: number): UidPool {
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

  function release(uid: number): void {
    if (!busy.has(uid)) {
      // Double-release or release of a UID we never owned — ignore.
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
