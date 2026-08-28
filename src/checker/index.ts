import { constants as fsConstants, promises as fs } from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import type { RunMeasurement } from "../types";
import { runSandboxed } from "../sandbox/nsjail";
import { decodeJailExit } from "../sandbox/exitStatus";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { setterCompileArgv } from "../languages";
import { runCompile } from "../util/compile";

/**
 * Custom checkers — for problems whose answer is not unique ("output any
 * valid arrangement").
 *
 * A checker is a C++ program compiled ONCE per submission and invoked
 * once per test case with three real file paths in the submission's
 * workdir:
 *
 *   checker.out <input_file> <expected_file> <contestant_output_file>
 *
 * Its exit code carries the verdict; its stderr carries the human
 * explanation. It runs through the same nsjail path as user code — a
 * checker is still just a C++ binary and a buggy one must not be able
 * to hang or escape the judge — but with its own generous limits.
 *
 * **The EXIT CODES are testlib's; the ARGUMENT ORDER deliberately is
 * not.** Upstream `testlib.h` binds `argv[2]` to the *participant's*
 * output and `argv[3]` to the *jury's* answer; wmoj passes them the
 * other way round, `<input> <expected> <received>`. A checker copied
 * from a testlib problem therefore validates the jury's own answer —
 * which is valid by construction — and exits 0 on every case, so every
 * submission to that problem silently scores 100% with nothing in the
 * response to distinguish it from an easy problem. Adapt a testlib
 * checker by swapping its two answer files before using it here, and
 * never describe the argument order as "the testlib convention".
 */

/** Source file the checker is written to inside the workdir. */
export const CHECKER_SOURCE_FILENAME = "Checker.cpp";

/** Compiled checker binary inside the workdir. */
export const CHECKER_BINARY_FILENAME = "checker.out";

/**
 * The checker gets far more headroom than a submission: it is trusted
 * problem-setter code, it may need to re-solve the case to validate an
 * answer, and it must never be the reason a correct solution fails.
 * The limits exist only so a buggy checker cannot wedge the judge.
 */
export const CHECKER_TIME_LIMIT_MS = 10_000;
export const CHECKER_MEM_LIMIT_MB = 256;

/** Cap on the per-case `checkerMessage` surfaced to the caller. */
export const CHECKER_MESSAGE_MAX_BYTES = 1024;

/** Appended by `truncateBytes` when it had to cut. Counted against the cap. */
const CHECKER_MESSAGE_TRUNCATED_MARKER = "… (truncated)";

/**
 * A single trailing U+FFFD, which is all a byte-boundary cut can ever
 * leave behind. Anchored and NOT repeated on purpose: `runSandboxed`
 * already maps the checker's malformed bytes (and NULs) to U+FFFD, so a
 * `+` here would eat replacement characters the checker legitimately
 * produced — and a message consisting only of them would collapse to a
 * bare truncation marker with no content at all.
 */
const TRAILING_REPLACEMENT_RE = /�$/;

/**
 * Outcome of running the checker on one test case.
 *
 *   accepted       exit 0                        -> the case passes
 *   rejected       exit 1 / 2 / other chosen 0-7 -> WA (2 is PE, treated as WA)
 *   internal-error exit 3, the checker was killed,
 *                  died by a signal, could not be
 *                  exec'd, or the harness could not
 *                  run it at all                 -> verdict `IE`
 */
export type CheckerOutcome = "accepted" | "rejected" | "internal-error";

export interface CheckerVerdict {
  outcome: CheckerOutcome;
  /** Trimmed, truncated checker stderr. Empty string when it said nothing. */
  message: string;
  /** Raw exit code, for logging. */
  exitCode: number | null;
}

/**
 * What one checker invocation produced: a verdict, or the judge's own
 * sandbox machinery failing before the checker could say anything.
 *
 * The fault arm is deliberately NOT a `CheckerVerdict` with an extra
 * field. It used to be — `outcome: "internal-error"` plus an optional
 * `sandboxError` — and an optional field is a field a caller can forget:
 * ignore it and the judge breaking becomes `IE`, a problem-configuration
 * fault billed to a problem that is fine. Behind `ok` there is no way to
 * reach the verdict without having looked. `ok: false` must be thrown on,
 * so the route's `catch` returns the documented `500 {error}`.
 */
