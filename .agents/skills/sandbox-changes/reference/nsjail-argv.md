# The nsjail argv, flag by flag

The complete argv `runSandboxed` builds, in order, from `src/sandbox/nsjail.ts`. Nothing else is
passed; anything not listed here is nsjail's default.

```
nsjail --mode o
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
| `--mode o` | one-shot execute; the judge spawns a fresh nsjail per test case |
| `--disable_clone_new*` (×7) | creating any namespace needs privileges the container lacks; the flags make that explicit rather than letting nsjail fail at runtime |
| `--keep_caps` | skips `prctl(PR_SET_SECUREBITS, …)`, which needs `CAP_SETPCAP`. Without it nsjail aborts with "Operation not permitted" |
| `--cwd` | the per-submission `0700` workdir. It is why run argv and checker argv use **relative** paths (`./a.out`, `checker-input-0.txt`) |
| `--rlimit_as` | virtual address space, in MB. Not RSS — see `verdicts-and-comparison` for what that does to MLE |
| `--rlimit_cpu` | whole seconds only, hence the `+1` so sub-second limits do not floor to 0 and so it fires strictly after the userland CPU check |
| `--rlimit_nproc 256` | room for PyPy's and glibc's threads; `as`/`cpu` already bound abuse |
| `--rlimit_nofile 256` | same reasoning |
| `--rlimit_fsize 10` | MB per file. A submission cannot fill the host disk through the shared `/tmp` |
| `--rlimit_core 0` | no core dumps |
| `--seccomp_policy` | `config.SECCOMP_POLICY`, default `/app/policy.kafel`, **re-read on every spawn** |
| `--env NAME` (×4) | name-only form: nsjail forwards these four from its own environment. Nothing else from the judge's env reaches the child |
| `--time_limit` | wall-clock liveness backstop only, deliberately the loosest of the four timers |
| `--log_fd 3` | nsjail's own diagnostics, on a dedicated pipe. Read back into `nsjailLog` and parsed by `parseNsjailStderr` |

Node opens four stdio slots — `["pipe", "pipe", "pipe", "pipe"]` — so slot 3 is the parent end of the
log pipe. Slot 2 therefore carries **only** the child's stderr, byte-clean and unfiltered, which is
what `/generate-tests` and `TestResult.stderr` both depend on.

# `classifyKill`, in order

`killedBy` is `"TO" | "OOM" | "SIG" | null`. The ladder short-circuits top to bottom:

1. Node's last-resort SIGKILL timer fired → `TO` (a stuck nsjail or kernel, not a runaway program)
2. nsjail reported `RLIMIT_CPU` / `--time_limit` → `TO`
3. nsjail reported a memory limit **exceeded** → `OOM`
4. `meta.cpuTimeMs >= timeLimitMs` → `TO` — **the authoritative gate**
5. clean exit (`0`, no signal) → `null`; never downgrade a finished program on wall noise
6. `innerWallMs >= 3 * timeLimitMs` → `TO` (blocked on syscalls without burning CPU)
7. peak RSS `>= MEM_LIMIT_RSS_RATIO` (0.98) of the cap → `OOM`
8. any remaining signal → `SIG`
9. `exitCode === null` (spawn failure) → `SIG`
10. otherwise → `null`

Step 5 sitting *after* step 4 is what keeps a program that finished but overspent its budget a TLE.
Step 7 sitting after step 5 is what keeps a solution that used its whole budget and exited cleanly an
AC. Reordering either reintroduces a bug that has already been fixed once.

# `parseNsjailStderr` — the version contract

Six regexes, applied only to lines starting with `[` (nsjail always prefixes `[L][timestamp]`):

| Match | Sets | Consumed by |
|---|---|---|
| `time >= soft limit` / `cpu time limit` | `exitReason = "cpu-limit"` | `classifyKill` step 2 |
| `(memory limit\|maximum memory) … (exceed\|reach\|hit\|over)`, or `oom-kill` | `exitReason = "mem-limit"` | `classifyKill` step 3 |
| `max rss … N k` / `maxrss=N` | `maxRssKb` | `memKb`, MLE rules 1 and 2 |
| `wall time … N.NN` | `wallTimeMs` | `timeMs`, wall backstop |
| `cpu time … N.NN` | `cpuTimeMs` | `cpuMs`, the authoritative TLE gate |
| `killed by signal … N` | `signal` | diagnostics |

The `mem-limit` pattern deliberately requires a word meaning *exceeded*: nsjail's startup lines echo
the **configured** `rlimit_as`, and a limit being set is not a limit being hit. An earlier version
matched the literal `rlimit_as` and reported OOM on every single run.

If any of these stops matching, the judge does not error — it reports zeros. That is why an nsjail
version bump has to be verified against a real TLE and a real MLE submission by hand.
