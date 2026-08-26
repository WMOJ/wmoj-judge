---
name: sandbox-changes
description: Changes the wmoj-judge sandbox without silently breaking every submission — the nsjail argv flag by flag, the exact rlimit set, the kafel seccomp policy and why its DEFAULT is ENOSYS, the four-timer TLE ladder that must stay ordered, the Dockerfile's USER 1000 / UID pool / Debian trixie pins, and the known escape paths that must not get worse. Use whenever someone wants to edit, tighten, widen, harden, debug, or review src/sandbox/**, policy.kafel, the seccomp allowlist, an nsjail flag, an rlimit, the UID pool, or the Dockerfile.
---

# Changing the wmoj-judge sandbox

Every flag, rlimit, and syscall in here is load-bearing, and most of the failures are silent: the
judge keeps returning 200s while every verdict is wrong. Read the rule before you change the thing,
and never widen anything just to make a submission work.

The sandbox is deliberately weaker than a textbook one because it has to run **unprivileged**: no
`CAP_SYS_ADMIN`, no `CAP_SETPCAP`, no cgroups. `src/sandbox/nsjail.ts` builds the argv,
`policy.kafel` is the seccomp filter, and the `Dockerfile` supplies the UID pool and the toolchain.
The three are one design; you cannot change one in isolation.

## The four timers, and the order they must stay in

TLE is decided from **CPU time**, not wall clock, so verdicts stay stable on a shared 0.1-CPU host.
Four independent timers back that up, and the ordering is the whole design:

| # | Timer | Value for `tl` ms | Set in |
|---|---|---|---|
| 1 | userland CPU check — **authoritative** | `cpuMs >= tl` | `classifyKill`, `nsjail.ts` |
| 2 | kernel `RLIMIT_CPU` backstop | `ceil(tl/1000) + 1` s | `--rlimit_cpu` |
| 3 | Node last-resort `SIGKILL` | `tl + KILL_GRACE_MS` (5000 ms) | `killTimer`, `nsjail.ts` |
| 4 | nsjail `--time_limit` wall backstop | `ceil((tl+5000)/1000) + 2` s | `--time_limit` |

**1 < 2 < 3 < 4 must hold for every time limit.** Tighten any of them and the kernel kills the
program with SIGXCPU before the userland check can classify it: `classifyKill` falls through to
`SIG`, `deriveVerdict` maps that to **RE**, and every TLE in the system becomes a runtime error. A
separate wall backstop (`innerWallMs >= 3 * tl` → `TO`) catches programs that block without burning
CPU; it is not a substitute for any of the four.

## The nsjail argv

`reference/nsjail-argv.md` is the flag-by-flag matrix. The four that break everything:

**1. `--log_fd 3` — never route nsjail's log back to stderr.** nsjail's `[I][timestamp]` lines used
to interleave *byte-wise* with the child's stderr, and a generator's stderr JSON array also starts
with `[`, so `/generate-tests` was destroyed outright by any "strip lines starting with `[`" filter.
It is also the fd `parseNsjailStderr` consumes: move it and `cpuMs`/`memKb` silently become `0`,
which disables both the authoritative TLE gate and MLE rule 2 with no error anywhere.

**2. `--keep_caps`, with `--user`/`--group` absent.** nsjail's `initNsFromChild` issues
`prctl(PR_SET_SECUREBITS, …)`, which needs `CAP_SETPCAP` that Render does not grant. Running as a
non-root UID hits nsjail's early return (`if (!clone_newuser && orig_euid != 0) return true;`) and
skips that block entirely. Asking nsjail to `setresuid()` to a foreign UID fails EPERM and every
submission exits **255**.

**3. All seven `--disable_clone_new*` flags.** No user, net, mnt, pid, ipc, uts, or cgroup namespace
is created — creating one needs privileges this container lacks. Their absence is why network
blocking rests on seccomp alone and why the pool UID is only a concurrency gate.

**4. No `--chroot`.** Chrooting into the workdir would hide `/usr/bin/python3`, `/usr/bin/g++`, and
the shared libraries from the child, breaking `execve` on every run. `SandboxOpts.chrootDir` is
accepted by the type and ignored; so is `rlimitAsMb`. `gid` is passed by every caller and never read.

The rlimits, all in `--rlimit_*` form:

| rlimit | Value | Why |
|---|---|---|
| `as` | the enforced memory cap (MB) | caps **virtual address space**, so `malloc` fails rather than the kernel killing — this is the whole reason MLE needs its own classification |
| `cpu` | `ceil(tl/1000) + 1` s | kernel backstop, timer 2 above |
| `nproc` | **256** | comfortable for PyPy and thread-heavy runtimes; DoS is already bounded by `as`/`cpu` |
| `nofile` | **256** | same |
| `fsize` | **10** (MB) | a submission cannot fill the 512 MB host's disk |
| `core` | **0** | no core dumps into a shared `/tmp` |

The env allowlist is exactly four `--env` entries: `PATH`, `LANG`, `LC_ALL`, `PYTHONUNBUFFERED`.
Never add a fifth to make something work.

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

**`clone { (clone_flags & 0x7E020000) == 0 }` is the only argument-filtered rule**, and that mask is
exactly the seven `CLONE_NEW*` bits. Widen it and a submission can create namespaces; narrow it and
threads stop working.

`kill`, `tkill`, and `tgkill` are allowed unfiltered — see the weaknesses below before you touch
them, and before you assume they are safe.

## Dockerfile

- **`USER 1000` is required**, for the `--keep_caps` reason above. Overriding `USER` in `docker run`,
  or adding `--user`, gives exit 255 on every submission.
- **The `useradd` loop (`seq 1000 1015`) must track `UID_POOL_SIZE`** (16) and `BASE_UID = 1000` in
  `src/sandbox/uidPool.ts`. They are three separate literals with no shared source.
- **Debian trixie cannot be downgraded.** `cpp23` needs g++ 14 for complete `-std=c++23`; bookworm's
  g++ 12 and bullseye's g++ 10 only cover part of it. Watch `libprotobuf32t64` — trixie's 64-bit
  `time_t` rename of `libprotobuf32`; the old name does not exist and nsjail will not link.
- **nsjail is pinned to tag 3.3**, built from source in stage 1. `parseNsjailStderr`'s **six regexes**
  (`cpu-limit`, `mem-limit`, `maxrss`, wall time, cpu time, signal) are an undocumented contract with
  that version's log format. Bump the pin and the parse can silently yield `cpuMs === 0` and
  `memKb === 0` — no exception, no log line, just a judge that never reports TLE or MLE again. If you
  bump it, verify a known-TLE and a known-MLE submission by hand against the built image.

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

## Never

- Never widen the seccomp allowlist, or relax `DEFAULT ERRNO(38)`, to make a runtime work — find
  which syscall it needs and decide deliberately, in a commit that says why.
- Never remove `execve`/`execveat` from the ALLOW block, and never change the `clone` flag mask.
- Never move nsjail's log off fd 3, and never parse it out of the child's stderr.
- Never add `--user`, `--group`, or `--chroot`, and never override `USER` in `docker run`.
- Never tighten one timer without re-checking all four against the table above.
- Never change `UID_POOL_SIZE`, `BASE_UID`, or the `useradd` loop without changing the other two.
- Never bump the nsjail pin without re-verifying `parseNsjailStderr` against real log output.
- Never claim you verified sandbox behaviour on macOS — nsjail is Linux-only. Build the image.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
moved flag, a new syscall in the policy, a changed rlimit, an nsjail version bump, a weakness that
got fixed or got worse — update it as part of your change. This skill is only useful while it is
accurate.
