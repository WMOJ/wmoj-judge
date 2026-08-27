import { spawn } from "child_process";
import * as os from "os";
import * as path from "path";
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
 * still firing well within Render's SIGTERM->SIGKILL drain window.
 */
const KILL_GRACE_MS = 5000;

/**
 * Node clamps any `setTimeout` delay above 2^31-1 ms to **1 ms** (with
 * a TimeoutOverflowWarning) instead of treating it as "far future".
 * `timeLimit` has no upper bound in the request contract, so an admin
 * typo of `3000000000` used to SIGKILL the jail ~1 ms after spawn and
 * return `TLE` for every case of every submission on a clean 200 --
 * the exact inversion of the four-timer ordering the sandbox depends
 * on. Every delay and every numeric argv value is clamped to this.
 */
const MAX_INT32 = 2_147_483_647;

/**
 * Once the runner has exited, its stdio pipes may still be held open by
 * a descendant that inherited fds 1/2 (there is no PID namespace, and
 * `clone` without CLONE_NEW* bits is allowed). Node's `'close'` waits
 * for every one of those copies, so it can never arrive. Settle on
 * `'exit'` instead, give the pipes this long to hand over whatever the
 * kernel already buffered, then destroy them.
 */
const STREAM_DRAIN_MS = 250;

/**
 * Absolute backstop past the SIGKILL timer, after which `runSandboxed`
 * settles regardless of what the process or its streams are doing.
 * Nothing should ever reach it -- it exists so that a single wedged run
 * can never again hold a UID-pool slot and a semaphore permit forever
 * and wedge the whole judge while `/health` stays green.
 */
const ABSOLUTE_DEADLINE_SLACK_MS = 15_000;

/**
 * Caps on how much of the child's output the sandbox retains. Nothing
 * else bounds this: `requestCaps` bounds the *request*, `--rlimit_as`
 * bounds address space rather than pipe throughput, and `--rlimit_fsize`
 * is enforced by the kernel for regular files only (`S_ISREG`), so pipe
 * writes are never checked against it. An ordinary `for(;;) puts("x")`
 * bug therefore used to push hundreds of MB into the Node heap of a
 * 512 MB container -- and `Buffer.concat` plus `.toString("utf8")` need
 * two more copies of it -- which either OOM-killed the whole service or
 * threw `RangeError` past `MAX_STRING_LENGTH`.
 *
 * 1 MiB of stdout sits just above `requestCaps`' 1,000,000-byte cap on
 * a single expected output, so for `/submit` a truncated run is one
 * that could not have been `AC` regardless. `/generate-tests`, whose
 * stdout IS the payload, must raise `maxStdoutBytes` deliberately.
 */
export const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/**
 * Cap on nsjail's own fd-3 diagnostics. Same unbounded-accumulation
 * class as the two above; nothing classifies a verdict from this text
 * any more, it is only logged.
 */
const MAX_NSJAIL_LOG_BYTES = 256 * 1024;

/** Cap on the runner's report pipe. One short line is ever written. */
const MAX_REPORT_BYTES = 4096;

/**
 * Fraction of the memory cap at which peak RSS counts as "hit the
 * limit". Shared with `submit.ts`'s MLE classification so the sandbox
 * and the verdict layer agree on the threshold. See the comment at the
 * RSS check in `classifyKill` for why it isn't 1.0.
 */
export const MEM_LIMIT_RSS_RATIO = 0.98;

/**
 * The fd `wmoj-jailrun` writes its resource report to. Slot 4 of the
 * stdio array below; slot 3 is nsjail's own `--log_fd`. The runner sets
 * FD_CLOEXEC on it before forking, so nsjail -- and therefore the jailed
 * program -- never inherits it and cannot forge or truncate the report.
 */
const REPORT_FD = 4;

/** Signal numbers we decode out of nsjail's `128 + WTERMSIG` status. */
const SIGKILL_NUM = 9;
const SIGXCPU_NUM = 24;

/**
 * The resource report `wmoj-jailrun` writes to `REPORT_FD`.
 *
 * WHY THIS EXISTS AT ALL. nsjail 3.3 -- the pinned tag -- collects no
 * rusage: both `wait4()` calls in its `subproc.cc` pass `NULL`, and no
 * log line it emits at runtime contains a CPU time, a wall time or a
 * maxrss. The judge used to scrape six regexes out of that log, all of
 * which matched nothing, so `cpuMs` and `memKb` were `0` on every run.
 * That silently disabled the authoritative TLE gate, both RSS-based MLE
 * rules, and the setup-overhead telemetry added to catch exactly this
 * class of regression. There was no error and no log line -- just a
 * judge that had stopped reporting TLE and MLE.
 *
 * WHY A RUNNER RATHER THAN THE ALTERNATIVES. Sampling `/proc/<pid>` is
 * a poll race: the numbers we need are final only after the jailed
 * process is reaped, and the entry is gone microseconds later.
 * `getrusage(RUSAGE_CHILDREN)` is not exposed by Node
 * (`process.resourceUsage()` is RUSAGE_SELF) and would need a native
 * addon. Wrapping the *jailed* argv would put the reporter under
 * `policy.kafel` and inside the address-space cap it is trying to
 * measure. Wrapping nsjail from OUTSIDE the jail has none of those
 * problems: the runner is judge-owned code that never enters the
 * sandbox, so it needs no seccomp allowance, and `wait4()`'s `rusage`
 * is the kernel's own accounting for nsjail plus every descendant it
 * reaped -- which is the jailed program. It also hands us nsjail's
 * exact wait status.
 */
