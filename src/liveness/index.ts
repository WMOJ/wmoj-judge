import { spawn } from "child_process";
import { constants as fsConstants, promises as fs } from "fs";
import * as os from "os";
import { config } from "../config";
import { logger } from "../util/logger";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { runSandboxed } from "../sandbox/nsjail";
import { gradeCase } from "../verdict";
import { toolchainProbes, type ToolchainProbe } from "../languages";

/**
 * Liveness: whether the judge can grade correctly right now. One list of
 * checks, two callers — boot (`assertAtBoot`, refuse to start on any
 * failure) and `GET /health` (`snapshot`/`refresh`, answer from a cache).
 *
 * Two cadences, because the checks differ by two orders of magnitude in
 * cost and in what they catch:
 *
 *   - "fast" (every `FAST_TTL_MS`): the three toolchain probes and a real
 *     jailed `/bin/true`. Cheap, and they catch a missing binary, a
 *     `policy.kafel` that will not compile, and a runner that launches
 *     but does not report.
 *   - "slow" (every `SLOW_TTL_MS`): the sandbox MEASURING — a CPU-bound
 *     probe that must come back with a real `cpuMs` and grade `TLE`. This
 *     used to run only at boot, so a judge whose resource accounting died
 *     after boot stayed green for the rest of its life while every TLE and
 *     MLE verdict it produced was wrong.
 *
 * Before this module, boot and `/health` answered "is the judge working?"
 * with two different check lists in two files, and the strong one ran
 * once. Now there is one definition, and `createLiveness` takes the list
 * as a parameter so the scheduling — TTLs, single flight, merging — is
 * tested with fake checks and an injected clock, while production gets
 * `productionChecks()`.
 */

export interface LivenessCheck {
  readonly name: string;
  /** "fast" runs on every `FAST_TTL_MS` refresh; "slow" on the `SLOW_TTL_MS` one. */
  readonly cadence: "fast" | "slow";
  /**
   * null = healthy; otherwise a reason specific enough to act on — it is
   * what `/health` puts in `reason` and what boot puts in its fatal log
   * line. A rejection is reported as a failure, never propagated.
   */
  run(): Promise<string | null>;
}

export interface LivenessSnapshot {
  readonly ok: boolean;
  /** "name: reason", every failing check across both cadences, fast first. */
  readonly failures: readonly string[];
  /** When each cadence last completed, per the injected clock. */
  readonly checkedAt: { readonly fast: number; readonly slow: number };
}

export interface Liveness {
  /** Last merged answer, or null before the first refresh. Never blocks. */
  snapshot(): LivenessSnapshot | null;
  /**
   * Re-run every cadence whose TTL has expired — none, when nothing is
   * due — single-flighted per cadence, and return the merged snapshot.
   */
  refresh(): Promise<LivenessSnapshot>;
  /**
   * Run every check once, regardless of TTL, and throw naming every
   * failure. Boot calls this and exits 1 on the throw.
   */
  assertAtBoot(): Promise<void>;
}

export interface LivenessOptions {
  readonly fastTtlMs?: number;
  readonly slowTtlMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
}

type Cadence = LivenessCheck["cadence"];

export const FAST_TTL_MS = 30_000;

/**
 * The measurement check burns roughly 200 ms of CPU on a ~0.1-CPU host
 * every time it runs, in direct competition with judging. Five minutes is
 * the trade between noticing a dead reporter and paying for the proof:
 * at this cadence it costs well under 0.1 % of the box.
 */
export const SLOW_TTL_MS = 300_000;

interface CadenceState {
  /** Failures from the last completed round, or null before the first. */
  failures: readonly string[] | null;
  checkedAt: number;
  inFlight: Promise<readonly string[]> | null;
}

/**
 * Run one cadence's checks in parallel and collect "name: reason" lines.
 *
 * Never rejects: each check is individually wrapped, because `spawn`
 * throws **synchronously** for every errno outside the handful it reports
 * via the 'error' event (ENOMEM among them). With no Express error
 * middleware — deliberate, see AGENTS.md — an escaping rejection on the
 * /health path would terminate the process under Node 20's default
 * `--unhandled-rejections=throw`.
 */
