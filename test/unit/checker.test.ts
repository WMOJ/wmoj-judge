import test from "node:test";
import assert from "node:assert/strict";
import type { RunMeasurement } from "../../src/types";
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
 * The function now takes the whole `RunMeasurement` rather than
 * `(exitCode, killedBy, stderr)`: the sandbox stopped classifying, so
 * there is no `killedBy` to hand it, and the two facts that replace it —
 * "the judge's last-resort timer fired" and "the runner itself was
 * signalled" — are raw fields on the measurement.
 */

/** Appended by the truncator, and counted against the cap, not added to it. */
const MARKER = "… (truncated)";
const MARKER_BYTES = Buffer.byteLength(MARKER, "utf8");

/**
 * A measurement for a checker that ran and exited under its own power.
 * Every field a case does not care about is set to the boring value, so
 * a test's `overrides` are exactly the fact it is about.
 */
function measurement(overrides: Partial<RunMeasurement> = {}): RunMeasurement {
  return {
    exitCode: 0,
    runnerSignal: null,
    cpuMs: 3,
    maxRssKb: 2048,
    jailWallMs: 4,
    nsjailExit: 0,
    nsjailSignal: 0,
    parentWallMs: 9,
    nodeTimerFired: false,
    stdout: "",
    stderr: "",
    truncated: false,
    ...overrides,
  };
}

function messageFor(stderr: string): string {
  return classifyCheckerResult(measurement({ exitCode: 1, stderr })).message;
}

test("exit 0 is accepted", () => {
  assert.deepEqual(classifyCheckerResult(measurement({ exitCode: 0 })), {
    outcome: "accepted",
    message: "",
    exitCode: 0,
  });
});

test("exit 1 is rejected — the checker answered 'wrong answer'", () => {
  assert.deepEqual(
    classifyCheckerResult(measurement({ exitCode: 1, stderr: "nope" })),
    { outcome: "rejected", message: "nope", exitCode: 1 },
  );
});

test("exit 2 (presentation error) folds into rejected — WMOJ has no PE verdict", () => {
  assert.equal(
    classifyCheckerResult(measurement({ exitCode: 2 })).outcome,
    "rejected",
  );
});

test("exit 3 is the checker declaring its own internal error", () => {
  assert.deepEqual(
    classifyCheckerResult(measurement({ exitCode: 3, stderr: "bad test data" })),
    { outcome: "internal-error", message: "bad test data", exitCode: 3 },
  );
});

test("an unconventional chosen code below 128 is rejected", () => {
  for (const exitCode of [4, 5, 6, 7, 42, 127]) {
    assert.equal(
      classifyCheckerResult(measurement({ exitCode })).outcome,
      "rejected",
      `exit ${String(exitCode)} must be rejected`,
    );
  }
});

test("128 and above is never a verdict — the checker could not answer", () => {
  // In `--mode o` nsjail's own exit status IS the child's fate:
  // 128 + WTERMSIG for a signal, and 255 when it could not execve at all.
  // Every one of these used to fall through to `default: rejected`.
  // 128 itself is a CHOSEN code (WTERMSIG is never 0) and is still
  // refused, because the policy is about which codes a checker may use.
  for (const exitCode of [128, 134, 139, 152, 159, 192, 193, 255]) {
    assert.equal(
      classifyCheckerResult(measurement({ exitCode })).outcome,
      "internal-error",
      `exit ${String(exitCode)} must be internal-error`,
    );
  }
});

test("127 is the last code a checker may still choose", () => {
  // Guards the boundary from both sides in one place: one off-by-one in
  // the policy either lets a segfault (139) be read as a verdict or
  // refuses a checker's own legitimate code.
  assert.equal(
    classifyCheckerResult(measurement({ exitCode: 127 })).outcome,
    "rejected",
  );
  assert.equal(
    classifyCheckerResult(measurement({ exitCode: 128 })).outcome,
    "internal-error",
  );
});

test("the judge's last-resort timer firing is an internal error, whatever the exit code", () => {
  // A checker the judge had to SIGKILL never finished its comparison, so
  // even a zero exit status mirrored back is not an answer.
  for (const exitCode of [0, 1, null]) {
    assert.equal(
      classifyCheckerResult(measurement({ exitCode, nodeTimerFired: true }))
        .outcome,
      "internal-error",
      `nodeTimerFired with exit ${String(exitCode)} must be internal-error`,
    );
  }
});

test("a signalled runner is an internal error even on a zero exit code", () => {
  assert.equal(
    classifyCheckerResult(measurement({ exitCode: 0, runnerSignal: "SIGKILL" }))
      .outcome,
    "internal-error",
  );
});

test("a null exit code (nothing ran) is an internal error", () => {
  assert.deepEqual(
    classifyCheckerResult(measurement({ exitCode: null, stderr: "boom" })),
    { outcome: "internal-error", message: "boom", exitCode: null },
  );
});

test("a missing resource report does not change the classification", () => {
  // `cpuMs`/`maxRssKb` are absent on a force-killed run. The checker's
  // verdict must come from its exit status alone; reading an absent
  // number as 0 and deciding from it is exactly the trap the optional
  // fields exist to make visible.
  const forceKilled = measurement({ exitCode: 1 });
  delete forceKilled.cpuMs;
  delete forceKilled.maxRssKb;
  delete forceKilled.jailWallMs;
  assert.equal(classifyCheckerResult(forceKilled).outcome, "rejected");
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

test("the message is taken from the checker's stderr on every arm", () => {
  // A message that only survived on the `rejected` path would leave an
  // `IE` with nothing to explain it, which is the state that made a
  // broken checker look like a healthy problem.
  for (const exitCode of [0, 1, 3, 139, null]) {
    assert.equal(
      classifyCheckerResult(measurement({ exitCode, stderr: " why \n" }))
        .message,
      "why",
      `exit ${String(exitCode)} must carry the checker's message`,
    );
  }
});
