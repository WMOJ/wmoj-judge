# wmoj-judge — agent guide

The execution half of WMOJ. A **stateless, synchronous** HTTP service that compiles and runs
untrusted competitive-programming submissions inside `nsjail` + seccomp and returns per-test
verdicts in the same response.

Node 20 · TypeScript (CommonJS) · Express 4. Deployed as a Docker container (Render is the
reference platform). Its only client is `wmoj-app`, over a static shared secret.

**No database. No queue. No job IDs. No callbacks or webhooks. No persistence.** A `/submit` call
blocks until every test case has finished.

---

## Commands

```bash
npm ci
npm run build    # tsc → dist/ — the ONLY automated quality gate; keep it clean
npm run dev      # tsx watch src/server.ts
npm run start    # node dist/server.js

docker build -t wmoj-judge .
docker run --rm -p 4001:4001 \
  -e JUDGE_SHARED_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_STRICT=true \
  wmoj-judge

curl http://localhost:4001/health     # {"status":"ok"}
```

**There are no tests, no linter, no formatter, and no CI.** Do not invent `npm test`. `tsc` runs
with `strict` + `noUncheckedIndexedAccess`, so a clean build is a meaningful bar — but anything
behavioural must be verified by hand against a running container.

> **This will not run natively on macOS.** nsjail is Linux-only. Use Docker for anything that
> actually executes code. `npm run dev` on a Mac will fail at boot.

> **`.env.local` is never loaded.** There is no `dotenv` dependency, no `--env-file` flag in any
> script, and no manual file read — despite the README implying otherwise. Export the vars, or run
> `node --env-file=.env.local dist/server.js`. This is the most common first-hour trap.

---

## Architecture

```
server.ts  →  httpLogger → cors → express.json → in-flight tracker
           →  /health                              (UNAUTHENTICATED, by design)
           →  /submit         ┐ authMiddleware
           →  /generate-tests ┘ → rateLimit → requestCaps
```

`routes/submit.ts` is the pipeline:

1. **Drain check** → 503 if shutting down (before acquiring any resource, so SIGTERM can quiesce)
2. **Validate** — pure shape check, no coercion → 400
3. **Normalize** — legacy language aliases, defaults (`compareMode: 'trim-trailing'`,
   `timeLimit: 5000`, memory from payload → `languages.json` → 256)
4. **Global semaphore** (`queue/globalSemaphore.ts`) — nothing escapes it
5. **Acquire** a UID from the pool, create a `0700` tmpdir
6. **Compile** — cache lookup first (`sha256(language, code, compileArgv)`), else `executors/*`
7. **Run each test case** through `sandbox/nsjail.ts`, compare via `compare/*`, derive a verdict
8. **Aggregate + respond**; `finally` cleans the workdir and releases the UID

Supporting modules: `config.ts` (the *only* place that reads `process.env`), `types.ts` (the single
shared contract), `cache/compileCache.ts`, `util/{logger,shutdown,workdir}.ts`.

---

## API surface

Only three endpoints exist. **There is no root route, no 404 handler, and no global error handler**
— unmatched paths and body-parse failures return Express's default HTML pages from a service that
otherwise speaks only JSON.

`createRateLimiter()` is instantiated once into a shared middleware array, so **`/submit` and
`/generate-tests` consume the same 60-req/min budget**.

### `POST /submit`

Body: `{ language, code, input[], output[], timeLimit?, memoryLimit?, compareMode? }`.
`input` and `output` must be equal-length string arrays.

Returns **HTTP 200** with `{ summary: {total, passed, failed}, results: TestResult[] }`.

**A compile error is also HTTP 200** — `{ summary: {0,0,0}, results: [], compileError }`. This is
contractual; `wmoj-app` depends on it. 4xx/5xx means the *request* or the *judge* is wrong, never
the user's code.

Errors: 400 (validation) · 401 (strict auth) · 413 (requestCaps) · 429 (rate limit) · 500 · 503
(draining).