export type CheckerRun =
  | { ok: true; verdict: CheckerVerdict }
  | { ok: false; sandboxError: string };

/**
 * Compile the checker with the problem-setter compile line from
 * `src/languages` — the same one `/generate-tests` builds its generators
 * with, now by CONSTRUCTION rather than by two hand-spelled copies
 * happening to agree. They did not: this one carried no `-fmax-errors`
 * and passed absolute paths, so a checker diagnostic leaked the
 * `/tmp/judge-<nanoid>` workdir into `checkerError`.
 *
 * The dialect is the SUBMISSION dialect (`cpp17`'s `-std=c++17`), not the
 * `gnu++17` this used to spell: all 64 problem-setter programs stored in
 * production compile clean under it, and none is testlib-derived — see
 * `docs/adr/0003-problem-setter-code-compiles-under-the-submission-dialect.md`.
 *
 * Like the generator's, this compile runs OUTSIDE nsjail — same trust
 * boundary, it is problem-setter source, not contestant source — but
 * still with a scrubbed child env.
 *
 * MUST be called after the compile cache has been populated for this
 * submission: the cache stores the whole workdir keyed on (language,
 * user code, compile argv), so a checker binary sitting in the workdir
 * at `put()` time would be served to a different problem that happens
 * to share the user's source.
 *
 * Every failure path — including writing `Checker.cpp` — resolves
 * `{ok:false, stderr}` rather than rejecting. An `ENOSPC` on the shared
 * `/tmp` used to escape as a rejection and become a 500, when the
 * contract says a checker that cannot be built is an HTTP 200 with
 * `checkerError`.
 */
export async function compileChecker(
  workDir: string,
  source: string,
): Promise<{ ok: true; binaryPath: string } | { ok: false; stderr: string }> {
  const srcPath = path.join(workDir, CHECKER_SOURCE_FILENAME);
  const outPath = path.join(workDir, CHECKER_BINARY_FILENAME);

  try {
    await fs.writeFile(srcPath, source, "utf8");
  } catch (err) {
    return {
      ok: false,
      stderr: `could not write ${CHECKER_SOURCE_FILENAME}: ${(err as Error).message}`,
    };
  }

  const result = await runCompile(
    setterCompileArgv(CHECKER_SOURCE_FILENAME, CHECKER_BINARY_FILENAME),
    workDir,
    buildChildEnv(),
  );
  return result.ok ? { ok: true, binaryPath: outPath } : result;
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes, cutting on a byte
 * boundary and dropping any partial multi-byte sequence left at the
 * end. A marker is appended so the caller can tell it was cut.
 *
 * The marker is counted **against** the cap, not added on top of it:
 * appending it afterwards made a 1400-byte message come back as 1039
 * bytes from a function whose JSDoc and whose caller both promised
 * 1024. Assumes `maxBytes` exceeds the marker's 15 bytes, which the only
 * caller's `CHECKER_MESSAGE_MAX_BYTES` does by two orders of magnitude.
 *
 * `s.slice(0, room)` before `Buffer.from` bounds the intermediate
 * allocation: a checker gets 10 s to write and its stderr arrives capped
 * at 64 KiB, and materialising the whole thing just to keep the first
 * kilobyte is pure waste. The slice is safe because a UTF-16 code unit
 * is never *fewer* than one UTF-8 byte, so `room` code units always
 * carry at least `room` bytes.
 */
function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const room = Math.max(
    0,
    maxBytes - Buffer.byteLength(CHECKER_MESSAGE_TRUNCATED_MARKER, "utf8"),
  );
  const cut = Buffer.from(s.slice(0, room), "utf8")
    .subarray(0, room)
    .toString("utf8")
    .replace(TRAILING_REPLACEMENT_RE, "");
  return `${cut}${CHECKER_MESSAGE_TRUNCATED_MARKER}`;
}

