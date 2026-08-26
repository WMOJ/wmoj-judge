import { spawn } from "child_process";
import type { SandboxOpts, SandboxResult } from "../types";
import { buildChildEnv } from "./minimalEnv";
import { logger } from "../util/logger";
import { config } from "../config";

/**
 * How long to wait (past the submission time limit) before Node sends
 * a SIGKILL of last resort. nsjail should have killed the child via
 * RLIMIT_CPU well before this, so reaching this timer indicates a
 * stuck nsjail or kernel issue rather than a runaway user program.
 *
 * Sized to absorb per-spawn overhead spikes (nsjail fork+exec, kafel
 * parse, BPF compile, V8 GC) without false kills under load, while
 * still firing well within Render's SIGTERM→SIGKILL drain window.
 */
const KILL_GRACE_MS = 5000;

/**
 * Fraction of the memory cap at which peak RSS counts as "hit the
 * limit". Shared with `submit.ts`'s MLE classification so the sandbox
 * and the verdict layer agree on the threshold. See the comment at the
 * RSS check in `classifyKill` for why it isn't 1.0.
 */
export const MEM_LIMIT_RSS_RATIO = 0.98;

interface NsjailMeta {
  exitReason?: string;
  maxRssKb?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  signal?: number;
}

/**
 * Convert a submission's time budget in ms to the RLIMIT_CPU value
 * nsjail wants in whole seconds. +1s of slack so short (<1s) limits
 * don't underflow and so RLIMIT_CPU triggers strictly after the
 * userland CPU check in classifyKill — RLIMIT_CPU is a kernel-level
 * backstop against runaway CPU, while `meta.cpuTimeMs >= timeLimitMs`
 * is the authoritative TLE gate with sub-second precision.
 */
function cpuLimitSecFor(timeLimitMs: number): number {
  return Math.ceil(timeLimitMs / 1000) + 1;
}

/**
 * Shell out to nsjail with the argv described in the plan.
 * Responsibilities:
 *   - Build argv: disabled namespaces, --keep_caps, cwd, rlimits,
 *     seccomp policy, env allow-list. Deliberately NO --chroot and no
 *     --user/--group -- see the comments above the argv below.
 *   - Stream `opts.stdin` to the child, collect stdout/stderr.
 *   - Parse nsjail's own diagnostic output on --log_fd=3 (a dedicated
 *     pipe, separate from the child's stderr — see comment on the
 *     stdio array below for why).
 *   - Honour the node-side last-resort SIGKILL timer.
 */
