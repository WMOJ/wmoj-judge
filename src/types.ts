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
}

export interface SubmitResponse {
  summary: { total: number; passed: number; failed: number };
  results: TestResult[];
  compileError?: string;
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
