import rateLimit from "express-rate-limit";
import type { Request, RequestHandler } from "express";
import { config } from "../config";

/**
 * express-rate-limit middleware keyed on both the remote IP and the
 * `X-Judge-Token` value. Keying on the token as well as the IP means
 * a single misbehaving deploy can't deny service to other callers
 * even if they sit behind the same NAT/edge IP, and conversely
 * different tenants on the same shared IP keep independent budgets.
 *
 * Limits come from config.ts (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`)
 * so ops can tune per environment without a code change.
 */
export function createRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const rawToken = req.header("X-Judge-Token");
      const token =
        typeof rawToken === "string" && rawToken.length > 0 ? rawToken : "anon";
      return `${req.ip ?? "unknown"}|${token}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        error: "rate limit exceeded",
        retryAfterMs: config.RATE_LIMIT_WINDOW_MS,
      });
    },
  });
}
