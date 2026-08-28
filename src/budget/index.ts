/**
 * The test-data budget: does this much test data fit in one request?
 *
 * Two routes answer that question about the same arrays against the
 * same constants — `requestCaps` on the way IN to `/submit` (413) and
 * `/generate-tests` on the way OUT (400), because everything a generator
 * emits is posted straight back to `/submit` by the admin create form,
 * and a generator that produced data the judge later refuses strands an
 * admin with an unsolvable problem. The constants were already shared;
 * the walk was not, and the second copy once measured `output` against
 * the input cap. Now there is one walk, `fitsTestDataBudget`, and the two
 * routes differ only in how they render its structured verdict.
 *
 * Rejecting early keeps malicious or accidental giant payloads from
 * burning CPU/memory. Limits are tight but leave headroom for every real
 * CP submission shape.
 */

export const MAX_INPUT_CASES = 200;
export const MAX_INPUT_BYTES_PER_CASE = 1_000_000;
export const MAX_OUTPUT_BYTES_PER_CASE = 1_000_000;
export const MAX_CODE_BYTES = 100_000;
/**
 * Custom checkers are C++ source too, and get the same 100 KB budget as
 * a submission. Anything larger is a mistake, not a checker.
 */
export const MAX_CHECKER_BYTES = 100_000;

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
 * on the next `/submit`.
 */
export const MAX_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024;

/**
 * `limit` for the `express.json()` instance mounted in `server.ts`.
 *
 * This MUST stay strictly above `MAX_TOTAL_REQUEST_BYTES`, and the two
 * MUST be read from here together. When the parser limit sits *below*
 * the largest payload the caps permit, a legal request is rejected by
 * body-parser instead of by `requestCaps` — and since the service
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
 * newline on the wire relative to the decoded byte count `requestCaps`
 * measures. `test/unit/budget.test.ts` holds the ordering.
 */
export const JSON_BODY_LIMIT = "32mb";

/**
 * What a future `/submit` needs beyond the test data: the largest source
 * and the largest checker the caps admit. `/generate-tests` reserves
 * this out of the aggregate so the data it hands back can always be
 * submitted with any legal program against it. Derived, not restated,
 * so a change to either source cap moves it.
 */
export const SUBMISSION_SOURCE_HEADROOM_BYTES = MAX_CODE_BYTES + MAX_CHECKER_BYTES;

export type BudgetViolation =
  | { kind: "count"; field: "input" | "output"; count: number; limit: number }
  | {
      kind: "per-case";
      field: "input" | "output";
      index: number;
      bytes: number;
      limit: number;
    }
  | {
      kind: "aggregate";
      /** The running total at the point it went over — reserved bytes included. */
      bytes: number;
      limit: number;
    };

export type BudgetVerdict =
  | { ok: true; bytes: number }
  | { ok: false; violation: BudgetViolation };

/**
 * Byte length as UTF-8. Node's `Buffer.byteLength` is cheaper than
 * `new Blob([s]).size` and matches what child stdin will see on the wire.
 */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Render a cap for a human, without letting the literal drift from the constant. */
export function formatCap(bytes: number): string {
  return bytes % 1_000_000 === 0 ? `${String(bytes / 1_000_000)}MB` : `${String(bytes)} bytes`;
}

/**
 * The one walk. Order is part of the contract, because the FIRST
 * violation is the one a body gets told about: input count, input items,
 * output count, output items, with the aggregate checked as it
 * accumulates inside each walk. Non-string items are skipped (the route
 * 400s them for shape). `reservedBytes` is what the caller has already
 * spent (code + checker) or must leave room for.
 */
export function fitsTestDataBudget(
  input: readonly unknown[],
  output: readonly unknown[],
  reservedBytes: number,
): BudgetVerdict {
  let total = reservedBytes;
  const walk = (
    items: readonly unknown[],
    field: "input" | "output",
    perCaseCap: number,
  ): BudgetViolation | null => {
    if (items.length > MAX_INPUT_CASES) {
      return { kind: "count", field, count: items.length, limit: MAX_INPUT_CASES };
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (typeof item !== "string") continue;
      const n = utf8Bytes(item);
      if (n > perCaseCap) {
        return { kind: "per-case", field, index: i, bytes: n, limit: perCaseCap };
      }
      total += n;
      if (total > MAX_TOTAL_REQUEST_BYTES) {
        return { kind: "aggregate", bytes: total, limit: MAX_TOTAL_REQUEST_BYTES };
      }
    }
    return null;
  };
  const violation =
    walk(input, "input", MAX_INPUT_BYTES_PER_CASE) ??
    walk(output, "output", MAX_OUTPUT_BYTES_PER_CASE);
  return violation === null ? { ok: true, bytes: total } : { ok: false, violation };
}

/**
 * The canonical wording. `wmoj-app` surfaces `reason` to the admin who
 * authored the test data, so every string here is contract and
 * `test/unit/requestCaps.test.ts` pins each one; `/generate-tests`
 * overrides only the aggregate line.
 */
export function describeViolation(v: BudgetViolation): string {
  switch (v.kind) {
    case "count":
      return v.field === "input"
        ? `too many test cases (max ${String(v.limit)})`
        : `too many expected outputs (max ${String(v.limit)})`;
    case "per-case":
      return `${v.field}[${String(v.index)}] exceeds ${formatCap(v.limit)}`;
    case "aggregate":
      return `total payload exceeds ${String(v.limit)} bytes`;
  }
}
