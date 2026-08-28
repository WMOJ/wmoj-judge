import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import { liveness, type LivenessSnapshot } from "../liveness";

/**
 * The 503 body, in one place so the shape `wmoj-app` reads never drifts
 * between the draining, check-failure and caught-exception branches.
 *
 * `seccomp` reports whether the syscall filter is actually installed on every
 * run, additively — `status` and `version` are untouched, so no existing caller
 * changes. It is here because `UNSAFE_DISABLE_SECCOMP` is otherwise invisible
 * from outside the box: a judge running unfiltered answers `{"status":"ok"}`
 * exactly like a correctly sandboxed one, and the boot banner has long since
 * scrolled away. Anything that can reach /health can now tell them apart.
 */
function degraded(res: Response, reason: string): void {
  res.status(503).json({
    status: "degraded",
    reason,
    version: config.VERSION,
    seccomp: config.SECCOMP_STATUS,
  });
}

function respond(res: Response, snapshot: LivenessSnapshot): void {
  if (snapshot.ok) {
    res.json({ status: "ok", version: config.VERSION, seccomp: config.SECCOMP_STATUS });
    return;
  }
  degraded(res, snapshot.failures.join(", "));
}

export const healthRouter: Router = Router();

/**
 * GET /health — NO auth middleware. Returns
 * `{ status: "ok", version, seccomp }` (200) or
 * `{ status: "degraded", reason, version, seccomp }` (503).
 *
 * The answer is `src/liveness`'s last snapshot — every check the judge
 * has, on its two cadences — served from cache while a refresh runs in
 * the background, so the endpoint stays cheap and constant-cost no matter
 * how many unauthenticated clients poll it. `refresh()` re-runs only the
 * cadences whose TTL has expired and is single-flighted, so calling it on
 * every request costs nothing when nothing is due.
 *
 * Reports `degraded` with reason `draining` once a shutdown signal has
 * arrived. Otherwise Render's load balancer and wmoj-app's status page
 * both keep seeing a healthy instance for the whole drain window and
 * keep routing submissions to it — every one of which is answered with
 * the routes' own 503.
 *
 * `status` is unchanged and remains the contract every existing caller
 * (Render's probe, wmoj-app's `api/status/health`) reads. `version` is
 * purely additive: it is `RENDER_GIT_COMMIT` in production, so polling
 * /health from outside tells you exactly when a push went live. See
 * `resolveVersion` in config.ts.
 */
healthRouter.get("/", async (_req: Request, res: Response) => {
  try {
    if (isDraining()) {
      degraded(res, "draining");
      return;
    }

    const snapshot = liveness.snapshot();
    if (snapshot === null) {
      // Only reachable if the boot assertion was bypassed; every normal
      // boot populates the snapshot before the server starts listening.
      respond(res, await liveness.refresh());
      return;
    }
    // Stale-while-revalidate. The rejection handler is mandatory, not
    // defensive: an unhandled rejection from this un-awaited promise
    // would take the process down.
    void liveness.refresh().catch((err: unknown) => {
      logger.warn({ err }, "health: background refresh failed");
    });
    respond(res, snapshot);
  } catch (err) {
    logger.error({ err }, "health: probe failed");
    if (!res.headersSent) {
      degraded(res, (err as Error).message);
    }
  }
});
