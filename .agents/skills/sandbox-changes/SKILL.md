---
name: sandbox-changes
description: Changes the wmoj-judge sandbox without silently breaking every submission — the nsjail argv flag by flag, the wmoj-jailrun resource reporter that supplies cpuMs/memKb, the exact rlimit set, the kafel seccomp policy and why its DEFAULT is ENOSYS, the four-timer TLE ladder that must stay ordered, the Dockerfile's linux/amd64 pin, tini, USER 1000, UID pool and Debian trixie pins, and the known escape paths that must not get worse. Use whenever someone wants to edit, tighten, widen, harden, debug, or review src/sandbox/**, policy.kafel, the seccomp allowlist, an nsjail flag, an rlimit, the UID pool, or the Dockerfile.
---

# Changing the wmoj-judge sandbox

Every flag, rlimit, and syscall in here is load-bearing, and most of the failures are silent: the
judge keeps returning 200s while every verdict is wrong. Read the rule before you change the thing,
and never widen anything just to make a submission work.

The sandbox is deliberately weaker than a textbook one because it has to run **unprivileged**: no
`CAP_SYS_ADMIN`, no `CAP_SETPCAP`, no cgroups. `src/sandbox/nsjail.ts` builds the argv,
`wmoj-jailrun` (built from source inside the `Dockerfile`) measures the run, `policy.kafel` is the
seccomp filter, and the `Dockerfile` supplies the UID pool and the toolchain. They are one design;
you cannot change one in isolation.

## The failure this whole area exists to prevent

A silent one has already shipped here once, and it is the template for the next. `cpuMs` and `memKb`
were **`0` on every single run for the life of the nsjail 3.3 pin**, because the code scraped them
out of nsjail's log and nsjail 3.3 emits no such lines. Nothing threw, nothing logged. The
authoritative TLE gate, both RSS-based MLE rules, and the setup-overhead telemetry meant to catch
exactly this were all dead at once, and the only visible symptom was a judge that had quietly stopped
reporting TLE and MLE. **Assume any new measurement you add can fail this way, and make it loud.**

## Resource accounting: `wmoj-jailrun`

`runSandboxed` does not spawn nsjail directly. It spawns

```
wmoj-jailrun 4 <NSJAIL_BIN> <nsjail argv...>
```

`wmoj-jailrun` is a ~90-line C program whose source lives in a heredoc **inside the Dockerfile** and
which is installed beside the nsjail binary. `nsjail.ts` locates it as
`path.dirname(config.NSJAIL_BIN) + "/wmoj-jailrun"`, so **the two must stay side by side**; there is
deliberately no env var for it, because a runner that does not match its nsjail is a bug, not a
deployment choice.

It forks, execs nsjail, `wait4()`s it with `rusage`, writes one line to the fd named in `argv[1]`,
and exits with nsjail's own status (`128 + WTERMSIG` when signalled), so nothing downstream changes
shape. The report line is the contract:

```
WMOJ-JAILRUN v1 exit=<n> signal=<n> cpu_us=<n> maxrss_kb=<n> wall_us=<n>
WMOJ-JAILRUN v1 error=<what> errno=<n>        # the runner itself failed
```

matched by `REPORT_RE` / `REPORT_ERROR_RE` in `nsjail.ts`. **Change one, change the other.** The
`recapture-measurements` CI job is what catches a change to either side that the other did not
follow: any change under `Dockerfile`, `policy.kafel`, `src/sandbox/**`, `src/verdict/**` or
`src/tools/**` re-captures `test/fixtures/measurements` on the x86_64 runner and diffs it against
the committed set, nightly too (ADR 0002).

Why out-of-jail rather than the alternatives, all of which were considered and rejected:

- `/proc/<pid>` sampling is a poll race — the numbers are final only once the jailed process is
  reaped, and the entry disappears microseconds later.
- `getrusage(RUSAGE_CHILDREN)` is not exposed by Node (`process.resourceUsage()` is `RUSAGE_SELF`)
  and would need a native addon.
- Wrapping the **jailed** argv would put the reporter under `policy.kafel` and inside the
  `--rlimit_as` cap it is trying to measure, and would need new syscalls in the ALLOW block.

Because it sits outside the jail it needs **no seccomp allowance at all**, and because it sets
`FD_CLOEXEC` on the report fd before forking, the jailed program never inherits fd 4 and cannot forge
or truncate its own TLE verdict.

Two properties to keep in mind:

- `ru_maxrss` is the peak over nsjail **and** every descendant it reaped, so `memKb` includes
  nsjail's own few MB. It can only ever over-report, never hide a real MLE.
