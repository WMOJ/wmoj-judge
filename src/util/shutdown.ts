import type { Server } from "http";
import { promises as fs } from "fs";
import { logger, flushLogger } from "./logger";
import { listActiveWorkdirs } from "./workdir";

/**
 * Hard ceiling on how long we wait for in-flight requests to finish
 * after SIGTERM. Render typically sends SIGTERM then SIGKILLs 30s
 * later; give us one second of slack under that.
 */
const DRAIN_TIMEOUT_MS = 29_000;

/**
 * Tracks the number of in-flight /submit / /generate-tests calls.
 * Routes call `enterRequest()` at the start and `exitRequest()` at
 * the end (in a finally block). Shutdown waits until this is zero or
 * the drain timeout elapses.
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
 * Install SIGTERM/SIGINT handlers that gracefully shut the judge
 * down:
 *   1. Stop the HTTP server from accepting new connections.
 *   2. Flip `draining` so the /submit route can 503 new requests
 *      (caller's responsibility to check `isDraining()`).
 *   3. Wait for the in-flight counter to hit zero, up to DRAIN_TIMEOUT_MS.
 *   4. Remove every tracked workdir.
 *   5. Flush the logger.
 *   6. exit(0).
 *
 * Called once at boot by server.ts.
 */
export function installShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true;
    logger.info({ signal }, "shutdown: received signal; draining");

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (inFlight > 0) {
      logger.info({ inFlight }, "shutdown: waiting for in-flight requests");
      await Promise.race([
        new Promise<void>((resolve) => drainWaiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
      ]);
    }

    if (inFlight > 0) {
      logger.warn(
        { inFlight },
        "shutdown: drain timeout reached; proceeding with cleanup",
      );
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

    logger.info({ cleanedWorkdirs: dirs.length }, "shutdown: done; exiting");
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