interface JailRunReport {
  /** nsjail's exit code, or -1 when nsjail was itself signalled. */
  exit: number;
  /** Signal that killed nsjail itself, or 0. */
  signal: number;
  cpuMs: number;
  maxRssKb: number;
  wallMs: number;
}

/**
 * The runner's report format is a contract with a small C file this
 * repository builds in its own Dockerfile, not with a third party's log
 * output. That is the whole point: the previous contract was with
 * nsjail's log strings, which changed under us with no signal. A parse
 * failure here is a judge fault and is reported as one.
 */
const REPORT_RE =
  /^WMOJ-JAILRUN v1 exit=(-?\d+) signal=(\d+) cpu_us=(\d+) maxrss_kb=(\d+) wall_us=(\d+)$/m;
const REPORT_ERROR_RE = /^WMOJ-JAILRUN v1 error=([a-z_]+) errno=(\d+)$/m;

/**
 * U+0000 and its replacement, built from char codes so the literal
 * bytes never appear in this source file. See decodeChildOutput.
 */
const NUL_RE = new RegExp(String.fromCharCode(0), "g");
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * Absolute path to `wmoj-jailrun`, which the Dockerfile installs beside
 * the nsjail binary. Deliberately derived from `config.NSJAIL_BIN`
 * rather than given its own env var: the two are one unit -- a runner
 * that does not match the nsjail it wraps is a bug, not a deployment
 * choice -- and there is nothing here an operator would want to tune.
 * A bare `NSJAIL_BIN` (PATH lookup) yields a bare runner name so PATH
 * resolves both the same way.
 */
function jailRunnerBin(): string {
  const dir = path.dirname(config.NSJAIL_BIN);
  return dir === "." ? "wmoj-jailrun" : path.join(dir, "wmoj-jailrun");
}

/**
 * Clamp a caller-supplied millisecond budget into a range every timer
 * and every argv value can represent. See MAX_INT32.
 */
function clampMs(ms: number): number {
  if (!Number.isFinite(ms)) return MAX_INT32;
  return Math.min(MAX_INT32, Math.max(0, Math.trunc(ms)));
}

/**
 * Convert a submission's time budget in ms to the RLIMIT_CPU value
 * nsjail wants in whole seconds. +1s of slack so short (<1s) limits
 * don't underflow and so RLIMIT_CPU triggers strictly after the
 * userland CPU check in classifyKill -- RLIMIT_CPU is a kernel-level
 * backstop against runaway CPU, while `report.cpuMs >= timeLimitMs`
 * is the authoritative TLE gate with sub-millisecond precision.
 */
function cpuLimitSecFor(timeLimitMs: number): number {
  return Math.ceil(clampMs(timeLimitMs) / 1000) + 1;
}

/**
 * Render a number for the argv. nsjail parses every numeric flag with
 * `strtol`, and `String(1e21)` is `"1e+21"`, which `strtol` reads as
 * **1** -- a 10^21 MB address-space cap silently becoming a 1 MB one.
 * Truncating and clamping first makes that unrepresentable.
 */
function argvInt(n: number): string {
  if (!Number.isFinite(n)) return String(MAX_INT32);
  return String(Math.min(MAX_INT32, Math.max(0, Math.trunc(n))));
}

/** Resolve an optional byte cap, rejecting nonsense without throwing. */
function capOf(requested: number | undefined, fallback: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  return Math.trunc(requested);
}

/**
 * A byte-capped chunk accumulator. Chunks past the cap are dropped
 * rather than pushed, and the child is deliberately NOT killed: we keep
 * draining the pipe so the program stays CPU-bound and reaches its own
 * RLIMIT_CPU. Killing on overflow instead would destroy the exit status
 * and turn an honest `TLE` (an infinite print loop) into a spurious
 * `RE`, and would turn a program that merely prints too much into `RE`
 * where `WA` is the truth. Memory -- the actual defect -- is bounded
 * either way, and RLIMIT_CPU still bounds how long the drain runs.
 */
