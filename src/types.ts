// Shared types for wmoj-judge. Interfaces here are frozen per the plan's
// "Module boundaries" contract — A, B, C all import from this file.

/**
 * Re-exported, not declared: `Language` is now the `keyof` of
 * `languages.json` (see `src/languages`), so the accepted codes and the
 * table the judge runs from cannot drift apart the way a hand-kept union
 * beside a JSON file could. The contract still names it here.
 */
import type { Language } from "./languages";
export type { Language };

export type Verdict = "AC" | "WA" | "TLE" | "MLE" | "RE" | "CE" | "IE";

export type CompareMode =
  | "exact"
  | "trim-trailing"
  | "whitespace"
  | "float-epsilon";

export interface SubmitRequest {
  language: Language;
  code: string;
  input: string[];
  output: string[];
  timeLimit?: number;
  memoryLimit?: number;
  compareMode?: CompareMode;
  /**
   * Optional C++ source for a custom checker (problems whose answer is
   * not unique). Compiled once per submission with the problem-setter
   * compile line (`src/languages`' `setterCompileArgv`, the `cpp17`
   * entry's dialect) and invoked per test case as
   *
   *   checker.out <input_file> <expected_file> <contestant_output_file>
   *
   * Exit codes follow the testlib/DMOJ convention: 0 = accepted,
   * 1 = wrong answer, 2 = presentation error (treated as WA),
   * 3 = checker internal error (verdict `IE`), any other non-zero = WA.
   * The checker's stderr is surfaced per case as
   * `TestResult.checkerMessage`.
   *
   * Absent, null, or empty ⇒ the byte comparison selected by
   * `compareMode` is used, exactly as before checkers existed. When a
   * checker IS supplied it REPLACES `compareMode` entirely.
   */
  checker?: string;
}

export interface TestResult {
  index: number;
  exitCode: number | null;
  passed: boolean;
  expected: string;
  received: string;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  verdict: Verdict;
  timeMs: number;
  /**
   * CPU time (user + system) actually consumed by the jailed process
   * tree, in milliseconds. Measured by `wait4()`/`getrusage` in the
   * out-of-jail runner — see `RunMeasurement.cpuMs`. Between the
   * introduction of the nsjail 3.3 pin and that runner this was `0` on
   * every single run, which silently disabled the authoritative TLE
   * gate; treat a whole response of `cpuMs: 0` as a judge fault, not as
   * a set of very fast submissions.
   */
  cpuMs: number;
  /**
   * Peak RSS of the jailed process tree, in KB. Same provenance and the
   * same "0 everywhere means the judge is broken" caveat as `cpuMs`.
   */
  memKb: number;
  /**
   * Set when the program wrote more than the sandbox will retain, so
   * `stdout`/`stderr`/`received` above are a prefix rather than the
   * whole stream. Present only when something was actually dropped, so
   * responses for ordinary submissions stay byte-identical to before
   * the cap existed.
   *
   * A truncated run can still be graded: the cap sits above the largest
   * expected output `requestCaps` will accept, so a program that trips
   * it cannot have been `AC` anyway. It exists because an unbounded
   * `for(;;) puts("x")` used to accumulate hundreds of MB in the Node
   * heap of a 512 MB container and take the whole service down.
   */
  truncated?: boolean;
  /**
   * Trimmed, ~1 KB-truncated stderr of the custom checker for this
   * case. Present only when a `checker` was supplied AND the checker
   * actually ran (the program exited cleanly) AND it wrote something to
   * stderr. This is how a problem explains *why* an answer was rejected.
   */
  checkerMessage?: string;
}

export interface SubmitResponse {
  summary: { total: number; passed: number; failed: number };
  results: TestResult[];
  /**
   * The memory cap actually enforced on the sandbox, in MB — an integer:
   *   max(1, floor(min(max(requested, languageFloor) || 256, HOST_MEMORY_CEILING_MB)))
   * `max`, not `??`: both real clients always send a number, so a language
   * FLOOR (pypy3 → 384) has to win over a smaller declared limit or it
   * never applies. A consequence worth knowing: a problem cannot currently
   * declare a limit TIGHTER than a language's floor; the floor wins and
   * this field reports it, so the override is visible rather than silent.
   */
  effectiveMemoryLimitMb: number;
  /** The user's code failed to compile. Their fault. */
  compileError?: string;
  /**
   * The problem's custom checker failed to compile. A problem-configuration
   * fault, NOT the user's — deliberately a separate field from
   * `compileError` so `wmoj-app` never synthesizes a `CE` that blames the
   * student for our broken checker.
   */
  checkerError?: string;
}

