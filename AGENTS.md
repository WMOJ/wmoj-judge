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

**`POST /submit`** — `{language, code, input[], output[], timeLimit?, memoryLimit?, compareMode?}`;
`input`/`output` must be equal-length string arrays. Returns 200 with
`{summary:{total,passed,failed}, results[]}`.

> **A compile error is also HTTP 200** — `{summary:{0,0,0}, results:[], compileError}`. This is
> contractual; `wmoj-app` depends on it. 4xx/5xx means the request or the judge is wrong, never the
> user's code.

**`POST /generate-tests`** — `{code, language?}`. The generator prints a JSON array of inputs to
**stdout** and expected outputs to **stderr**, equal length. Limits 60 s / 1 GB. It's *documented* as
admin-only but not enforced here, and it **bypasses the global semaphore**.

**`GET /health`** — probes the three toolchains (2 s each, cached 30 s). `200 {"status":"ok"}` or
`503 {"status":"degraded", reason}`.

## Size caps and test-case budget

Enforced in `src/middleware/requestCaps.ts` (413 on violation):

| Limit | Value |
|---|---|
| Test cases per submission | **200** |
| Bytes per single input | **1 MB** |
| Bytes per single expected output | **1 MB** |
| Source code | 100 KB |

These exist because the host has 512 MB of RAM and the whole payload is buffered in memory. WMOJ
problems are authored to fit: in practice **8–65 cases (avg ~33)**, most inputs a few KB, heaviest
around 50–120 KB per case. That is deliberately fewer and smaller than other sites hosting the same
problems — coverage of core edge cases is the goal, not exhaustiveness.

Two live problems currently exceed the 1 MB per-case cap and are therefore unsubmittable (413 before
anything runs). Note also that a `memoryLimit` above ~512 MB can never actually be enforced, since it
exceeds the host's total RAM.

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
  both `executors/cpp.ts` and `routes/generateTests.ts`. Only the *run* step goes through nsjail.

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

`deriveVerdict` returns **only** `TLE | MLE | RE | AC | WA`:

```
killedBy 'TO' → TLE   |   killedBy 'OOM' → MLE
exitCode !== 0 || killedBy 'SIG' → RE   |   passed ? AC : WA
```

`CE` and `IE` are declared in `types.ts` but **never produced** — compile failures surface via
`compileError`, and `wmoj-app` synthesizes its own `CE`. A test passes only if
`exitCode === 0 && killedBy === null && compare(...)`; correct output with a non-zero exit fails.

Comparison modes: `exact`, **`trim-trailing` (default)**, `whitespace`, `float-epsilon` (1e-6).
**No early exit** — every case runs even after a failure. No partial scoring, subtasks, custom
checkers, or interactive problems; all scoring lives in `wmoj-app`.

## Concurrency & config

Three throttles: `submitSemaphore` (CPU count, `/submit` only), a per-submission pool
(**1 = serial**, deliberate — parallel runs on shared vCPUs made TLE non-deterministic), and the
**16-UID pool, which is the true ceiling** and covers both gated endpoints. Backpressure is
queue-never-reject: no depth cap, no admission control, no client-disconnect handling.

`src/config.ts` is the **only** place that reads `process.env`; everything else imports the frozen
`config`. In practice only `JUDGE_SHARED_SECRET` and `AUTH_STRICT` are ever set — every other var
runs on its default, and each is tagged inline. Preserve those comments.

`AUTH_STRICT` **defaults to `false` (fail-open)**, so always set it to `true` in production. CORS is
wide open (`*`) and the secret is the only gate — never call this service from browser code. Rate
limiting is 60/min shared across both gated routes, and since there's no `trust proxy` and every
wmoj-app request carries the same token, the whole application shares one bucket.

## Requires a decision, not a drive-by change

1. `policy.kafel` — state which syscalls move and why.
2. The nsjail argv — disabled namespaces, `--keep_caps`, `--log_fd 3`, absent `--user`/`--chroot`.
3. The Dockerfile's `USER 1000`, useradd loop, trixie base, `libprotobuf32t64`.
4. The `/submit` contract — compile errors stay HTTP 200 with `compileError`. **Cross-repo breaking
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
  regexes; the `mem-limit` regex also matches the literal `rlimit_as`. **MLE often surfaces as RE**
  because `RLIMIT_AS` makes allocation fail with a non-zero exit rather than a signal.
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