interface CappedStream {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function newCappedStream(): CappedStream {
  return { chunks: [], bytes: 0, truncated: false };
}

function collect(target: CappedStream, cap: number, chunk: Buffer): void {
  const room = cap - target.bytes;
  if (room <= 0) {
    target.truncated = true;
    return;
  }
  if (chunk.length <= room) {
    target.chunks.push(chunk);
    target.bytes += chunk.length;
    return;
  }
  // Splitting mid-sequence can leave a partial UTF-8 character at the
  // boundary; the decoder turns it into U+FFFD, which is the same thing
  // it already does for any malformed byte the child emits.
  target.chunks.push(chunk.subarray(0, room));
  target.bytes = cap;
  target.truncated = true;
}

/**
 * Decode captured child bytes into the string the API returns.
 *
 * `toString("utf8")` already maps malformed sequences to U+FFFD, but
 * **U+0000 is valid UTF-8 and survives it**, and `wmoj-app` inserts
 * these strings verbatim into a PostgreSQL `jsonb` column, which cannot
 * represent a NUL escape. A student whose program writes a single NUL --
 * `putchar(0)`, an uninitialised buffer flushed with `fwrite` -- gets a
 * correct 200 from the judge whose row is then silently never persisted:
 * no history, no points, no error shown to anyone. Substituting the same
 * replacement character the decoder already uses for malformed bytes
 * keeps the output storable and keeps it visibly not equal to an
 * expected output that has no NUL in it.
 */
function decodeChildOutput(target: CappedStream): string {
  return Buffer.concat(target.chunks)
    .toString("utf8")
    .replace(NUL_RE, REPLACEMENT_CHAR);
}

/**
 * Kill an entire process group with SIGKILL.
 *
 * `spawn(..., { detached: true })` makes the runner a process-group
 * leader, and `setsid`/`setpgid` are NOT in `policy.kafel`'s ALLOW block,
 * so no jailed descendant can leave that group. Signalling `-pid` is
 * therefore airtight where `child.kill()` was not: `child.kill()` targets
 * only the pid libuv has already reaped and returns `false`, leaving a
 * forked orphan holding fds 1/2 -- and the request -- open forever.
 *
 * PID reuse is not a practical hazard here: this only ever runs
 * immediately after the group's own leader exited, and a group id stays
 * reserved while any member lives.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH -- the group is already empty. Nothing to do.
  }
}

/** Read a capture group under `noUncheckedIndexedAccess`. */
function groupInt(m: RegExpExecArray, i: number): number {
  const raw = m[i];
  return raw === undefined ? 0 : Number.parseInt(raw, 10);
}

/**
 * Parse the runner's report. Returns `undefined` when no report was
 * written at all -- the caller decides whether that is expected, and it
 * is exactly when we force-killed the group, because the runner is in
 * that group and dies with it.
 */
function parseJailRunReport(
  text: string,
): { ok: true; value: JailRunReport } | { ok: false; error: string } | undefined {
  const failed = REPORT_ERROR_RE.exec(text);
  if (failed) {
    return {
      ok: false,
      error: `jail runner failed at ${failed[1] ?? "unknown"} (errno ${failed[2] ?? "?"})`,
    };
  }
  const m = REPORT_RE.exec(text);
  if (!m) return undefined;
  return {
    ok: true,
    value: {
      exit: groupInt(m, 1),
      signal: groupInt(m, 2),
      cpuMs: Math.round(groupInt(m, 3) / 1000),
      maxRssKb: groupInt(m, 4),
      wallMs: Math.round(groupInt(m, 5) / 1000),
    },
  };
}

/**
 * nsjail's fatal-level prefix. When nsjail cannot start -- an unreadable
 * or uncompilable `--seccomp_policy`, a missing `--cwd` -- it emits
 * `[F] main():360 Couldn't prepare sandboxing policy` on fd 3 and exits
 * 255 without executing anything of the user's. Left undetected that
 * grades every test case of every submission `RE` on a clean HTTP 200
 * while `/health` still reports `{"status":"ok"}`, so nothing restarts
 * the instance and only a redeploy recovers. It is a live failure mode,
 * not a hypothetical: `policy.kafel` targets the amd64 syscall table, so
 * an image built for arm64 fails to compile it on every single spawn.
 */
function looksLikeNsjailSetupFailure(exitCode: number | null, log: string): boolean {
  if (exitCode !== 255 && exitCode !== 1) return false;
  return /(^|\n)\[F\]/.test(log);
}

/**
 * Shell out to nsjail with the argv described in the plan, wrapped in
 * the out-of-jail `wmoj-jailrun` reporter (see `JailRunReport`).
 * Responsibilities:
 *   - Build argv: disabled namespaces, --keep_caps, cwd, rlimits,
 *     seccomp policy, env allow-list. Deliberately NO --chroot and no
 *     --user/--group -- see the comments above the argv below.
 *   - Stream `opts.stdin` to the child, collect capped stdout/stderr.
 *   - Read the runner's resource report off fd 4 and classify the run
 *     from it plus nsjail's exit status.
 *   - Honour the node-side last-resort SIGKILL timer, and guarantee
 *     that the promise settles and the process group dies either way.
 */
export async function runSandboxed(
  opts: SandboxOpts,
): Promise<SandboxResult> {
  const timeLimitMs = clampMs(opts.timeLimitMs);
  const cpuSec = cpuLimitSecFor(timeLimitMs);
  // --rlimit_fsize is in MB per nsjail's docs; --rlimit_as is in MB.
  const memLimitMb = Math.max(1, Math.floor(opts.memLimitMb));
  const maxStdoutBytes = capOf(opts.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
  const maxStderrBytes = capOf(opts.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);

  // No --chroot: Render's unprivileged containers do not grant
  // CAP_SYS_ADMIN, so we cannot bind-mount /usr, /lib, /etc/alternatives,
  // etc. into a per-submission chroot. Chrooting into just the workdir
  // would hide the language runtimes (/usr/bin/python3, /usr/bin/g++
  // shims, etc.) from the child, breaking execve.
  //
  // No --user / --group: the Dockerfile drops Node to UID 1000 (see
  // `USER 1000` and the comment there). Asking nsjail to setresuid() to
  // anything other than our own UID fails EPERM because a non-root
  // process cannot switch to a foreign UID, and nsjail bails with
  // "Launching child process failed" (exit 255).
  //
  // Be precise about what that leaves, because this is the comment a
  // maintainer reads before widening something:
  //   - There is exactly ONE uid. The jailed child runs as UID 1000 --
  //     the same UID as this Node process, as g++, and as every other
  //     submission. It is NOT an isolation boundary. The pool in
  //     queue/uidPoolSingleton is a concurrency gate and nothing more.
  //   - /app is `chown 1000:1000, chmod 750` (Dockerfile), and there is
  //     no chroot and no path filter on open/write, so user code can
  //     read AND rewrite /app/policy.kafel (re-read on every spawn) and
  //     /app/dist/*.js. A one-shot bypass is therefore a persistent one.
  //   - The per-submission 0700 workdir is hygiene against other UIDs on
  //     the host, not cross-submission isolation: every submission shares
  //     UID 1000 and one /tmp root, so 0700 excludes nobody who matters.
  // What DOES hold: the seccomp allow-list blocks network, namespace ops,
  // and every cross-process memory probe (ptrace, process_vm_readv /
  // process_vm_writev, kcmp), so concurrent submissions genuinely cannot
  // read each other's memory; --disable_clone_new* prevents any new
  // namespace; and the kernel rlimits below bound memory, CPU and files.
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
    "--rlimit_as", argvInt(memLimitMb),
    "--rlimit_cpu", argvInt(cpuSec),
    // RLIMIT_NPROC is checked against the total task count for the REAL
    // UID, and --user/--group are deliberately absent, so this is one
    // ceiling shared by every concurrent submission, every g++, and the
    // Node judge itself -- it is NOT per-submission headroom, and it is
    // re-inherited afresh by every fork, so it bounds a fork bomb only
    // in aggregate. What actually bounds one here is the unconditional
    // process-group kill below (transient descendants) plus tini reaping
    // orphans in the image (permanent zombies, which the kernel counts
    // against this same per-UID budget until they are reaped). Lowering
    // the number would isolate nothing -- it would only decide which
    // submission gets EAGAIN first -- and 256 already has to cover
    // PyPy's and glibc's threads across up to 16 concurrent runs.
    "--rlimit_nproc", "256",
    "--rlimit_nofile", "256",
    "--rlimit_fsize", "10",
    "--rlimit_core", "0",
    // The ONLY thing UNSAFE_DISABLE_SECCOMP changes: the filter is not
    // installed, so nothing above is affected and the run is measured,
    // rlimited and killed exactly as it would be otherwise. It exists
    // because QEMU cannot install this amd64 BPF program on an arm64
    // kernel (EINVAL from prctl), which makes the judge unbootable on
    // Apple Silicon; `config.ts` refuses the variable outright when
    // NODE_ENV=production, so this branch is dead code in production.
    // Do not reach for it to make a submission work: an unfiltered
    // child has the network and every syscall the kernel offers.
    ...(config.UNSAFE_DISABLE_SECCOMP
      ? []
      : ["--seccomp_policy", config.SECCOMP_POLICY]),
    "--env", "PATH",
    "--env", "LANG",
    "--env", "LC_ALL",
    "--env", "PYTHONUNBUFFERED",
    // nsjail's --time_limit is wall-clock and serves only as a liveness
    // backstop; CPU time (via --rlimit_cpu and the userland cpuMs check
    // in classifyKill) is authoritative for TLE. Set generously beyond
    // Node's own SIGKILL timer so we get one authoritative wall kill
    // (Node's) rather than racing two wall timers against setup overhead.
    "--time_limit", argvInt(Math.ceil((timeLimitMs + KILL_GRACE_MS) / 1000) + 2),
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
    // robust fix -- the child's stderr is now byte-clean.
    "--log_fd", "3",
    "--",
    ...opts.argv,
  ];

  // nsjail reads PATH/LANG/... from its own environment and forwards
  // them to the jailed child via `--env <VAR>` (name-only form).
  // Nothing else from the judge's own env leaks through. The runner
  // execs nsjail directly, so it changes nothing about this.
  const jailEnv = buildChildEnv("python3");

  const started = Date.now();
  // Five stdio slots: stdin (0), child stdout (1), child stderr (2), a
  // dedicated pipe (3) that nsjail's `--log_fd 3` writes its own
  // diagnostics to, and a dedicated pipe (4) that `wmoj-jailrun` writes
  // its resource report to. Keeping nsjail's log on fd 3 means fd 2
  // carries ONLY the child's stderr -- no interleaving, no string-based
  // filter needed downstream. Keeping the report on fd 4, marked
  // FD_CLOEXEC by the runner before it forks, means the jailed program
  // never sees the fd its own TLE verdict is measured on.
  //
  // `detached: true` puts the runner in its own process group so a
  // forked orphan cannot outlive the request: see killProcessGroup.
  const child = spawn(
    jailRunnerBin(),
    [String(REPORT_FD), config.NSJAIL_BIN, ...argv],
    {
      cwd: opts.cwd,
      env: jailEnv,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    },
  );

  try {
    // Feed stdin and close. If the child never reads, the pipe EOFs and
    // the child sees EOF on read -- correct behaviour for CP judging.
    child.stdin.on("error", () => {
      // EPIPE when child exits before consuming stdin -- not a
      // judge-side error, ignore.
    });
    child.stdin.write(opts.stdin);
    child.stdin.end();

    const out = newCappedStream();
    const err = newCappedStream();
    const log = newCappedStream();
    const report = newCappedStream();
    child.stdout.on("data", (c: Buffer) => collect(out, maxStdoutBytes, c));
    child.stderr.on("data", (c: Buffer) => collect(err, maxStderrBytes, c));

    // child.stdio[3] / [4] are the parent-side ends of the extra pipes.
    // They're typed as Readable | Writable | null in Node's TS defs (the
    // spawn() options can produce either direction), but for our
    // `stdio: [..., "pipe", "pipe"]` entries the kernel makes them
    // readable -- the child writes there.
    const logStream = child.stdio[3] as NodeJS.ReadableStream | null;
    if (logStream) {
      logStream.on("data", (c: Buffer) => collect(log, MAX_NSJAIL_LOG_BYTES, c));
      // Swallow any unexpected error on the log pipe -- diagnostics are
      // strictly best-effort and must never fail the run.
      logStream.on("error", () => {});
    }
    const reportStream = child.stdio[4] as NodeJS.ReadableStream | null;
    if (reportStream) {
      reportStream.on("data", (c: Buffer) => collect(report, MAX_REPORT_BYTES, c));
      reportStream.on("error", () => {});
    }

    // `forcedKill` records that WE destroyed the group. The runner is in
    // that group and dies with it without writing a report, so an absent
    // report is expected on exactly these paths and must not be reported
    // as a judge fault. The cost is that a run we had to force-kill has
    // no CPU/RSS numbers -- acceptable, because step 1 of the ladder has
    // already classified it as TO, and every ordinary TLE (RLIMIT_CPU
    // firing inside the jail) still reports real ones.
    let killedByTimer = false;
    let forcedKill = false;
    const killDelayMs = Math.min(MAX_INT32, timeLimitMs + KILL_GRACE_MS);
    const absoluteDeadlineMs = Math.min(
      MAX_INT32,
      killDelayMs + ABSOLUTE_DEADLINE_SLACK_MS,
    );

    const killTimer = setTimeout(() => {
      killedByTimer = true;
      forcedKill = true;
      killProcessGroup(child.pid);
    }, killDelayMs);

    const outcome = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      spawnError: string | null;
      deadlineExceeded: boolean;
    }>((resolve) => {
      let settled = false;
      let drainTimer: NodeJS.Timeout | undefined;
      // Declared up here rather than at its assignment below because
      // `settle` closes over it: a `const` read from a closure defined
      // above its declaration is a temporal-dead-zone trap the next edit
      // to this block would spring.
      let deadlineTimer: NodeJS.Timeout | undefined;

      const destroyStreams = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
        for (const slot of [logStream, reportStream]) {
          const destroyable = slot as { destroy?: () => void } | null;
          if (destroyable && typeof destroyable.destroy === "function") {
            destroyable.destroy();
          }
        }
      };

      const settle = (value: {
        code: number | null;
        signal: NodeJS.Signals | null;
        spawnError: string | null;
        deadlineExceeded: boolean;
      }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        resolve(value);
      };

      // Fast path: every stdio stream reached EOF, so nothing inherited
      // the pipes and we have the complete output.
      child.once("close", (exitCode, exitSignal) => {
        settle({
          code: exitCode,
          signal: exitSignal,
          spawnError: null,
          deadlineExceeded: false,
        });
      });

      // Slow path, and the one that used to hang forever. `'exit'` fires
      // as soon as the runner itself is gone; a descendant holding fds
      // 1/2 open can keep `'close'` from EVER firing, which left the
      // promise unsettled, the submission's `finally` unreached, and a
      // UID-pool slot plus a semaphore permit leaked permanently --
      // sixteen of those wedged the whole judge while /health stayed
      // green. Give the pipes a bounded drain, then take what we have.
      child.once("exit", (exitCode, exitSignal) => {
        if (settled) return;
        drainTimer = setTimeout(() => {
          destroyStreams();
          settle({
            code: exitCode,
            signal: exitSignal,
            spawnError: null,
            deadlineExceeded: false,
          });
        }, STREAM_DRAIN_MS);
      });

      child.once("error", (spawnErr) => {
        logger.error({ err: spawnErr }, "sandbox: jail runner spawn failed");
        settle({
          code: null,
          signal: null,
          spawnError: spawnErr.message,
          deadlineExceeded: false,
        });
      });

      // Absolute deadline: settle no matter what the process or its
      // streams are doing. Nothing should reach it now that 'exit'
      // settles the promise, but it is the guarantee that one wedged run
      // can never again hold a pool slot forever.
      deadlineTimer = setTimeout(() => {
        forcedKill = true;
        killProcessGroup(child.pid);
        destroyStreams();
        settle({
          code: null,
          signal: null,
          spawnError: null,
          deadlineExceeded: true,
        });
      }, absoluteDeadlineMs);
    });

