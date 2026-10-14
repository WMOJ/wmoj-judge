---
name: request-pipeline
description: Changes what happens to a wmoj-judge request around the grading itself — the load-bearing middleware order in src/server.ts, the size caps and JSON body limit in src/budget, the 384 MB host memory ceiling, the three concurrency throttles (submit semaphore, per-submission pool, UID pool) and the queue-never-reject backpressure, rate limiting, the liveness cadences behind /health, the env boundary in src/config.ts, and the 25 s graceful-shutdown drain. Use whenever someone wants to add, reorder, tune, debug, or review a middleware, a route mount, a size cap, a 413, a 429, HOST_MEMORY_CEILING_MB, concurrency, the semaphore, queueing, an env var or its default, AUTH_STRICT, /health checks, or SIGTERM handling.
---

# The request pipeline in wmoj-judge

Everything here is sized for a free Render instance — 512 MB RAM, ~0.1 CPU — and most of it exists
because a looser version already took the service down once. Field names, status codes and deploy
ordering are in `judge-app-contract`; this skill is the machinery around them.

## Middleware order (`src/server.ts`)

```
httpLogger → cors() → /health →
[rateLimit, auth, express.json(JSON_BODY_LIMIT), requestCaps, in-flight counter] → /submit, /generate-tests
```

The order of the gated chain is load-bearing:

- **The rate limiter sits ahead of auth**, so a flood of *failed* auth attempts is throttled too.
  Behind auth it only ever throttled callers who already held the secret.
- **The body parser is inside the gated chain**, after auth. body-parser buffers, concatenates,
  decodes and parses — several times the body size in peak RSS — so mounted globally, an
  unauthenticated giant POST to any URL could OOM the container before auth ran.
- `requestCaps` needs the parsed body, so it follows the parser. The in-flight counter is last, so it
  counts only requests that reached a judging route.
- One limiter and one parser instance are shared by both mounts: "60/min across both gated routes" is
  one budget, not two.

There is **no 404 handler and no global error handler** — deliberate — so unmatched paths get
Express's default **HTML**. Gates mount with `app.use`, so even `GET /submit` runs auth first.

## Size caps (`src/budget`)

Decided by one walk over the request (UTF-8 bytes) and enforced from that same walk by `requestCaps`
(**413** `{error, reason, limit}`) and by `/generate-tests` (**400**), so the two cannot disagree:

| Cap | Value |
|---|---|
| cases | **200** |
| bytes per input, and per expected output | **1,000,000** |
| bytes of source, and of checker | **100,000** |
| aggregate `MAX_TOTAL_REQUEST_BYTES` over `code + checker + Σinput + Σoutput` | **16 MiB** |
| `JSON_BODY_LIMIT` | `"32mb"` — 2× the aggregate |

`JSON_BODY_LIMIT` lives in the same module and `test/unit/budget.test.ts` asserts the relation, so
the parser limit can never again sit *below* the largest legal payload — it used to, and a legal
max-size body got Express's HTML 413. `/generate-tests` enforces the per-case and aggregate caps
`/submit` will later apply, so it cannot hand an admin test data the judge would then refuse.

**Changing any cap means changing `wmoj-app`'s `judge.sh` constants in the same change** — see
`judge-app-contract`.

## The host memory ceiling

Every submission's cap is clamped to `min(requested, HOST_MEMORY_CEILING_MB)` — **384**, not 512.
Node and the compile cache share the same 512 MB, so a ceiling equal to the box means the OOM-killer
fires before `RLIMIT_AS` does and every in-flight submission dies instead of one getting a clean
`MLE`. The clamped value is what the sandbox enforces and what the response reports as
`effectiveMemoryLimitMb` (the full expression is in `verdicts-and-comparison`).

`/generate-tests` is exempt: generators run at **60 s / 1024 MB**, outside the clamp.

## Concurrency

Three throttles, all in-process promise scheduling — no `worker_threads`, no queue workers:

1. **`submitSemaphore`** (`src/queue/globalSemaphore.ts`), a p-limit at
   `max(1, min(cpuCount, floor(ceiling / 256)))`. Derived from memory, **not** `os.cpus().length`:
   inside a container that reads the *host's* CPU count and is blind to the CFS quota. **`/submit`
   only** — `/generate-tests` bypasses it.
