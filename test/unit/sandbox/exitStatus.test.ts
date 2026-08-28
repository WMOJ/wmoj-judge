import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeJailExit,
  SIGKILL,
  SIGSYS,
  SIGXCPU,
} from "../../../src/sandbox/exitStatus";

/**
 * The single decoder of nsjail's `128 + WTERMSIG` status, and the reason
 * it exists: three places used to decode it and disagreed about where the
 * signal range ends. The boundaries are the whole content of this module,
 * so they are what these cases pin.
 */

test("a null exit code is 'none' — nothing ran, or the runner was signalled", () => {
  assert.deepEqual(decodeJailExit(null), { kind: "none" });
});

test("codes outside the signal range are the program's own", () => {
  // 128 is the interesting one: it looks like `128 + 0`, but WTERMSIG is
  // never 0, so a program that exits 128 chose to. 255 is nsjail's own
  // "could not execve", which must keep its distinct meaning.
  for (const code of [0, 1, 7, 42, 127, 128, 193, 254, 255]) {
    assert.deepEqual(
      decodeJailExit(code),
      { kind: "exited", code },
      `exit ${String(code)} must decode as a chosen exit code`,
    );
  }
});

test("129 through 192 decode as the signal that killed the child", () => {
  for (let code = 129; code <= 192; code += 1) {
    assert.deepEqual(
      decodeJailExit(code),
      { kind: "signalled", signal: code - 128 },
      `exit ${String(code)} must decode as signal ${String(code - 128)}`,
    );
  }
});

test("the boundaries hold on both sides", () => {
  // One off-by-one here turns a SIGHUP kill into "the program exited 129"
  // (an RE with no timeout flag) or a chosen exit 128 into "signal 0".
  assert.deepEqual(decodeJailExit(128), { kind: "exited", code: 128 });
  assert.deepEqual(decodeJailExit(129), { kind: "signalled", signal: 1 });
  assert.deepEqual(decodeJailExit(192), { kind: "signalled", signal: 64 });
  assert.deepEqual(decodeJailExit(193), { kind: "exited", code: 193 });
});

test("the named signals decode to the statuses the ladder and the checker read", () => {
  assert.deepEqual(decodeJailExit(128 + SIGKILL), {
    kind: "signalled",
    signal: SIGKILL,
  });
  assert.deepEqual(decodeJailExit(128 + SIGXCPU), {
    kind: "signalled",
    signal: SIGXCPU,
  });
  assert.deepEqual(decodeJailExit(128 + SIGSYS), {
    kind: "signalled",
    signal: SIGSYS,
  });
  // The numbers themselves, because the ladder compares against them and
  // a wrong constant is a wrong verdict with nothing to show for it.
  assert.equal(SIGKILL, 9);
  assert.equal(SIGXCPU, 24);
  assert.equal(SIGSYS, 31);
});
