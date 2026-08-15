# wmoj-judge — agent guide

The execution half of WMOJ. A **stateless, synchronous** HTTP service that compiles and runs
untrusted competitive-programming submissions inside `nsjail` + seccomp and returns per-test
verdicts in the same response.

Node 20 · TypeScript (CommonJS) · Express 4 · Docker. Its only client is `wmoj-app`, authenticated
with a static shared secret. **No database, queue, job IDs, callbacks, or persistence.**

## The constraint that explains this codebase

It runs on a **free Render instance: 512 MB RAM, ~0.1 CPU**, in a container with no
`CAP_SYS_ADMIN`/`CAP_SETPCAP` and no cgroup access. Nearly every limitation here — the disabled
namespaces, serial test execution, the size caps, the compile cache — is a consequence of that host,
not an oversight. Before "fixing" something that looks under-built, check whether it is load-bearing
for this environment.

## Commands

```bash
npm ci
npm run build    # tsc → dist/ — the ONLY automated quality gate; keep it clean
npm run dev      # tsx watch (Linux only)
npm run start
docker build -t wmoj-judge .
docker run --rm -p 4001:4001 -e JUDGE_SHARED_SECRET=… -e AUTH_STRICT=true wmoj-judge
```

**No tests, no linter, no CI.** `tsc` runs with `strict` + `noUncheckedIndexedAccess`, so a clean
build is a real bar — but behavioural changes must be checked by hand against a running container.

- **Won't run natively on macOS** — nsjail is Linux-only. Use Docker.
- **`.env.local` is intentionally not loaded** (no `dotenv`, no `--env-file`). There's no need for
  strict auth locally, so local runs fall back to `AUTH_STRICT=false`. In production the vars come
  from the Render dashboard.
- The judge **refuses to boot** unless `python3`, `pypy3`, and `g++` are all on `PATH`.
  `NODE_ENV=production` is baked into the image, so a missing `JUDGE_SHARED_SECRET` exits 1.

## API

Three endpoints. `/health` is unauthenticated by design (Render probes); `/submit` and
`/generate-tests` sit behind `auth → rateLimit → requestCaps`. There is **no 404 handler and no
global error handler**, so unmatched paths return Express's default HTML.

**`POST /submit`** —
`{language, code, input[], output[], timeLimit?, memoryLimit?, compareMode?, checker?}`;
`input`/`output` must be equal-length string arrays. Returns 200 with
`{summary:{total,passed,failed}, results[], effectiveMemoryLimitMb}`.

`effectiveMemoryLimitMb` is the cap actually enforced —
`min(requested ?? language default ?? 256, HOST_MEMORY_CEILING_MB)`. A problem may *declare* more
than the host can back; this reports what was really applied. Present on **every** 200, including
the two error shapes below.

> **A compile error is also HTTP 200** — `{summary:{0,0,0}, results:[], compileError}`. This is
> contractual; `wmoj-app` depends on it. 4xx/5xx means the request or the judge is wrong, never the
> user's code.

### Custom checkers (`checker`)

For problems whose answer is not unique ("print any valid arrangement"), send the checker's **C++
source** in `checker`. Absent, `null`, or blank ⇒ the byte comparison selected by `compareMode`,
exactly as before checkers existed. That backwards compatibility is mandatory: every live problem
today ships without a checker and none of them may change behaviour. When a checker *is* supplied it
**replaces `compareMode` entirely**; the string comparison never runs.

- Compiled **once per submission** (never per case) with
  `/usr/bin/g++ -O2 -std=gnu++17 Checker.cpp -o checker.out`, the same hardcoded shape
  `/generate-tests` uses for generators. Deliberately not routed through `Executor.compile()`, which
  takes no filename and can only build `Main.cpp`.
- Invoked per case as `checker.out <input_file> <expected_file> <contestant_output_file>` — three
  real files in the workdir, passed relative to it (nsjail sets it as cwd). Scratch files are
  removed after each case; 200 cases × 3 × 1 MB would not fit on this host otherwise.
- Runs through **the same `runSandboxed` path as submissions** (a buggy checker must not hang or
  escape the judge) with its own generous limits: **10 s CPU, 256 MB**.
- Only runs when the contestant's program itself finished cleanly. A TLE/MLE/RE case never reaches
  the checker.

Exit codes are the testlib/DMOJ convention:

| Exit | Meaning | wmoj-judge verdict |
|---|---|---|
| `0` | accepted | case passes |
| `1` | wrong answer | `WA` |
| `2` | presentation error | `WA` (no PE verdict here) |
| `3` | checker internal error | **`IE`** |
| other non-zero | — | `WA` |
| checker killed / never ran | — | **`IE`** |

The checker's **stderr** is trimmed, truncated to ~1 KB, and returned per case as
`TestResult.checkerMessage` — that is how a problem explains *why* an answer was rejected. The key
is omitted entirely when there is no checker or it said nothing.

> **A checker that fails to compile is HTTP 200 with a top-level `checkerError`** —
> `{summary:{0,0,0}, results:[], effectiveMemoryLimitMb, checkerError}`, exactly parallel to
> `compileError`. **Never reuse `compileError` for this**: `wmoj-app` synthesizes a user-facing `CE`
> from that field, and a broken checker is a problem-configuration fault, not the student's.

`examples/checkers/any-valid-pair.cpp` is a working reference checker (plus fixtures in
`examples/checkers/fixtures/`) covering all four exit codes; its header comment is the short version
of this section.

**Load-bearing ordering:** the checker is compiled *after* the compile cache is populated. The cache
stores the whole workdir keyed on (language, user source, compile argv) — a checker binary sitting
there at `put()` time would be served to a different problem whose contestant submitted the same
source.

**`POST /generate-tests`** — `{code, language?}`. The generator prints a JSON array of inputs to
**stdout** and expected outputs to **stderr**, equal length. Limits 60 s / 1 GB. It's *documented* as
admin-only but not enforced here, and it **bypasses the global semaphore**.

**`GET /health`** — probes the three toolchains (2 s each, cached 30 s).
`200 {"status":"ok", version}` or `503 {"status":"degraded", reason, version}`.

`version` is the **deployment marker**: `RENDER_GIT_COMMIT` when Render sets it (so polling /health
from outside tells you exactly when a push went live), otherwise the package.json version plus this
process's start time. `status` is unchanged and remains what every existing caller reads — Render's
probe and wmoj-app's `api/status/health` are untouched by the addition.

## Size caps and test-case budget

Enforced in `src/middleware/requestCaps.ts` (413 on violation):

| Limit | Value |
|---|---|
| Test cases per submission | **200** |
| Bytes per single input | **1 MB** |
| Bytes per single expected output | **1 MB** |
| Source code | 100 KB |
| Checker source | 100 KB |

These exist because the host has 512 MB of RAM and the whole payload is buffered in memory. WMOJ
problems are authored to fit: in practice **8–65 cases (avg ~33)**, most inputs a few KB, heaviest
around 50–120 KB per case. That is deliberately fewer and smaller than other sites hosting the same
problems — coverage of core edge cases is the goal, not exhaustiveness.

Two live problems currently exceed the 1 MB per-case cap and are therefore unsubmittable (413 before
anything runs).

A `memoryLimit` above the host's total RAM can never actually be enforced, so the judge no longer
pretends otherwise: every submission's cap is clamped to
`min(requested, HOST_MEMORY_CEILING_MB)` (default **512**, env-overridable) and the clamped value is
returned as `effectiveMemoryLimitMb`. The six live problems declaring 1024 MB now run at 512 and get
a clean `MLE` instead of a confusing container-level crash. The clamp applies to `/submit` only —
`/generate-tests` keeps its own hardcoded 60 s / 1 GB generator limits.

## Sandbox — read before touching `src/sandbox/` or `policy.kafel`

**Deliberately weaker than a textbook sandbox**, stripped down to run unprivileged:

| Active | Disabled |
|---|---|
| seccomp BPF (`policy.kafel`) | all namespaces — user, net, mnt, pid, ipc, uts, cgroup |
| rlimits (`as`/`cpu`/`nproc`/`nofile`/`fsize`/`core`) | chroot |
| per-submission `0700` tmpdir | `--user`/`--group` (setuid to a pool UID) |
| 4-var env allowlist | cgroups |

Consequences to reason about:

- Every submission runs as **UID 1000 — the same UID as the Node process** — sharing its PID, mount,
  and network namespaces.
- The **UID pool is now just a concurrency gate**; the numeric UID only reaches a log line, `gid` is
  never read.