/**
 * Map a checker's measurement onto a `CheckerVerdict`. Pure — split out
 * from `runChecker` so the exit-code convention can be exercised without
 * a sandbox.
 *
 * Anything the checker could not answer authoritatively — killed by the
 * sandbox, dead by a signal, never exec'd, or an explicit exit 3 — is an
 * `internal-error`, which the caller turns into the `IE` verdict. It is
 * never silently folded into WA: a broken checker must be visible, not
 * blamed on the student.
 *
 * **The `code >= 128` arm is a POLICY, not a second decoder.**
 * `decodeJailExit` already says what nsjail's status means; on top of it
 * this function adds a rule about checker *trustworthiness*: exit codes
 * from 128 up are reserved for the `128 + WTERMSIG` encoding and for
 * nsjail's own 255 ("could not execve"), so a checker cannot legitimately
 * choose one, and a result carrying one cannot be read as a verdict.
 * Without that arm, a checker that segfaulted (139), aborted (134) or
 * could not be exec'd (255) fell through to `default: rejected` — nsjail
 * reports the child's death as its OWN exit status and exits normally, so
 * Node's signal is `null` — and the whole problem was graded `WA` with no
 * `IE` anywhere and, when the checker's stderr was empty, no
 * `checkerMessage` either. The problem looked healthy; the student looked
 * wrong. That is the failure this arm exists to prevent, and the cost of
 * being wrong here is invisible mass-misgrading.
 *
 * Note what is deliberately NOT consulted: the kill ladder. It lives in
 * `src/verdict` now and applies the *submission's* limits, not the
 * checker's. Every way a checker is actually killed still lands here —
 * `RLIMIT_CPU` and `RLIMIT_AS` both end in a signal, so a `signalled`
 * status; the judge's last-resort kill sets `nodeTimerFired`; a signalled
 * runner sets `runnerSignal`. What the ladder would have added on top is
 * "the checker answered, but spent more than its budget doing so", and a
 * checker that answered is a checker that answered.
 */
export function classifyCheckerResult(run: RunMeasurement): CheckerVerdict {
  const message = truncateBytes(run.stderr.trim(), CHECKER_MESSAGE_MAX_BYTES);
  const exitCode = run.exitCode;

  // The judge killed it, or the runner itself was signalled: nothing the
  // checker wrote can be trusted as a complete answer.
  if (run.nodeTimerFired || run.runnerSignal !== null) {
    return { outcome: "internal-error", message, exitCode };
  }

  const exit = decodeJailExit(exitCode);
  // `none` — nothing ran. `signalled` — the checker died by a signal
  // nsjail reported as its own status.
  if (exit.kind !== "exited") {
    return { outcome: "internal-error", message, exitCode };
  }
  if (exit.code >= 128) {
    return { outcome: "internal-error", message, exitCode };
  }

  switch (exit.code) {
    case 0:
      return { outcome: "accepted", message, exitCode };
    case 1:
      return { outcome: "rejected", message, exitCode };
    // Presentation error. WMOJ has no PE verdict, so it counts as WA —
    // the checker's stderr explains the formatting problem.
    case 2:
      return { outcome: "rejected", message, exitCode };
    case 3:
      return { outcome: "internal-error", message, exitCode };
    default:
      return { outcome: "rejected", message, exitCode };
  }
}

export interface RunCheckerOpts {
  /** Submission workdir; the compiled `checker.out` lives here. */
  workDir: string;
  /** Test-case index. Appears in the scratch filenames for readability. */
  index: number;
  /** Exactly the bytes the contestant's program received on stdin. */
  input: string;
  /** Exactly the expected output bytes from the request. */
  expected: string;
  /** Exactly the contestant program's stdout. */
  received: string;
}

