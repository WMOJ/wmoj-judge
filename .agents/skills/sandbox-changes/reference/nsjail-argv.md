# The nsjail argv, flag by flag

`runSandboxed` does not spawn nsjail directly — it spawns the out-of-jail resource reporter, which
execs nsjail. The complete argv, in order, from `src/sandbox/nsjail.ts`. Nothing else is passed;
anything not listed here is nsjail's default.

```
wmoj-jailrun 4 /usr/local/bin/nsjail
       --mode o
       --disable_clone_newuser --disable_clone_newnet --disable_clone_newns
       --disable_clone_newpid  --disable_clone_newipc --disable_clone_newuts
       --disable_clone_newcgroup
       --keep_caps
       --cwd <workdir>
       --rlimit_as <memLimitMb> --rlimit_cpu <ceil(tl/1000)+1>
       --rlimit_nproc 256 --rlimit_nofile 256 --rlimit_fsize 10 --rlimit_core 0
       --seccomp_policy /app/policy.kafel
       --env PATH --env LANG --env LC_ALL --env PYTHONUNBUFFERED
       --time_limit <ceil((tl+5000)/1000)+2>
       --log_fd 3
       -- <run argv>
```

| Flag | Why it is exactly this |
|---|---|
| `wmoj-jailrun 4` | the reporter and the fd it writes its resource report to. It is `config.NSJAIL_BIN`'s directory sibling, forks/execs nsjail, `wait4()`s it with `rusage`, and exits with nsjail's own status. See the report contract below |
| `--mode o` | one-shot execute; the judge spawns a fresh nsjail per test case |
| `--disable_clone_new*` (×7) | creating any namespace needs privileges the container lacks; the flags make that explicit rather than letting nsjail fail at runtime |
| `--keep_caps` | skips `prctl(PR_SET_SECUREBITS, …)`, which needs `CAP_SETPCAP`. Without it nsjail aborts with "Operation not permitted" |
| `--cwd` | the per-submission `0700` workdir. It is why run argv and checker argv use **relative** paths (`./a.out`, `checker-input-0.txt`) |
| `--rlimit_as` | virtual address space, in MB. Not RSS — see `verdicts-and-comparison` for what that does to MLE |
| `--rlimit_cpu` | whole seconds only, hence the `+1` so sub-second limits do not floor to 0 and so it fires strictly after the userland CPU check |
| `--rlimit_nproc 256` | a **per-UID ceiling shared with the judge process**, not per-submission headroom — see SKILL.md. It is re-inherited by every fork, so it bounds a fork bomb only in aggregate |
| `--rlimit_nofile 256` | per process |
| `--rlimit_fsize 10` | MB per **regular file** (`S_ISREG`). It does not bound pipe writes — the stdout/stderr caps in `runSandboxed` do that |
| `--rlimit_core 0` | no core dumps |
| `--seccomp_policy` | `config.SECCOMP_POLICY`, default `/app/policy.kafel`, **re-read on every spawn**. The ONLY conditional flag: omitted entirely when `UNSAFE_DISABLE_SECCOMP` is set, a local-development escape hatch for arm64 hosts that `config.ts` refuses under `NODE_ENV=production` → `run-judge-locally` |
| `--env NAME` (×4) | name-only form: nsjail forwards these four from its own environment. Nothing else from the judge's env reaches the child |
| `--time_limit` | wall-clock liveness backstop only, deliberately the loosest of the four timers |
| `--log_fd 3` | nsjail's own diagnostics, on a dedicated pipe. Read into `nsjailLog` and **logged only** — no verdict derives from it |

Every numeric value goes through `argvInt`, which truncates and clamps to 2^31-1. nsjail parses each
one with `strtol`, and `String(1e21)` is `"1e+21"` — which `strtol` reads as **1**, silently turning
an unbounded `memoryLimit` into a 1 MB address-space cap.

Node opens five stdio slots — `["pipe","pipe","pipe","pipe","pipe"]` — plus `detached: true`:

- slot 3 is the parent end of nsjail's log pipe;
- slot 4 is the parent end of the **reporter's** pipe, which `wmoj-jailrun` marks `FD_CLOEXEC`
  before forking so nsjail and the jailed program never inherit it;
