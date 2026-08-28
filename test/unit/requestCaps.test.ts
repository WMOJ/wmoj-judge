import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response, NextFunction } from "express";
import {
  requestCaps,
  MAX_INPUT_CASES,
  MAX_INPUT_BYTES_PER_CASE,
  MAX_OUTPUT_BYTES_PER_CASE,
  MAX_TOTAL_REQUEST_BYTES,
} from "../../src/middleware/requestCaps";

/**
 * The 413 bodies this middleware sends are cross-repo contract:
 * `wmoj-app` surfaces `reason` to the admin who authored the test data,
 * and `judge.sh` in the add-problem skill hardcodes the same caps. Every
 * assertion below pins the body byte for byte on purpose — a reworded
 * `reason` is a client-visible change, not a cosmetic one.
 *
 * The middleware is driven through a hand-written fake rather than a live
 * Express app because its whole interface is (body in) -> (413 body, or
 * `next()`); mounting a server would test Express, not the caps.
 */

/** The subset of `Response` this middleware touches. */
interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
}

interface CapsOutcome {
  /** Set when the middleware sent a response instead of calling `next()`. */
  statusCode: number | null;
  body: unknown;
  nextCalls: number;
}

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: null,
    body: undefined,
    status(code: number): FakeResponse {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown): FakeResponse {
      res.body = payload;
      return res;
    },
  };
  return res;
}

/**
 * Run the middleware over one body. The two casts are the only place the
 * fakes meet Express's types: `requestCaps` reads `req.body` and calls
 * `res.status().json()`, and nothing else on either object.
 */
function runCaps(body: unknown): CapsOutcome {
  const res = makeResponse();
  let nextCalls = 0;
  const next: NextFunction = () => {
    nextCalls += 1;
  };
  requestCaps({ body } as Request, res as unknown as Response, next);
  return { statusCode: res.statusCode, body: res.body, nextCalls };
}

/** Assert the request was let through untouched. */
function assertPassed(outcome: CapsOutcome): void {
  assert.equal(outcome.nextCalls, 1);
  assert.equal(outcome.statusCode, null);
  assert.equal(outcome.body, undefined);
}

/** Assert the exact 413 body, and that the request was NOT forwarded. */
function assert413(outcome: CapsOutcome, reason: string, limit: number): void {
  assert.equal(outcome.nextCalls, 0);
  assert.equal(outcome.statusCode, 413);
  assert.deepEqual(outcome.body, { error: "payload too large", reason, limit });
}

/** `n` UTF-8 bytes of ASCII. */
function bytes(n: number): string {
  return "a".repeat(n);
}

const MAX_CODE_BYTES = 100_000;

test("a body with no cap-relevant fields passes", () => {
  assertPassed(runCaps({}));
  assertPassed(runCaps({ language: "cpp17" }));
});

test("an absent body passes — `req.body` is undefined before express.json()", () => {
  assertPassed(runCaps(undefined));
});

test("code at exactly 100KB passes; one byte more is 413", () => {
  assertPassed(runCaps({ code: bytes(MAX_CODE_BYTES) }));
  assert413(
    runCaps({ code: bytes(MAX_CODE_BYTES + 1) }),
    "code exceeds 100KB",
    MAX_CODE_BYTES,
  );
});

test("code is measured in UTF-8 bytes, not UTF-16 code units", () => {
  // 50,001 two-byte characters is 100,002 bytes but only 50,001 chars —
  // a length-based cap would have let it through.
  assert413(
    runCaps({ code: "é".repeat(50_001) }),
    "code exceeds 100KB",
    MAX_CODE_BYTES,
  );
});

test("checker over 100KB is 413 with its own wording", () => {
  assert413(
    runCaps({ code: "int main(){}", checker: bytes(MAX_CODE_BYTES + 1) }),
    "checker exceeds 100KB",
    MAX_CODE_BYTES,
  );
});

test("code is checked before checker", () => {
  assert413(
    runCaps({
      code: bytes(MAX_CODE_BYTES + 1),
      checker: bytes(MAX_CODE_BYTES + 1),
    }),
    "code exceeds 100KB",
    MAX_CODE_BYTES,
  );
});

test("201 test cases is 413", () => {
  assertPassed(runCaps({ input: Array<string>(MAX_INPUT_CASES).fill("1\n") }));
  assert413(
    runCaps({ input: Array<string>(MAX_INPUT_CASES + 1).fill("1\n") }),
    "too many test cases (max 200)",
    MAX_INPUT_CASES,
  );
});

test("201 expected outputs is 413, worded for the output array", () => {
  assert413(
    runCaps({
      input: Array<string>(MAX_INPUT_CASES).fill("1\n"),
      output: Array<string>(MAX_INPUT_CASES + 1).fill("1\n"),
    }),
    "too many expected outputs (max 200)",
    MAX_INPUT_CASES,
  );
});

test("an oversized input names its index", () => {
  const input = ["a", "b", "c", bytes(MAX_INPUT_BYTES_PER_CASE + 1)];
  assert413(runCaps({ input }), "input[3] exceeds 1MB", MAX_INPUT_BYTES_PER_CASE);
});