    const { code, signal, spawnError, deadlineExceeded } = outcome;

    const wallMs = Date.now() - started;
    const stdout = decodeChildOutput(out);
    // The child's stderr is byte-clean: nsjail's logger writes to fd 3
    // (captured separately into `nsjailLog` below) and the runner's
    // report to fd 4, so nothing here came from either. Forward it to
    // the caller as-is -- no filtering, no normalisation beyond the NUL
    // substitution in decodeChildOutput. This is what makes
    // /generate-tests parseable and what makes /submit's
    // TestResult.stderr show the user's real stderr.
    const stderr = decodeChildOutput(err);
    // nsjail's fd-3 log is now DIAGNOSTIC ONLY -- no verdict is derived
    // from its text. That matters because it is not settled whether the
    // jailed process can write to fd 3 itself; while the six log regexes
    // existed, a submission that could write there could forge its own
    // CPU and memory numbers. It can now at worst pollute a log line
    // and, by forging a `[F]` fatal prefix on an exit-255 run with no
    // stdout, turn its OWN submission into a judge-fault 500.
    const nsjailLog = Buffer.concat(log.chunks).toString("utf8");
    const parsed = parseJailRunReport(
      Buffer.concat(report.chunks).toString("utf8"),
    );

    let sandboxError: string | undefined;
    if (spawnError !== null) {
      // code === null here means nothing of the user's ever ran.
      sandboxError = `sandbox could not be started: ${spawnError}`;
    } else if (deadlineExceeded) {
      sandboxError = "sandbox exceeded its absolute deadline and was force-killed";
    } else if (parsed !== undefined && !parsed.ok) {
      sandboxError = parsed.error;
    } else if (parsed === undefined && !forcedKill) {
      sandboxError =
        "sandbox produced no resource report -- the jail runner did not complete";
    } else if (looksLikeNsjailSetupFailure(code, nsjailLog) && stdout.length === 0) {
      sandboxError = `nsjail failed to start the jail (exit ${String(code)})`;
    }

