import { createUidPool } from "../sandbox/uidPool";
import { config } from "../config";

/**
 * Process-wide UID pool singleton. Every route that spawns user code
 * (/submit, /generate-tests) pulls its pool UID from here so the pool
 * size is honored across all concurrent requests.
 *
 * The pool itself lives in `src/sandbox/uidPool.ts` (teammate A); this
 * module just constructs the single instance at import time so callers
 * don't have to juggle it.
 */
export const uidPool = createUidPool(config.UID_POOL_SIZE);

/** Convenience re-export so callers don't go through `uidPool.` twice. */
export const acquireUid = (): Promise<number> => uidPool.acquire();

/** Convenience re-export matching `acquireUid`. */
export const releaseUid = (uid: number): void => uidPool.release(uid);