- **Network is blocked by seccomp alone.** No second layer.
- `open`/`read`/`getdents64` are allowed with no path filtering and no chroot.
- **Compilation is NOT sandboxed** — `g++` is spawned directly with no timeout and no rlimits, in
  `executors/cpp.ts`, `routes/generateTests.ts`, and `checker/index.ts`. Only the *run* step goes
  through nsjail. Checkers and generators are problem-setter source, i.e. the same trust boundary
  as `/generate-tests` already assumed; contestant source has always been compiled unsandboxed too.

### Load-bearing details that look like noise

- **`--log_fd 3`** — nsjail's `[I]` log lines used to interleave byte-wise with generator stderr
  (which also starts with `[`), destroying `/generate-tests`. Never route it back to stderr.
- **`execve`/`execveat` must stay in the seccomp allowlist** — nsjail installs the filter *before*
  exec, so removing them SIGSYS-kills every submission (exit 159).
- **`DEFAULT ERRNO(38)` (ENOSYS) must not become `KILL` or `EPERM`** — `KILL` breaks glibc's syscall
  probes; `EPERM` breaks `pthread_create`, which needs `clone3` to fail with ENOSYS so glibc falls
  back to classic `clone()`.
- **`USER 1000` in the Dockerfile** — running non-root skips nsjail's `prctl(PR_SET_SECUREBITS)`,
  which would need `CAP_SETPCAP`. **Don't override `USER` in `docker run`** or everything exits 255.
- **`UID_POOL_SIZE` must track the Dockerfile `useradd` loop** (`seq 1000 1015`, `BASE_UID = 1000`).
- **The Debian trixie base can't be downgraded** — g++ 14 is needed for full `-std=c++23`; watch the
  trixie-specific `libprotobuf32t64`.
- TLE is decided from **CPU time**, not wall clock, so verdicts stay stable on a shared 0.1-CPU host.

## Languages