    const measured = parsed !== undefined && parsed.ok ? parsed.value : undefined;
    const cpuMs = measured?.cpuMs ?? 0;
    const memKb = measured?.maxRssKb ?? 0;
    const jailWallMs = measured?.wallMs ?? wallMs;
    const truncated = out.truncated || err.truncated;

    const killedBy = classifyKill({
      timedOutByNode: killedByTimer,
      cpuMs: measured?.cpuMs,
      maxRssKb: measured?.maxRssKb,
      jailWallMs: measured?.wallMs,
      signal,
      exitCode: code,
      wallMs,
      timeLimitMs,
      memLimitMb,
    });

    // Setup-overhead telemetry. `parentWallMs` includes Node's spawn,
    // V8 GC pauses and event-loop jitter; `jailWallMs` is the runner's
    // own fork()->wait4() measurement of nsjail. The delta is the
    // judge's per-spawn overhead -- useful for verifying that TLE is no
    // longer sensitive to it, and for alerting when it regresses. This
    // number was itself always 0 while resource accounting was broken,
    // which is why the regression it exists to catch went unnoticed.
    logger.debug(
      {
        cpuMs,
        memKb,
        jailWallMs,
        parentWallMs: wallMs,
        setupOverheadMs: Math.max(0, wallMs - jailWallMs),
        killedBy,
        truncated,
        timeLimitMs,
      },
      "sandbox: timing",
    );