### `POST /generate-tests`

Body: `{ code, language? }`. The generator prints a **JSON array of inputs to stdout** and a **JSON
array of outputs to stderr**, equal length. Returns
`{ inputJson, outputJson, input[], output[] }`. Every failure mode is a 400 carrying the raw
`inputJson`/`outputJson` for UI debugging.

Limits: 60 s, 1 GB. It is *documented* as admin-only but the judge enforces no such distinction —
the same shared secret unlocks it, and `wmoj-app` is the only thing gating regular users. It also
**bypasses the global submit semaphore**; only the rate limiter and the 16-UID pool bound it.

### `GET /health`

Unauthenticated by design (Render probes). Probes `python3 -V`, `pypy3 --version`, `g++ --version`
in parallel, 2 s each, cached 30 s. `200 {"status":"ok"}` or
`503 {"status":"degraded","reason":"..."}`.

`probeToolchainAtBoot()` runs the same check at startup and **throws if any tool is missing** →
`process.exit(1)`. The judge refuses to boot without all three toolchains.

---

## The sandbox — read before touching anything in `src/sandbox/` or `policy.kafel`

**The sandbox is deliberately weaker than a textbook one.** It was progressively stripped down to
run on Render's unprivileged containers (no `CAP_SYS_ADMIN`, no `CAP_SETPCAP`).

| Layer | Status |
|---|---|
| seccomp BPF (`policy.kafel`) | **active** |
| Kernel rlimits (`--rlimit_as/cpu/nproc/nofile/fsize/core`) | **active** |
| Per-submission `0700` tmpdir | **active** |
| Env scrub (4-var allowlist) | **active** |
| Namespaces — user, net, mnt, pid, ipc, uts, cgroup | **all explicitly disabled** |
| chroot | **not used** |
| setuid to a distinct pool UID (`--user`/`--group`) | **not used** |
| cgroups | never used |

Consequences you must reason about before changing anything:

- Every submission runs as **UID 1000 — the same UID as the Node judge process** — in the same PID,
  mount, and network namespaces.
- The **UID pool has degraded into a pure concurrency gate**. The numeric UID is passed to
  `nsjail.ts` but only ever used in a log line; `gid` is never read at all.
- **Network is blocked only by seccomp** (`socket`/`connect`/`bind`/…). There is no second layer.
- `open`/`openat`/`read`/`getdents64` are allowed with **no path filtering and no chroot**, so user
  code can read anything readable by UID 1000.
- **Compilation is NOT sandboxed.** `g++` is spawned directly, with no timeout and no rlimits, in
  both `executors/cpp.ts` and `routes/generateTests.ts`. Do not assume "the judge sandboxes
  everything" — only the *run* step goes through nsjail.

If you ever deploy somewhere with real privileges, the path back is: remove the
`--disable_clone_new*` flags in `src/sandbox/nsjail.ts` and re-enable `--chroot` and `--user`.

### Load-bearing details that look like noise

- **`--log_fd 3` is not cosmetic.** nsjail's `[I][timestamp]` log lines used to interleave byte-wise
  with generator stderr (which also starts with `[`), destroying `/generate-tests`. fd 2 now carries
  only the child's stderr, byte-clean. Never route nsjail's log back to stderr.
- **`execve` and `execveat` must stay in the seccomp ALLOW list.** nsjail installs the filter
  *before* exec'ing the user binary; removing them SIGSYS-kills every submission before a single
  instruction runs (exit 159).
- **`DEFAULT ERRNO(38)` (ENOSYS) must not become `KILL` or `EPERM`.** `KILL` breaks modern glibc's
  syscall probes (`rseq`, `statx`, `clone3`, …) that Kafel 3.3 doesn't know about; `EPERM` breaks
  `pthread_create`, which needs `clone3` to fail with ENOSYS specifically so glibc falls back to
  classic `clone()`.
