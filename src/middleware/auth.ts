import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { logger } from "../util/logger";

const HEADER = "X-Judge-Token";

/**
 * Constant-time string compare. Returns false on length mismatch
 * without leaking the expected length. `timingSafeEqual` throws when
 * the buffers differ in length, so we guard that ahead of the call.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Shared-secret auth middleware for `/submit` and `/generate-tests`.
 *
 * Two modes, selected by `config.AUTH_STRICT`:
 *   - strict=false (soft): missing / wrong token emits a warning log
 *     and the request is allowed through. Used during the rollout
 *     window described in the plan's Deployment section.
 *   - strict=true: missing / wrong token returns 401 JSON.
 *
 * `/health` never mounts this middleware so it stays public for
 * Render health probes.
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = config.JUDGE_SHARED_SECRET;
  const provided = req.header(HEADER);

  const missing = typeof provided !== "string" || provided.length === 0;
  const mismatch = !missing && !constantTimeEquals(provided, expected);

  if (!missing && !mismatch) {
    next();
    return;
  }

  const reason = missing ? "missing-token" : "bad-token";

  if (config.AUTH_STRICT) {
    logger.warn(
      { reason, ip: req.ip, path: req.path },
      "auth: rejecting request (strict mode)",
    );
    res.status(401).json({ error: "unauthorized", reason });
    return;
  }

  logger.warn(
    { reason, ip: req.ip, path: req.path },
    "auth: soft mode — request allowed despite failed token check",
  );
  next();
}