    // Diagnostic logging. A student's program crashing is ordinary and
    // logs at debug; only a JUDGE-side fault logs at warn. The old
    // condition fired at warn on every single RE case -- up to 200 per
    // submission, 6 KB of attacker-chosen text each -- on a metered
    // free-tier instance, and its second disjunct (`code >= 128`) was a
    // strict subset of its first (`code !== 0`) and never added anything.
    const diagnostics = {
      exitCode: code,
      signal,
      killedBy,
      argv: opts.argv,
      cwd: opts.cwd,
      uid: opts.uid,
      wallMs,
      cpuMs,
      memKb,
      truncated,
      stdoutLen: stdout.length,
      stderrLen: stderr.length,
      // The runner's own view of nsjail's wait status. `exitCode` above
      // is the runner mirroring it, so these two agreeing is the normal
      // case; `nsjailSignal !== 0` means nsjail ITSELF was signalled
      // (the container OOM killer, or user code -- it shares UID 1000
      // and `kill` is allowed), which `exitCode` alone cannot express.
      nsjailExit: measured?.exit,
      nsjailSignal: measured?.signal,
    };
    if (sandboxError !== undefined) {
      logger.warn(
        { ...diagnostics, sandboxError, nsjailLog: nsjailLog.slice(0, 2000) },
        "sandbox: judge-side sandbox failure -- nothing of the user's was graded",
      );
    } else if (code !== 0) {
      logger.debug(
        {
          ...diagnostics,
          nsjailLog: nsjailLog.slice(0, 1000),
          childStderr: stderr.slice(0, 400),
        },
        "sandbox: non-clean exit",
      );
    }