- **`USER 1000` in the Dockerfile is load-bearing.** nsjail's `initNsFromChild` calls
  `prctl(PR_SET_SECUREBITS)`, which needs `CAP_SETPCAP`. Running Node as non-root hits nsjail's
  early-return guard and skips that call entirely. **Do not override `USER` in `docker run`** — the
  container must run as UID 1000 or every execution fails with exit 255.
- **`UID_POOL_SIZE` and the Dockerfile `useradd` loop must move together** (`seq 1000 1015` and
  `BASE_UID = 1000`).
- **The Debian trixie base cannot be downgraded** — g++ 14 is required for full `-std=c++23`. Watch
  `libprotobuf32t64`, whose package name is trixie-specific.
- TLE is decided from **CPU time**, not parent wall clock, so verdicts stay stable under load.
  `--rlimit_cpu` gets +1 s of slack so the userland check is authoritative and the kernel limit is
  only a backstop.

---

## Languages

`languages.json` is the single source of truth, imported directly by the executors and by
`routes/submit.ts`.

| ID | File | Compile | Run | Default mem |
|---|---|---|---|---|
| `python3` | `Main.py` | — | `python3 -u Main.py` | 256 MB |
| `pypy3` | `Main.py` | — | `pypy3 -u Main.py` | **384 MB** |
| `cpp14` / `cpp17` / `cpp20` / `cpp23` | `Main.cpp` | `g++ -O2 -std=c++NN Main.cpp -o a.out` | `./a.out` | 256 MB |

- **Legacy aliases `python` → `python3` and `cpp` → `cpp17` are still accepted** during the wmoj-app
  cutover, each logging a one-time deprecation warning. Removing them may break in-flight callers.
- PyPy's higher default is deliberate: its baseline RSS (~60 MB vs CPython's ~14 MB) needs headroom
  under a 256 MB `RLIMIT_AS`.
- `/generate-tests` compiles with **`-std=gnu++17`** and ignores the requested `language` — a
  different dialect from every `/submit` path.
- Java was removed entirely. `policy.kafel` still carries JVM-era comments; they are stale.

**Adding a language:** `languages.json` → new `src/executors/<lang>.ts` → register it in
`executors/index.ts` **and** the `Language` union in `types.ts` **and** `ALL_LANGUAGES` in
`routes/submit.ts` → install the runtime in the Dockerfile **runtime** stage → add a `/health` probe
→ verify `policy.kafel` covers the runtime's startup syscalls → update the README table.

---

## Verdicts and comparison

`deriveVerdict` can return **only** `TLE | MLE | RE | AC | WA`:

```
killedBy === 'TO'                    → TLE
killedBy === 'OOM'                   → MLE
exitCode !== 0 || killedBy === 'SIG' → RE
passed ? AC : WA
```

`CE` and `IE` are declared in `types.ts` and documented in the README but **are never produced by
any code path**. Compile failures surface as the `compileError` field; an nsjail spawn failure
surfaces as `RE`. `wmoj-app` synthesizes its own `CE` verdict from `compileError`.

A test passes only if `exitCode === 0 && killedBy === null && compare(...)` — all three. Correct
output with a non-zero exit is a fail.

Comparison modes: `exact`, **`trim-trailing` (default)**, `whitespace`, `float-epsilon` (relative-
or-absolute, `1e-6`). stdin always gets a trailing newline appended if absent.

**No early exit** — every test case always runs, even after the first failure. **No partial scoring,
no subtasks, no custom checkers, no interactive problems.** All scoring lives in `wmoj-app`.

---

## Concurrency

Three independent in-process throttles:

| Mechanism | Scope | Default |
|---|---|---|
| `submitSemaphore` | whole process, **`/submit` only** | `os.cpus().length` |
| per-submission pool | test cases within one submission | **1 (serial)** |
| UID pool | whole process, **both** endpoints | 16 |

- **The UID pool is the true hard ceiling.** Raising `GLOBAL_SUBMIT_CONCURRENCY` above
  `UID_POOL_SIZE` just parks requests in the FIFO waiter queue.