export async function runSandboxed(
  opts: SandboxOpts,
): Promise<SandboxResult> {
  const cpuSec = cpuLimitSecFor(opts.timeLimitMs);
  // --rlimit_fsize is in MB per nsjail's docs; --rlimit_as is in MB.
  const memLimitMb = Math.max(1, Math.floor(opts.memLimitMb));
  // Optional caller override for --rlimit_as (VA space). Kept for
  // future runtimes that need more virtual address space than the
  // user-visible memory cap; currently unused by any language.
  const rlimitAsMb = opts.rlimitAsMb !== undefined
    ? Math.max(memLimitMb, Math.floor(opts.rlimitAsMb))
    : memLimitMb;

  // No --chroot: Render's unprivileged containers do not grant
  // CAP_SYS_ADMIN, so we cannot bind-mount /usr, /lib, /etc/alternatives,
  // etc. into a per-submission chroot. Chrooting into just the workdir
  // would hide the language runtimes (/usr/bin/python3, /usr/bin/g++
  // shims, etc.) from the child, breaking execve. We rely on:
  //   - unprivileged pool UID (cannot read /app or other pool UIDs' workdirs)
  //   - 0700 workdir perms (cross-submission isolation)
  //   - seccomp allow-list (blocks network, ptrace, namespace ops, etc.)
  //   - --disable_clone_new* (prevents any new namespaces)
  //   - kernel rlimits (memory / cpu / procs / files)
  // `opts.chrootDir` is accepted in the type for forward-compat but
  // ignored here until the runtime platform supports bind-mounting.
  //
  // No --user / --group: the Dockerfile drops Node to UID 1000 (see
  // `USER 1000` and the comment there). Asking nsjail to setresuid() to
  // anything other than our own UID fails EPERM because a non-root
  // process cannot switch to a foreign UID, and nsjail bails with
  // "Launching child process failed" (exit 255). The sandbox child
  // therefore inherits Node's UID implicitly; the UID pool in
  // queue/uidPoolSingleton still exists as a concurrency gate, but the
  // numeric UID is no longer plumbed here. Isolation between concurrent
  // submissions comes from per-submission 0700 workdirs owned by that
  // same UID, and the seccomp policy blocks every cross-process probe
  // (ptrace, process_vm_*, kcmp) so they cannot see each other's memory.
  const argv: string[] = [
    "--mode", "o",
    "--disable_clone_newuser",
    "--disable_clone_newnet",
    "--disable_clone_newns",
    "--disable_clone_newpid",
    "--disable_clone_newipc",
    "--disable_clone_newuts",
    "--disable_clone_newcgroup",
    // --keep_caps skips nsjail's prctl(PR_SET_SECUREBITS,
    // SECBIT_KEEP_CAPS | SECBIT_NO_SETUID_FIXUP), which requires
    // CAP_SETPCAP and is denied on Render's unprivileged containers
    // ("Operation not permitted"). Since we also omit --user/--group
    // below (no setuid happens), the child inherits Node's UID 1000
    // and its already-dropped capability set -- still unprivileged,
    // no-new-privs, with the full seccomp allow-list and rlimits.
    "--keep_caps",
    "--cwd", opts.cwd,
    "--rlimit_as", String(rlimitAsMb),
    "--rlimit_cpu", String(cpuSec),
    // 256 is comfortable for multi-threaded runtimes (PyPy, any future
    // thread-heavy language) and still far below anything a malicious
    // submission could use for DoS given RLIMIT_AS / RLIMIT_CPU are
    // also in effect.
    "--rlimit_nproc", "256",
    "--rlimit_nofile", "256",
    "--rlimit_fsize", "10",
    "--rlimit_core", "0",
    "--seccomp_policy", config.SECCOMP_POLICY,
    "--env", "PATH",
    "--env", "LANG",
    "--env", "LC_ALL",
    "--env", "PYTHONUNBUFFERED",
    // nsjail's --time_limit is wall-clock and serves only as a liveness
    // backstop; CPU time (via --rlimit_cpu and userland cpuTimeMs check
    // in classifyKill) is authoritative for TLE. Set generously beyond
    // Node's own SIGKILL timer so we get one authoritative wall kill
    // (Node's) rather than racing two wall timers against setup overhead.
    "--time_limit", String(Math.ceil((opts.timeLimitMs + KILL_GRACE_MS) / 1000) + 2),
    // Route nsjail's own diagnostic output to fd 3 (a dedicated pipe set
    // up below via stdio: [..., "pipe"]) instead of fd 2. If we let nsjail
    // log to fd 2, its `[L][timestamp] ...` lines interleave with the
    // child's stderr at the byte level (cerr's unit-buffered writes can
    // be split mid-array by nsjail logger writes). That cross-talk broke
    // /generate-tests entirely, because the generator's stderr-side JSON
    // array (`[...]`) shares a leading `[` with nsjail's log prefix, so
    // any string-based "strip lines that start with [" filter either ate
    // the user's JSON outright or fragmented it into something that
    // JSON.parse choked on ("Unexpected non-whitespace character after
    // JSON at position N"). Keeping them on separate fds is the only
    // robust fix — the child's stderr is now byte-clean.
    "--log_fd", "3",
    "--",
    ...opts.argv,
  ];

  // nsjail reads PATH/LANG/... from its own environment and forwards
  // them to the jailed child via `--env <VAR>` (name-only form).
  // Nothing else from the judge's own env leaks through.
  const jailEnv = buildChildEnv("python3");

  const started = Date.now();
  // Four stdio slots: stdin (0), child stdout (1), child stderr (2),
  // and a dedicated pipe (3) that nsjail's `--log_fd 3` writes its own
  // diagnostics to. Keeping nsjail's log on fd 3 means fd 2 carries
  // ONLY the child's stderr — no interleaving, no string-based filter
  // needed downstream. (See the comment on `--log_fd 3` in argv above
  // for the full background.)
  const child = spawn(config.NSJAIL_BIN, argv, {
    cwd: opts.cwd,
    env: jailEnv,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  // Feed stdin and close. If the child never reads, the pipe EOFs and
  // the child sees EOF on read — correct behaviour for CP judging.
  child.stdin.on("error", () => {
    // EPIPE when child exits before consuming stdin — not a judge-side
    // error, ignore.
  });
  child.stdin.write(opts.stdin);
  child.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const logChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
  // child.stdio[3] is the parent-side end of the log pipe. It's typed as
  // Readable | Writable | null in Node's TS defs (the spawn() options
  // can produce either direction), but for our `stdio: [..., "pipe"]`
  // entry the kernel makes it readable — the child writes its log there.
  const logStream = child.stdio[3] as NodeJS.ReadableStream | null;
  if (logStream) {
    logStream.on("data", (c: Buffer) => logChunks.push(c));
    // Swallow any unexpected error on the log pipe — diagnostics are
    // strictly best-effort and must never fail the run.
    logStream.on("error", () => {});
  }

  let killedByTimer = false;
  const killTimer = setTimeout(() => {
    killedByTimer = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }, opts.timeLimitMs + KILL_GRACE_MS);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(killTimer);
      resolve({ code: exitCode, signal: exitSignal });
    });
    child.once("error", (err) => {
      clearTimeout(killTimer);
      logger.error({ err }, "nsjail spawn failed");
      resolve({ code: null, signal: null });
    });
  });

  const wallMs = Date.now() - started;
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  // The child's stderr is now byte-clean: nsjail's logger writes to fd
  // 3 (captured separately into `nsjailLog` below), so nothing here
  // came from nsjail. Forward it to the caller as-is — no filtering,
  // no normalisation. This is what makes /generate-tests parseable
  // again and what makes /submit's TestResult.stderr show the user's
  // real stderr without the old `[I][...]` cross-talk getting mixed in.
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const nsjailLog = Buffer.concat(logChunks).toString("utf8");

  const meta = parseNsjailStderr(nsjailLog);

  const killedBy = classifyKill({
    timedOutByNode: killedByTimer,
    meta,
    signal,
    exitCode: code,
    wallMs,
    timeLimitMs: opts.timeLimitMs,
    memLimitMb: opts.memLimitMb,
  });

  // Setup-overhead telemetry. `parentWallMs` includes nsjail fork/exec,
  // kafel parse, BPF compile, V8 GC pauses, and event-loop jitter;
  // `nsjailWallMs` is nsjail's own inner measurement of just the jailed
  // child. The delta is the judge's per-spawn overhead — useful for
  // verifying that TLE is no longer sensitive to it, and for alerting
  // when it regresses. Debug level so it's off by default in prod.
  logger.debug(
    {
      cpuMs: meta.cpuTimeMs,
      nsjailWallMs: meta.wallTimeMs,
      parentWallMs: wallMs,
      setupOverheadMs: Math.max(0, wallMs - (meta.wallTimeMs ?? wallMs)),
      killedBy,
      timeLimitMs: opts.timeLimitMs,
    },
    "sandbox: timing",
  );

  // Diagnostic logging: surface raw nsjail output to server logs
  // whenever a run didn't complete normally. Covers:
  //   - nsjail setup failures (exit 255 / 1 / null)
  //   - seccomp SIGSYS kills (exit 159 = 128 + 31)
  //   - other fatal signals (exit > 128)
  //   - any empty-stdout case that wasn't a clean exit(0)
  // nsjail's log fd is captured into `nsjailLog`; the child's own stderr
  // (which we surface to the API caller) is captured into `stderr`. Both
  // are useful when debugging an IE — log a slice of each.
  const nonCleanExit = code !== 0;
  const signalKilled = typeof code === "number" && code >= 128;
  if (nonCleanExit || signalKilled) {
    logger.warn(
      {
        exitCode: code,
        signal,
        killedBy,
        argv: opts.argv,
        cwd: opts.cwd,
        uid: opts.uid,
        wallMs,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
        nsjailLog: nsjailLog.slice(0, 3000),
        childStderr: stderr.slice(0, 3000),
      },
      "sandbox: non-clean exit — raw nsjail diagnostics follow",
    );
  }

  return {
    exitCode: code,
    timedOut: killedBy === "TO",
    memKb: meta.maxRssKb ?? 0,
    timeMs: meta.wallTimeMs ?? wallMs,
    cpuMs: meta.cpuTimeMs ?? 0,
    stdout,
    stderr,
    killedBy,
  };
}

