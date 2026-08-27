import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import { promises as fs, constants as fsConstants } from "fs";
import * as os from "os";
import { config } from "../config";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { runSandboxed } from "../sandbox/nsjail";
import languages from "../../languages.json";
import type { Language } from "../types";

/**
 * A single liveness check. Resolves to `null` when the dependency is
 * healthy, or to a human-readable reason when it is not — the reason is
 * what `/health` puts in `reason` and what the boot probe puts in its
 * fatal log line, so make it specific enough to act on.
 */
interface HealthCheck {
  name: string;
  run: () => Promise<string | null>;
}

/**
 * One toolchain probe: the binary to run and the version flag. Passes
 * if the process exits 0 within `PROBE_TIMEOUT_MS`.
 *
 * `envLang` selects which language-flavoured env map buildChildEnv
 * produces for the spawn — keeps every spawn going through the same
 * scrub path as user code (no leaking the judge's full process.env).
 */
interface ToolchainProbe {
  bin: string;
  args: string[];
  envLang: Language;
}

/**
 * The binaries below come from `languages.json` rather than being
 * spelled out here, because that is what submissions actually execute.
 * Probing a bare `python3`/`g++` resolved through PATH, as this used
 * to, means /health can pass against a completely different binary
 * from the absolute `/usr/bin/...` path every run and compile uses.
 */
function binOf(argv: readonly string[], what: string): string {
  const bin = argv[0];
  if (bin === undefined) {
    throw new Error(`languages.json: ${what} has an empty argv`);
  }
  return bin;
}

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * The sandbox probe runs a real jailed process, because that is the
 * only thing that catches the failure that matters: nsjail exiting 255
 * on an unreadable or uncompilable `policy.kafel` writes its diagnostic
 * to fd 3 and leaves the child's stderr empty, so every test case of
 * every submission is graded `RE` on a clean HTTP 200 while /health
 * reports `{"status":"ok"}`. `fs.access` alone cannot see that: the
 * file is present and readable, it just does not compile.
 *
 * `/bin/true` is used because it is the smallest thing that still
 * exercises the whole path — argv build, nsjail launch, kafel parse,
 * BPF install, execve, clean exit.
 */
const SANDBOX_PROBE_ARGV = ["/bin/true"];
const SANDBOX_PROBE_TIME_MS = 1_000;
/** Same shape a default submission gets, so the probe exercises the real rlimit. */
const SANDBOX_PROBE_MEM_MB = 256;
/**
 * Last-resort bound on the sandbox probe: nsjail.ts's own SIGKILL grace
 * is 5s past the time limit, so anything past 7s means `runSandboxed`
 * itself is wedged. Without this, a wedged sandbox hangs the boot probe
 * forever and the deploy never finishes or fails.
 */
const SANDBOX_PROBE_DEADLINE_MS = 7_000;

interface CachedHealth {
  ok: boolean;
  failures: string[];
  expiresAt: number;
}

let cached: CachedHealth | null = null;
let refreshInFlight: Promise<CachedHealth> | null = null;

/**
 * Run a single toolchain probe. Resolves to `null` (healthy) or a
 * reason — never rejects, so `Promise.all` sees every probe's result.
 */
function runToolchainProbe(p: ToolchainProbe): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(p.bin, p.args, {
      // Nothing reads a probe's output. Piped-but-undrained streams
      // deadlock any tool whose --version is chatty enough to fill the
      // 64 KB pipe buffer: it blocks in write() forever and the probe
      // can only ever report "timeout".
      stdio: ["ignore", "ignore", "ignore"],
      env: buildChildEnv(p.envLang),
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve("timeout");
    }, PROBE_TIMEOUT_MS);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err.message);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? null : `exit ${String(code)}`);
    });
  });
}

/**
 * Check that the sandbox can actually launch something.
 *
 * `NSJAIL_BIN` and `SECCOMP_POLICY` are the two things every single
 * submission depends on, and neither used to be probed at all — so a
 * judge that graded every case of every submission `RE` still answered
 * `{"status":"ok"}` and Render never restarted it. The three steps
 * below fail with progressively more specific reasons: missing binary,
 * unreadable policy, then a policy that exists but does not work.
 */
