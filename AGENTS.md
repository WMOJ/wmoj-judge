# wmoj-judge — agent guide

The execution half of WMOJ. A **stateless, synchronous** HTTP service that compiles and runs
untrusted competitive-programming submissions inside `nsjail` + seccomp and returns per-test verdicts
in the same response. **No database, queue, job IDs, callbacks, or persistence.**

Node 20 · TypeScript 5.9 (**CommonJS**) · Express 4.21 · pino · Docker. Its only client is
`wmoj-app`, authenticated with a static shared secret. `nanoid` 3 and `p-limit` 3 are pinned to CJS
majors — **v4+ are ESM-only, do not bump**. nsjail is pinned to tag **3.3**, built from source.

## The constraint that explains this codebase

It runs on a **free Render instance: 512 MB RAM, ~0.1 CPU**, with no `CAP_SYS_ADMIN`/`CAP_SETPCAP`
and no cgroup access. Nearly every limitation here — disabled namespaces, serial test execution, the
size caps, the compile cache, CPU-time TLE — follows from that host, not from oversight. Before
"fixing" something that looks under-built, check whether it is load-bearing for this environment.

## Commands

```bash
npm ci
npm run build       # tsc → dist/ — builds AND typechecks src/
npm run typecheck   # tsc over src/ AND test/ (tsconfig.test.json), emits nothing
npm test            # node:test unit suite in test/unit — pure modules, no container
npm run test:e2e    # replays test/fixtures/e2e against JUDGE_URL; needs a running judge
npm run dev         # tsx watch (Linux only)
docker build --platform=linux/amd64 -t wmoj-judge .
docker run --rm -p 4001:4001 -e JUDGE_SHARED_SECRET=… -e AUTH_STRICT=true wmoj-judge
```

**No lint, no format script.** Three gates: `build`, `typecheck`, `test`; CI runs them plus the e2e
goldens against the amd64 image on every push. MLE and seccomp behaviour is only exercisable on an
amd64 kernel — on arm64 the e2e replay skips those fixtures (→ **`run-judge-locally`**) — so **a
verdict-affecting change is not verified until CI is green.** Tests live in `test/`, outside
`rootDir`, so they can never ship in `dist/`.

- **Won't run natively on macOS** — nsjail is Linux-only. Use Docker.
- **`.env.local` is intentionally not loaded** (no `dotenv`, no `--env-file`); local runs fall back
  to `AUTH_STRICT=false`. Production vars come from the Render dashboard.
- **Refuses to boot** unless every `src/liveness` check passes — a judge that cannot measure must not
  accept submissions. `NODE_ENV=production` is baked in, so a missing `JUDGE_SHARED_SECRET` exits 1.
- **Build `--platform=linux/amd64`.** `policy.kafel` targets the amd64 syscall table; built for
  arm64 it will not compile and nsjail exits 255, so the boot probe above refuses to start.

## Skills

Trigger-scoped detail lives in `.agents/skills/` (`.claude` symlinks to it). Load the matching
skill *before* touching the area; each holds failure modes this file has no room for.
`sandbox-changes` (`src/sandbox/**`, `policy.kafel`, `Dockerfile`) · `custom-checkers`
(`src/checker/`, the `checker` field) · `add-language` (a language or a compiler flag) ·
`verdicts-and-comparison` (`gradeCase`, the MLE rules, `src/compare/`) · `judge-app-contract`
(any request/response field, env-var name, or verdict string) · `run-judge-locally` (building,
booting or smoke-testing the container, and pairing it with a local `wmoj-app`).

## API

Middleware order (`src/server.ts`): `httpLogger → cors() → /health →
[rateLimit, auth, express.json(JSON_BODY_LIMIT), requestCaps, in-flight counter] → /submit,
/generate-tests`. **The body parser is inside the gated chain**, so an unauthenticated giant POST is
rejected before it is buffered, and the rate limiter sits *ahead* of auth so 401 floods are throttled
too. There is **no 404 handler and no global error handler**, so unmatched paths get Express's
default **HTML**; gates mount with `app.use`, so even `GET /submit` runs auth first.

