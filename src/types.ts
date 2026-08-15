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
  cpuMs: number;
  memKb: number;
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
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  memKb: number;
  timeMs: number;
  cpuMs: number;
  stdout: string;
  stderr: string;
  killedBy: "TO" | "OOM" | "SIG" | null;
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
