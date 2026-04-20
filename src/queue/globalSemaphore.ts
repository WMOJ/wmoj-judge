import pLimit from "p-limit";
import { config } from "../config";

/**
 * Global cap on in-flight /submit requests. Exactly one instance lives
 * for the lifetime of the process. Acquire via `submitSemaphore(fn)` —
 * if the cap is reached, further callers queue until a slot frees up.
 *
 * This is distinct from the per-submission worker pool in workerPool.ts:
 * that one bounds test-case parallelism *within* one submission;
 * this one bounds how many submissions run at all.
 */
export const submitSemaphore = pLimit(config.GLOBAL_SUBMIT_CONCURRENCY);
