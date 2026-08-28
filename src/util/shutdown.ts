import type { Server } from "http";
import { promises as fs } from "fs";
import { logger, flushLogger } from "./logger";
import { listActiveWorkdirs } from "./workdir";
import { stopCompileCache } from "../cache/compileCache";

/**
 * Whole-drain budget, measured from the moment the signal arrives —
 * NOT a per-step timeout.
 *
 * Render sends SIGTERM and SIGKILLs 30s later. Everything after the
 * drain (the workdir sweep, then flushing pino) still has to fit inside
 * that window, so the budget stops at 25s to leave ~5s of slack. The
 * previous 29s left one second for both, and was applied to only one
 * step of the ladder anyway.
 */
const DRAIN_BUDGET_MS = 25_000;

/**
 * Tracks in-flight judging work. Shutdown waits for this to hit zero or
 * for the drain budget to run out, whichever comes first.
 *
 * Incremented twice per judged request, by two brackets that answer
 * different questions:
 *
 *  - the `countInFlight` gate in `server.ts`, mounted on `/submit` and
 *    `/generate-tests` only so `/health` probes and unmatched paths
 *    never hold a deploy open. It keys on the response lifecycle, so it
 *    drops its count when the *client* disconnects — which a `curl`
 *    that gives up fires while the sandbox is still running.
 *  - `withWorkspace` (`src/workspace`), which brackets the JUDGING
 *    itself: the lease of a directory, a pool slot and this counter.
 *
 * Double-counting is deliberate and safe: the drain waits for the
 * counter to reach zero, so two brackets simply make it wait for the
 * later of the two — which is the workspace's, and is the one that must
 * not be interrupted mid-run.
 */
let inFlight = 0;
let draining = false;
const drainWaiters: Array<() => void> = [];

export function enterRequest(): void {
  inFlight += 1;
}

export function exitRequest(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0 && draining) {
    while (drainWaiters.length > 0) {
      const w = drainWaiters.shift();
      if (w) w();
    }
  }
}

export function isDraining(): boolean {
  return draining;
}

/**
 * How much judging work is in flight right now.
 *
 * Read by `test/unit/workspace.test.ts`, which asserts that a lease
 * brackets this counter on both the success and the throw path — the
 * property that makes a SIGTERM during a long submission wait for the
 * grading instead of for the client's socket.
 */
export function inFlightCount(): number {
  return inFlight;
}

/** Resolves once `inFlight` reaches zero. */
function drainToZero(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    drainWaiters.push(resolve);
  });
}

/**
 * Resolve `true` if `p` settles within `ms`, `false` when the deadline
 * expires first.
 *
 * The timer is always cleared: an uncleared `setTimeout` from a race
 * that the other side won keeps the event loop alive for the remainder
 * of the budget, which on the fast path is the difference between a
 * deploy that finishes immediately and one that sits for 25s.
 */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([p.then(() => true), expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Install SIGTERM/SIGINT handlers that gracefully shut the judge
 * down:
 *   1. Flip `draining` so both judging routes 503 new requests
 *      (caller's responsibility to check `isDraining()`), and stamp a
 *      single deadline that every step below is measured against.
 *   2. Stop accepting new connections, and drop the ones already idle.
 *   3. Wait for both the server to close and the in-flight counter to
 *      hit zero — bounded by the deadline, then forced.
 *   4. Remove every tracked workdir.
 *   5. Stop the compile cache's eviction timer.
 *   6. Flush the logger.
 *   7. exit(0).
 *
 * Why one deadline rather than a timeout per step: `server.close()`'s
 * callback fires only once every connection with an in-flight request
 * has ended — which is every `/submit`, and a 200-case submission runs
 * serially for minutes. Awaiting it unbounded *before* starting the
 * drain timer, as this used to, made the entire ladder below it
 * unreachable: by the time the timer started, `inFlight` was already
 * zero. Render then SIGKILLed at 30s, so the workdir sweep and the log
 * flush never ran and every deploy under load leaked workdirs and
 * truncated its own logs.
 *
 * Note the sweep at step 4 deletes the workdirs of any submission still
 * running when the budget expires. In Docker that is moot — Node is PID
 * 1, so `process.exit(0)` takes the children with it — but properly
 * closing that gap means signalling the sandbox layer to kill live
 * children first, which is a change to `sandbox/nsjail.ts`.
 *
 * Called once at boot by server.ts.
 */
export function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A second Ctrl-C means "I am done waiting". Swallowing it left
      // the operator with no way out of a stuck drain short of SIGKILL.
      logger.warn({ signal }, "shutdown: second signal; exiting immediately");
      await flushLogger();
      process.exit(1);
    }
    shuttingDown = true;
    draining = true;
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    logger.info(
      { signal, budgetMs: DRAIN_BUDGET_MS, inFlight },
      "shutdown: received signal; draining",
    );

    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // Node 19+ already drops idle keep-alive sockets on close(); this is
    // for connections that go idle *during* the drain, which close()
    // would otherwise keep waiting on.
    server.closeIdleConnections();

    const drained = await settlesWithin(
      Promise.all([closed, drainToZero()]),
      remaining(),
    );

    if (!drained) {
      logger.warn(
        { inFlight },
        "shutdown: drain budget exhausted; forcing connections closed",
      );
      // Without this the sockets of the requests we just gave up on stay
      // open until SIGKILL, so the client never learns the judge is
      // going away.
      server.closeAllConnections();
    }

    const dirs = listActiveWorkdirs();
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (err) {
          logger.warn({ err, dir }, "shutdown: failed to clean workdir");
        }
      }),
    );

    stopCompileCache();
    logger.info(
      { cleanedWorkdirs: dirs.length, drained },
      "shutdown: done; exiting",
    );
    await flushLogger();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
