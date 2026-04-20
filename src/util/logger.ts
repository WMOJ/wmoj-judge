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
 * Express middleware that attaches a request-scoped child logger as
 * `req.log`. Generates a short request id with `nanoid` so log lines
 * can be correlated.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, _res: ServerResponse) => {
    const existing = req.headers["x-request-id"];
    if (typeof existing === "string" && existing.length > 0) {
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
