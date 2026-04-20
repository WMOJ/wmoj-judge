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
 */
const KILL_GRACE_MS = 2000;

interface NsjailMeta {
  exitReason?: string;
  maxRssKb?: number;
  wallTimeMs?: number;
  cpuTimeMs?: number;
  signal?: number;
}

/**
 * Convert a submission's wall-clock time budget in ms to the
 * RLIMIT_CPU value nsjail wants in whole seconds. Add 1s of slack so
 * short (<1s) limits don't underflow and so the CPU limit triggers
 * slightly after wall-clock — wall is the authoritative limit.
 */
function cpuLimitSecFor(timeLimitMs: number): number {
  return Math.ceil(timeLimitMs / 1000) + 1;
}

/**
 * Shell out to nsjail with the argv described in the plan.
 * Responsibilities:
 *   - Build argv: chroot, user, group, rlimits, seccomp, env whitelist.
 *   - Stream `opts.stdin` to the child, collect stdout/stderr.
 *   - Parse nsjail's own diagnostic output on --log_fd=2 (same fd as
 *     the child's stderr).
 *   - Honour the node-side last-resort SIGKILL timer.
 */
export async function runSandboxed(
  opts: SandboxOpts,
): Promise<SandboxResult> {
  const cpuSec = cpuLimitSecFor(opts.timeLimitMs);
  // --rlimit_fsize is in MB per nsjail's docs; --rlimit_as is in MB.
  const memLimitMb = Math.max(1, Math.floor(opts.memLimitMb));
  // --rlimit_as may be bumped above the user-visible memory cap for
  // runtimes (notably the JVM) that reserve >1GB of VA space at
  // startup even when the effective heap is much smaller. The caller
  // is responsible for enforcing the user-visible limit via runtime
  // flags such as `-Xmx<memLimit>m`. See the java-investigator writeup
  // on VA-space reservation for CompressedClassSpace / ReservedCodeCache
  // / metaspace; without the bump every Java launch aborts before the
  // first user instruction runs.
  const rlimitAsMb = opts.rlimitAsMb !== undefined
    ? Math.max(memLimitMb, Math.floor(opts.rlimitAsMb))
    : memLimitMb;

  // No --chroot: Render's unprivileged containers do not grant
  // CAP_SYS_ADMIN, so we cannot bind-mount /usr, /lib, /etc/alternatives,
  // etc. into a per-submission chroot. Chrooting into just the workdir
  // would hide the language runtimes (`/usr/bin/python3`, `/usr/bin/java`)
  // from the child, breaking execve. We rely on:
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
    // JVMs are thread-heavy: GC workers, JIT compiler threads, signal
    // dispatcher, finalizer, reference handler, plus user threads.
    // 32 is too tight -- JDK 25 on a multi-core host can want 20+
    // at startup alone. 256 is comfortable for the JVM and still far
    // below anything a malicious submission could use for DoS given
    // RLIMIT_AS / RLIMIT_CPU are also in effect.
    "--rlimit_nproc", "256",
    "--rlimit_nofile", "256",
    "--rlimit_fsize", "10",
    "--rlimit_core", "0",
    "--seccomp_policy", config.SECCOMP_POLICY,
    "--env", "PATH",
    "--env", "LANG",
    "--env", "LC_ALL",
    "--env", "PYTHONUNBUFFERED",
    "--time_limit", String(cpuSec),
    "--log_fd", "2",
    "--",
    ...opts.argv,
  ];

  // nsjail reads PATH/LANG/... from its own environment and forwards
  // them to the jailed child via `--env <VAR>` (name-only form). No
  // language-specific variables are needed (Temurin's `java` resolves
  // lib/ via /proc/self/exe, so JAVA_HOME is unnecessary). Nothing
  // else from the judge's own env leaks through.
  const jailEnv = buildChildEnv("python3");

  const started = Date.now();
  const child = spawn(config.NSJAIL_BIN, argv, {
    cwd: opts.cwd,
    env: jailEnv,
    stdio: ["pipe", "pipe", "pipe"],
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
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

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
  const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");

  const meta = parseNsjailStderr(stderrRaw);
  const stderr = stripNsjailLogLines(stderrRaw);

  const killedBy = classifyKill({
    timedOutByNode: killedByTimer,
    meta,
    signal,
    exitCode: code,
    wallMs,
    timeLimitMs: opts.timeLimitMs,
    memLimitMb: opts.memLimitMb,
  });

  // Diagnostic logging: surface raw nsjail output to server logs
  // whenever a run didn't complete normally. Covers:
  //   - nsjail setup failures (exit 255 / 1 / null)
  //   - seccomp SIGSYS kills (exit 159 = 128 + 31)
  //   - other fatal signals (exit > 128)
  //   - any empty-stdout case that wasn't a clean exit(0)
  // `stripNsjailLogLines` hides these from the client response by
  // design, but ops needs to see them.
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
        nsjailRaw: stderrRaw.slice(0, 3000),
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
 * nsjail writes diagnostics to `--log_fd=2`, interleaved with the
 * child's own stderr. Lines it emits start with a `[` (timestamp +
 * level prefix). Parse the ones we care about:
 *
 *   "exit status: N"                    -> exit code
 *   "killed by signal: SIGKILL (9)"     -> signal
 *   "pid=..., rusage = maxrss=NNN KB"   -> peak RSS
 *   "wall time elapsed: N.NNs"          -> wall time
 *   "cpu time:        N.NNs"            -> cpu time
 *   "time >= soft limit"                -> RLIMIT_CPU hit (TLE)
 *   "maximum memory usage"              -> RLIMIT_AS hit (MLE)
 */
function parseNsjailStderr(stderr: string): NsjailMeta {
  const meta: NsjailMeta = {};
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("[")) continue;

    if (/time\s*>=\s*soft\s*limit/i.test(line) || /cpu\s*time\s*limit/i.test(line)) {
      meta.exitReason = meta.exitReason ?? "cpu-limit";
    }
    if (/rlimit_as|memory\s*limit|maximum\s*memory/i.test(line)) {
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
 * Remove nsjail's own log lines (those starting with `[`) from the
 * combined stderr stream so the caller only sees what user code wrote.
 * Log lines are still available in the parsed meta object above.
 */
function stripNsjailLogLines(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("["))
    .join("\n");
}

/**
 * Decide the `killedBy` classification. Checks in this order:
 *   TO : RLIMIT_CPU, wall-clock, or node-side kill timer fired.
 *   OOM: RLIMIT_AS hit, peak RSS >= memLimit, or SIGSEGV with RSS near
 *        the limit.
 *   SIG: any non-zero signal that isn't explained by the above.
 *   null: clean exit.
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

  // Wall-clock hit: nsjail's --time_limit or Node's timer.
  if (wallMs >= timeLimitMs) return "TO";

  const memLimitKb = memLimitMb * 1024;
  if (meta.maxRssKb !== undefined && meta.maxRssKb >= memLimitKb) {
    return "OOM";
  }

  if (signal !== null) return "SIG";
  if (exitCode === null) return "SIG";

  return null;
}
