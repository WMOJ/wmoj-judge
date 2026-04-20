import pLimit from "p-limit";
import type { WorkerPool } from "../types";

/**
 * Create a per-submission worker pool. `task` functions submitted via
 * `run` are scheduled with at most `n` executing concurrently. Ordering
 * of `run` return values is preserved in the order tasks were submitted.
 *
 * Thin wrapper over `p-limit` so the rest of the codebase depends on
 * the `WorkerPool` interface from `types.ts` rather than on p-limit's API.
 */
export function createPool(n: number): WorkerPool {
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`createPool: invalid concurrency ${n}`);
  }
  const limit = pLimit(n);
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return limit(task);
    },
  };
}