async function probeSandbox(): Promise<string | null> {
  try {
    await fs.access(config.NSJAIL_BIN, fsConstants.X_OK);
  } catch (err) {
    return `${config.NSJAIL_BIN} not executable: ${(err as Error).message}`;
  }
  // Skipped, and only skipped, when no policy is going to be installed.
  // The launch probe below still runs in full either way, so the mode
  // changes what the probe requires rather than whether it runs — the
  // normal path keeps demanding a policy that exists AND compiles.
  if (!config.UNSAFE_DISABLE_SECCOMP) {
    try {
      await fs.access(config.SECCOMP_POLICY, fsConstants.R_OK);
    } catch (err) {
      return `${config.SECCOMP_POLICY} not readable: ${(err as Error).message}`;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        `sandbox launch did not return within ${SANDBOX_PROBE_DEADLINE_MS}ms`,
      );
    }, SANDBOX_PROBE_DEADLINE_MS);
  });
  const launch = runSandboxed({
    argv: [...SANDBOX_PROBE_ARGV],
    cwd: os.tmpdir(),
    // The sandbox deliberately passes no --user/--group (see nsjail.ts),
    // so these are the judge's own ids and nsjail ignores them; they are
    // required by SandboxOpts, not by the jail.
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    timeLimitMs: SANDBOX_PROBE_TIME_MS,
    memLimitMb: SANDBOX_PROBE_MEM_MB,
    stdin: "",
  })
    .then((result): string | null => {
      if (result.exitCode === 0 && result.killedBy === null) return null;
      const killed =
        result.killedBy === null ? "" : `, killedBy ${result.killedBy}`;
      const what = SANDBOX_PROBE_ARGV.join(" ");
      return `sandbox launch failed: ${what} exited ${String(result.exitCode)}${killed}`;
    })
    .catch((err: unknown): string | null => {
      // Must never reject. When the deadline wins the race below there
      // is no handler left for a late rejection, and Node 20 would take
      // the whole process down over a failed health probe.
      return `sandbox launch threw: ${(err as Error).message}`;
    });

  try {
    return await Promise.race([launch, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const CHECKS: HealthCheck[] = [
  {
    name: "python3",
    run: () =>
      runToolchainProbe({
        bin: binOf(languages.python3.run.argv, "python3.run"),
        args: ["-V"],
        envLang: "python3",
      }),
  },
  {
    name: "pypy3",
    run: () =>
      runToolchainProbe({
        bin: binOf(languages.pypy3.run.argv, "pypy3.run"),
        args: ["--version"],
        envLang: "pypy3",
      }),
  },
  {
    name: "g++",
    run: () =>
      runToolchainProbe({
        bin: binOf(languages.cpp17.compile.argv, "cpp17.compile"),
        args: ["--version"],
        envLang: "cpp17",
      }),
  },
  { name: "sandbox", run: probeSandbox },
];

/**
 * Run every check in parallel and build a cache entry from the result.
 *
 * Never rejects: each check is individually wrapped, because `spawn`
 * throws **synchronously** for every errno outside the handful it
 * reports via the 'error' event (ENOMEM among them). With no Express
 * error middleware — deliberate, see AGENTS.md — an escaping rejection
 * on the /health path would terminate the process under Node 20's
 * default `--unhandled-rejections=throw`.
 */
async function computeHealth(): Promise<CachedHealth> {
  const results = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        return { name: check.name, reason: await check.run() };
      } catch (err) {
        return { name: check.name, reason: (err as Error).message };
      }
    }),
  );
  const failures = results.flatMap((r) =>
    r.reason === null ? [] : [`${r.name}: ${r.reason}`],
  );
  return {
    ok: failures.length === 0,
    failures,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

/**
 * Single-flight refresh: at most one round of probes is ever in flight,
 * and every caller that arrives while it runs shares it.
 *
 * The cache used to be assigned only *after* `computeHealth()` resolved
 * up to 2s later, so every request inside that window saw the same
 * expired entry and started its own round of spawns. /health is
 * unauthenticated by design and mounted ahead of the rate limiter, so
 * nothing else bounded that: a few hundred concurrent probes fork 4N
 * processes on a 512 MB box, the memory pressure lengthens the window,
 * the widened window admits more requests, and once the probes exceed
 * their timeout the resulting *degraded* answer is cached for 30s —
 * long enough for Render to restart the instance and drop every
 * submission in flight.
 */
function refreshHealth(): Promise<CachedHealth> {
  refreshInFlight ??= computeHealth()
    .then((next) => {
      cached = next;
      return next;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Eager probe at boot so operators notice a broken dependency right
 * away instead of only when a request arrives. Covers the sandbox as
 * well as the three language toolchains.
 *
 * THROWS by design when anything is missing or degraded, so
 * server.ts's `main().catch(...)` exits 1 rather than booting a judge
 * that would mis-grade every submission it is given.
 */
export async function probeToolchainAtBoot(): Promise<void> {
  const health = await refreshHealth();
  if (!health.ok) {
    logger.error({ failures: health.failures }, "runtime probes failed at boot");
    throw new Error(`runtime degraded: ${health.failures.join(", ")}`);
  }
  logger.info("runtime probes passed");
}

export const healthRouter: Router = Router();

/**
 * The 503 body, in one place so the shape `wmoj-app` reads never drifts
 * between the draining, probe-failure and caught-exception branches.
 *
 * `seccomp` reports whether the syscall filter is actually installed on every
 * run, additively — `status` and `version` are untouched, so no existing caller
 * changes. It is here because `UNSAFE_DISABLE_SECCOMP` is otherwise invisible
 * from outside the box: a judge running unfiltered answers `{"status":"ok"}`
 * exactly like a correctly sandboxed one, and the boot banner has long since
 * scrolled away. Anything that can reach /health can now tell them apart.
 */
function degraded(res: Response, reason: string): void {
  res.status(503).json({
    status: "degraded",
    reason,
    version: config.VERSION,
    seccomp: config.SECCOMP_STATUS,
  });
}

function respond(res: Response, health: CachedHealth): void {
  if (health.ok) {
    res.json({ status: "ok", version: config.VERSION, seccomp: config.SECCOMP_STATUS });
    return;
  }
  degraded(res, health.failures.join(", "));
}

/**
 * GET /health — NO auth middleware. Returns
 * `{ status: "ok", version }` (200) or
 * `{ status: "degraded", reason, version }` (503).
 *
 * Answered from a 30s cache, and while a refresh runs the previous
 * entry is served rather than every caller queueing behind the probes —
 * so the endpoint stays cheap and constant-cost no matter how many
 * unauthenticated clients poll it.
 *
 * Reports `degraded` with reason `draining` once a shutdown signal has
 * arrived. Otherwise Render's load balancer and wmoj-app's status page
 * both keep seeing a healthy instance for the whole drain window and
 * keep routing submissions to it — every one of which is answered with
 * the routes' own 503.
 *
 * `status` is unchanged and remains the contract every existing caller
 * (Render's probe, wmoj-app's `api/status/health`) reads. `version` is
 * purely additive: it is `RENDER_GIT_COMMIT` in production, so polling
 * /health from outside tells you exactly when a push went live. See
 * `resolveVersion` in config.ts.
 */
healthRouter.get("/", async (_req: Request, res: Response) => {
  try {
    if (isDraining()) {
      degraded(res, "draining");
      return;
    }

    const snapshot = cached;
    if (snapshot === null) {
      // Only reachable if the boot probe was bypassed; every normal
      // boot populates the cache before the server starts listening.
      respond(res, await refreshHealth());
      return;
    }
    if (snapshot.expiresAt <= Date.now()) {
      // Stale-while-revalidate. The rejection handler is mandatory, not
      // defensive: an unhandled rejection from this un-awaited promise
      // would take the process down.
      void refreshHealth().catch((err: unknown) => {
        logger.warn({ err }, "health: background refresh failed");
      });
    }
    respond(res, snapshot);
  } catch (err) {
    logger.error({ err }, "health: probe failed");
    if (!res.headersSent) {
      degraded(res, (err as Error).message);
    }
  }
});