- A run that **we** force-kill (`process.kill(-pid, "SIGKILL")` from the last-resort timer or the
  absolute deadline) takes the runner down with it, so no report is written and `cpuMs`/`memKb` are
  `0` for that run only. `nsjail.ts` tracks that with `forcedKill` and does **not** treat the missing
  report as a judge fault. Every ordinary TLE — RLIMIT_CPU firing inside the jail — still reports
  real numbers.

**The `sandbox-measures` liveness check** (`src/liveness`) is the loudness guarantee: it runs a
shell loop that overspends a 50 ms budget and fails unless a report arrived with a non-zero `cpuMs`
**and** `gradeCase` grades that measurement `TLE`. Boot asserts it and refuses to start; `/health`
re-runs it every 5 min, so a reporter that dies after boot turns the instance degraded instead of
leaving it green. The `selfcheck` measurement fixture is the same assertion replayed in-process. It
also doubles as the nsjail/`policy.kafel` boot probe.

## The four timers, and the order they must stay in

TLE is decided from **CPU time**, not wall clock, so verdicts stay stable on a shared 0.1-CPU host.
Four independent timers back that up, and the ordering is the whole design:

| # | Timer | Value for `tl` ms | Set in |
|---|---|---|---|
| 1 | userland CPU check — **authoritative** | `cpuMs >= tl` | the ladder in `src/verdict`, from the jailrun report |
| 2 | kernel `RLIMIT_CPU` backstop | `ceil(tl/1000) + 1` s | `--rlimit_cpu` |
| 3 | Node last-resort `SIGKILL` of the group | `tl + KILL_GRACE_MS` (5000 ms) | `killTimer`, `nsjail.ts` |
| 4 | nsjail `--time_limit` wall backstop | `ceil((tl+5000)/1000) + 2` s | `--time_limit` |

**1 < 2 < 3 < 4 must hold for every time limit.** Tighten any of them and the kernel kills the
program with SIGXCPU before the userland check can classify it. That used to mean every TLE became a
runtime error; the ladder now also decodes nsjail's `128 + WTERMSIG` status and maps SIGXCPU to
`TO`, so the failure is contained — but the ordering is still what makes the verdict *precise*
instead of rounded up to whole seconds.

Every delay and every numeric argv value is clamped to `MAX_INT32` before use. That is not
decoration: `timeLimit` is unbounded in the request contract, Node clamps a `setTimeout` delay above
2^31-1 ms to **1 ms**, and `String(1e21)` is `"1e+21"`, which nsjail's `strtol` reads as **1**. Both
turn an admin typo into an instantly and universally wrong verdict.

A separate wall backstop (`jail wall >= 3 * tl` → `TO`) catches programs that block without burning
CPU; it is not a substitute for any of the four.

## The nsjail argv

`reference/nsjail-argv.md` is the flag-by-flag matrix. The four that break everything:

**1. `--log_fd 3` — never route nsjail's log back to stderr.** nsjail's `[I][timestamp]` lines used
to interleave *byte-wise* with the child's stderr, and a generator's stderr JSON array also starts
with `[`, so `/generate-tests` was destroyed outright by any "strip lines starting with `[`" filter.
The log is now **diagnostic only** — no verdict is derived from its text — which is what makes it
safe that nobody has settled whether the jailed process can write to fd 3 itself.

**2. `--keep_caps`, with `--user`/`--group` absent.** nsjail's `initNsFromChild` issues
`prctl(PR_SET_SECUREBITS, …)`, which needs `CAP_SETPCAP` that Render does not grant. Running as a
non-root UID hits nsjail's early return (`if (!clone_newuser && orig_euid != 0) return true;`) and
skips that block entirely. Asking nsjail to `setresuid()` to a foreign UID fails EPERM and every
submission exits **255**.

**3. All seven `--disable_clone_new*` flags.** No user, net, mnt, pid, ipc, uts, or cgroup namespace
is created — creating one needs privileges this container lacks. Their absence is why network
blocking rests on seccomp alone and why the pool UID is only a concurrency gate.

**4. No `--chroot`.** Chrooting into the workdir would hide `/usr/bin/python3`, `/usr/bin/g++`, and
the shared libraries from the child, breaking `execve` on every run. `--rlimit_as` is always
`memLimitMb`; there is no per-caller override, so it cannot drift from the enforced memory cap and
silently disable the refused-allocation MLE rule. `SandboxOpts.label` names the call site
(`submit:case3`, `checker:case3`, `generator`, `liveness:launch`, `liveness:measure`,
`capture:<name>`) so a sandbox log line can be tied back to the work that produced it; the `uid`/`gid`
fields it replaced were never read.

