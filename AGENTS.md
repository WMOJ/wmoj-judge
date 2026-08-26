# wmoj-judge — agent guide

The execution half of WMOJ. A **stateless, synchronous** HTTP service that compiles and runs
untrusted competitive-programming submissions inside `nsjail` + seccomp and returns per-test verdicts
in the same response. **No database, queue, job IDs, callbacks, or persistence.**

Node 20 · TypeScript 5.9 (**CommonJS**) · Express 4.21 · pino · Docker. Its only client is
`wmoj-app`, authenticated with a static shared secret. `nanoid` 3 and `p-limit` 3 are pinned to CJS
majors — **v4+ are ESM-only, do not bump**. nsjail is pinned to tag **3.3**, built from source.

## The constraint that explains this codebase

It runs on a **free Render instance: 512 MB RAM, ~0.1 CPU**, in a container with no
`CAP_SYS_ADMIN`/`CAP_SETPCAP` and no cgroup access. Nearly every limitation here — the disabled
namespaces, serial test execution, the size caps, the compile cache, CPU-time TLE — is a consequence
of that host, not an oversight. Before "fixing" something that looks under-built, check whether it is
load-bearing for this environment.

## Commands

```bash
npm ci
npm run build    # tsc → dist/ — builds AND typechecks; the ONLY automated gate
npm run dev      # tsx watch (Linux only)
npm start        # needs a build first
docker build -t wmoj-judge .
docker run --rm -p 4001:4001 -e JUDGE_SHARED_SECRET=… -e AUTH_STRICT=true wmoj-judge
```

**No lint, no test, no typecheck, no format script; no CI, no deploy manifest, zero test files.**
Never claim otherwise. `tsc` runs with `strict` + `noUncheckedIndexedAccess`, so a clean build is a
real bar — but behavioural changes must be checked by hand against a running container.

- **Won't run natively on macOS** — nsjail is Linux-only. Use Docker.
- **`.env.local` is intentionally not loaded** (no `dotenv`, no `--env-file`); local runs fall back
  to `AUTH_STRICT=false`. Production vars come from the Render dashboard.
- The judge **refuses to boot** unless `python3`, `pypy3`, and `g++` are all on `PATH`.
  `NODE_ENV=production` is baked into the image, so a missing `JUDGE_SHARED_SECRET` exits 1.

## Skills

Trigger-scoped detail lives in `.agents/skills/` (`.claude` symlinks to it). Load the matching
skill *before* touching the area; each holds failure modes this file has no room for.

| Skill | Load when |
|---|---|
| `sandbox-changes` | touching `src/sandbox/**`, `policy.kafel`, or the `Dockerfile` |
| `custom-checkers` | touching `src/checker/`, the `checker` field, or authoring a checker |
| `add-language` | adding or removing a language, or changing a compiler flag |
| `verdicts-and-comparison` | touching `deriveVerdict`, the MLE rules, or `src/compare/` |
| `judge-app-contract` | changing a request/response field, an env-var name, or a verdict string |

## API

Middleware order (`src/server.ts`): `httpLogger → cors() → express.json({limit:"250mb"}) →
in-flight counter → /health → [auth, rateLimit, requestCaps] → /submit, /generate-tests`. There is
**no 404 handler and no global error handler**, so unmatched paths and over-250 MB bodies get
Express's default **HTML**; gates mount with `app.use`, so even `GET /submit` runs auth first.

**`POST /submit`** —
`{language, code, input[], output[], timeLimit?, memoryLimit?, compareMode?, checker?}`;
`input`/`output` must be equal-length string arrays. Returns 200 with
`{summary:{total,passed,failed}, results[], effectiveMemoryLimitMb}`.

`effectiveMemoryLimitMb = max(1, min(requested ?? language default ?? 256, HOST_MEMORY_CEILING_MB))`
is the cap actually enforced. Present on **every** 200, including both error shapes below.

> **A compile error is HTTP 200** — `{summary:{0,0,0}, results:[], compileError}`. **A checker that
> fails to compile is HTTP 200 with a separate top-level `checkerError`.** Never merge the two:
> `wmoj-app` synthesizes a user-facing `CE` from `compileError`, and a broken checker is a
> problem-configuration fault, not the student's. 4xx/5xx means the request or the judge is wrong,
> never the user's code.

**`POST /generate-tests`** — `{code, language?}`. The generator prints a JSON array of inputs to
**stdout** and expected outputs to **stderr**, equal length; a compile failure is **400**, not 200.
Limits 60 s / 1024 MB, passed straight through — bypassing the host clamp, so `RLIMIT_AS` is twice
the box's RAM. Documented admin-only but **not enforced**, and it **bypasses the global semaphore**.

**`GET /health`** — unauthenticated by design (Render probes). Probes the three toolchains (2 s
each, cached 30 s): `200 {status:"ok", version}` or `503 {status:"degraded", reason, version}`.
`version` is the deployment marker: `RENDER_GIT_COMMIT` if set, else package version + start time.

## Size caps and the memory clamp