- **`PER_SUBMISSION_CONCURRENCY = 1` is deliberate** — parallel execution on shared vCPUs inflated
  wall time via scheduler round-robin and made TLE non-deterministic. Raising it also means
  concurrent children share one workdir.
- **Backpressure is queue-never-reject.** No queue-depth cap, no admission control, no
  client-disconnect handling. Under sustained overload the failure mode is memory exhaustion, not a
  clean 503.
- Graceful shutdown drains for up to 29 s (one second under Render's 30 s SIGKILL), then removes
  every tracked workdir and exits 0.

---

## Configuration

Every variable is read once in `src/config.ts` and frozen. **Nothing else may touch `process.env`.**

| Variable | Default | Purpose |
|---|---|---|
| `JUDGE_SHARED_SECRET` | `""` dev / **throws** in prod | The `X-Judge-Token` value |
| `AUTH_STRICT` | **`false`** | `true` → 401 on bad token; `false` → **warn and allow** |
| `PORT` (→ `JUDGE_PORT`) | `4001` | Listen port |
| `UID_POOL_SIZE` | `16` | Concurrency ceiling; must match the Dockerfile useradd loop |
| `GLOBAL_SUBMIT_CONCURRENCY` | CPU count | Concurrent `/submit` |
| `PER_SUBMISSION_CONCURRENCY` | `1` | Concurrent test cases per submission |
| `COMPILE_CACHE_TTL_MS` / `COMPILE_CACHE_DIR` | 15 min / `/tmp/judge-cache` | Artifact cache |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | 60 s / 60 | Shared across both gated routes |
| `NSJAIL_BIN` / `SECCOMP_POLICY` | `/usr/local/bin/nsjail` / `/app/policy.kafel` | Set in the Dockerfile |
| `LOG_LEVEL` | `info` | pino level |

**Only `JUDGE_SHARED_SECRET` and `AUTH_STRICT` are actually set** in `.env.local` and the Render
dashboard. Every other variable is intentionally unset and runs on the default. `config.ts` tags
each one inline — preserve those comments when editing.

`AUTH_STRICT` **defaults to `false`, which means fail-open**: a judge deployed with a secret but
without `AUTH_STRICT=true` accepts unauthenticated requests. Always set it in production.

`NODE_ENV=production` is baked into the image, so a container without `JUDGE_SHARED_SECRET` exits 1
at boot. CORS is wide open (`*`) — the shared secret is the only gate, so **never call this service
from browser code**.

---

## Conventions

- Read env vars only in `config.ts`; import the frozen `config` object everywhere else.
- All shared types live in `types.ts`; don't duplicate response shapes.
- New dependencies must be **CJS-compatible** — `nanoid@3` and `p-limit@3` are pinned to v3 for
  exactly this reason (v4+ are ESM-only).
- Structured logging through the shared pino `logger`; never `console.log`.
- `tsc` runs with `noUncheckedIndexedAccess` — handle `undefined` from index access explicitly.
- **Keep the existing "why" comments.** They record specific production failures (Render capability
  limits, glibc `clone3`, nsjail log interleaving, PyPy RSS). They are institutional memory, not
  noise. Update them; don't strip them.

## Requires an explicit decision, not a drive-by change

1. `policy.kafel` — every change must state which syscalls move and why.
2. The nsjail argv in `src/sandbox/nsjail.ts` — the disabled namespaces, `--keep_caps`, `--log_fd 3`,
   and the absent `--user`/`--chroot` are all deliberate workarounds.
3. The Dockerfile's `USER 1000`, useradd loop, trixie base, and `libprotobuf32t64`.
4. The `/submit` response contract — compile errors must stay HTTP 200 with `compileError`.
   Any field change is a **cross-repo breaking change**; coordinate with `wmoj-app`.
5. The legacy `python` / `cpp` language aliases.
6. Never widen the seccomp allowlist, the compile trust boundary, or the env allowlist just to make
   something work.

---

## Known issues

So agents don't rediscover these or regress them silently.

**Security:**
- `config.ts` deletes `JUDGE_SHARED_SECRET` from `process.env` and claims this closes the
  `/proc/<pid>/environ` leak. On Linux, `unsetenv()` only removes the pointer — the original string
  stays in the process's env memory region. Combined with shared UID 1000, no PID namespace, no
  chroot, and allowed `open`/`read`, **user code can plausibly read the secret out of the judge's
  `/proc` entry and print it to stdout**. Unverified empirically, but the mechanism is well
  established. Highest-value item to test and fix.
- **Unsandboxed, untimed compilation** — a compile bomb (recursive templates, `#include` loops) burns
  unbounded host CPU/RAM and can OOM the service.
- `#include "/etc/…"` leaks file contents through `compileError`, since g++ has no path restriction.
- **All submissions share UID 1000 and one `/tmp` root**, so a submission can `readdir("/tmp")` and
  read a sibling's source and binary. The README's "no cross-submission visibility" claim does not
  hold in the current configuration.
- `ioctl` is unconditionally allowed; its justification assumes a chroot that isn't there.
- `timeLimit` and `memoryLimit` have **no upper bound** — only `> 0` and finite.

**Correctness:**
- `cpuMs` and `memKb` may silently be `0` if nsjail 3.3's log format doesn't match the regexes in
  `parseNsjailStderr`. If so, CPU-authoritative TLE never fires. **Verify this first against a real
  deployment.** Relatedly, the `mem-limit` regex matches the literal string `rlimit_as`, so any
  nsjail line echoing the flag name would classify every run as MLE.
- **MLE frequently surfaces as RE.** `RLIMIT_AS` makes allocation fail, so programs die via
  `bad_alloc`/`MemoryError` with a non-zero exit rather than a signal.
- The compile cache can be evicted between `get()` and `fs.cp()`, producing a 500 instead of falling
  back to a fresh compile. It also **leaks disk across restarts** (in-memory map, no boot sweep, no
  size cap) and pointlessly caches interpreted-language workdirs.
- `express.json({limit: '250mb'})` doesn't actually cover the documented worst case (~400 MB at the
  requestCaps ceiling), so large payloads get an HTML 413 from body-parser instead of the intended
  JSON one.