/**
 * nsjail writes diagnostics to `--log_fd=3` (a dedicated pipe set up
 * by runSandboxed). Every line nsjail emits there starts with a `[L]`
 * level prefix followed by a `[timestamp]`. Parse the ones we care
 * about:
 *
 *   "exit status: N"                    -> exit code
 *   "killed by signal: SIGKILL (9)"     -> signal
 *   "pid=..., rusage = maxrss=NNN KB"   -> peak RSS
 *   "wall time elapsed: N.NNs"          -> wall time
 *   "cpu time:        N.NNs"            -> cpu time
 *   "time >= soft limit"                -> RLIMIT_CPU hit (TLE)
 *   "memory limit exceeded" / "oom-kill" -> memory cap hit (MLE)
 *
 * Lines that don't start with `[` are skipped defensively — nsjail's
 * own logger always prefixes with `[L][timestamp]` so anything else
 * is either a continuation/multi-line message from a future version
 * or noise we can't reliably interpret.
 */
function parseNsjailStderr(stderr: string): NsjailMeta {
  const meta: NsjailMeta = {};
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("[")) continue;

    if (/time\s*>=\s*soft\s*limit/i.test(line) || /cpu\s*time\s*limit/i.test(line)) {
      meta.exitReason = meta.exitReason ?? "cpu-limit";
    }
    // Memory-limit detection. `rlimit_as` used to be an alternative
    // here, which is wrong twice over: nsjail's own startup lines echo
    // the CONFIGURED rlimit (a limit being set is not a limit being
    // hit), and RLIMIT_AS never produces a kill in the first place — it
    // makes malloc/new fail, so the program exits non-zero on its own.
    // Only phrases that describe the limit actually being EXCEEDED count.
    // The real RLIMIT_AS case is caught downstream in submit.ts from the
    // program's own allocation-failure stderr.
    if (
      /(?:memory\s*limit|maximum\s*memory)[^\n]*(?:exceed|reach|hit|over)/i.test(line) ||
      /oom[-_\s]?kill/i.test(line)
    ) {
      meta.exitReason = meta.exitReason ?? "mem-limit";
    }

    const rssMatch =
      /max(?:imum)?\s*rss[^0-9]*([0-9]+)\s*k/i.exec(line) ||
      /maxrss=([0-9]+)/i.exec(line);
    if (rssMatch && rssMatch[1]) {
      meta.maxRssKb = Number.parseInt(rssMatch[1], 10);
    }

    const wallMatch = /wall\s*time[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (wallMatch && wallMatch[1]) {
      meta.wallTimeMs = Math.round(Number.parseFloat(wallMatch[1]) * 1000);
    }

    const cpuMatch = /cpu\s*time[^0-9]*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (cpuMatch && cpuMatch[1]) {
      meta.cpuTimeMs = Math.round(Number.parseFloat(cpuMatch[1]) * 1000);
    }

    const signalMatch = /killed\s*by\s*signal[^0-9]*([0-9]+)/i.exec(line);
    if (signalMatch && signalMatch[1]) {
      meta.signal = Number.parseInt(signalMatch[1], 10);
    }
  }
  return meta;
}

