// Shared types for wmoj-judge. Interfaces here are frozen per the plan's
// "Module boundaries" contract — A, B, C all import from this file.

export type Language =
  | "python3"
  | "pypy3"
  | "cpp14"
  | "cpp17"
  | "cpp20"
  | "cpp23";

export type Verdict = "AC" | "WA" | "TLE" | "MLE" | "RE" | "CE" | "IE";

export type CompareMode =
  | "exact"
  | "trim-trailing"
  | "whitespace"
  | "float-epsilon";

export interface SubmitRequest {
  language: Language | "python" | "cpp"; // legacy accepted during cutover
  code: string;
  input: string[];
  output: string[];
  timeLimit?: number;
  memoryLimit?: number;
  compareMode?: CompareMode;
  /**
   * Optional C++ source for a custom checker (problems whose answer is
   * not unique). Compiled once per submission with
   * `g++ -O2 -std=gnu++17` and invoked per test case as
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
   * out-of-jail runner — see `SandboxResult.cpuMs`. Between the
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
   * The memory cap actually enforced on the sandbox, in MB:
   * `min(requested ?? language default ?? 256, HOST_MEMORY_CEILING_MB)`.
   * A problem may declare more than the host can back; this reports what
   * was really applied.
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

export interface Executor {
  filename(code: string): string;
  prepare(workDir: string, code: string): Promise<void>;
  compile(
    workDir: string,
  ): Promise<{ ok: true } | { ok: false; stderr: string }>;
  buildRunCommand(workDir: string, filename: string): { argv: string[] };
}

export interface SandboxOpts {
  argv: string[];
  cwd: string;
  uid: number;
  gid: number;
  timeLimitMs: number;
  memLimitMb: number;
  /**
   * Optional override for the nsjail --rlimit_as VA-space cap. When set,
   * nsjail uses this value instead of `memLimitMb` for --rlimit_as.
   * Clamped to `>= memLimitMb` inside nsjail.ts.
   */
  rlimitAsMb?: number;
  stdin: string;
  chrootDir?: string;
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

export interface SandboxResult {
  /**
   * The jailed program's exit code as nsjail reports it: its own status
   * for a normal exit, or `128 + WTERMSIG` when a signal killed it.
   * `null` only when nothing ran (spawn failure) or the runner itself
   * was signalled — both of which also set `sandboxError`.
   */
  exitCode: number | null;
  timedOut: boolean;
  /** Peak RSS of the jailed process tree in KB. See `cpuMs`. */
  memKb: number;
  /**
   * Wall time of the jail, in ms: the runner's own measurement across
   * `fork()`→`wait4()` of nsjail, so it excludes Node's spawn latency
   * and V8 pauses. Falls back to parent-measured wall time only when
   * the run was force-killed and no report survived.
   */
  timeMs: number;
  /**
   * CPU time (user + system) of the jailed process tree in ms, from
   * `wait4()`'s `rusage`. This is the quantity `classifyKill` treats as
   * the authoritative TLE gate; it is real, kernel-accounted work, not
   * a number scraped out of nsjail's log.
   */
  cpuMs: number;
  stdout: string;
  stderr: string;
  killedBy: "TO" | "OOM" | "SIG" | null;
  /**
   * True when stdout or stderr exceeded its cap and the retained string
   * is a prefix. See `TestResult.truncated`.
   */
  truncated: boolean;
  /**
   * Set ONLY when the judge's own sandbox machinery failed, never for
   * anything the user's program did: nsjail or the runner could not be
   * spawned, nsjail bailed before executing anything (an unreadable or
   * uncompilable `--seccomp_policy`, a missing `--cwd`), or the run
   * produced no resource report at all.
   *
   * Callers must treat this as "the judge is wrong" — throw, so the
   * route's `catch` returns `500 {error}` — and must NOT grade it. The
   * failure it exists to stop is a container where `policy.kafel` will
   * not compile: nsjail exits 255 with its diagnostic on fd 3, so the
   * child's stdout and stderr are both empty, and every test case of
   * every submission comes back `RE` on a clean HTTP 200 while
   * `/health` still says `{"status":"ok"}`.
   *
   * Deliberately not `IE`: `IE` is documented as checker-only.
   */
  sandboxError?: string;
}

export interface UidPool {
  acquire(): Promise<number>;
  release(uid: number): void;
}

export interface WorkerPool {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export interface CompileCache {
  get(key: string): Promise<string | null>;
  put(key: string, artifactDir: string): Promise<string>;
}