Enforced in `src/middleware/requestCaps.ts` (413 on violation), by UTF-8 `Buffer.byteLength`:

| Limit | Value |
|---|---|
| Test cases per submission | **200** |
| Bytes per single input | **1,000,000** |
| Bytes per single expected output | **1,000,000** |
| Source code | 100,000 |
| Checker source | 100,000 |

The `express.json` 250 MB limit sits deliberately *above* the worst case these permit, so
`requestCaps` returns its own 413 with a reason. Problems are authored to fit these caps; the corpus
numbers describing them belong to `wmoj-app`.

Every submission's cap is clamped to `min(requested, HOST_MEMORY_CEILING_MB)` (512, env-overridable)
and returned as `effectiveMemoryLimitMb`. A problem may declare its contest's real limit; anything
over 512 runs at 512 with a clean `MLE`, not a container crash. `/generate-tests` is exempt.

## Sandbox

**Deliberately weaker than a textbook sandbox**, stripped down to run unprivileged. Active: seccomp
BPF (`policy.kafel`), rlimits, a per-submission `0700` tmpdir, a 4-var env allowlist (`PATH`, `LANG`,
`LC_ALL`, `PYTHONUNBUFFERED`). Disabled: **all seven namespaces** (user, net, mnt, pid, ipc, uts,
cgroup), chroot, `--user`/`--group`, cgroups.

- Every submission runs as **UID 1000 — the same UID as the Node process** — sharing its PID, mount,
  and network namespaces. The UID pool is now just a concurrency gate.
- **Network is blocked by seccomp alone.** There is no second layer.
- `open`/`read`/`write`/`getdents64` are allowed with **no path filtering and no chroot**, and every
  submission shares UID 1000 and one `/tmp` root, so **cross-submission isolation does not hold**.
- **Compilation is NOT sandboxed** — `g++` is spawned directly with no timeout and no rlimits in
  `executors/cpp.ts`, `checker/index.ts`, and `routes/generateTests.ts`. A compile bomb can OOM the
  service, and `#include` of an arbitrary path leaks its contents through `compileError`. Only the
  *run* step goes through nsjail.
- Every flag, rlimit, and seccomp rule prevents one specific failure → **`sandbox-changes`**.

## Verdicts

`Verdict = AC | WA | TLE | MLE | RE | CE | IE`. **The order of `deriveVerdict`'s checks is
load-bearing: TLE → MLE → RE → IE → WA/AC**, with MLE tested *before* the `exitCode !== 0` branch
(the rationale is a 45-line comment at `submit.ts:181-226`, and in `verdicts-and-comparison`).

- `IE` is produced **only** by a custom checker that could not answer.
- **`CE` is declared but never produced** — compile failures surface via
  `compileError`/`checkerError`, and `wmoj-app` synthesizes its own `CE`.
- A case passes only if `exitCode === 0 && killedBy === null` **and** the checker accepted (or, with
  no checker, `compare(...)` matched) — correct output with a non-zero exit fails.
- **No early exit** — every case runs after a failure. An `IE` case counts as failed in `summary`.
- Default comparator `trim-trailing`. Partial scoring, subtasks, and interactive problems are not
  supported; all scoring lives in `wmoj-app`.

## Languages

`languages.json` is the source of truth: `python3`, `pypy3` (384 MB default), `cpp14/17/20/23`
(`g++ -O2 -std=c++NN`). Legacy aliases `python`→`python3` and `cpp`→`cpp17` are still accepted for the
wmoj-app cutover; Java was removed. Adding one touches eight places, one of which the compiler does
**not** check for you → **`add-language`**.

## Concurrency & config

Three throttles: `submitSemaphore` (p-limit at `os.cpus().length`, **`/submit` only**), a
per-submission pool (**1 = serial**, deliberate — parallel runs on shared vCPUs made TLE
non-deterministic), and the **16-UID pool, which is the true ceiling** and covers both gated
endpoints. All in-process promise scheduling — no worker_threads, no queue workers. Backpressure is
**queue-never-reject**: no depth cap, no timeout, no disconnect handling; a burst past the rate
limiter queues indefinitely with the connection held open.

`src/config.ts` is the env boundary — everything else imports the frozen `config`. One exception:
`sandbox/minimalEnv.ts:26` reads `process.env.PATH`. `intEnv` silently falls back on unparseable
values; `readSharedSecret()` deletes the var from `process.env` after reading it. Each var carries an
inline comment recording that it is unset in both `.env.local` and Render — **preserve those**.

`AUTH_STRICT` **defaults to `false` (fail-open)**, and in soft mode a **missing** token is let
through too, not just a wrong one. Always `true` in production — and only there, since outside it the
secret is `""`, which strict mode rejects everything against. CORS is wide open (`*`) and the secret
is the only gate, so **never call this service from browser code**. Rate limiting is 60/min across
both gated routes; with no `trust proxy` and one token, all of wmoj-app shares one bucket.