/**
 * Decide the `killedBy` classification. CPU time is the authoritative
 * measure of program cost — parent-measured wall time includes nsjail
 * fork/exec, kafel parse, BPF compile, V8 GC, and event-loop jitter,
 * none of which is user work, and all of which vary run-to-run under
 * load. The old "wallMs >= timeLimitMs" check produced flaky TLE on
 * identical submissions; this ladder decides from CPU time and uses
 * wall only as a loose liveness backstop.
 *
 * Order of checks:
 *   1. Node's last-resort SIGKILL timer fired    -> TO  (stuck nsjail/kernel)
 *   2. nsjail reported RLIMIT_CPU / --time_limit -> TO
 *   3. nsjail reported a memory limit exceeded   -> OOM
 *   4. CPU time consumed >= user's timeLimitMs   -> TO  (authoritative)
 *   5. Clean exit (0, no signal) && CPU in budget -> null (AC/WA)
 *   6. Inner wall >= 3 * timeLimitMs             -> TO  (sleepy/blocked)
 *   7. Peak RSS at >=98% of the memory cap       -> OOM
 *   8. Any fatal signal not explained above       -> SIG
 *   9. Null exit code (nsjail spawn fail)        -> SIG
 *  10. Otherwise                                  -> null
 */
function classifyKill(args: {
  timedOutByNode: boolean;
  meta: NsjailMeta;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  wallMs: number;
  timeLimitMs: number;
  memLimitMb: number;
}): SandboxResult["killedBy"] {
  const {
    timedOutByNode,
    meta,
    signal,
    exitCode,
    wallMs,
    timeLimitMs,
    memLimitMb,
  } = args;

  if (timedOutByNode) return "TO";
  if (meta.exitReason === "cpu-limit") return "TO";
  if (meta.exitReason === "mem-limit") return "OOM";

  // CPU-time TLE (authoritative). nsjail emits `cpu time: N.NNs` which
  // we parse into meta.cpuTimeMs. This is the actual CPU work consumed
  // by the process, independent of host scheduling or judge overhead,
  // and is what makes verdicts deterministic across runs.
  if (meta.cpuTimeMs !== undefined && meta.cpuTimeMs >= timeLimitMs) {
    return "TO";
  }

  // Clean-exit guard. A normal exit(0) with no signal and no node-side
  // kill means the program actually finished — never downgrade it to
  // TLE on parent-measured wall noise. (The CPU-time check above has
  // already rejected programs that finished but exceeded their budget.)
  if (exitCode === 0 && signal === null) return null;

  // Wall-clock liveness backstop. Catches programs that block on
  // syscalls (sleep, I/O wait) without consuming CPU. Uses nsjail's
  // inner wall clock when available (excludes judge setup overhead);
  // 3x cushion keeps the threshold far from legitimate-run noise while
  // still bounding wedged submissions. Node's SIGKILL timer (fired at
  // timeLimitMs + KILL_GRACE_MS) is the tighter of the two in practice.
  const innerWallMs = meta.wallTimeMs ?? wallMs;
  if (innerWallMs >= timeLimitMs * 3) return "TO";

  // Peak RSS at (or within 2% of) the cap on a run that did NOT exit
  // cleanly — the clean-exit guard above has already returned for those.
  // The 2% band exists because RSS is sampled by the kernel at page
  // granularity and a process that is being torn down for exceeding its
  // limit rarely reports the round number exactly.
  const memLimitKb = memLimitMb * 1024;
  if (meta.maxRssKb !== undefined && meta.maxRssKb >= memLimitKb * MEM_LIMIT_RSS_RATIO) {
    return "OOM";
  }

  if (signal !== null) return "SIG";
  if (exitCode === null) return "SIG";

  return null;
}