- **No `app.set('trust proxy')`**, so behind a load balancer `req.ip` is the proxy for every request.
  Since every wmoj-app call carries the same token, the entire application shares one 60/min bucket.
- `/generate-tests` validates `language` and then ignores it.
- The README's compile-error example shows `summary: {total: 3, passed: 0, failed: 3}`; the code
  returns `{0, 0, 0}`.

**Dead code:** `SandboxOpts.chrootDir` (accepted, ignored), `SandboxOpts.rlimitAsMb` (honoured, never
set), `SandboxOpts.gid` (never read), `buildChildEnv(_lang)` (parameter unused),
`Executor.filename(code)` (argument ignored by all implementations), the `chownTree`/`isRootNode`
paths (dead while Node runs as UID 1000), and `TestResult.received`/`stdout` (identical values in
every response).

---

## Related repo

`wmoj-app` — the Next.js application that calls this service. It has its own `AGENTS.md`. It sends
`X-Judge-Token` from server-side route handlers only, and it synthesizes the `CE` verdict this
service never emits. Changes to the `/submit` or `/generate-tests` contract must be coordinated
across both repos.

---

## Keeping this file current

**If you are an agent working in this repo and you notice anything in this `AGENTS.md` that is
outdated, stale, incorrect, or missing — update it as part of your change.** That includes: a known
issue you just fixed, a sandbox flag or seccomp rule that moved, a new language or environment
variable, a changed API contract, a claim here you verified or disproved against a real container,
or knowledge you had to discover the hard way that isn't written down. This file is only useful
while it is accurate; treat letting it go stale as leaving the work unfinished.
