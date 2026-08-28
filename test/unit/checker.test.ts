import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCheckerResult,
  CHECKER_MESSAGE_MAX_BYTES,
} from "../../src/checker";

/**
 * `classifyCheckerResult` is the function that decides whether a custom
 * checker ANSWERED. Getting it wrong is invisible: every arm that should
 * be `internal-error` (verdict `IE`, a problem-configuration fault) and
 * is not instead becomes `rejected`, and the whole problem grades `WA`
 * with a healthy-looking response — the student looks wrong and the
 * broken checker looks fine. That is the failure these cases pin.
 *
 * `truncateBytes` is private, so the message rules are exercised through
 * this same entrypoint, which is also the only way the judge reaches
 * them.
 *
 * NOTE: this file is rewritten in the commit that turns the function's
 * input into a measurement; it is written against today's
 * `(exitCode, killedBy, stderr)` signature on purpose.
 */

/** Appended by the truncator, and counted against the cap, not added to it. */
const MARKER = "… (truncated)";
const MARKER_BYTES = Buffer.byteLength(MARKER, "utf8");

function messageFor(stderr: string): string {
  return classifyCheckerResult(1, null, stderr).message;
}

test("exit 0 is accepted", () => {
  assert.deepEqual(classifyCheckerResult(0, null, ""), {
    outcome: "accepted",
    message: "",
    exitCode: 0,
  });
});

test("exit 1 is rejected — the checker answered 'wrong answer'", () => {
  assert.deepEqual(classifyCheckerResult(1, null, "nope"), {
    outcome: "rejected",
    message: "nope",
    exitCode: 1,
  });
});

test("exit 2 (presentation error) folds into rejected — WMOJ has no PE verdict", () => {
  assert.equal(classifyCheckerResult(2, null, "").outcome, "rejected");
});

test("exit 3 is the checker declaring its own internal error", () => {
  assert.deepEqual(classifyCheckerResult(3, null, "bad test data"), {
    outcome: "internal-error",
    message: "bad test data",
    exitCode: 3,
  });
});

test("an unconventional chosen code below 128 is rejected", () => {
  assert.equal(classifyCheckerResult(7, null, "").outcome, "rejected");
});

test("128 and above is never a verdict — the checker could not answer", () => {
  // In `--mode o` nsjail's own exit status IS the child's fate:
  // 128 + WTERMSIG for a signal, and 255 when it could not execve at all.
  // Every one of these used to fall through to `default: rejected`.
  for (const exitCode of [128, 134, 139, 152, 159, 255]) {
    assert.equal(
      classifyCheckerResult(exitCode, null, "").outcome,
      "internal-error",
      `exit ${exitCode} must be internal-error`,
    );
  }
});

test("a killed checker is an internal error even on a zero exit code", () => {
  for (const killedBy of ["TO", "OOM", "SIG"] as const) {
    assert.equal(
      classifyCheckerResult(0, killedBy, "").outcome,
      "internal-error",
      `killedBy ${killedBy} must be internal-error`,
    );
  }
});

test("a null exit code (nothing ran) is an internal error", () => {
  assert.deepEqual(classifyCheckerResult(null, null, "boom"), {
    outcome: "internal-error",
    message: "boom",
    exitCode: null,
  });
});

test("stderr is trimmed at both ends", () => {
  assert.equal(messageFor("  \n  pair 1 2 does not sum to 9 \n\n"), "pair 1 2 does not sum to 9");
  assert.equal(messageFor("   \n "), "");
});

test("a message just under the cap is returned whole", () => {
  const stderr = "a".repeat(CHECKER_MESSAGE_MAX_BYTES - 1);
  assert.equal(messageFor(stderr), stderr);
});

test("a message at exactly the cap is returned whole, with no marker", () => {
  const stderr = "a".repeat(CHECKER_MESSAGE_MAX_BYTES);
  const message = messageFor(stderr);
  assert.equal(message, stderr);
  assert.equal(Buffer.byteLength(message, "utf8"), CHECKER_MESSAGE_MAX_BYTES);
  assert.equal(message.includes(MARKER), false);
});

test("one byte over the cap comes back at exactly the cap, marker included", () => {
  const stderr = "a".repeat(CHECKER_MESSAGE_MAX_BYTES + 1);
  const message = messageFor(stderr);
  // The marker is counted AGAINST the cap: appending it afterwards made a
  // function that promised 1024 return 1039.
  assert.equal(Buffer.byteLength(message, "utf8"), CHECKER_MESSAGE_MAX_BYTES);
  assert.equal(message.endsWith(MARKER), true);
  assert.equal(
    message.slice(0, -MARKER.length),
    "a".repeat(CHECKER_MESSAGE_MAX_BYTES - MARKER_BYTES),
  );
});

test("a message well over the cap comes back at exactly the cap", () => {
  const message = messageFor("a".repeat(64 * 1024));
  assert.equal(Buffer.byteLength(message, "utf8"), CHECKER_MESSAGE_MAX_BYTES);
  assert.equal(message.endsWith(MARKER), true);
});

test("a two-byte character cut at the boundary leaves no partial character", () => {
  // 1200 bytes of U+00E9. The cut lands at 1009 bytes — mid-character —
  // so the decoder produces one trailing U+FFFD, which is stripped.
  const message = messageFor("é".repeat(600));
  assert.equal(message.includes("�"), false);
  assert.equal(message.endsWith(MARKER), true);
  assert.ok(Buffer.byteLength(message, "utf8") <= CHECKER_MESSAGE_MAX_BYTES);
  assert.equal(message.slice(0, -MARKER.length), "é".repeat(504));
});

test("a four-byte character cut at the boundary leaves no partial character", () => {
  // Astral plane: two UTF-16 code units per character, so the `slice`
  // that bounds the intermediate allocation can split a surrogate pair
  // as well as a UTF-8 sequence.
  const message = messageFor("😀".repeat(400));
  assert.equal(message.includes("�"), false);
  assert.equal(message.endsWith(MARKER), true);
  assert.ok(Buffer.byteLength(message, "utf8") <= CHECKER_MESSAGE_MAX_BYTES);
  assert.equal(message.slice(0, -MARKER.length), "😀".repeat(252));
});

test("a U+FFFD the checker really wrote survives when nothing is truncated", () => {
  // `runSandboxed` maps the checker's malformed bytes and NULs to U+FFFD,
  // so they are legitimate content. The trailing-replacement strip is
  // anchored and un-repeated precisely so it cannot eat them.
  assert.equal(messageFor("bad byte: �"), "bad byte: �");
});