async function runChecks(
  checks: readonly LivenessCheck[],
): Promise<readonly string[]> {
  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        return { name: check.name, reason: await check.run() };
      } catch (err) {
        return { name: check.name, reason: (err as Error).message };
      }
    }),
  );
  return results.flatMap((r) =>
    r.reason === null ? [] : [`${r.name}: ${r.reason}`],
  );
}

export function createLiveness(
  checks: readonly LivenessCheck[],
  opts: LivenessOptions = {},
): Liveness {
  const ttl: Record<Cadence, number> = {
    fast: opts.fastTtlMs ?? FAST_TTL_MS,
    slow: opts.slowTtlMs ?? SLOW_TTL_MS,
  };
  const now = opts.now ?? Date.now;
  const state: Record<Cadence, CadenceState> = {
    fast: { failures: null, checkedAt: 0, inFlight: null },
    slow: { failures: null, checkedAt: 0, inFlight: null },
  };
  const byCadence = (cadence: Cadence): LivenessCheck[] =>
    checks.filter((c) => c.cadence === cadence);

  /**
   * Single flight per cadence: at most one round is ever in flight, and
   * every caller that arrives while it runs shares it.
   *
   * The /health cache used to be assigned only *after* the probes
   * resolved, up to 2 s later, so every request inside that window saw
   * the same expired entry and started its own round of spawns. /health
   * is unauthenticated by design and mounted ahead of the rate limiter,
   * so nothing else bounded that: a few hundred concurrent polls fork 4N
   * processes on a 512 MB box, the memory pressure lengthens the window,
   * the widened window admits more requests, and once the probes exceed
   * their timeout the resulting *degraded* answer is cached for 30 s —
   * long enough for Render to restart the instance and drop every
   * submission in flight.
   */
  function runCadence(cadence: Cadence): Promise<readonly string[]> {
    const s = state[cadence];
    if (s.inFlight !== null) return s.inFlight;
    s.inFlight = runChecks(byCadence(cadence))
      .then((failures) => {
        s.failures = failures;
        s.checkedAt = now();
        return failures;
      })
      .finally(() => {
        s.inFlight = null;
      });
    return s.inFlight;
  }

  function due(cadence: Cadence): boolean {
    const s = state[cadence];
    return s.failures === null || now() - s.checkedAt >= ttl[cadence];
  }

  function merged(): LivenessSnapshot | null {
    const fast = state.fast.failures;
    const slow = state.slow.failures;
    if (fast === null || slow === null) return null;
    const failures = [...fast, ...slow];
    return {
      ok: failures.length === 0,
      failures,
      checkedAt: { fast: state.fast.checkedAt, slow: state.slow.checkedAt },
    };
  }

  async function refresh(): Promise<LivenessSnapshot> {
    const cadences: Cadence[] = ["fast", "slow"];
    await Promise.all(cadences.filter(due).map(runCadence));
    const snapshot = merged();
    if (snapshot === null) {
      // Unreachable: a cadence that has never completed is `due`, and
      // the await above ran it. Kept as a typed guard rather than a cast.
      throw new Error("liveness: refresh completed without a snapshot");
    }
    return snapshot;
  }

  return {
    snapshot: merged,
    refresh,
    async assertAtBoot(): Promise<void> {
      await Promise.all([runCadence("fast"), runCadence("slow")]);
      const snapshot = merged();
      if (snapshot === null || !snapshot.ok) {
        const failures = snapshot?.failures ?? ["liveness: no snapshot"];
        logger.error({ failures }, "liveness checks failed at boot");
        throw new Error(`runtime degraded: ${failures.join(", ")}`);
      }
      logger.info("liveness checks passed");
    },
  };
}

// ---------------------------------------------------------------------------
// The production checks
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Run one toolchain probe, from `src/languages`: the binary a submission
 * in that language actually executes, and the flag that makes it exit 0.
 * Passes if it does so within `PROBE_TIMEOUT_MS`.
 *
 * The spawn takes its environment from `buildChildEnv()`, the same
 * four-variable allow-list user code gets, so a probe cannot pass on a
 * PATH or locale the real run would never see — and the judge's own
 * process.env never leaks into it. There is deliberately no per-probe env
 * knob: `buildChildEnv` builds one env for every language, and the probe
 * interface used to carry an `envLang` field advertising a
 * "language-flavoured env map" that the function ignored.
 *
 * Resolves to `null` (healthy) or a reason — never rejects.
 */
