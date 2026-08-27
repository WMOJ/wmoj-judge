import type { Request, Response, NextFunction } from "express";

/**
 * Hard size caps enforced before any heavy work (compile, sandbox
 * launch). Rejecting early keeps malicious or accidental giant
 * payloads from burning CPU/memory. Limits are tight but leave
 * headroom for every real CP submission shape.
 */
export const MAX_INPUT_CASES = 200;
export const MAX_INPUT_BYTES_PER_CASE = 1_000_000;
export const MAX_OUTPUT_BYTES_PER_CASE = 1_000_000;
const MAX_CODE_BYTES = 100_000;
/**
 * Custom checkers are C++ source too, and get the same 100 KB budget as
 * a submission. Anything larger is a mistake, not a checker.
 */
const MAX_CHECKER_BYTES = 100_000;

/**
 * Aggregate cap on `code + checker + Σinput + Σoutput`, in UTF-8 bytes.
 *
 * The per-field caps above multiply out to 400,200,000 bytes
 * (200 × 1 MB in + 200 × 1 MB out + 100 KB code + 100 KB checker), which
 * is ~780× the RAM this service is given. Nothing downstream is
 * streamed: every case is held as a JS string for the whole request, so
 * a payload anywhere near that product OOM-kills the 512 MB container
 * long before the first test runs. The per-field caps stay where they
 * are because they bound the shape of a *single* case (which is what a
 * problem author reasons about); this bounds the request as a whole.
 *
 * 16 MiB is deliberately generous — the largest problem WMOJ actually
 * ships is ~1.2 MB of test data, so this is ~13× the observed worst
 * case. It is also the ceiling `/generate-tests` must respect for the
 * data it *produces*, since anything it emits comes straight back here
 * on the next `/submit`; that is why this is exported rather than
 * private to the middleware.
 */
export const MAX_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * `limit` for the `express.json()` instance mounted in `server.ts`.
 *
 * This MUST stay strictly above `MAX_TOTAL_REQUEST_BYTES`, and the two
 * MUST be read from here together. When the parser limit sits *below*
 * the largest payload the caps permit, a legal request is rejected by
 * body-parser instead of by this middleware — and since the service
 * deliberately has no error middleware, body-parser's `next(err)`
 * produces Express's default **HTML** 413. `wmoj-app` calls
 * `resp.json()` before it checks `resp.ok`, so parsing that HTML throws
 * and the student sees a generic 500 instead of a size complaint. That
 * is exactly the regression this pair of constants exists to prevent,
 * and it is the regression that shipped when the parser was pinned at
 * "250mb" while the caps permitted 400,200,000 bytes.
 *
 * The 2× headroom absorbs JSON overhead: field names, brackets, and
 * above all backslash escaping, which doubles every `"`, `\` and
 * newline on the wire relative to the decoded byte count this
 * middleware measures.
 */
export const JSON_BODY_LIMIT = "32mb";

interface SubmitLikeBody {
  code?: unknown;
  input?: unknown;
  output?: unknown;
  checker?: unknown;
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
 * The 413 body every cap violation returns. Kept in one place so the
 * `{error, reason, limit}` shape `wmoj-app` reads never drifts between
 * branches.
 */
function tooLarge(res: Response, reason: string, limit: number): void {
  res.status(413).json({ error: "payload too large", reason, limit });
}

/** Render a cap for a human, without letting the literal drift from the constant. */
export function formatCap(bytes: number): string {
  return bytes % 1_000_000 === 0 ? `${bytes / 1_000_000}MB` : `${bytes} bytes`;
}

/**
 * Validate one array-of-strings field against its per-case cap, accumulating
 * into the running byte total and checking the aggregate as it grows.
 *
 * Returns the new total, or `null` when it has already sent the 413 — so the
 * caller returns without touching `res` again. `input` and `output` differ only
 * in their per-case cap and their wording, which is exactly why they share this
 * rather than being maintained as two copies that drift.
 */
function checkCaseArray(
  res: Response,
  items: unknown[],
  field: "input" | "output",
  noun: string,
  perCaseCap: number,
  runningTotal: number,
): number | null {
  if (items.length > MAX_INPUT_CASES) {
    tooLarge(res, `too many ${noun} (max ${MAX_INPUT_CASES})`, MAX_INPUT_CASES);
    return null;
  }

  let total = runningTotal;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (typeof item !== "string") continue; // let route do shape 400
    const n = byteLen(item);
    if (n > perCaseCap) {
      tooLarge(res, `${field}[${i}] exceeds ${formatCap(perCaseCap)}`, perCaseCap);
      return null;
    }
    total += n;
    if (total > MAX_TOTAL_REQUEST_BYTES) {
      tooLarge(
        res,
        `total payload exceeds ${MAX_TOTAL_REQUEST_BYTES} bytes`,
        MAX_TOTAL_REQUEST_BYTES,
      );
      return null;
    }
  }
  return total;
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
 *
 * Two layers of cap: a per-field one that names the offending field
 * (the useful diagnostic for a problem author), and the aggregate
 * `MAX_TOTAL_REQUEST_BYTES` that bounds the request as a whole. The
 * running total is checked as it accumulates rather than only at the
 * end, so an oversized body stops being measured as soon as it is
 * known to be over — which is also why there is no final sweep: `code`
 * and `checker` together cannot reach the aggregate cap on their own.
 */
export function requestCaps(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const body = (req.body ?? {}) as SubmitLikeBody;
  let total = 0;

  if (typeof body.code === "string") {
    const n = byteLen(body.code);
    if (n > MAX_CODE_BYTES) {
      tooLarge(res, "code exceeds 100KB", MAX_CODE_BYTES);
      return;
    }
    total += n;
  }

  if (typeof body.checker === "string") {
    const n = byteLen(body.checker);
    if (n > MAX_CHECKER_BYTES) {
      tooLarge(res, "checker exceeds 100KB", MAX_CHECKER_BYTES);
      return;
    }
    total += n;
  }

  if (Array.isArray(body.input)) {
    const next = checkCaseArray(res, body.input, "input", "test cases", MAX_INPUT_BYTES_PER_CASE, total);
    if (next === null) return;
    total = next;
  }

  if (Array.isArray(body.output)) {
    const next = checkCaseArray(res, body.output, "output", "expected outputs", MAX_OUTPUT_BYTES_PER_CASE, total);
    if (next === null) return;
    total = next;
  }

  next();
}