export interface SandboxOpts {
  argv: string[];
  cwd: string;
  /**
   * Which call site spawned this jail — "submit:case3", "checker:case3",
   * "generator", "liveness:launch", "liveness:measure", "capture:<name>".
   * Diagnostics only: it is what ties a sandbox log line back to the work
   * that produced it, which the pool uid it replaces never did (every jail
   * runs as 1000). Required so a caller cannot forget it.
   */
  label: string;
  timeLimitMs: number;
  memLimitMb: number;
  stdin: string;
  /**
   * Cap, in bytes, on how much of the child's stdout the sandbox
   * retains. Defaults to `DEFAULT_MAX_STDOUT_BYTES` (1 MiB) in
   * `nsjail.ts`, which sits just above the 1,000,000-byte per-case
   * expected-output cap `requestCaps` enforces — so for `/submit` the
   * default can never truncate output that could have been `AC`.
   *
   * `/generate-tests` is the one caller whose stdout IS the payload
   * (a JSON array of every test input) and can legitimately exceed
   * 1 MiB; it must raise this deliberately rather than inherit the
   * `/submit` default.
   */
  maxStdoutBytes?: number;
  /**
   * Cap, in bytes, on retained child stderr. Defaults to
   * `DEFAULT_MAX_STDERR_BYTES` (64 KiB). `/generate-tests` carries its
   * expected outputs on stderr and has the same reason as above to
   * raise it.
   */
  maxStderrBytes?: number;
}

/**
 * The raw facts about one run. Carries NO verdict and NO threshold: every
 * "was it a timeout / did it blow memory" decision is `src/verdict`'s,
 * from these numbers and the limits the route enforced. That split is
 * what lets the whole TLE→MLE→RE→IE ladder be exercised from a JSON file
 * (`test/fixtures/measurements`) with no Linux kernel involved.
 */
export interface RunMeasurement {
  /**
   * nsjail's exit status as mirrored by wmoj-jailrun: the program's own
   * code, or 128+WTERMSIG when a signal killed it. null when the runner
   * itself was signalled or never ran.
   */
  exitCode: number | null;
  /** The signal that killed the RUNNER (Node's view of its direct child), or null. */
  runnerSignal: NodeJS.Signals | null;
  /**
   * From the runner's report. Absent only when no report survived, which
   * happens exactly when the judge force-killed the group.
   */
  cpuMs?: number;
  maxRssKb?: number;
  jailWallMs?: number;
  nsjailExit?: number;
  nsjailSignal?: number;
  /** Parent-measured wall, spawn to settle. Always present. */
  parentWallMs: number;
  /** Node's last-resort SIGKILL timer fired (timeLimitMs + KILL_GRACE_MS). */
  nodeTimerFired: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Either a measurement or a judge fault. `ok:false` is the former optional
 * `sandboxError` field made unignorable: a caller has to look at `ok`
 * before it can reach `run`, which is what stops a sixth call site
 * repeating the /health bug commit 1 fixed.
 *
 * `sandboxError` is set ONLY when the judge's own sandbox machinery
 * failed, never for anything the user's program did: nsjail or the runner
 * could not be spawned, nsjail bailed before executing anything (an
 * unreadable or uncompilable `--seccomp_policy`, a missing `--cwd`), or
 * the run produced no resource report at all. Callers must treat it as
 * "the judge is wrong" — throw, so the route's `catch` returns
 * `500 {error}` — and must NOT grade it. Deliberately not `IE`: `IE` is
 * documented as checker-only.
 */
export type RunOutcome =
  | { ok: true; run: RunMeasurement }
  | { ok: false; sandboxError: string };