function runToolchainProbe(p: ToolchainProbe): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(p.bin, [...p.args], {
      // Nothing reads a probe's output. Piped-but-undrained streams
      // deadlock any tool whose --version is chatty enough to fill the
      // 64 KB pipe buffer: it blocks in write() forever and the probe
      // can only ever report "timeout".
      stdio: ["ignore", "ignore", "ignore"],
      env: buildChildEnv(),
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
 * The launch probe runs a real jailed process, because that is the only
 * thing that catches the failure that matters: nsjail exiting 255 on an
 * unreadable or uncompilable `policy.kafel` writes its diagnostic to fd 3
 * and leaves the child's stderr empty, so every test case of every
 * submission is graded `RE` on a clean HTTP 200 while /health reports
 * `{"status":"ok"}`. `fs.access` alone cannot see that: the file is
 * present and readable, it just does not compile.
 *
 * `/bin/true` is the smallest thing that still exercises the whole path
 * — argv build, nsjail launch, kafel parse, BPF install, execve, clean
 * exit.
 */
const SANDBOX_PROBE_ARGV = ["/bin/true"];
const SANDBOX_PROBE_TIME_MS = 1_000;
/** Same shape a default submission gets, so the probe exercises the real rlimit. */
const SANDBOX_PROBE_MEM_MB = 256;
/**
 * Last-resort bound on the launch probe: nsjail.ts's own SIGKILL grace is
 * 5 s past the time limit, so anything past 7 s means `runSandboxed`
 * itself is wedged. Without this, a wedged sandbox hangs the boot probe
 * forever and the deploy never finishes or fails.
 */
const SANDBOX_PROBE_DEADLINE_MS = 7_000;

/**
 * Check that the sandbox can actually launch something.
 *
 * `NSJAIL_BIN` and `SECCOMP_POLICY` are the two things every single
 * submission depends on, and neither used to be probed at all — so a
 * judge that graded every case of every submission `RE` still answered
 * `{"status":"ok"}` and Render never restarted it. The four steps below
 * fail with progressively more specific reasons: missing binary,
 * unreadable policy, a policy that exists but does not work, and a runner
 * that launches but does not report.
 */
async function probeSandboxLaunch(): Promise<string | null> {
  try {
    await fs.access(config.NSJAIL_BIN, fsConstants.X_OK);
  } catch (err) {
    return `${config.NSJAIL_BIN} not executable: ${(err as Error).message}`;
  }
  // Skipped, and only skipped, when no policy is going to be installed.
  // The launch below still runs in full either way, so the mode changes
  // what the probe requires rather than whether it runs — the normal path
  // keeps demanding a policy that exists AND compiles.
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
        `sandbox launch did not return within ${String(SANDBOX_PROBE_DEADLINE_MS)}ms`,
      );
    }, SANDBOX_PROBE_DEADLINE_MS);
  });
  const launch = runSandboxed({
    argv: [...SANDBOX_PROBE_ARGV],
    cwd: os.tmpdir(),
    label: "liveness:launch",
    timeLimitMs: SANDBOX_PROBE_TIME_MS,
    memLimitMb: SANDBOX_PROBE_MEM_MB,
    stdin: "",
  })
    .then((outcome): string | null => {
      // The runner's own fault channel comes first, and it cannot be
      // skipped: a launch that exits 0 with no resource report is the
      // reporter being dead, and `ok` is the only thing that says so —
      // the exit code and the streams all look healthy, which is how
      // /health answered "ok" while every /submit case was a 500. The
      // union is what makes forgetting that check a type error rather
      // than a silent green light.
      if (!outcome.ok) {
        return `sandbox launch failed: ${outcome.sandboxError}`;
      }
      const run = outcome.run;
      if (
        run.exitCode === 0 &&
        run.runnerSignal === null &&
        !run.nodeTimerFired
      ) {
        return null;
      }
      const killed = run.nodeTimerFired
        ? ", killed by the judge after the time limit"
        : run.runnerSignal !== null
          ? `, runner signalled ${run.runnerSignal}`
          : "";
      const what = SANDBOX_PROBE_ARGV.join(" ");
      return `sandbox launch failed: ${what} exited ${String(run.exitCode)}${killed}`;
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

/**
 * Proof that the sandbox MEASURES, and that the verdict module turns the
 * measurement into a verdict.
 *
 * The launch probe cannot catch the failure that actually shipped here:
 * the sandbox running but reporting nothing. `cpuMs`/`memKb` were `0` on
 * every run for the entire life of the nsjail 3.3 pin, because the code
 * scraped them from a log format nsjail does not emit. Nothing threw and
 * nothing logged; the judge simply reported zeros, and with them went
 * the authoritative CPU-time TLE gate and the RSS-based MLE rule.
 * Confirmed in production data: 3,457 stored cases, zero non-zero
 * `cpuMs`, and 94 real timeouts recorded as `WA`.
 *
 * So the sandbox proves itself: a shell loop deliberately overspends a
 * 50 ms budget, and the check demands BOTH halves of the contract — a
 * report with real CPU time, and `gradeCase` grading that measurement
 * `TLE` under the same limits. A judge that cannot measure must not
 * accept submissions, because every verdict it produces would be wrong
 * and nothing downstream would notice; at boot that means refusing to
 * start, and on the slow cadence it means `/health` going degraded so
 * Render restarts the instance instead of leaving it green for the rest
 * of its life.
 *
 * It also doubles as the nsjail/`policy.kafel` boot probe: an image whose
 * policy will not compile fails this with `ok: false` rather than grading
 * every submission `RE`.
 */
const MEASURE_PROBE_TIME_MS = 50;
const MEASURE_PROBE_MEM_MB = 128;
const MEASURE_PROBE_ARGV = [
  "/bin/sh",
  "-c",
  "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done",
];

async function probeSandboxMeasures(): Promise<string | null> {
  const outcome = await runSandboxed({
    argv: [...MEASURE_PROBE_ARGV],
    cwd: os.tmpdir(),
    label: "liveness:measure",
    timeLimitMs: MEASURE_PROBE_TIME_MS,
    memLimitMb: MEASURE_PROBE_MEM_MB,
    stdin: "",
  });
  if (!outcome.ok) {
    return `sandbox self-check could not run: ${outcome.sandboxError}`;
  }
  const run = outcome.run;
  if (run.cpuMs === undefined || run.cpuMs === 0) {
    return (
      "sandbox self-check measured cpuMs=0 for a CPU-bound probe -- resource " +
      "accounting is broken, so TLE and MLE would never fire"
    );
  }
  const result = await gradeCase(
    {
      index: 0,
      expected: "",
      run,
      limits: { timeLimitMs: MEASURE_PROBE_TIME_MS, memLimitMb: MEASURE_PROBE_MEM_MB },
    },
    async () => ({ passed: true }),
  );
  if (result.verdict !== "TLE") {
    return (
      `sandbox self-check burned cpuMs=${String(run.cpuMs)} against a ` +
      `${String(MEASURE_PROBE_TIME_MS)}ms limit but was graded ${result.verdict} ` +
      "instead of TLE -- the ladder is not reading the measurement"
    );
  }
  // The numbers, so a reader of the boot log or of Render's log stream
  // can see the accounting is alive rather than merely not failing.
  logger.info(
    { cpuMs: result.cpuMs, memKb: result.memKb, timeMs: result.timeMs },
    "liveness: sandbox measured",
  );
  return null;
}

/**
 * The checks production runs, in one place.
 *
 * The toolchain list is `languages.json`'s, not a hand-picked one:
 * `toolchainProbes()` returns one probe per distinct binary in the table
 * (python3, pypy3 and g++ today — the four C++ entries share one
 * compiler), so a language added to the JSON is probed at boot without
 * anyone remembering to add it here, and a language removed stops being
 * probed. The names are the ones `/health`'s `reason` has always used.
 */
export function productionChecks(): readonly LivenessCheck[] {
  const probes: readonly ToolchainProbe[] = toolchainProbes();
  return [
    ...probes.map(
      (p): LivenessCheck => ({ name: p.name, cadence: "fast", run: () => runToolchainProbe(p) }),
    ),
    { name: "sandbox-launch", cadence: "fast", run: probeSandboxLaunch },
    { name: "sandbox-measures", cadence: "slow", run: probeSandboxMeasures },
  ];
}

/** The production instance: what boot asserts and what `/health` serves. */
export const liveness: Liveness = createLiveness(productionChecks());
