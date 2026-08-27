import { constants as fsConstants, promises as fs } from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import type { SandboxResult } from "../types";
import { runSandboxed } from "../sandbox/nsjail";
import { buildChildEnv } from "../sandbox/minimalEnv";
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
 * Exit status at or above which the checker cannot have chosen its own
 * exit code, so its result carries no verdict.
 *
 * In `--mode o` nsjail's own exit status IS the jailed child's fate:
 * `128 + WTERMSIG` when a signal killed it (139 SIGSEGV, 134 SIGABRT,
 * 159 SIGSYS — a syscall outside `policy.kafel`), and **255** when
 * nsjail could not `execve` the child at all. In every one of those
 * cases nsjail itself exits *normally*, so Node's `signal` argument is
 * `null` and `killedBy` can legitimately be `null` too — which is why
 * "could not answer" cannot be detected from `killedBy` alone.
 *
 * The documented "any other non-zero ⇒ rejected" row is about codes a
 * checker deliberately *chooses*; the testlib convention only uses 0–7,
 * so `>= 128` is unambiguous and 255 is included by it.
 */
const CHECKER_FATAL_EXIT_FLOOR = 128;

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
  /**
   * Set ONLY when the judge's own sandbox machinery failed while trying
   * to run the checker — see `SandboxResult.sandboxError`. Nothing of
   * the checker ran, so this is not a statement about the problem or the
   * submission and **must not be graded**: the caller throws, and the
   * route's `catch` turns it into the documented `500 {error}` judge-
   * fault channel. `outcome` is set to `internal-error` alongside it so
   * that a caller which ignores this field still cannot report `WA`.
   */
  sandboxError?: string;
}

/**
 * Compile the checker with the SAME hardcoded invocation
 * `/generate-tests` uses for generators:
 * `/usr/bin/g++ -O2 -std=gnu++17 Checker.cpp -o checker.out`.
 *
 * Deliberately not routed through `Executor.compile()`: that interface
 * takes only a workdir and compiles the single hardcoded `Main.cpp`
 * from `languages.json`, so it cannot compile a second file. Like the
 * generator's, this compile runs OUTSIDE nsjail — same trust boundary,
 * it is problem-setter source, not contestant source — but still with a
 * scrubbed child env.
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
    ["/usr/bin/g++", "-O2", "-std=gnu++17", srcPath, "-o", outPath],
    workDir,
    buildChildEnv("cpp17"),
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
 * Map a checker's sandbox result onto a `CheckerVerdict`. Pure — split
 * out from `runChecker` so the exit-code convention can be exercised
 * without a sandbox.
 *
 * Anything the checker could not answer authoritatively — killed by the
 * sandbox, dead by a signal, never exec'd, or an explicit exit 3 — is an
 * `internal-error`, which the caller turns into the `IE` verdict. It is
 * never silently folded into WA: a broken checker must be visible, not
 * blamed on the student.
 *
 * The `>= CHECKER_FATAL_EXIT_FLOOR` arm is the one that makes that true.
 * `killedBy !== null || exitCode === null` alone missed every checker
 * that segfaulted (139), aborted (134), tripped seccomp (159) or could
 * not be exec'd (255), because nsjail reports the child's death as its
 * OWN exit status and exits normally itself: those all fell through to
 * `default: rejected` and the whole problem was graded `WA` with no
 * `IE` anywhere, and — when the checker's stderr was empty — no
 * `checkerMessage` either. The problem looked healthy; the student
 * looked wrong. `classifyKill` now decodes `128 + WTERMSIG` as well, so
 * most of these arrive with `killedBy === "SIG"`; this stays as
 * belt-and-braces because the cost of being wrong here is invisible
 * mass-misgrading.
 */
export function classifyCheckerResult(
  exitCode: number | null,
  killedBy: SandboxResult["killedBy"],
  stderr: string,
): CheckerVerdict {
  const message = truncateBytes(stderr.trim(), CHECKER_MESSAGE_MAX_BYTES);

  // The checker was killed (TLE/OOM/signal), died by a signal nsjail
  // reported as its own status, could not be exec'd, or never started.
  if (
    killedBy !== null ||
    exitCode === null ||
    exitCode >= CHECKER_FATAL_EXIT_FLOOR
  ) {
    return { outcome: "internal-error", message, exitCode };
  }

  switch (exitCode) {
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
  /** Pool UID held by this submission. Diagnostics only, as elsewhere. */
  uid: number;
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
 * The one failure that is NOT graded is a `sandboxError`: that is the
 * judge's own machinery breaking, so it is handed back for the caller to
 * throw on.
 */
export async function runChecker(opts: RunCheckerOpts): Promise<CheckerVerdict> {
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

    const sb = await runSandboxed({
      argv: [`./${CHECKER_BINARY_FILENAME}`, inName, expName, outName],
      cwd: opts.workDir,
      uid: opts.uid,
      gid: opts.uid,
      timeLimitMs: CHECKER_TIME_LIMIT_MS,
      memLimitMb: CHECKER_MEM_LIMIT_MB,
      stdin: "",
    });

    if (sb.sandboxError !== undefined) {
      return {
        outcome: "internal-error",
        message: "",
        exitCode: sb.exitCode,
        sandboxError: sb.sandboxError,
      };
    }

    return classifyCheckerResult(sb.exitCode, sb.killedBy, sb.stderr);
  } catch (err) {
    return {
      outcome: "internal-error",
      message: truncateBytes(
        `checker harness error: ${(err as Error).message}`,
        CHECKER_MESSAGE_MAX_BYTES,
      ),
      exitCode: null,
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