    const result: SandboxResult = {
      exitCode: code,
      timedOut: killedBy === "TO",
      memKb,
      timeMs: jailWallMs,
      cpuMs,
      stdout,
      stderr,
      killedBy,
      truncated,
    };
    if (sandboxError !== undefined) result.sandboxError = sandboxError;
    return result;
  } finally {
    // Unconditional, on every path including a thrown one. Descendants
    // must never outlive their submission: with no PID namespace, no
    // reaper inside the jail and rlimits that reset on fork, an orphan
    // left behind burns the 0.1-CPU host and holds the shared per-UID
    // RLIMIT_NPROC budget against every OTHER student's submission.
    killProcessGroup(child.pid);
  }
}

/**
 * Boot-time proof that resource accounting actually works.
 *
 * The failure this exists for is silent by construction: when the CPU
 * and RSS numbers stop arriving, nothing throws and nothing logs -- the
 * judge simply reports `cpuMs: 0, memKb: 0` forever, and with them go
 * the authoritative TLE gate and both RSS-based MLE rules. That state
 * shipped and survived, so the sandbox now proves itself instead.
 *
 * Runs a shell loop that deliberately overspends a 50 ms budget and
 * asserts BOTH halves of the contract: that CPU time is measured at all,
 * and that the ladder converts it into `TO`. Costs well under a second
 * even on a throttled host. `server.ts` should await this at boot next
 * to `probeToolchainAtBoot` and refuse to start on `ok: false` -- a
 * judge that cannot measure CPU time returns wrong verdicts on every
 * submission, which is strictly worse than not booting. It doubles as
 * the missing nsjail/policy.kafel boot probe: an image whose policy will
 * not compile fails this with a `sandboxError` rather than grading every
 * submission `RE`.
 */
export async function sandboxSelfCheck(): Promise<
  | { ok: true; value: { cpuMs: number; memKb: number; timeMs: number } }
  | { ok: false; error: string }
> {
  const probeTimeLimitMs = 50;
  const sb = await runSandboxed({
    argv: ["/bin/sh", "-c", "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done"],
    cwd: os.tmpdir(),
    uid: 1000,
    gid: 1000,
    timeLimitMs: probeTimeLimitMs,
    memLimitMb: 128,
    stdin: "",
  });

  if (sb.sandboxError !== undefined) {
    return { ok: false, error: `sandbox self-check could not run: ${sb.sandboxError}` };
  }
  if (sb.cpuMs === 0) {
    return {
      ok: false,
      error:
        "sandbox self-check measured cpuMs=0 for a CPU-bound probe -- resource " +
        "accounting is broken, so TLE and MLE would never fire",
    };
  }
  if (sb.killedBy !== "TO") {
    return {
      ok: false,
      error:
        `sandbox self-check burned ${String(sb.cpuMs)}ms of CPU against a ` +
        `${String(probeTimeLimitMs)}ms limit but was classified ` +
        `${sb.killedBy ?? "null"} instead of TO`,
    };
  }
  return { ok: true, value: { cpuMs: sb.cpuMs, memKb: sb.memKb, timeMs: sb.timeMs } };
}

