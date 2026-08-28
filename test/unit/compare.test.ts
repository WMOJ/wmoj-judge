import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compare } from "../../src/compare";

/**
 * The four comparators, exercised through the one entrypoint the judge
 * itself uses: `compare(mode, expected, received)`. Testing past that
 * seam would test code no submission ever reaches.
 *
 * Two things here are load-bearing beyond "does it compare correctly":
 *
 *  - **The linear-time guard.** `trim-trailing` is the DEFAULT comparator
 *    and runs over both expected and received for every line of every
 *    case. Its right-trim used to be `/[\s﻿\xA0]+$/`, a greedy class
 *    anchored only at `$`, which backtracks Theta(n^2) on a whitespace run
 *    that is not at end of line — ~26 minutes at the 1 MB per-case cap for
 *    an ordinary `printf("%1000000d")`. On a single-threaded judge that is
 *    the whole service, so the budget below is an upper bound with three
 *    orders of magnitude of headroom, not a benchmark.
 *  - **Leading and interior whitespace stay significant** under
 *    `trim-trailing`. Relaxing that quietly turns it into `whitespace`
 *    and accepts wrong answers.
 */

/** Wall-clock budget for a one-million-character line. See above. */
const LINEAR_TIME_BUDGET_MS = 200;

/** Long enough to be quadratic-fatal, and the per-case cap's order of magnitude. */
const PATHOLOGICAL_LENGTH = 1_000_000;

test("exact: identical strings match, byte for byte", () => {
  assert.equal(compare("exact", "3\n", "3\n"), true);
  assert.equal(compare("exact", "", ""), true);
});

test("exact: a trailing newline, a trailing space and case are all significant", () => {
  assert.equal(compare("exact", "3\n", "3"), false);
  assert.equal(compare("exact", "3", "3 "), false);
  assert.equal(compare("exact", "YES", "yes"), false);
});

test("trim-trailing: trailing whitespace on a line is ignored", () => {
  assert.equal(compare("trim-trailing", "3\n", "3   \n"), true);
  assert.equal(compare("trim-trailing", "3\t \n", "3\n"), true);
  assert.equal(compare("trim-trailing", "a\nb\n", "a  \nb\t\n"), true);
});

test("trim-trailing: trailing empty lines are ignored on both sides", () => {
  assert.equal(compare("trim-trailing", "3\n", "3\n\n\n"), true);
  assert.equal(compare("trim-trailing", "3\n\n\n", "3"), true);
  assert.equal(compare("trim-trailing", "", "\n\n"), true);
});

test("trim-trailing: leading whitespace is significant", () => {
  assert.equal(compare("trim-trailing", "3\n", " 3\n"), false);
});

test("trim-trailing: interior whitespace is significant", () => {
  assert.equal(compare("trim-trailing", "1 2\n", "1  2\n"), false);
  assert.equal(compare("trim-trailing", "1 2\n", "1\t2\n"), false);
});

test("trim-trailing: an interior empty line is significant", () => {
  assert.equal(compare("trim-trailing", "a\nb\n", "a\n\nb\n"), false);
});

test("trim-trailing: a differing line still fails", () => {
  assert.equal(compare("trim-trailing", "1\n2\n", "1\n3\n"), false);
});

test("trim-trailing: a line of 1,000,000 spaces is compared in linear time", () => {
  const line = " ".repeat(PATHOLOGICAL_LENGTH);
  const started = performance.now();
  const matched = compare("trim-trailing", `${line}\n`, `${line}\n`);
  const elapsedMs = performance.now() - started;

  assert.equal(matched, true);
  assert.ok(
    elapsedMs < LINEAR_TIME_BUDGET_MS,
    `trim-trailing took ${elapsedMs.toFixed(1)}ms on a ${PATHOLOGICAL_LENGTH}-space line (budget ${LINEAR_TIME_BUDGET_MS}ms)`,
  );
});

test("trim-trailing: 1,000,000 spaces followed by a non-space is compared in linear time", () => {
  // The pathological shape for the old regex: the whitespace run is
  // INTERIOR, so every backtracking attempt fails `$` and the engine
  // restarts one character along. The all-spaces case above is the easy
  // one — this is the one that actually took 26 minutes.
  const line = `${" ".repeat(PATHOLOGICAL_LENGTH)}5`;
  const started = performance.now();
  const matched = compare("trim-trailing", `${line}\n`, `${line}\n`);
  const elapsedMs = performance.now() - started;

  assert.equal(matched, true);
  assert.ok(
    elapsedMs < LINEAR_TIME_BUDGET_MS,
    `trim-trailing took ${elapsedMs.toFixed(1)}ms on an interior ${PATHOLOGICAL_LENGTH}-space run (budget ${LINEAR_TIME_BUDGET_MS}ms)`,
  );
});

test("whitespace: every whitespace run collapses to one space and both ends are trimmed", () => {
  assert.equal(compare("whitespace", "1 2 3", "  1\t\t2\n\n3  "), true);
  assert.equal(compare("whitespace", "a\nb", "a b"), true);
});

test("whitespace: non-whitespace differences still fail", () => {
  assert.equal(compare("whitespace", "1 2", "1 3"), false);
  assert.equal(compare("whitespace", "12", "1 2"), false);
});

test("float-epsilon: tolerance is absolute below 1", () => {
  // |0.3333333 - 0.333333333| ~ 3.3e-8 <= max(EPS, EPS*0.33) = 1e-6
  assert.equal(compare("float-epsilon", "0.333333333", "0.3333333"), true);
  // 1e-5 apart, well outside a 1e-6 absolute tolerance.
  assert.equal(compare("float-epsilon", "0.00001", "0.00002"), false);
});

test("float-epsilon: tolerance is relative above 1", () => {
  // 1e6 * 1e-6 = 1.0 of slack, so a whole unit is inside tolerance...
  assert.equal(compare("float-epsilon", "1000000.0", "1000000.5"), true);
  // ...and two units are not.
  assert.equal(compare("float-epsilon", "1000000.0", "1000002.0"), false);
});

test("float-epsilon: token counts must match", () => {
  assert.equal(compare("float-epsilon", "1 2", "1 2 3"), false);
  assert.equal(compare("float-epsilon", "1 2", "1"), false);
  // Whitespace shape does not matter; only the token sequence does.
  assert.equal(compare("float-epsilon", "1\n2\n", "  1   2  "), true);
});

test("float-epsilon: a non-numeric token must be byte-equal", () => {
  assert.equal(compare("float-epsilon", "YES 1.0", "YES 1.0000001"), true);
  assert.equal(compare("float-epsilon", "YES", "yes"), false);
  // One side numeric, the other not: no tolerance applies, so the raw
  // tokens must match — and they do not.
  assert.equal(compare("float-epsilon", "1.0", "one"), false);
  // NaN/Infinity are not finite, so they fall through to byte equality.
  assert.equal(compare("float-epsilon", "nan", "nan"), true);
  assert.equal(compare("float-epsilon", "Infinity", "1e999"), false);
});

test("float-epsilon: two empty strings tokenize to nothing and match", () => {
  assert.equal(compare("float-epsilon", "", "   \n "), true);
});
