import type { Request, Response, NextFunction } from "express";

/**
 * Hard size caps enforced before any heavy work (compile, sandbox
 * launch). Rejecting early keeps malicious or accidental giant
 * payloads from burning CPU/memory. Limits are tight but leave
 * headroom for every real CP submission shape.
 */
const MAX_INPUT_CASES = 200;
const MAX_INPUT_BYTES_PER_CASE = 1_000_000;
const MAX_OUTPUT_BYTES_PER_CASE = 1_000_000;
const MAX_CODE_BYTES = 100_000;

interface SubmitLikeBody {
  code?: unknown;
  input?: unknown;
  output?: unknown;
}

/**
 * Return the byte length of `s` as UTF-8. Node's `Buffer.byteLength`
 * is cheaper than `new Blob([s]).size` and matches what child stdin
 * will see on the wire.
 */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Express middleware that validates the body-size contract for
 * `/submit` and `/generate-tests`. Routes that don't carry a body
 * (e.g. `/health`) fall straight through.
 *
 * Only applied AFTER `express.json()`, so `req.body` is already
 * parsed. Any cap violation returns a 413 JSON error instead of
 * advancing to the route. Shape validation (types of `code`/`input`)
 * stays on the route layer — this middleware only looks at sizes when
 * the right-shaped fields are present.
 */
export function requestCaps(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = (req.body ?? {}) as SubmitLikeBody;

  if (typeof body.code === "string") {
    if (byteLen(body.code) > MAX_CODE_BYTES) {
      res.status(413).json({
        error: "payload too large",
        reason: "code exceeds 100KB",
        limit: MAX_CODE_BYTES,
      });
      return;
    }
  }

  if (Array.isArray(body.input)) {
    if (body.input.length > MAX_INPUT_CASES) {
      res.status(413).json({
        error: "payload too large",
        reason: `too many test cases (max ${MAX_INPUT_CASES})`,
        limit: MAX_INPUT_CASES,
      });
      return;
    }
    for (let i = 0; i < body.input.length; i += 1) {
      const item = body.input[i];
      if (typeof item !== "string") continue; // let route do shape 400
      if (byteLen(item) > MAX_INPUT_BYTES_PER_CASE) {
        res.status(413).json({
          error: "payload too large",
          reason: `input[${i}] exceeds 1MB`,
          limit: MAX_INPUT_BYTES_PER_CASE,
        });
        return;
      }
    }
  }

  if (Array.isArray(body.output)) {
    if (body.output.length > MAX_INPUT_CASES) {
      res.status(413).json({
        error: "payload too large",
        reason: `too many expected outputs (max ${MAX_INPUT_CASES})`,
        limit: MAX_INPUT_CASES,
      });
      return;
    }
    for (let i = 0; i < body.output.length; i += 1) {
      const item = body.output[i];
      if (typeof item !== "string") continue;
      if (byteLen(item) > MAX_OUTPUT_BYTES_PER_CASE) {
        res.status(413).json({
          error: "payload too large",
          reason: `output[${i}] exceeds 1MB`,
          limit: MAX_OUTPUT_BYTES_PER_CASE,
        });
        return;
      }
    }
  }

  next();
}