**`POST /submit`** —
`{language, code, input[], output[], timeLimit?, memoryLimit?, compareMode?, checker?}`;
`input`/`output` must be equal-length string arrays. Returns 200 with
`{summary:{total,passed,failed}, results[], effectiveMemoryLimitMb}`.

`effectiveMemoryLimitMb = floor(max(1, min(max(requested, language floor) || 256, ceiling)))` is the
cap actually enforced — an integer, so advertised and enforced always agree. Present on **every** 200.
`TestResult` also carries real `cpuMs`/`memKb` and an optional `truncated`.

> **A compile error is HTTP 200** — `{summary:{0,0,0}, results:[], compileError}`. **A checker that
> fails to compile is HTTP 200 with a separate top-level `checkerError`.** Never merge the two:
> `wmoj-app` synthesizes a user-facing `CE` from `compileError`, and a broken checker is a
> problem-configuration fault, not the student's. 4xx/5xx means the request or the judge is wrong,
> never the user's code.

**`POST /generate-tests`** — `{code, language?}`. The generator prints a JSON array of inputs to
**stdout** and expected outputs to **stderr**, equal length; a compile failure is **400**, not 200.
It now enforces the same per-case and aggregate caps `/submit` will later apply, so it cannot hand an
admin test data the judge would refuse. Limits 60 s / 1024 MB, bypassing the host clamp. Documented
admin-only but **not enforced**, and it **bypasses the global semaphore**.

**`GET /health`** — unauthenticated by design (Render probes). Five checks in `src/liveness`: three
toolchains and a sandbox launch every 30 s, the sandbox *measuring* (the CPU-time self-check that
once ran only at boot) every 5 min; boot runs all five. `200 {status,version,seccomp}`, `503
{status:"degraded",reason,version,seccomp}`, or 503 `"draining"` while shutting down. `version` is
`RENDER_GIT_COMMIT` if set, else package version + start time; `seccomp` is `enforced`/`disabled`.

## Size caps and the memory clamp

Decided in `src/budget` (one walk, UTF-8 bytes) and enforced by `requestCaps` (413) and
`/generate-tests` (400) from that same walk: **200** cases, **1,000,000** bytes per input and per
expected output, 100,000 per source and per checker, and an **aggregate** `MAX_TOTAL_REQUEST_BYTES`
= 16 MiB over `code + checker + Σinput + Σoutput`. `JSON_BODY_LIMIT` is `"32mb"`, 2× the aggregate,
in the same module, asserted by `test/unit/budget.test.ts`, so the parser limit can never again sit
*below* the largest legal payload — it used to, so a legal max-size body got Express's HTML 413.
Changing any cap means changing `wmoj-app`'s `judge.sh` constants in the same commit.

Every submission's cap is clamped to `min(requested, HOST_MEMORY_CEILING_MB)` — **384**, not 512:
Node and the compile cache share the same 512 MB, so a ceiling equal to the box means the OOM-killer
fires before `RLIMIT_AS` and every in-flight submission dies instead of one getting a clean `MLE`.
`/generate-tests` is exempt.

## Sandbox

**Deliberately weaker than a textbook sandbox**, stripped down to run unprivileged. Active: seccomp
BPF (`policy.kafel`, dropped only by the dev-only `UNSAFE_DISABLE_SECCOMP`, which `config.ts` refuses
under `NODE_ENV=production`), rlimits, a per-submission `0700` tmpdir, a 4-var env allowlist (`PATH`,
`LANG`, `LC_ALL`, `PYTHONUNBUFFERED`). Disabled: **all seven namespaces** (user, net, mnt, pid, ipc,
uts, cgroup), chroot, `--user`/`--group`, cgroups.

- Every submission runs as **UID 1000 — the same UID as the Node process** — sharing its PID, mount,
  and network namespaces. The UID pool is now just a concurrency gate.