The rlimits, all in `--rlimit_*` form:

| rlimit | Value | Why |
|---|---|---|
| `as` | the enforced memory cap (MB) | caps **virtual address space**, so `malloc` fails rather than the kernel killing — this is the whole reason MLE needs its own classification |
| `cpu` | `ceil(tl/1000) + 1` s | kernel backstop, timer 2 above |
| `nproc` | **256** | a **shared per-UID ceiling**, not per-submission headroom — see below |
| `nofile` | **256** | per process |
| `fsize` | **10** (MB) | a submission cannot fill the 512 MB host's disk. Regular files only (`S_ISREG`): it does **not** bound pipe writes |
| `core` | **0** | no core dumps into a shared `/tmp` |

**`--rlimit_nproc` bounds far less than it looks like it does**, and the old comment claiming
"`as`/`cpu` already bound abuse" was wrong three times over. `RLIMIT_CPU` and `RLIMIT_AS` are
per-process and re-inherited afresh by every `fork`, so forking N times multiplies the budget.
`RLIMIT_NPROC` is counted against the total tasks for the **real UID**, and `--user`/`--group` are
deliberately absent, so every submission, every `g++`, every `/health` probe **and the Node judge
itself** draw on the same 256. Lowering the number isolates nothing — it only decides which
submission gets `EAGAIN` first, and 256 already has to cover PyPy's and glibc's threads across up to
16 concurrent runs. What actually bounds a fork bomb here is the **unconditional process-group kill**
(transient descendants) plus **tini** reaping orphans (permanent zombies, which the kernel counts
against this same budget until reaped). Per-submission process accounting would need cgroups, which
this host does not have.

The env allowlist is exactly four `--env` entries: `PATH`, `LANG`, `LC_ALL`, `PYTHONUNBUFFERED`.
Never add a fifth to make something work.

## Process lifetime: settle on `'exit'`, kill the group

Node emits `'close'` only after the process has ended **and every stdio stream has closed**, and a
pipe EOFs only when every copy of the write end is gone — including copies held by descendants. With
no PID namespace and `clone` allowed, `int main(){ if (fork()==0) pause(); }` used to hold fds 1/2
open forever: the promise never settled, `submit.ts`'s `finally` never ran, and a UID-pool slot plus
a semaphore permit leaked permanently. Sixteen of those wedged the whole judge while `/health` stayed
green, and only a redeploy recovered. Four things keep that fixed, and none of them is optional:

1. Settle on **`'exit'`**, then drain the pipes for `STREAM_DRAIN_MS` (250 ms) and `destroy()` them.
   `'close'` stays as the fast path when it arrives first.
2. `spawn(..., { detached: true })`, so the runner is a process-group leader.
3. Kill the **group** — `process.kill(-child.pid, "SIGKILL")` — never `child.kill()`, which targets a
   pid libuv has already reaped and returns `false`.
4. That group kill runs **unconditionally in a `finally`** after every run, and an absolute deadline
   settles the promise regardless of stream state.

The group kill is airtight because `setsid` and `setpgid` are **not** in `policy.kafel`'s ALLOW block
(0 matches) — no descendant can leave the group. If you ever add either, this stops holding.

## Output caps

`stdout` (1 MiB), `stderr` (64 KiB) and the nsjail log (256 KiB) are capped in the `data` handlers.
Nothing else bounds them — `requestCaps` bounds the *request*, `--rlimit_as` bounds address space
rather than pipe throughput, and `--rlimit_fsize` never applies to pipes — so `for(;;) puts("x")`
used to push hundreds of MB into the Node heap of a 512 MB container. The 1 MiB stdout cap sits just
above `requestCaps`' 1,000,000-byte per-case expected-output cap, so a truncated `/submit` run could
not have been `AC` anyway; `RunMeasurement.truncated` says it happened.

Two deliberate choices here. The child is **not** killed on overflow — we keep draining and
discarding, so an infinite print loop stays CPU-bound and reaches its own `RLIMIT_CPU` and a real
`TLE`, instead of losing its exit status to a kill and coming back a spurious `RE`. And `/submit`'s
1 MiB default is **wrong for `/generate-tests`**, whose stdout IS the payload: that caller must pass
a larger `maxStdoutBytes`/`maxStderrBytes` deliberately.

U+0000 is stripped to U+FFFD on the way out. It is valid UTF-8 so it survives `toString("utf8")`,
and `wmoj-app` inserts these strings into a PostgreSQL `jsonb` column that cannot represent it — a
single `putchar(0)` produced a correct 200 whose row was then silently never persisted.