test("an input at exactly 1MB passes", () => {
  assertPassed(runCaps({ input: [bytes(MAX_INPUT_BYTES_PER_CASE)] }));
});

test("an oversized expected output names its index", () => {
  assert413(
    runCaps({
      input: ["1\n"],
      output: [bytes(MAX_OUTPUT_BYTES_PER_CASE + 1)],
    }),
    "output[0] exceeds 1MB",
    MAX_OUTPUT_BYTES_PER_CASE,
  );
});

test("non-string array items are skipped, leaving the shape 400 to the route", () => {
  // A number is not measured at all — and must not crash the middleware
  // or be counted against the aggregate.
  assertPassed(runCaps({ input: [1, null, { nested: true }, "1\n"] }));
});

test("a legal maximum-size body — exactly 16 MiB of measured payload — passes", () => {
  const { code, checker, input, output } = maximalBody();
  const total =
    Buffer.byteLength(code, "utf8") +
    Buffer.byteLength(checker, "utf8") +
    input.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0) +
    output.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0);
  assert.equal(total, MAX_TOTAL_REQUEST_BYTES);

  assertPassed(runCaps({ code, checker, input, output }));
});

test("one byte past the aggregate is 413", () => {
  const { code, checker, input, output } = maximalBody();
  const last = output[output.length - 1] ?? "";
  const overBy1 = [...output.slice(0, -1), `${last}a`];
  assert413(
    runCaps({ code, checker, input, output: overBy1 }),
    `total payload exceeds ${MAX_TOTAL_REQUEST_BYTES} bytes`,
    MAX_TOTAL_REQUEST_BYTES,
  );
});

test("the aggregate can be tripped by the input array alone", () => {
  // 17 cases x 1 MB = 17,000,000 bytes > 16,777,216. The per-case cap is
  // never broken, which is the whole reason the aggregate exists.
  const input = Array<string>(17).fill(bytes(MAX_INPUT_BYTES_PER_CASE));
  assert413(
    runCaps({ input }),
    `total payload exceeds ${MAX_TOTAL_REQUEST_BYTES} bytes`,
    MAX_TOTAL_REQUEST_BYTES,
  );
});

test("first violation wins: input count, then input items, then output count, then output items, then the aggregate", () => {
  const tooManyInputs = Array<string>(MAX_INPUT_CASES + 1).fill("1\n");
  const tooManyOutputs = Array<string>(MAX_INPUT_CASES + 1).fill("1\n");
  const oversizedInput = [bytes(MAX_INPUT_BYTES_PER_CASE + 1)];
  const oversizedOutput = [bytes(MAX_OUTPUT_BYTES_PER_CASE + 1)];

  // input count beats every later branch
  assert413(
    runCaps({ input: tooManyInputs, output: tooManyOutputs }),
    "too many test cases (max 200)",
    MAX_INPUT_CASES,
  );
  // an oversized input beats the output array entirely
  assert413(
    runCaps({ input: oversizedInput, output: tooManyOutputs }),
    "input[0] exceeds 1MB",
    MAX_INPUT_BYTES_PER_CASE,
  );
  // output count beats an oversized output item
  assert413(
    runCaps({ input: ["1\n"], output: tooManyOutputs }),
    "too many expected outputs (max 200)",
    MAX_INPUT_CASES,
  );
  // an oversized output item beats the aggregate: 16 MB of input plus
  // this item is 17,000,001 bytes, over the 16,777,216 aggregate, but
  // the per-case check runs before the running total is updated.
  assert413(
    runCaps({
      input: Array<string>(16).fill(bytes(MAX_INPUT_BYTES_PER_CASE)),
      output: oversizedOutput,
    }),
    "output[0] exceeds 1MB",
    MAX_OUTPUT_BYTES_PER_CASE,
  );
});

/**
 * The largest body the caps permit at equal case sizes: 100 KB of code,
 * 100 KB of checker, and 200 input/output pairs summing to exactly
 * `MAX_TOTAL_REQUEST_BYTES`. This is the payload that used to be rejected
 * by body-parser with Express's default HTML 413 because `JSON_BODY_LIMIT`
 * sat below it.
 */
function maximalBody(): {
  code: string;
  checker: string;
  input: string[];
  output: string[];
} {
  const code = bytes(MAX_CODE_BYTES);
  const checker = bytes(MAX_CODE_BYTES);
  const remaining = MAX_TOTAL_REQUEST_BYTES - 2 * MAX_CODE_BYTES;
  const per = Math.floor(remaining / (2 * MAX_INPUT_CASES));
  const input = Array<string>(MAX_INPUT_CASES).fill(bytes(per));
  const output = Array<string>(MAX_INPUT_CASES).fill(bytes(per));
  // Spend the remainder on the last expected output so the total lands
  // exactly on the cap rather than just under it.
  const slack = remaining - per * 2 * MAX_INPUT_CASES;
  output[MAX_INPUT_CASES - 1] = bytes(per + slack);
  return { code, checker, input, output };
}
