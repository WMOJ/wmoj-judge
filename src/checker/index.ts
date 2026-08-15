import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import type { SandboxResult } from "../types";
import { runSandboxed } from "../sandbox/nsjail";
import { buildChildEnv } from "../sandbox/minimalEnv";

/**
 * Custom checkers — the standard testlib/DMOJ convention for problems
 * whose answer is not unique ("output any valid arrangement").
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

/**
 * Outcome of running the checker on one test case.
 *
 *   accepted       exit 0                        -> the case passes
 *   rejected       exit 1 / 2 / any other non-0  -> WA (2 is PE, treated as WA)
 *   internal-error exit 3, or the checker itself
 *                  crashed / timed out / never ran -> verdict `IE`
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
 */
export async function compileChecker(
  workDir: string,
  source: string,
): Promise<{ ok: true; binaryPath: string } | { ok: false; stderr: string }> {
  const srcPath = path.join(workDir, CHECKER_SOURCE_FILENAME);
  const outPath = path.join(workDir, CHECKER_BINARY_FILENAME);
  await fs.writeFile(srcPath, source, "utf8");

  return new Promise((resolve) => {
    const env = buildChildEnv("cpp17");
    const child = spawn(
      "/usr/bin/g++",
      ["-O2", "-std=gnu++17", srcPath, "-o", outPath],
      { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, stderr: `spawn error: ${err.message}\n${stderr}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, binaryPath: outPath });
      } else {
        const combined = stderr + (stdout ? `\n${stdout}` : "");
        resolve({ ok: false, stderr: combined || `g++ exited ${code}` });
      }
    });
  });
}

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes, cutting on a byte
 * boundary and dropping any partial multi-byte sequence left at the
 * end. A marker is appended so the caller can tell it was cut.
 */
function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const cut = Buffer.from(s, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/�+$/, "");
  return `${cut}… (truncated)`;
}

/**
 * Map a checker's sandbox result onto a `CheckerVerdict`. Pure — split
 * out from `runChecker` so the exit-code convention can be exercised
 * without a sandbox.
 *
 * Anything the checker could not answer authoritatively (killed by the
 * sandbox, spawn failure, explicit exit 3) is an `internal-error`, which
 * the caller turns into the `IE` verdict. It is never silently folded
 * into WA: a broken checker must be visible, not blamed on the student.
 */
export function classifyCheckerResult(
  exitCode: number | null,
  killedBy: SandboxResult["killedBy"],
  stderr: string,
): CheckerVerdict {
  const message = truncateBytes(stderr.trim(), CHECKER_MESSAGE_MAX_BYTES);

  // The checker itself was killed (TLE/OOM/signal) or never started.
  if (killedBy !== null || exitCode === null) {
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
  /** Test-case index — makes the three scratch filenames unique. */
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
 * keeps working if a chroot is ever reinstated.
 */
export async function runChecker(opts: RunCheckerOpts): Promise<CheckerVerdict> {
  const inName = `checker-input-${opts.index}.txt`;
  const expName = `checker-expected-${opts.index}.txt`;
  const outName = `checker-received-${opts.index}.txt`;
  const files = [inName, expName, outName].map((n) => path.join(opts.workDir, n));

  try {
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

    return classifyCheckerResult(sb.exitCode, sb.killedBy, sb.stderr);
  } finally {
    await Promise.all(
      files.map((f) => fs.rm(f, { force: true }).catch(() => {})),
    );
  }
}