## `RunOutcome.ok === false`: a judge fault is never a student's verdict

`runSandboxed` resolves a `RunOutcome`: `{ok: true, run: RunMeasurement}` or
`{ok: false, sandboxError}`. The second arm is the judge's own machinery failing, with **nothing of
the user's run or gradeable**: the runner or nsjail could not be spawned, the runner reported its
own failure, no resource report arrived on a run we did not force-kill, or nsjail exited 255/1 with
an `[F]` fatal line on fd 3 and empty stdout. A caller has to look at `ok` before it can reach the
measurement, and every caller throws on `ok: false` so the route's `catch` returns `500 {error}` —
the documented "the judge is wrong" channel. Do **not** reuse `IE`; it is checker-only.

The failure it exists for is live, not hypothetical: build the image for arm64 and `policy.kafel`
(amd64 syscall table) fails to compile, nsjail exits 255 on every spawn, and **every test case of
every submission is graded `RE`** on a clean HTTP 200 while `/health` still says `{"status":"ok"}`.

## policy.kafel

Structure: an explicit `ERRNO(1)` denylist block (network, ptrace, mount, module, namespace, setuid,
keyring, clock), then an `ALLOW` fast-path block for the syscalls the runtimes actually make, then
`USE wmoj_judge DEFAULT ERRNO(38)` at the bottom.

**`DEFAULT ERRNO(38)` is ENOSYS and must stay ENOSYS.**

- Making it `KILL` breaks glibc's unknown-syscall probes — `rseq`, `statx`, `faccessat2`,
  `close_range`, `clone3`, `openat2` are all outside Kafel 3.3's amd64 table, so each one SIGSYS-kills
  the process before `main()` runs (exit **159** = 128+31).
- Making it `ERRNO(1)` (EPERM) breaks `pthread_create`: modern glibc calls `clone3` first and only
  falls back to classic `clone()` when it sees **ENOSYS**. EPERM propagates straight through.

**`execve` and `execveat` must stay ALLOWed.** nsjail installs the filter *before* it execs the user
binary, so removing either SIGSYS-kills every submission at exit 159 — the same symptom as
`DEFAULT KILL`, and just as easy to misdiagnose as a compiler problem.

**Three rules are argument-filtered**, and each mask is exact:

- `clone { (clone_flags & 0x7E020000) == 0 }` — exactly the seven `CLONE_NEW*` bits. Widen it and a
  submission can create namespaces; narrow it and threads stop working.
- `prlimit64 { pid == 0 }` and `sched_setaffinity { pid == 0 }` — both take a pid, and with
  `--user` absent every submission shares UID 1000 **with the Node judge**, so an unfiltered call
  could retarget the judge itself. `pid == 0` ("myself") is the only form a submission needs.
  A non-matching pid falls to `DEFAULT ERRNO(38)`, so it is ENOSYS, never a SIGSYS kill.

A 4-byte `pid` compares on the low 32 bits only, which is what the kernel truncates to `pid_t`, so
there is no high-half bypass in either direction.

`kill`, `tkill`, and `tgkill` are allowed unfiltered and **must stay that way**: CPython's `abort()`
and `signal.raise_signal()` go through `tgkill(getpid(), gettid(), sig)` with a **non-zero** pid, so
a `pid == 0` filter would break legitimate self-signalling. See the weaknesses below.
`setsid`/`setpgid` are absent and must stay absent: the process-group kill above depends on it.

The policy targets the **amd64** syscall table. That is why the Dockerfile pins the platform.

## Dockerfile

- **Every `FROM` pins `--platform=linux/amd64`, and that pin is load-bearing.** Without it, a build
  on an Apple Silicon machine produces a native arm64 image where `policy.kafel` will not compile
  (`Undefined identifier 'umount'`), nsjail exits 255, and every submission is graded `RE` on a clean
  200. Render's target is amd64; on arm64 hosts this builds under emulation and is slow, which is the
  correct trade.
- **`ENTRYPOINT ["/usr/bin/tini","--"]` is required.** Node is not an init and libuv `waitpid()`s
  only handles it created, so orphans reparented to PID 1 become permanent zombies — and the kernel
  counts a zombie against `RLIMIT_NPROC` for its real UID until it is reaped. Render does not allow
  `docker run --init`, so the init has to live in the image. tini forwards SIGTERM to node, so the
  graceful drain is unaffected.