- slot 2 therefore carries **only** the child's stderr, byte-clean and unfiltered, which is what
  `/generate-tests` and `TestResult.stderr` both depend on;
- `detached: true` makes the reporter a process-group leader so the group can be killed as a unit.

# The `wmoj-jailrun` report — the measurement contract

This replaced a six-regex scrape of nsjail's log. That scrape matched **nothing** nsjail 3.3 emits —
both `wait4()` calls in its `subproc.cc` pass `NULL` for rusage, and no runtime log line contains a
CPU time, a wall time or a maxrss — so `cpuMs` and `memKb` were `0` on every run, the authoritative
TLE gate had never once executed, and MLE rules 1 and 2 were dead. The replacement is a contract with
a C file this repository builds itself, in the Dockerfile, rather than with a third party's log text.

One line, written to fd 4 after `wait4()` returns:

```
WMOJ-JAILRUN v1 exit=<n> signal=<n> cpu_us=<n> maxrss_kb=<n> wall_us=<n>
```

or, when the reporter itself failed (bad fd, `fork`, `execvp`, `wait4`):

```
WMOJ-JAILRUN v1 error=<what> errno=<n>
```

| Field | Source | Consumed by |
|---|---|---|
| `exit` | `WEXITSTATUS`, or `-1` if nsjail was signalled | diagnostics; `SandboxResult.exitCode` comes from the runner's own exit status, which mirrors it |
| `signal` | `WTERMSIG` of **nsjail itself**, or 0 | diagnostics |
| `cpu_us` | `ru_utime + ru_stime` | `cpuMs`, the authoritative TLE gate |
| `maxrss_kb` | `ru_maxrss` (KB on Linux) | `memKb`, MLE rules 1 and 2, `classifyKill` step 5 |
| `wall_us` | `CLOCK_MONOTONIC` across fork→wait4 | `timeMs`, the wall backstop, `setupOverheadMs` |

`rusage` from `wait4()` covers nsjail **and every descendant nsjail reaped** — which is the jailed
program — so `cpu_us` is the submission's real CPU cost and `maxrss_kb` its real peak, with nsjail's
own few MB included in the latter.

**No report is written when the judge force-kills the process group** (the last-resort SIGKILL timer
or the absolute deadline), because the reporter is in that group. `runSandboxed` tracks that with
`forcedKill` and does not call it a judge fault; those runs report `cpuMs: 0` and are already
classified `TO` by ladder step 1. A missing report on any *other* path sets `sandboxError`.

# `classifyKill`, in order

`killedBy` is `"TO" | "OOM" | "SIG" | null`. The ladder short-circuits top to bottom:

1. Node's last-resort SIGKILL timer fired → `TO` (a stuck nsjail or kernel, not a runaway program)
2. `cpuMs >= timeLimitMs` → `TO` — **the authoritative gate**
3. clean exit (`0`, no signal) → `null`; never downgrade a finished program on wall noise
4. jail wall `>= 3 * timeLimitMs` → `TO` (blocked on syscalls without burning CPU)
5. peak RSS `>= MEM_LIMIT_RSS_RATIO` (0.98) of the cap → `OOM`
6. nsjail's `128 + WTERMSIG` status: SIGXCPU (24) → `TO`; SIGKILL (9) with jail wall already past the
   budget → `TO`; anything else → `SIG`
7. a signal on the runner itself → `SIG`
8. `exitCode === null` (spawn failure) → `SIG`
9. otherwise → `null`

Step 3 sitting *after* step 2 is what keeps a program that finished but overspent its budget a TLE.
Step 5 sitting after step 3 is what keeps a solution that used its whole budget and exited cleanly an
AC. Reordering either reintroduces a bug that has already been fixed once.

Step 6 is the one that used to be missing. In `--mode o` nsjail's own exit status **is** the jailed
child's fate, and Node's `signal` argument describes what killed nsjail — `null` in every one of
these cases. Without the decode the ladder fell through to `null`, so a program the kernel SIGXCPU'd
came back `RE` with `timedOut: false`: neither a TLE verdict nor a timeout flag, and the outcome
depended on how fast the host was.

The two steps that used to sit between 1 and 2 — "nsjail reported `RLIMIT_CPU`" and "nsjail reported
a memory limit exceeded" — are gone along with the log scrape that fed them. Neither had ever fired.