/**
 * Decide the `killedBy` classification. CPU time is the authoritative
 * measure of program cost -- parent-measured wall time includes Node's
 * spawn, nsjail's fork/exec, kafel parse, BPF compile, V8 GC, and
 * event-loop jitter, none of which is user work, and all of which vary
 * run-to-run under load. The old "wallMs >= timeLimitMs" check produced
 * flaky TLE on identical submissions; this ladder decides from CPU time
 * and uses wall only as a loose liveness backstop.
 *
 * Order of checks:
 *   1. Node's last-resort SIGKILL timer fired     -> TO  (stuck nsjail/kernel)
 *   2. CPU time consumed >= user's timeLimitMs    -> TO  (authoritative)
 *   3. Clean exit (0, no signal) && CPU in budget -> null (AC/WA)
 *   4. Jail wall >= 3 * timeLimitMs               -> TO  (sleepy/blocked)
 *   5. Peak RSS at >=98% of the memory cap        -> OOM
 *   6. nsjail's 128+signal status                 -> TO for SIGXCPU (and
 *      for a SIGKILL that already overran the budget), else SIG
 *   7. A signal on the runner itself              -> SIG
 *   8. Null exit code (spawn failure)             -> SIG
 *   9. Otherwise                                  -> null
 *
 * Step 3 sitting after step 2 is what keeps a program that finished but
 * overspent its budget a TLE. Step 5 sitting after step 3 is what keeps
 * a solution that used its whole budget and exited cleanly an AC.
 * Reordering either reintroduces a bug that has already been fixed once.
 *
 * The two steps that used to sit at #2 and #3 -- "nsjail reported
 * RLIMIT_CPU" and "nsjail reported a memory limit exceeded" -- are gone
 * with the log scraper that fed them. nsjail 3.3 never emitted either
 * phrase, so neither had ever fired; step 2 and step 5 now do that work
 * from real measurements, and step 6 catches the kernel's SIGXCPU
 * directly out of the exit status.
 */
function classifyKill(args: {
  timedOutByNode: boolean;
  cpuMs: number | undefined;
  maxRssKb: number | undefined;
  jailWallMs: number | undefined;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  wallMs: number;
  timeLimitMs: number;
  memLimitMb: number;
}): SandboxResult["killedBy"] {
  const {
    timedOutByNode,
    cpuMs,
    maxRssKb,
    jailWallMs,
    signal,
    exitCode,
    wallMs,
    timeLimitMs,
    memLimitMb,
  } = args;

  if (timedOutByNode) return "TO";

  // CPU-time TLE (authoritative). This is `wait4()`'s rusage for nsjail
  // and every descendant it reaped -- actual CPU work consumed by the
  // program, independent of host scheduling or judge overhead, which is
  // what makes verdicts deterministic across runs and across hosts.
  if (cpuMs !== undefined && cpuMs >= timeLimitMs) return "TO";

  // Clean-exit guard. A normal exit(0) with no signal and no node-side
  // kill means the program actually finished -- never downgrade it to
  // TLE on wall noise. (The CPU-time check above has already rejected
  // programs that finished but exceeded their budget.)
  if (exitCode === 0 && signal === null) return null;

  // Wall-clock liveness backstop. Catches programs that block on
  // syscalls (sleep, I/O wait) without consuming CPU. Uses the runner's
  // inner wall clock when available (excludes Node's spawn latency);
  // 3x cushion keeps the threshold far from legitimate-run noise while
  // still bounding wedged submissions. Node's SIGKILL timer (fired at
  // timeLimitMs + KILL_GRACE_MS) is the tighter of the two in practice.
  const innerWallMs = jailWallMs ?? wallMs;
  if (innerWallMs >= timeLimitMs * 3) return "TO";

  // Peak RSS at (or within 2% of) the cap on a run that did NOT exit
  // cleanly -- the clean-exit guard above has already returned for those.
  // The 2% band exists because RSS is sampled by the kernel at page
  // granularity and a process that is being torn down for exceeding its
  // limit rarely reports the round number exactly. Note this is the peak
  // of the whole jail tree, so it includes nsjail's own few MB; that
  // cannot manufacture a false MLE at any realistic cap, and it can only
  // ever over-report, never hide a real one.
  const memLimitKb = memLimitMb * 1024;
  if (maxRssKb !== undefined && maxRssKb >= memLimitKb * MEM_LIMIT_RSS_RATIO) {
    return "OOM";
  }

  // In --mode o nsjail's own exit status IS the jailed child's fate:
  // `128 + WTERMSIG` when a signal killed it. Node's `signal` argument
  // describes what killed the RUNNER, which is null in every one of
  // these cases, so before this decode existed the ladder fell all the
  // way through to `null` and a SIGXCPU kill came back as `RE` with
  // `timedOut: false` -- neither a TLE verdict nor a timeout flag -- on
  // any host fast enough for RLIMIT_CPU to beat the wall timers.
  if (exitCode !== null && exitCode > 128 && exitCode <= 128 + 64) {
    const childSignal = exitCode - 128;
    // SIGXCPU is RLIMIT_CPU firing: unambiguously a timeout.
    if (childSignal === SIGXCPU_NUM) return "TO";
    // SIGKILL is nsjail's own --time_limit wall backstop when the run
    // has already outlived its budget; a program that SIGKILLs itself
    // inside its budget stays a runtime error.
    if (childSignal === SIGKILL_NUM && innerWallMs >= timeLimitMs) return "TO";
    return "SIG";
  }

  if (signal !== null) return "SIG";
  if (exitCode === null) return "SIG";

  return null;
}
