import test from "node:test";
import assert from "node:assert/strict";
import {
  JSON_BODY_LIMIT,
  MAX_CHECKER_BYTES,
  MAX_CODE_BYTES,
  MAX_INPUT_BYTES_PER_CASE,
  MAX_INPUT_CASES,
  MAX_OUTPUT_BYTES_PER_CASE,
  MAX_TOTAL_REQUEST_BYTES,
  SUBMISSION_SOURCE_HEADROOM_BYTES,
  describeViolation,
  fitsTestDataBudget,
  formatCap,
  type BudgetViolation,
} from "../../src/budget";
import { DEFAULT_MAX_STDOUT_BYTES } from "../../src/sandbox/nsjail";

/**
 * The one walk both routes decide from. `requestCaps.test.ts` pins the 413
 * bodies `/submit` sends and the `generator-too-many-cases` golden pins the
 * `/generate-tests` 400; this file pins the walk itself — which violation
 * is named first, the wording of each, that the aggregate is incremental
 * and that reserved bytes count — and the two cross-module invariants the
 * constants have to keep.
 */

function violationOf(input: unknown[], output: unknown[], reserved = 0): BudgetViolation {
  const verdict = fitsTestDataBudget(input, output, reserved);
  assert.equal(verdict.ok, false, "expected a violation");
  if (verdict.ok) throw new Error("unreachable");
  return verdict.violation;
}

test("empty arrays fit, and the total is exactly the reserved bytes", () => {
  assert.deepEqual(fitsTestDataBudget([], [], 0), { ok: true, bytes: 0 });
  assert.deepEqual(fitsTestDataBudget([], [], 123), { ok: true, bytes: 123 });
});

test("the total is UTF-8 bytes, not string length", () => {
  const verdict = fitsTestDataBudget(["é"], ["日本"], 1);
  assert.deepEqual(verdict, { ok: true, bytes: 1 + 2 + 6 });
});

test("too many inputs is a count violation with the /submit wording", () => {
  const v = violationOf(new Array<string>(MAX_INPUT_CASES + 1).fill(""), []);
  assert.deepEqual(v, { kind: "count", field: "input", count: 201, limit: 200 });
  assert.equal(describeViolation(v), "too many test cases (max 200)");
});

test("too many outputs is worded for the output array", () => {
  const v = violationOf([], new Array<string>(MAX_INPUT_CASES + 1).fill(""));
  assert.deepEqual(v, { kind: "count", field: "output", count: 201, limit: 200 });
  assert.equal(describeViolation(v), "too many expected outputs (max 200)");
});

test("an oversized input names its index and the cap", () => {
  const v = violationOf(["", "", "x".repeat(MAX_INPUT_BYTES_PER_CASE + 1)], []);
  assert.deepEqual(v, {
    kind: "per-case",
    field: "input",
    index: 2,
    bytes: MAX_INPUT_BYTES_PER_CASE + 1,
    limit: MAX_INPUT_BYTES_PER_CASE,
  });
  assert.equal(describeViolation(v), "input[2] exceeds 1MB");
});

test("an oversized output is measured against the OUTPUT cap", () => {
  // The generator route once measured `output` against the input cap;
  // equal today, so it changed nothing — right up until one of them moves.
  const v = violationOf([], ["x".repeat(MAX_OUTPUT_BYTES_PER_CASE + 1)]);
  assert.equal(v.kind, "per-case");
  assert.equal(v.limit, MAX_OUTPUT_BYTES_PER_CASE);
  assert.equal(describeViolation(v), "output[0] exceeds 1MB");
});

test("a case at exactly the per-case cap fits", () => {
  const verdict = fitsTestDataBudget(["x".repeat(MAX_INPUT_BYTES_PER_CASE)], [], 0);
  assert.deepEqual(verdict, { ok: true, bytes: MAX_INPUT_BYTES_PER_CASE });
});

test("non-string items are skipped, not measured and not rejected", () => {
  assert.deepEqual(fitsTestDataBudget([42, null, "ab"], [{}, "c"], 0), { ok: true, bytes: 3 });
});

