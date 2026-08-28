import * as os from "os";
import * as path from "path";

/**
 * Prefix shared by every judge-owned directory under `os.tmpdir()`:
 * the per-submission workdirs created in `util/workdir.ts` and the
 * compile cache rooted at `COMPILE_CACHE_DIR` below.
 *
 * The coupling is load-bearing. `startupSweep()` reclaims a previous
 * process's leftovers by removing every `os.tmpdir()` entry starting
 * with this prefix, and that sweep is the compile cache's ONLY
 * cross-restart reclamation path — the cache itself is TTL-only with no
 * size cap. Move the cache off this prefix, or off `os.tmpdir()`, and it
 * leaks forever.
 *
 * It lives in this module rather than in `util/workdir.ts` because
 * `COMPILE_CACHE_DIR` has to derive from it, and `util/workdir.ts`
 * imports `util/logger.ts`, which imports this module. Importing the
 * other way round would close a CommonJS require cycle and hand
 * `logger.ts` a half-initialised `config`, so pino would be constructed
 * with `level: undefined`.
 */
export const WORKDIR_PREFIX = "judge-";

interface NumericBounds {
  readonly min?: number;
  readonly max?: number;
}

/**
 * Parse an integer environment variable. Unset, empty, or
 * whitespace-only means "not configured" and yields `fallback`.
 * Anything else must be a complete base-10 integer inside `bounds`, or
 * the process refuses to boot.
 *
 * The previous implementation handed the raw string to
 * `Number.parseInt`, which takes the longest valid *prefix* and never
 * returns a non-finite value for a string that starts with a digit — so
 * the documented fallback never fired and a malformed value silently
 * became a different, wrong number. `HOST_MEMORY_CEILING_MB=1e6` became
 * 1 and clamped every submission to 1 MB, so even `print("hello")` came
 * back MLE; `COMPILE_CACHE_TTL_MS=15m` became a 15 ms TTL and the cache
 * never hit; `RATE_LIMIT_MAX=0` 429'd every gated request. Each of those
 * is a total, silent outage with no log line. Refusing to start on a
 * value the operator plainly meant as something else is the cheaper
 * failure, and this module is the env boundary whose job that is.
 */
function intEnv(
  name: string,
  fallback: number,
  bounds: NumericBounds = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `${name} must be a base-10 integer, got ${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  const { min, max } = bounds;
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}, got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}, got ${parsed}`);
  }
  return parsed;
}

/**
 * Read a string environment variable, treating empty and
 * whitespace-only as unset.
 *
 * `??` only catches `undefined`, so before this an exported-but-empty
 * `COMPILE_CACHE_DIR=""` made `path.join("", key)` **relative** and
 * landed the compile cache under `/app` — a directory that is writable
 * by user code (everything in the container runs as UID 1000) and that
 * no sweep ever touches.
 */
function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

/**
 * Parse a boolean environment variable. Accepts `true`/`1`/`yes` and
 * `false`/`0`/`no`, case-insensitively; unset or empty yields
 * `fallback`. Anything else throws.
 *
 * Silently falling back was safe-looking and wasn't: `AUTH_STRICT` is
 * the switch that decides whether the shared secret is checked at all,
 * and in soft mode `authMiddleware` lets a **missing** token through,
 * not just a wrong one. An operator who typed `AUTH_STRICT=on` in the
 * Render dashboard got `false`, a judge that booted healthy, a green
 * `/health`, and — with wide-open CORS, an unsandboxed compile path and
 * a 60 s / 1024 MB `/generate-tests` — arbitrary code execution for
 * anyone who found the URL. The only signal was one `warn` line per
 * request. A typo in a security switch must fail loudly.
 */
function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  throw new Error(
    `${name} must be one of true/false/1/0/yes/no, got ${JSON.stringify(raw)}`,
  );
}

/** Levels pino accepts for its `level` option. */
const PINO_LEVELS: readonly string[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
];

/**
 * Read `LOG_LEVEL` and reject anything pino would not accept. pino
 * throws on an unknown level from inside its own constructor, which in
 * this codebase happens while `util/logger.ts` is being imported — a
 * raw V8 stack from a module nobody suspects. Catching it here names
 * the variable that is wrong.
 */
function logLevelEnv(): string {
  const level = strEnv("LOG_LEVEL", "info").toLowerCase();
  if (!PINO_LEVELS.includes(level)) {
    throw new Error(
      `LOG_LEVEL must be one of ${PINO_LEVELS.join("/")}, got ${JSON.stringify(level)}`,
    );
  }
  return level;
}

const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PROD = NODE_ENV === "production";

const cpuCount = Math.max(1, os.cpus().length);

/**
 * The memory cap a submission ends up with when neither the request nor
 * the language declares one (`routes/submit.ts`). Used below only to
 * size the default global concurrency — i.e. how many *typical*
 * submissions this host could actually back at once.
 */