2. **The per-submission pool**, `PER_SUBMISSION_CONCURRENCY` = **1**, i.e. serial. Deliberate:
   parallel cases on shared vCPUs made TLE non-deterministic. `custom-checkers` also relies on it.
3. **The 16-UID pool, which is the true ceiling** and covers both gated endpoints. Both lease it
   through `withWorkspace` (`src/workspace`), which owns `enterRequest → acquire → createWorkdir → fn
   → cleanup → release → exitRequest` as one bracket, so a client disconnect no longer drops the
   in-flight count mid-judging.

Backpressure is **queue-never-reject**: no depth cap, no timeout, no disconnect handling. A burst
past the rate limiter queues indefinitely with the connection held open.

`/generate-tests` is documented as admin-only but that is **not enforced** by the judge — any holder
of the shared secret can call it.

## Rate limiting and auth

60 requests per minute (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`), keyed on remote IP plus the
token. With no `trust proxy` and one token, **all of `wmoj-app` shares one bucket**; a bulk import
and live traffic compete for it.

`AUTH_STRICT` **defaults to `IS_PROD`** — fail-open in dev, fail-closed in production. In soft mode a
**missing** token is let through, not just a wrong one. CORS is wide open (`*`) and the secret is the
only gate, which is why this service must never be called from browser code. The token is redacted
from logs under three header spellings.

## `/health` and liveness (`src/liveness`)

Five checks. Boot runs all five and **refuses to start** unless every one passes. Afterwards
`/health` re-runs them on two cadences: the three toolchain probes and a real sandbox launch every
**30 s**, and the sandbox *measuring* (the CPU-time self-check that once ran only at boot — see
`sandbox-changes`) every **5 min**. A failed check is `503 {status:"degraded", reason, …}`; during
shutdown the reason is `"draining"`.

## Config (`src/config.ts`)

The env boundary: everything else imports the frozen `config`, and `.env.example` documents every
variable. The one exception is `sandbox/minimalEnv.ts`, which reads `process.env.PATH`.

- **A malformed value throws at boot** rather than silently becoming a different number —
  `COMPILE_CACHE_TTL_MS=15m` once became a 15 ms TTL, and `RATE_LIMIT_MAX=0` 429'd every request.
- `readSharedSecret()` deletes `JUDGE_SHARED_SECRET` from `process.env` after reading it (what that
  does and does not buy is under "Known weaknesses" in `sandbox-changes`).
- `NODE_ENV=production` is baked into the image, so a missing secret exits 1.
- **`.env.local` is intentionally not loaded** (no `dotenv`, no `--env-file`). Production values come
  from the Render dashboard.

## Graceful shutdown (`src/util/shutdown.ts`)

`SIGTERM`/`SIGINT` → both routes 503 → a single **25 s whole-drain budget** stamped at signal
receipt, from which `server.close()`, idle-close, the drain and force-close all derive → `rm -rf`
the workdirs → flush pino → exit 0. A second signal exits 1 immediately.

It is a whole-drain budget, not a per-step timeout, because Render SIGKILLs 30 s after SIGTERM and
the workdir sweep and the log flush have to fit inside that window too.

## Never

- Never mount `express.json` ahead of auth, or the rate limiter behind it.
- Never add a 404 or error middleware as a drive-by; routes own their `try/catch/finally`.
- Never raise a cap without checking `JSON_BODY_LIMIT` and `judge.sh` in `wmoj-app`.
- Never set `HOST_MEMORY_CEILING_MB` to the size of the box.
- Never size concurrency from `os.cpus()`, and never raise `PER_SUBMISSION_CONCURRENCY` to make
  judging faster — it trades away deterministic TLE.
- Never read `process.env` outside `config.ts`, and never let a bad value fall back silently.
- Never turn the drain budget into per-step timeouts, or push it past Render's 30 s.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
reordered gate, a changed cap, a new throttle, a different cadence or drain budget — update it as
part of your change. This skill is only useful while it is accurate.