test("the aggregate is checked as it accumulates — over by the last byte of the last output", () => {
  const chunk = "x".repeat(MAX_INPUT_BYTES_PER_CASE);
  const full = Math.floor(MAX_TOTAL_REQUEST_BYTES / MAX_INPUT_BYTES_PER_CASE); // 16
  const remainder = MAX_TOTAL_REQUEST_BYTES - full * MAX_INPUT_BYTES_PER_CASE; // 222,208
  const input = new Array<string>(full).fill(chunk);
  const exactlyFull = fitsTestDataBudget(input, ["y".repeat(remainder)], 0);
  assert.deepEqual(exactlyFull, { ok: true, bytes: MAX_TOTAL_REQUEST_BYTES });

  const v = violationOf(input, ["y".repeat(remainder + 1)]);
  assert.deepEqual(v, {
    kind: "aggregate",
    bytes: MAX_TOTAL_REQUEST_BYTES + 1,
    limit: MAX_TOTAL_REQUEST_BYTES,
  });
  assert.equal(describeViolation(v), "total payload exceeds 16777216 bytes");
});

test("the aggregate can be tripped by the input array alone", () => {
  const input = new Array<string>(17).fill("x".repeat(MAX_INPUT_BYTES_PER_CASE));
  const v = violationOf(input, []);
  assert.equal(v.kind, "aggregate");
  assert.equal(v.bytes, 17 * MAX_INPUT_BYTES_PER_CASE);
});

test("reserved bytes count against the aggregate", () => {
  const input = ["x".repeat(MAX_INPUT_BYTES_PER_CASE)];
  const room = MAX_TOTAL_REQUEST_BYTES - MAX_INPUT_BYTES_PER_CASE;
  assert.equal(fitsTestDataBudget(input, [], room).ok, true);
  const v = violationOf(input, [], room + 1);
  assert.deepEqual(v, {
    kind: "aggregate",
    bytes: MAX_TOTAL_REQUEST_BYTES + 1,
    limit: MAX_TOTAL_REQUEST_BYTES,
  });
});

test("first violation wins: input count, input items, output count, output items, aggregate", () => {
  const big = "x".repeat(MAX_INPUT_BYTES_PER_CASE + 1);
  const many = new Array<string>(MAX_INPUT_CASES + 1).fill("");
  // input count beats an oversized input item and everything about output
  assert.equal(violationOf([...many, big], [big]).kind, "count");
  assert.deepEqual(violationOf([...many], [...many]), {
    kind: "count",
    field: "input",
    count: MAX_INPUT_CASES + 1,
    limit: MAX_INPUT_CASES,
  });
  // an oversized input item beats output count and output items
  assert.deepEqual(violationOf(["", big], [...many]), {
    kind: "per-case",
    field: "input",
    index: 1,
    bytes: MAX_INPUT_BYTES_PER_CASE + 1,
    limit: MAX_INPUT_BYTES_PER_CASE,
  });
  // output count beats an oversized output item
  assert.equal(violationOf([], [...many, big]).kind, "count");
  // per-case beats the aggregate even when the aggregate is also over
  const v = violationOf(new Array<string>(17).fill("x".repeat(MAX_INPUT_BYTES_PER_CASE)), [big]);
  assert.equal(v.kind, "aggregate", "the input walk overran the aggregate before output was reached");
});

test("formatCap renders whole megabytes as MB and anything else as bytes", () => {
  assert.equal(formatCap(1_000_000), "1MB");
  assert.equal(formatCap(2_000_000), "2MB");
  assert.equal(formatCap(100_000), "100000 bytes");
});

test("the source headroom is derived from the two source caps", () => {
  assert.equal(SUBMISSION_SOURCE_HEADROOM_BYTES, MAX_CODE_BYTES + MAX_CHECKER_BYTES);
  assert.equal(SUBMISSION_SOURCE_HEADROOM_BYTES, 200_000);
});

test("the JSON body limit sits strictly above the aggregate cap", () => {
  // A parser limit below the largest legal payload rejects a legal
  // request with Express's HTML 413 — the regression this pair exists
  // to prevent.
  const match = /^(\d+)mb$/.exec(JSON_BODY_LIMIT);
  assert.ok(match, `JSON_BODY_LIMIT must be a whole number of mb, got ${JSON_BODY_LIMIT}`);
  const bodyLimitBytes = Number(match[1]) * 1024 * 1024;
  assert.ok(
    bodyLimitBytes > MAX_TOTAL_REQUEST_BYTES,
    `JSON_BODY_LIMIT (${String(bodyLimitBytes)}) must exceed MAX_TOTAL_REQUEST_BYTES`,
  );
});

test("the sandbox keeps more stdout than the largest expected output it can be asked to match", () => {
  // `TestResult.received` is a prefix past `DEFAULT_MAX_STDOUT_BYTES`; if
  // that cap ever dropped below the per-case output cap, a correct
  // program with a maximum-size answer would be truncated and graded WA.
  assert.ok(DEFAULT_MAX_STDOUT_BYTES > MAX_OUTPUT_BYTES_PER_CASE);
});
