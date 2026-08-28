import { createUidPool } from "../sandbox/uidPool";
import { config } from "../config";

/**
 * Process-wide UID pool singleton, and the judge's true concurrency
 * ceiling: it is the one throttle that covers both gated endpoints.
 *
 * Its only consumer is the workspace lease (`src/workspace`), which
 * acquires a slot for the life of a submission and releases it in a
 * `finally`. The two convenience re-exports that used to live here went
 * with the hand-assembled leases in the routes: a slot is never held
 * without the directory and the in-flight bracket that go with it, so
 * there is nothing left to acquire one on its own for.
 */
export const uidPool = createUidPool(config.UID_POOL_SIZE);