`languages.json` is the source of truth. `python3`, `pypy3` (384 MB default — its baseline RSS is
~60 MB vs CPython's ~14 MB), and `cpp14/17/20/23` (`g++ -O2 -std=c++NN`). Legacy aliases
`python`→`python3` and `cpp`→`cpp17` are still accepted for the wmoj-app cutover. `/generate-tests`
always compiles `-std=gnu++17` and ignores the requested language. Java was removed; the JVM comments
in `policy.kafel` are stale.

**Adding one:** `languages.json` → `src/executors/<lang>.ts` → register in `executors/index.ts`, the
`Language` union in `types.ts`, and `ALL_LANGUAGES` in `routes/submit.ts` → install in the Dockerfile
*runtime* stage → add a `/health` probe → verify `policy.kafel` covers its startup syscalls.

## Verdicts

`deriveVerdict` returns `TLE | MLE | RE | IE | AC | WA`, and **the order of its checks is
load-bearing**:

```
TLE → MLE → RE → IE → WA/AC
```

MLE is tested *before* the `exitCode !== 0` branch. That ordering is the whole fix for the old
"MLE surfaces as RE" bug: limits are enforced with `--rlimit_as`, which caps **virtual address
space, not resident memory**, so hitting it makes `malloc`/`new` *fail* rather than triggering a
kill — the program throws, exits non-zero, and used to be labelled `RE`. Peak RSS can't rescue it
either: RSS stays *below* the cap precisely because the allocation was refused.

A case is `MLE` when **any** of these hold (see `isMemoryLimitExceeded` in `routes/submit.ts`):

1. the sandbox classified the kill as `OOM` — nsjail reported a memory limit **exceeded**, or peak
   RSS reached the cap;
2. peak RSS ≥ **98%** of the *enforced* cap (`MEM_LIMIT_RSS_RATIO` in `sandbox/nsjail.ts`);
3. the program exited non-zero **and** its stderr matches an allocation-failure signature —
   `std::bad_alloc`, `bad_array_new_length`, `Cannot allocate memory`, `MemoryError`, `Killed`.

Rules 2 and 3 are gated on the run *not* having finished cleanly, so a solution that exit(0)'d
having used its whole budget stays `AC`. A plain `SIGSEGV` from a null-pointer bug has low RSS and
no allocation signature, so it stays `RE`. The `mem-limit` regex no longer matches the literal
string `rlimit_as` — a limit being *configured* is not a limit being *hit*.

`IE` is produced **only** by a custom checker that could not answer (exit 3, or the checker itself
crashed / timed out). `CE` is declared in `types.ts` but still **never produced** — compile failures
surface via `compileError`/`checkerError`, and `wmoj-app` synthesizes its own `CE`.

A test passes only if `exitCode === 0 && killedBy === null` **and** the checker accepted (or, with no
checker, `compare(...)` matched); correct output with a non-zero exit fails.

Comparison modes: `exact`, **`trim-trailing` (default)**, `whitespace`, `float-epsilon` (1e-6) —
used only when no `checker` is supplied. **No early exit** — every case runs even after a failure.
Custom checkers **are** supported (see the API section); partial scoring, subtasks, and interactive
problems are not. All scoring lives in `wmoj-app`.

## Concurrency & config

Three throttles: `submitSemaphore` (CPU count, `/submit` only), a per-submission pool
(**1 = serial**, deliberate — parallel runs on shared vCPUs made TLE non-deterministic), and the
**16-UID pool, which is the true ceiling** and covers both gated endpoints. Backpressure is
queue-never-reject: no depth cap, no admission control, no client-disconnect handling.

`src/config.ts` is the **only** place that reads `process.env`; everything else imports the frozen
`config`. In practice only `JUDGE_SHARED_SECRET` and `AUTH_STRICT` are ever set — every other var
runs on its default, and each is tagged inline. Preserve those comments. Two derived values live
there too: `HOST_MEMORY_CEILING_MB` (512, the real ceiling every submission's cap is clamped to) and
`VERSION` (the `/health` deployment marker; reads `RENDER_GIT_COMMIT`, else package.json's version
plus process start time, via a runtime `require("../package.json")` so the JSON stays outside
tsconfig's `rootDir`).

`AUTH_STRICT` **defaults to `false` (fail-open)**, so always set it to `true` in production. CORS is
wide open (`*`) and the secret is the only gate — never call this service from browser code. Rate
limiting is 60/min shared across both gated routes, and since there's no `trust proxy` and every
wmoj-app request carries the same token, the whole application shares one bucket.

## Requires a decision, not a drive-by change

1. `policy.kafel` — state which syscalls move and why.
2. The nsjail argv — disabled namespaces, `--keep_caps`, `--log_fd 3`, absent `--user`/`--chroot`.
3. The Dockerfile's `USER 1000`, useradd loop, trixie base, `libprotobuf32t64`.
4. The `/submit` contract — compile errors stay HTTP 200 with `compileError`, checker compile
   errors HTTP 200 with `checkerError`, and the two must never be merged. **Cross-repo breaking
   change**; coordinate with `wmoj-app`.
5. The legacy `python`/`cpp` aliases.
6. Never widen the seccomp allowlist, the compile trust boundary, or the env allowlist just to make
   something work.

## Known issues (don't rediscover; not currently being fixed)

- `config.ts` deletes `JUDGE_SHARED_SECRET` from `process.env`, but `unsetenv()` only drops the
  pointer — the string stays in the process's env memory. With shared UID 1000, no PID namespace, and
  allowed `open`/`read`, user code can plausibly read it from `/proc/<pid>/environ`. Unverified.
- Unsandboxed, untimed compilation → a compile bomb can OOM the service. `#include` of arbitrary
  paths leaks file contents through `compileError`.
- All submissions share UID 1000 and one `/tmp` root, so cross-submission isolation doesn't hold.
- `cpuMs`/`memKb` may silently be `0` if nsjail's log format doesn't match `parseNsjailStderr`'s
  regexes. (**Fixed:** the `mem-limit` regex no longer matches the literal `rlimit_as`, and MLE no
  longer surfaces as RE — see Verdicts for the three-rule classification that replaced it.)
- The compile cache can be evicted between `get()` and `fs.cp()` (500 instead of a recompile) and
  leaks disk across restarts (no boot sweep, no size cap).
- `timeLimit`/`memoryLimit` have no upper bound. `/generate-tests` validates `language` then ignores
  it. Dead: `SandboxOpts.chrootDir`/`rlimitAsMb`/`gid`, `buildChildEnv(_lang)`, `chownTree`.

## Related repo

`wmoj-app` — the Next.js client, with its own `AGENTS.md`. It calls this service only from
server-side route handlers with `X-Judge-Token`.

---

**Keeping this current:** if you notice anything here that is outdated, stale, wrong, or missing —
update it as part of your change. A fixed issue, a moved sandbox flag or seccomp rule, a new language
or env var, a changed contract, a claim you verified or disproved against a real container, or
knowledge you had to discover the hard way all belong here. This file is only useful while it is
accurate; treat letting it go stale as leaving the work unfinished.