- **`USER 1000` is required**, for the `--keep_caps` reason above. Overriding `USER` in `docker run`,
  or adding `--user`, gives exit 255 on every submission.
- **The `useradd` loop (`seq 1000 1015`) must track `UID_POOL_SIZE`** (16) and `BASE_UID = 1000` in
  `src/sandbox/uidPool.ts`. They are three separate literals with no shared source.
- **Debian trixie cannot be downgraded.** `cpp23` needs g++ 14 for complete `-std=c++23`; bookworm's
  g++ 12 and bullseye's g++ 10 only cover part of it. Watch `libprotobuf32t64` — trixie's 64-bit
  `time_t` rename of `libprotobuf32`; the old name does not exist and nsjail will not link.
- **nsjail is pinned to tag 3.3**, built from source in stage 1, and `wmoj-jailrun` is built beside
  it from the heredoc in the same stage and copied to the same directory. Bumping the nsjail pin no
  longer risks silent zero resource numbers — those come from `wait4()` now — but it can still change
  the exit-status shape `decodeJailExit` (`src/sandbox/exitStatus.ts`) decodes. **If you bump it, verify a known-TLE and a known-MLE
  submission by hand against the built image.**

## Known weaknesses — do not make these worse

These are real and unfixed. Say so when you touch nearby code; do not quietly rely on them being safe.

**1. `/app` is writable by the sandboxed UID, and `policy.kafel` is re-read on every spawn.** The
Dockerfile does `chown -R 1000:1000 /app && chmod -R 750 /app` then `USER 1000`, and there is no
chroot and no path filtering on `open`/`write`/`rename`. A submission can therefore overwrite
`/app/policy.kafel` or `/app/dist/*.js`, and the **next** spawn — including its own next test case —
runs under it. That turns a one-shot bypass into a persistent one. Any change that makes `/app` more
writable, or that starts caching more state under it, makes this strictly worse.

**2. The judge process is killable by user code.** `kill`/`tkill`/`tgkill` are allowed unfiltered,
there is no PID namespace, and the Node process shares UID 1000, so a submission can find the judge's
PID through `/proc` and SIGKILL it.

**3. Compile-cache poisoning through the shared `/tmp`.** Every workdir and `/tmp/judge-cache` belong
to the same UID, so the cache's `0700` mode buys nothing against another submission.

**4. There is exactly one UID, and it is not a boundary.** Every submission, `g++`, and the Node
judge run as UID 1000. The per-submission `0700` `mkdtemp` workdir is hygiene against *other UIDs on
the host*, not cross-submission isolation. What genuinely holds is that `ptrace`, `process_vm_readv`,
`process_vm_writev` and `kcmp` are all denied, so concurrent submissions cannot read each other's
memory.

**5. fd 3 may be writable by the jailed program.** Unsettled — it depends on whether nsjail's
`containMakeFdsCoE` exempts the log fd. Nothing derives a verdict from that text any more, so the
worst case is a polluted log line, plus a submission that can turn its **own** run into a judge-fault
500 by forging an `[F]` prefix on an exit-255 run with no stdout. If it is ever confirmed
inheritable, switch to `--log_file` pointing at a judge-owned temp file outside the workdir.

## Never

- Never widen the seccomp allowlist, or relax `DEFAULT ERRNO(38)`, to make a runtime work — find
  which syscall it needs and decide deliberately, in a commit that says why.
- Never remove `execve`/`execveat` from the ALLOW block, and never change the `clone` flag mask.
- Never add `setsid` or `setpgid` — the process-group kill depends on their absence.
- Never move nsjail's log off fd 3, and never parse it out of the child's stderr.
- Never derive a verdict from nsjail's log text again. Measure it, or make it loud.
- Never let `runSandboxed` resolve on `'close'`, and never drop `detached: true` or the `finally`
  group kill.
- Never separate `wmoj-jailrun` from the nsjail binary, and never change the report line's format on
  one side only.
- Never add `--user`, `--group`, or `--chroot`, and never override `USER` in `docker run`.
- Never drop `--platform=linux/amd64` or the tini `ENTRYPOINT`.
- Never tighten one timer without re-checking all four against the table above.
- Never change `UID_POOL_SIZE`, `BASE_UID`, or the `useradd` loop without changing the other two.
- Never bump the nsjail pin without re-verifying a real TLE and a real MLE against the built image.
- Never claim you verified sandbox behaviour on macOS — nsjail is Linux-only. Build the image.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
moved flag, a new syscall in the policy, a changed rlimit, an nsjail version bump, a weakness that
got fixed or got worse — update it as part of your change. This skill is only useful while it is
accurate.
