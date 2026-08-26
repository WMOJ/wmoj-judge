import pino from "pino";
import pinoHttp from "pino-http";
import { nanoid } from "nanoid";
import type { IncomingMessage, ServerResponse } from "http";
import { config } from "../config";

/**
 * Structured logger for the judge.
 *
 * Emits JSON lines on stdout with pino defaults. `pino-http` injects a
 * per-request `req.id` (nanoid) so downstream code can correlate log
 * messages to individual /submit calls.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "wmoj-judge" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      'req.headers["x-judge-token"]',
      'req.headers["X-Judge-Token"]',
      "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});

/**
 * Shape an inbound `x-request-id` must match to be trusted.
 *
 * `httpLogger` mounts well before auth, and `/health` needs no token at
 * all, so this header is anonymous, unauthenticated input that gets
 * stamped on every log line for the request. Accepted verbatim it let a
 * caller push up to Node's ~16 KB header budget into the logs on every
 * request, and deliberately collide ids to defeat correlation. pino
 * JSON-escapes the value, so the risk is log bloat and confusion rather
 * than injection — 64 characters of an id-shaped alphabet is all a real
 * upstream trace id ever needs.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Express middleware that attaches a request-scoped child logger as
 * `req.log`. Reuses a well-formed inbound `x-request-id` so a trace can
 * be followed across `wmoj-app` and the judge, and otherwise generates a
 * short id with `nanoid`.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, _res: ServerResponse) => {
    const existing = req.headers["x-request-id"];
    if (typeof existing === "string" && REQUEST_ID_PATTERN.test(existing)) {
      return existing;
    }
    return nanoid(12);
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  serializers: {
    req(req) {
      return { id: req.id, method: req.method, url: req.url };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

/**
 * Flush pino's async transports. Safe to call multiple times.
 * Used by shutdown.ts to drain logs before exit.
 */
export function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => resolve());
  });
}