const DEFAULT_SUBMISSION_MEMORY_MB = 256;

/**
 * Epoch of this process, ISO-8601. Used as the "build timestamp" half of
 * the fallback deployment marker (see `resolveVersion`). A redeploy
 * always restarts the process, so this changes whenever new code goes
 * live.
 */
const BOOTED_AT = new Date().toISOString();

/**
 * `version` from package.json, read at runtime rather than imported so
 * the JSON stays outside tsconfig's `rootDir`. Resolves to
 * `<repo>/package.json` from `src/` under tsx and to `/app/package.json`
 * from `dist/` in the runtime image (the Dockerfile copies it there for
 * `npm ci --omit=dev`).
 */
function readPackageVersion(): string {
  try {
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Deployment marker surfaced by `GET /health` so a deploy can be
 * detected from outside without shell access to the box.
 *
 * Render injects `RENDER_GIT_COMMIT` automatically on every build, so in
 * production this is the exact SHA that is live. Off Render (local
 * Docker, `npm run dev`) it falls back to
 * `<package.json version>+<process start time>`, which still changes on
 * every restart.
 */
function resolveVersion(): string {
  const commit = strEnv("RENDER_GIT_COMMIT", "");
  if (commit) return commit;
  return `${readPackageVersion()}+${BOOTED_AT}`;
}

function readSharedSecret(): string {
  const raw = process.env.JUDGE_SHARED_SECRET;
  // Scrub the variable from process.env as soon as we've read it.
  // Sandboxed children inherit Node's UID on Render (see Dockerfile
  // for why), so /proc/<node_pid>/environ would be readable to user
  // code. We already strip env via sandbox/minimalEnv, but this closes
  // the /proc-based leak path even before the child starts.
  delete process.env.JUDGE_SHARED_SECRET;
  if (raw && raw.length > 0) return raw;
  if (IS_PROD) {
    throw new Error(
      "JUDGE_SHARED_SECRET is required in production but was not set",
    );
  }
  return "";
}

// HOST_MEMORY_CEILING_MB: the most memory this host can actually back.
// The free Render instance has 512 MB of RAM total, and the Node
// process, its heap, and the compile cache's page cache all live inside
// that same 512 MB -- so a ceiling of 512 hands a single submission the
// entire box and leaves the judge itself nothing. When a submission
// really does reside near its cap, the container's OOM killer fires
// before RLIMIT_AS does, every in-flight submission is lost, and nobody
// gets the clean MLE the contract promises. 384 leaves ~128 MB for the
// judge. Every submission's cap is clamped to
// min(requested, HOST_MEMORY_CEILING_MB) and the clamped value is
// reported back as `effectiveMemoryLimitMb`. Raise it via env only on a
// host with more RAM.
// Unset in both .env.local and the Render dashboard — default 384
// applies.
const HOST_MEMORY_CEILING_MB = intEnv("HOST_MEMORY_CEILING_MB", 384, {
  min: 1,
});

// GLOBAL_SUBMIT_CONCURRENCY: how many /submit requests may run in
// parallel. Derived from what the host can back rather than from
// os.cpus(): inside a container os.cpus() reads the *host's*
// /proc/cpuinfo and is blind to the CFS quota, so on a ~0.1-vCPU
// instance it reports 4-16 and the old default sized concurrency off a
// number that has nothing to do with this box. Memory is the real
// constraint, so scale with the ceiling and never exceed the visible
// core count. Raising HOST_MEMORY_CEILING_MB on a bigger host raises
// this with it. Floor of 1 honours operator env overrides (a prior
// Math.max(2, …) silently ignored "1").
// Unset in both .env.local and the Render dashboard — the derived
// default applies.
const DEFAULT_GLOBAL_SUBMIT_CONCURRENCY = Math.max(
  1,
  Math.min(
    cpuCount,
    Math.floor(HOST_MEMORY_CEILING_MB / DEFAULT_SUBMISSION_MEMORY_MB),
  ),
);

/**
 * LOCAL-DEVELOPMENT ESCAPE HATCH: run the sandbox with **no seccomp
 * filter at all**. Off by default, and refused outright in production.
 *
 * Why it exists. `policy.kafel` is written against the amd64 syscall
 * table, so the image is pinned `--platform=linux/amd64`. On an arm64
 * host (an Apple Silicon laptop) that image runs under QEMU user-mode
 * emulation, and the emulator cannot install an amd64 BPF program on an
 * arm64 kernel: `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` returns
 * EINVAL, nsjail exits 255 before executing anything, and the liveness
 * checks correctly refuse to boot. That refusal is right
 * — it replaced a judge that booted green and graded every submission
 * `RE` — but it also means the service cannot be run at all on the
 * hardware most of its contributors own. Neither
 * `--security-opt seccomp=unconfined` nor `--privileged` changes this;
 * it is the architecture mismatch, not Docker's own profile.
 *
 * What it costs, precisely. Syscalls are NOT filtered: the child may
 * open sockets and reach the network, call `ptrace`/`process_vm_readv`
 * against other processes sharing UID 1000, and use every syscall the
 * kernel offers. Everything else the sandbox does still applies —
 * rlimits (`RLIMIT_AS`/`CPU`/`NPROC`/`NOFILE`/`FSIZE`/`CORE`),
 * `--mode o` with all seven namespaces disabled, no-new-privs, the
 * inherited unprivileged UID 1000 with no capabilities, the 4-var env
 * allowlist, the per-submission workdir, and the process-group kill. So
 * TLE/MLE still work and the judge still measures; containment against
 * hostile code does not. Use it against code you wrote, never against
 * anything other people can submit to.
 *
 * The production guard is a throw, not a warning, and it is deliberate
 * that it lands here at module-import time: `NODE_ENV=production` is
 * baked into the Dockerfile, so the shipped image refuses this variable
 * unless the operator also overrides `NODE_ENV`, and there is no code
 * path by which a Render deploy can end up running unfiltered.
 */
const UNSAFE_DISABLE_SECCOMP = boolEnv("UNSAFE_DISABLE_SECCOMP", false);
if (UNSAFE_DISABLE_SECCOMP && IS_PROD) {
  throw new Error(
    "UNSAFE_DISABLE_SECCOMP is a local-development escape hatch and is refused " +
      "when NODE_ENV=production. It runs untrusted submissions with no syscall " +
      "filter. If you need production behaviour, run the judge on an amd64 " +
      "Linux host, where policy.kafel installs correctly.",
  );
}

export interface JudgeConfig {
  readonly PORT: number;
  readonly NODE_ENV: string;
  readonly IS_PROD: boolean;
  readonly JUDGE_SHARED_SECRET: string;
  readonly AUTH_STRICT: boolean;
  readonly UID_POOL_SIZE: number;
  readonly HOST_MEMORY_CEILING_MB: number;
  readonly GLOBAL_SUBMIT_CONCURRENCY: number;
  readonly PER_SUBMISSION_CONCURRENCY: number;
  readonly COMPILE_CACHE_TTL_MS: number;
  readonly COMPILE_CACHE_DIR: string;
  readonly RATE_LIMIT_WINDOW_MS: number;
  readonly RATE_LIMIT_MAX: number;
  readonly NSJAIL_BIN: string;
  readonly SECCOMP_POLICY: string;
  readonly UNSAFE_DISABLE_SECCOMP: boolean;
  /**
   * `UNSAFE_DISABLE_SECCOMP` rendered for humans, derived here so the boot
   * banner and every `/health` body cannot disagree about it.
   */
  readonly SECCOMP_STATUS: "enforced" | "disabled";
  readonly LOG_LEVEL: string;
  readonly VERSION: string;
}

/**
 * Typed, frozen configuration object. Read once at module load time so
 * the rest of the codebase never reaches into `process.env` directly.
 *
 * Env-var convention: the only env vars currently set in both
 * `.env.local` and the Render dashboard's Environment Variables panel
 * are `JUDGE_SHARED_SECRET` and `AUTH_STRICT` (the two that .env.local
 * instructs operators to mirror into Render). Every other variable
 * referenced below is intentionally left unset — the fallback after
 * the comma (or `??`) is the effective value in production. Each
 * unset var is tagged inline below for clarity. Set an env var on a
 * specific deploy only when you genuinely need a non-default value.
 *
 * A rejected value throws from here, which is *module import* time —
 * before `server.ts`'s `main().catch(...)` exists — so it surfaces as an
 * uncaught exception and exit 1 rather than as the structured
 * "fatal: boot failed" line. That is deliberate for now: the process
 * must not come up misconfigured, and routing these through `main()`
 * means resolving the config lazily, which every importer of `config`
 * would have to be rewritten for.
 */
export const config: JudgeConfig = Object.freeze({
  // PORT (and fallback JUDGE_PORT): unset in both .env.local and the
  // Render dashboard — default 4001 applies.
  PORT: intEnv("PORT", intEnv("JUDGE_PORT", 4001, { min: 1, max: 65535 }), {
    min: 1,
    max: 65535,
  }),
  NODE_ENV,
  IS_PROD,
  JUDGE_SHARED_SECRET: readSharedSecret(),
  // AUTH_STRICT: set in both .env.local and the Render dashboard (one
  // of only two vars that are). Defaults to IS_PROD, so production is
  // closed unless someone explicitly opens it, while a local run still
  // fails open the way the dev workflow expects — outside production
  // the shared secret is "", which strict mode would reject every
  // request against. `readSharedSecret()` above already hard-fails a
  // missing secret in production; this is the matching assertion for
  // the switch that decides whether the secret is consulted at all.
  AUTH_STRICT: boolEnv("AUTH_STRICT", IS_PROD),
  // UID_POOL_SIZE: the true concurrency ceiling — it covers both gated
  // endpoints, unlike the /submit-only semaphore. Values above 16 hand
  // out UIDs the Dockerfile creates no accounts for; harmless while
  // nsjail is invoked without `--user`, but see sandbox-changes before
  // relying on it.
  // Unset in both .env.local and the Render dashboard — default 16
  // applies.
  UID_POOL_SIZE: intEnv("UID_POOL_SIZE", 16, { min: 1, max: 4096 }),
  HOST_MEMORY_CEILING_MB,
  GLOBAL_SUBMIT_CONCURRENCY: intEnv(
    "GLOBAL_SUBMIT_CONCURRENCY",
    DEFAULT_GLOBAL_SUBMIT_CONCURRENCY,
    { min: 1 },
  ),
  // PER_SUBMISSION_CONCURRENCY: how many test cases within a single
  // submission run in parallel. Default 1 (serial) so each test's CPU
  // and wall measurements are clean — under parallel execution on
  // shared vCPUs, wall time inflates with the scheduler's round-robin
  // and made TLE verdicts non-deterministic. Operators on dedicated
  // multi-core hardware can raise this via env var.
  // Unset in both .env.local and the Render dashboard — default 1
  // applies.
  PER_SUBMISSION_CONCURRENCY: intEnv("PER_SUBMISSION_CONCURRENCY", 1, {
    min: 1,
  }),
  // COMPILE_CACHE_TTL_MS: unset in both .env.local and the Render
  // dashboard — default 15 minutes applies.
  COMPILE_CACHE_TTL_MS: intEnv("COMPILE_CACHE_TTL_MS", 15 * 60 * 1000, {
    min: 0,
  }),
  // COMPILE_CACHE_DIR: derived from os.tmpdir() and WORKDIR_PREFIX, not
  // from a hardcoded "/tmp/judge-cache". os.tmpdir() honours
  // TMPDIR/TMP/TEMP, and `startupSweep()` — the cache's only
  // cross-restart reclamation — sweeps os.tmpdir(). With the literal,
  // a single `docker run -e TMPDIR=/var/tmp` moved the workdirs and
  // left the cache at /tmp/judge-cache, swept by nothing, forever.
  // Unset in both .env.local and the Render dashboard — default
  // <tmpdir>/judge-cache applies.
  COMPILE_CACHE_DIR: strEnv(
    "COMPILE_CACHE_DIR",
    path.join(os.tmpdir(), `${WORKDIR_PREFIX}cache`),
  ),
  // RATE_LIMIT_WINDOW_MS: unset in both .env.local and the Render
  // dashboard — default 60s applies.
  RATE_LIMIT_WINDOW_MS: intEnv("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1 }),
  // RATE_LIMIT_MAX: unset in both .env.local and the Render dashboard
  // — default 60 requests per window applies. Floored at 1 because 0
  // means "429 everything", a total outage that reads like a healthy
  // deploy.
  RATE_LIMIT_MAX: intEnv("RATE_LIMIT_MAX", 60, { min: 1 }),
  // NSJAIL_BIN: unset in both .env.local and the Render dashboard —
  // default /usr/local/bin/nsjail applies.
  NSJAIL_BIN: strEnv("NSJAIL_BIN", "/usr/local/bin/nsjail"),
  // SECCOMP_POLICY: unset in both .env.local and the Render dashboard
  // — default /app/policy.kafel applies. That path only exists in the
  // image; running from a source checkout must point this at the
  // repo's policy.kafel or every run fails to start the jail and every
  // submission is graded RE (see README, "Run from source").
  SECCOMP_POLICY: strEnv("SECCOMP_POLICY", "/app/policy.kafel"),
  // UNSAFE_DISABLE_SECCOMP: unset everywhere that matters — default
  // false, and the guard above makes `true` unreachable in production.
  // Set it only on a developer machine that cannot install the amd64
  // BPF filter (see the comment on the constant); `server.ts` logs a
  // banner and `/health` reports `seccomp: "disabled"` while it is on.
  UNSAFE_DISABLE_SECCOMP,
  SECCOMP_STATUS: UNSAFE_DISABLE_SECCOMP ? "disabled" : "enforced",
  // LOG_LEVEL: unset in both .env.local and the Render dashboard —
  // default "info" applies.
  LOG_LEVEL: logLevelEnv(),
  // VERSION: derived, not configured. RENDER_GIT_COMMIT is injected by
  // Render on every build; off-Render it falls back to the package.json
  // version plus this process's start time. Surfaced by GET /health.
  VERSION: resolveVersion(),
});