/**
 * Run the compiled checker against one test case.
 *
 * Writes the three files into the workdir, invokes
 * `./checker.out <in> <exp> <out>` under nsjail with the checker's own
 * limits, then removes the scratch files (200 cases x up to 1 MB each
 * would otherwise pile up on a 512 MB host's /tmp).
 *
 * Paths are passed relative to the workdir, which nsjail sets as the
 * child's cwd — same convention as the `./a.out` run command, and it
 * keeps working if a chroot is ever reinstated. **`argv[2]` is the
 * EXPECTED answer and `argv[3]` is the contestant's output — the
 * reverse of testlib; see the file header.**
 *
 * Three things here exist to stop a contestant turning their own
 * submission into a judge error or a forged verdict:
 *
 *  - The scratch names carry a per-call `nanoid`. They used to be
 *    derived only from the case index, and the contestant's program runs
 *    at the same UID in the same workdir strictly *before* the next
 *    case's files are written — so on case 0 it could
 *    `mkdir("checker-received-1.txt")`, `writeFile` would fail `EISDIR`
 *    on case 1, and the whole submission returned HTTP 500 instead of a
 *    grade. `mkdir`/`chmod` are ALLOWed by `policy.kafel`; an unguessable
 *    name is what removes the lever.
 *  - `fs.access(…, X_OK)` proves the binary is still there and runnable
 *    *before* spawning, so "the checker never ran" is detected rather
 *    than inferred from an exit code. `unlink` is ALLOWed too, so a
 *    submission can delete `checker.out` on case 0.
 *  - Every remaining harness failure resolves to `internal-error`
 *    (→ `IE`) instead of rejecting. `IE` is exactly "the checker could
 *    not answer", it counts as failed in `summary`, and it keeps a
 *    single bad case from discarding every verdict already computed.
 *
 * The one failure that is NOT graded is `ok: false`: that is the judge's
 * own machinery breaking, so it is handed back, behind a discriminant the
 * caller cannot read past without looking, for the caller to throw on.
 */
export async function runChecker(opts: RunCheckerOpts): Promise<CheckerRun> {
  const token = nanoid(10);
  const inName = `checker-${opts.index}-${token}-input.txt`;
  const expName = `checker-${opts.index}-${token}-expected.txt`;
  const outName = `checker-${opts.index}-${token}-received.txt`;
  const files = [inName, expName, outName].map((n) => path.join(opts.workDir, n));

  try {
    await fs.access(
      path.join(opts.workDir, CHECKER_BINARY_FILENAME),
      fsConstants.X_OK,
    );

    await fs.writeFile(path.join(opts.workDir, inName), opts.input, "utf8");
    await fs.writeFile(path.join(opts.workDir, expName), opts.expected, "utf8");
    await fs.writeFile(path.join(opts.workDir, outName), opts.received, "utf8");

    const outcome = await runSandboxed({
      argv: [`./${CHECKER_BINARY_FILENAME}`, inName, expName, outName],
      cwd: opts.workDir,
      label: `checker:case${String(opts.index)}`,
      timeLimitMs: CHECKER_TIME_LIMIT_MS,
      memLimitMb: CHECKER_MEM_LIMIT_MB,
      stdin: "",
    });

    if (!outcome.ok) {
      return { ok: false, sandboxError: outcome.sandboxError };
    }

    return { ok: true, verdict: classifyCheckerResult(outcome.run) };
  } catch (err) {
    return {
      ok: true,
      verdict: {
        outcome: "internal-error",
        message: truncateBytes(
          `checker harness error: ${(err as Error).message}`,
          CHECKER_MESSAGE_MAX_BYTES,
        ),
        exitCode: null,
      },
    };
  } finally {
    // `recursive` because the scratch path could be a directory: an
    // unguessable name makes that unreachable for a contestant, but a
    // plain `fs.rm` without it cannot remove one at all, and every
    // un-removed case leaves up to 3 MB behind on a 512 MB host's /tmp
    // for the remaining life of the submission.
    await Promise.all(
      files.map((f) =>
        fs.rm(f, { force: true, recursive: true }).catch(() => {}),
      ),
    );
  }
}