- **Network is blocked by seccomp alone.** There is no second layer.
- `open`/`read`/`write`/`getdents64` are allowed with **no path filtering and no chroot**, and every
  submission shares UID 1000 and one `/tmp` root, so **cross-submission isolation does not hold**.
  `prlimit64` and `sched_setaffinity` are filtered to `pid == 0` so a submission cannot retarget the
  judge; `kill`/`tgkill` deliberately are not (CPython's `abort()` needs a non-zero pid).
- **Compilation is NOT sandboxed** — `g++` is spawned directly (`util/compile.ts`) with no timeout
  and no rlimits for submissions, checkers and generators alike. A compile bomb can OOM the
  service, and `#include` of an arbitrary path leaks its contents through `compileError`. Only the
  *run* step goes through nsjail.
- **Resource accounting comes from `wmoj-jailrun`**, a small C wrapper built into the image that
  execs nsjail, `wait4()`s it with `rusage`, and reports over a `FD_CLOEXEC` fd the jailed program
  cannot reach — nsjail 3.3 emits **no** rusage.
- Every flag, rlimit, and seccomp rule prevents one specific failure → **`sandbox-changes`**.

## Verdicts

`Verdict = AC | WA | TLE | MLE | RE | CE | IE`. **`gradeCase` in `src/verdict` is the only place a
verdict is decided; the sandbox reports measurements and nothing else.** Its TLE → MLE → RE → IE →
WA/AC order and the kill ladder are internals guarded by `test/unit/verdict.test.ts` and the fixtures.

- `IE` is produced **only** by a custom checker that could not answer — including one that crashed,
  tripped seccomp, or could not be exec'd. Never let that reach a student as `WA`.
- **`CE` is declared but never produced** — compile failures surface via
  `compileError`/`checkerError`, and `wmoj-app` synthesizes its own `CE`.
- A case passes only if the run finished cleanly (exit 0, no kill class) **and** the checker accepted
  (or, with no checker, `compare(...)` matched) — correct output with a non-zero exit fails.
- **No early exit** — every case runs after a failure. An `IE` case counts as failed in `summary`.
- Default comparator `trim-trailing`. **Comparators must stay linear**: the trailing-whitespace regex
  was quadratic, and one ordinary `printf("%1000000d")` blocked the event loop for ~26 minutes.
- Partial scoring, subtasks and interactive problems are unsupported; scoring lives in `wmoj-app`.

## Languages

`languages.json` is the source of truth and `src/languages` derives everything from it (`Language`
is its `keyof`): `python3`, `pypy3` (384 MB floor), `cpp14/17/20/23`. Adding one → **`add-language`**.
`/submit` takes only canonical codes; `/generate-tests` still takes bare `cpp` for `judge.sh`.

## Concurrency & config

Three throttles: `submitSemaphore` (p-limit at `max(1, min(cpuCount, ceiling/256))` — **not**
`os.cpus().length`, which inside a container reads the *host's* CPU count; **`/submit` only**), a
per-submission pool (**1 = serial**, deliberate — parallel runs on shared vCPUs made TLE
non-deterministic), and the **16-UID pool, which is the true ceiling** and covers both gated
endpoints — both lease it through `withWorkspace`, which also brackets the in-flight counter so a
client disconnect no longer drops the count mid-judging. All in-process promise scheduling — no
worker_threads, no queue workers. Backpressure is **queue-never-reject**: no depth cap, no timeout,
no disconnect handling; a burst past the rate limiter queues indefinitely with the connection held
open.

`src/config.ts` is the env boundary — everything else imports the frozen `config`; `.env.example`
documents every variable. One exception: `sandbox/minimalEnv.ts` reads `process.env.PATH`. **A
malformed value throws at boot** rather than silently becoming a different number, and
`readSharedSecret()` deletes the secret from `process.env` after reading it.

`AUTH_STRICT` **defaults to `IS_PROD`** — fail-open in dev, fail-closed in production. In soft mode a
**missing** token is let through, not just a wrong one. CORS is wide open (`*`) and the secret is the
only gate, so **never call this service from browser code**. Rate limiting is 60/min across both
gated routes; with no `trust proxy` and one token, all of wmoj-app shares one bucket.

Graceful shutdown: `SIGTERM`/`SIGINT` → both routes 503 → a single **25 s whole-drain budget**
stamped at signal receipt, from which `server.close()`, idle-close, drain and force-close all derive
→ `rm -rf` workdirs → flush pino → exit 0. A second signal exits 1 immediately.

## Code conventions

Verified repo-wide by exhaustive grep — match them.

- CommonJS, **no `.js` extensions in imports**; **named exports only**; `import type` used throughout.
- **Zero `any`, and zero TODO/FIXME/HACK/XXX markers.** Known weaknesses are prose in JSDoc.
- **No custom error classes, no `next(err)`, no error middleware.** Failures are discriminated result
  objects (`{ok:true,value} | {ok:false,error}`); each route is one `try/catch/finally` returning
  `500 {error}`. A **judge** fault must throw, never become a verdict — never bill it to the student.
- **Manual validation, no zod.** Structured pino logging, token redacted under three header spellings.
- **Heavy JSDoc-`why` comments naming the specific failure the code prevents** — the strongest
  stylistic signature here. Preserve it; never leave a comment that contradicts its own file.
- `noUncheckedIndexedAccess` makes every `arr[i]` a `T | undefined`. Markdown wraps at ~100 columns.

Commits: Conventional Commits — lowercase, imperative, no trailing period, optional scope. Subjects
pack the reason in via a `so <consequence>` clause. **Zero trailers of any kind. Never add them.**

## Requires a decision, not a drive-by change

1. `policy.kafel` — state which syscalls move and why.
2. The nsjail argv — disabled namespaces, `--keep_caps`, `--log_fd 3`, absent `--user`/`--chroot`.
3. The Dockerfile's `--platform` pin, `tini` entrypoint, `USER 1000`, useradd loop, trixie base.
4. The `/submit` contract — compile errors stay HTTP 200 with `compileError`, checker compile errors
   HTTP 200 with `checkerError`, and the two must never be merged. **Cross-repo breaking change**;
   coordinate with `wmoj-app`.
5. `wmoj-jailrun`'s report format (parsed in `nsjail.ts`), and the checker/generator dialect (ADR 0003).
6. Never widen the seccomp allowlist, the compile trust boundary, or the env allowlist just to make
   something work.

## Known issues (don't rediscover; not currently being fixed)

- `config.ts` deletes `JUDGE_SHARED_SECRET` from `process.env`, but `unsetenv()` only drops the
  pointer — the string stays in the process's env memory. With shared UID 1000, no PID namespace,
  and allowed `open`/`read`, user code can plausibly read it from `/proc/<pid>/environ`. Unverified.
- Unsandboxed, untimed compilation; one shared UID and one shared `/tmp` root (see Sandbox).
- The compile cache has **no size cap** (TTL-only, 15 min, no LRU). It does *not* leak across
  restarts: `startupSweep()` removes every `os.tmpdir()` entry starting with `judge-`, so moving
  `COMPILE_CACHE_DIR` off that prefix *introduces* a leak.
- **`PYTHONHASHSEED` is not set**, so CPython/PyPy hash randomization stays on and set/dict iteration
  order varies run to run — any problem whose expected output depends on it is flaky.

## Related repo

`wmoj-app` — the Next.js client, with its own `AGENTS.md`. It calls this service only from
server-side route handlers with **`X-Judge-Token`**, and `JUDGE_SHARED_SECRET` must be identical on
both sides (constant-time compare; a length mismatch short-circuits before `timingSafeEqual`).

---

## Maintenance

Keep this file current, and keep it at or under **250 lines**. AGENTS.md is updated in the same
commit as the code, and letting it go stale is leaving the work unfinished.

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
