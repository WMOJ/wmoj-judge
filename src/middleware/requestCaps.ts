import type { Request, Response, NextFunction } from "express";
import {
  MAX_CHECKER_BYTES,
  MAX_CODE_BYTES,
  describeViolation,
  fitsTestDataBudget,
  utf8Bytes,
} from "../budget";

/**
 * Express middleware that enforces the body-size contract for `/submit`
 * and `/generate-tests` before any heavy work (compile, sandbox launch).
 * Routes that don't carry a body (e.g. `/health`) fall straight through.
 *
 * Only applied AFTER `express.json()`, so `req.body` is already parsed.
 * Any cap violation returns a 413 JSON error instead of advancing to the
 * route. Shape validation (types of `code`/`input`) stays on the route
 * layer — this middleware only looks at sizes when the right-shaped
 * fields are present.
 *
 * The caps themselves, and the walk over the test data, live in
 * `src/budget`: `/generate-tests` decides from the same walk whether the
 * data it produces will fit, so the two cannot disagree. This file is
 * only the HTTP rendering — the two source checks that are `/submit`'s
 * alone, and the 413.
 */

interface SubmitLikeBody {
  code?: unknown;
  input?: unknown;
  output?: unknown;
  checker?: unknown;
}

/**
 * The 413 body every cap violation returns. Kept in one place so the
 * `{error, reason, limit}` shape `wmoj-app` reads never drifts between
 * branches.
 */
function tooLarge(res: Response, reason: string, limit: number): void {
  res.status(413).json({ error: "payload too large", reason, limit });
}

export function requestCaps(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = (req.body ?? {}) as SubmitLikeBody;
  let reserved = 0;

  if (typeof body.code === "string") {
    const n = utf8Bytes(body.code);
    if (n > MAX_CODE_BYTES) {
      tooLarge(res, "code exceeds 100KB", MAX_CODE_BYTES);
      return;
    }
    reserved += n;
  }

  if (typeof body.checker === "string") {
    const n = utf8Bytes(body.checker);
    if (n > MAX_CHECKER_BYTES) {
      tooLarge(res, "checker exceeds 100KB", MAX_CHECKER_BYTES);
      return;
    }
    reserved += n;
  }

  // `code` and `checker` together cannot reach the aggregate cap on their
  // own, which is why they are reserved rather than checked: the walk
  // checks the running total as it accumulates, so an oversized body
  // stops being measured as soon as it is known to be over.
  const verdict = fitsTestDataBudget(
    Array.isArray(body.input) ? body.input : [],
    Array.isArray(body.output) ? body.output : [],
    reserved,
  );
  if (!verdict.ok) {
    tooLarge(res, describeViolation(verdict.violation), verdict.violation.limit);
    return;
  }

  next();
}
