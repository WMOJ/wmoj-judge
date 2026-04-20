import * as os from "os";

/**
 * Parse an integer environment variable. Returns `fallback` if the
 * variable is unset or cannot be parsed as a base-10 integer.
 */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parse a boolean environment variable. Accepts "true"/"1"/"yes" as true,
 * everything else (including unset) as `fallback`.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return fallback;
}

const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PROD = NODE_ENV === "production";

const cpuCount = Math.max(2, os.cpus().length);

function readSharedSecret(): string {
  const raw = process.env.JUDGE_SHARED_SECRET;
  if (raw && raw.length > 0) return raw;
  if (IS_PROD) {
    // Crash at boot — the judge must never run in prod without a secret.
    throw new Error(
      "JUDGE_SHARED_SECRET is required in production but was not set",
    );
  }
  return "";
}

export interface JudgeConfig {
  readonly PORT: number;
  readonly NODE_ENV: string;
  readonly IS_PROD: boolean;
  readonly JUDGE_SHARED_SECRET: string;
  readonly AUTH_STRICT: boolean;
  readonly UID_POOL_SIZE: number;
  readonly GLOBAL_SUBMIT_CONCURRENCY: number;
  readonly PER_SUBMISSION_CONCURRENCY: number;
  readonly COMPILE_CACHE_TTL_MS: number;
  readonly COMPILE_CACHE_DIR: string;
  readonly RATE_LIMIT_WINDOW_MS: number;
  readonly RATE_LIMIT_MAX: number;
  readonly NSJAIL_BIN: string;
  readonly SECCOMP_POLICY: string;
  readonly LOG_LEVEL: string;
}

/**
 * Typed, frozen configuration object. Read once at module load time so
 * the rest of the codebase never reaches into `process.env` directly.
 */
export const config: JudgeConfig = Object.freeze({
  PORT: intEnv("PORT", intEnv("JUDGE_PORT", 4001)),
  NODE_ENV,
  IS_PROD,
  JUDGE_SHARED_SECRET: readSharedSecret(),
  AUTH_STRICT: boolEnv("AUTH_STRICT", false),
  UID_POOL_SIZE: intEnv("UID_POOL_SIZE", 16),
  GLOBAL_SUBMIT_CONCURRENCY: Math.max(2, intEnv("GLOBAL_SUBMIT_CONCURRENCY", cpuCount)),
  PER_SUBMISSION_CONCURRENCY: Math.max(2, intEnv("PER_SUBMISSION_CONCURRENCY", cpuCount)),
  COMPILE_CACHE_TTL_MS: intEnv("COMPILE_CACHE_TTL_MS", 15 * 60 * 1000),
  COMPILE_CACHE_DIR: process.env.COMPILE_CACHE_DIR ?? "/tmp/judge-cache",
  RATE_LIMIT_WINDOW_MS: intEnv("RATE_LIMIT_WINDOW_MS", 60_000),
  RATE_LIMIT_MAX: intEnv("RATE_LIMIT_MAX", 60),
  NSJAIL_BIN: process.env.NSJAIL_BIN ?? "/usr/local/bin/nsjail",
  SECCOMP_POLICY: process.env.SECCOMP_POLICY ?? "/app/policy.kafel",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
});