Graceful shutdown: `SIGTERM`/`SIGINT` → both routes 503 at once → `server.close()` → wait up to
`DRAIN_TIMEOUT_MS = 29_000` (1 s inside Render's window) → `rm -rf` workdirs → flush pino → exit 0.

## Code conventions

Verified repo-wide by exhaustive grep — match them.

- CommonJS, **no `.js` extensions in imports**; **named exports only** (zero `export default` in
  `src/`); `import type` used consistently even though `verbatimModuleSyntax` is off.
- **Zero `any`, and zero TODO/FIXME/HACK/XXX markers.** Known weaknesses are written out as prose in
  JSDoc, not parked behind a marker.
- **No custom error classes, no `next(err)`, no Express error middleware.** Failures are discriminated
  result objects (`{ok:true, value} | {ok:false, error}`); each route is one `try/catch/finally` that
  logs and returns `500 {error: message}`.
- **Manual validation, no zod** — `unknown` narrowed by hand, then cast explicitly. Structured pino
  logging throughout, with the token redacted under three header spellings.
- **Heavy JSDoc-`why` comments naming the specific failure the code prevents** — the strongest
  stylistic signature here. Preserve it; never leave a comment that contradicts its own file.
- `noUncheckedIndexedAccess` makes every `arr[i]` a `T | undefined` — hence `payload.output[i] ?? ""`.
  Markdown hard-wraps at ~100 columns.

Commits: Conventional Commits — lowercase, imperative, no trailing period, optional scope
(`(sandbox)` dominates). Subjects pack the reason in via a `so <consequence>` clause; substantive
commits carry a hard-wrapped ~76-col body. **Zero trailers of any kind — no `Co-authored-by`, no
`Generated with`. Never add them.**

## Requires a decision, not a drive-by change

1. `policy.kafel` — state which syscalls move and why.
2. The nsjail argv — disabled namespaces, `--keep_caps`, `--log_fd 3`, absent `--user`/`--chroot`.
3. The Dockerfile's `USER 1000`, useradd loop, trixie base, `libprotobuf32t64`.
4. The `/submit` contract — compile errors stay HTTP 200 with `compileError`, checker compile errors
   HTTP 200 with `checkerError`, and the two must never be merged. **Cross-repo breaking change**;
   coordinate with `wmoj-app`.
5. The legacy `python`/`cpp` aliases.
6. Never widen the seccomp allowlist, the compile trust boundary, or the env allowlist just to make
   something work.

## Known issues (don't rediscover; not currently being fixed)

- `config.ts` deletes `JUDGE_SHARED_SECRET` from `process.env`, but `unsetenv()` only drops the
  pointer — the string stays in the process's env memory. With shared UID 1000, no PID namespace,
  and allowed `open`/`read`, user code can plausibly read it from `/proc/<pid>/environ`. Unverified.
- Unsandboxed, untimed compilation; one shared UID and one shared `/tmp` root (see Sandbox).
- The compile cache can be evicted between `get()` and `fs.cp()` (a 500 instead of a recompile) and
  has **no size cap** (TTL-only, 15 min, no LRU). It does *not* leak across restarts: `startupSweep()`
  removes every `os.tmpdir()` entry starting with `judge-` — which includes the default
  `/tmp/judge-cache` — and `server.ts` runs it before `startCompileCache()`. So a boot sweep "fixing"
  the leak is dead code, and moving `COMPILE_CACHE_DIR` off the `judge-` prefix *introduces* one.
- `timeLimit`/`memoryLimit` have no upper bound. `/generate-tests` validates `language`, then
  ignores it.
- **`PYTHONHASHSEED` is not set**, so CPython/PyPy hash randomization stays on and set/dict iteration
  order varies run to run — any problem whose expected output depends on it is flaky.

## Related repo

`wmoj-app` — the Next.js client, with its own `AGENTS.md`. It calls this service only from
server-side route handlers with **`X-Judge-Token`**, and `JUDGE_SHARED_SECRET` must be identical on
both sides (constant-time compare; a length mismatch short-circuits before `timingSafeEqual`).

---

## Maintenance

Keep this file current, and keep it at or under **250 lines**. AGENTS.md is updated in the same
commit as the code — `88640cd` shipped the checkers feature and its AGENTS.md changes together — and
letting it go stale is leaving the work unfinished.

⚠️ **Maintenance here is ZERO-SUM.** The line budget is the point, not an accident: a file nobody
finishes reading is a file that does not guide anything. So the test for whether something belongs
in AGENTS.md is not "is this true and useful" — almost everything is — it is:

> **Is this worth removing something else to make room for?**

If the answer is no, it does not go here. If the answer is yes, name what you are cutting and cut it
in the same change. Only when there is genuinely spare room may you add without removing.

Three questions settle most cases:

1. **Does it have a detectable trigger?** ("when touching the seccomp policy", "when adding a
   language") → it belongs in a skill, where it loads exactly when it is needed and costs nothing
   when it is not. This is the default answer; prefer it.
2. **Is it broad and unconditional** — something every change in this repository must respect
   regardless of what it touches? → it belongs here.
3. **Otherwise** → it is bloat. Delete it, or leave it as a comment beside the code it describes,
   which is where a narrow fact stays honest for longest.
