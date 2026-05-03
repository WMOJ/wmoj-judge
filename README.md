# Judge API

**The Open-Source, Easy-to-Use Custom Judge API for Competitive Programming.**

Judge API is a high-performance, dockerized remote code execution engine designed specifically for competitive programming platforms, coding interview tools, and educational grading systems. It compiles and runs untrusted user code inside an `nsjail` + seccomp sandbox, grades it against multiple test cases concurrently, and returns precise per-test results with minimal latency.

It powers the submission pipeline of [wmoj-app](https://github.com/WMOJ/wmoj-app), but it has no direct dependency on it — anything that can `POST` JSON can use it.

Built with **Node.js 20 (Express + TypeScript)** and **Docker** on top of `nsjail` for OS-level isolation.

---

## Table of contents

- [Features](#features)
- [Architecture & internals](#architecture--internals)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Run with Docker (recommended)](#run-with-docker-recommended)
  - [Run from source](#run-from-source)
- [Integrating with `wmoj-app`](#integrating-with-wmoj-app)
- [Language support](#language-support)
- [API reference](#api-reference)
  - [`POST /submit`](#post-submit)
  - [`POST /generate-tests`](#post-generate-tests)
  - [`GET /health`](#get-health)
- [Configuration](#configuration)
- [Sandbox & security model](#sandbox--security-model)
- [Performance & tuning](#performance--tuning)
- [Deploying](#deploying)
- [Troubleshooting](#troubleshooting)

---

## Features

* **Concurrent execution** — multiple test cases per submission can run in parallel; multiple submissions run side by side, gated by configurable global / per-submission limits.
* **Strong isolation** — every submission runs in its own ephemeral workdir under an unprivileged UID, locked down with namespaces, rlimits, and a custom seccomp policy compiled from `policy.kafel`.
* **Compile cache** — repeated submissions of the same source skip recompilation. Hash-keyed, disk-backed, TTL-evicted.
* **Six native languages** — Python 3, PyPy 3, and C++14/17/20/23 with `g++ -O2`.
* **CPU-time-authoritative TLE** — judging is based on the child process's CPU time, not parent wall clock, so verdicts are stable under load.
* **Multiple comparison modes** — `exact`, `trim-trailing` (default; the typical CP convention), `whitespace`, and `float-epsilon`.
* **Test generation** — a separate `/generate-tests` endpoint runs a C++ generator that prints input/output JSON to stdout/stderr — handy for problem setters.
* **Shared-secret auth** — every request can be required to carry an `X-Judge-Token` header, so the service is safe to expose to the public internet (behind a load balancer).
* **Soft / strict auth toggle** — flip `AUTH_STRICT` to roll out auth without breaking in-flight callers.
* **Per-IP, per-token rate limits** — keyed on `IP|token` with a configurable window.
* **Pino structured logs** — JSON, one line per request, with request-id correlation.
* **Graceful shutdown** — SIGTERM drains in-flight submissions before exiting.

---

## Architecture & internals

The service is a single stateless Node.js process. Lifecycle of a `/submit` request:

1. **Auth + rate-limit + payload caps.** Middleware checks `X-Judge-Token`, the per-(IP, token) bucket, and that the body is within hard limits (≤ 100 KB code, ≤ 200 cases, ≤ 1 MB per case).
2. **Workdir creation.** A unique tmpdir like `/tmp/judge-xxxxxxxx/` is created, owned by an unprivileged UID drawn from the UID pool.
3. **Compile (if applicable).**
   * `python3` / `pypy3` — no compile step; the source file is dropped into the workdir.
   * `cpp14` / `cpp17` / `cpp20` / `cpp23` — `g++ -O2 -std=c++NN` compiles to `a.out`. Compilation runs in the host process (with a scrubbed environment) — not inside `nsjail` — for speed. The compile cache hashes `(language, code, argv)` and reuses prior artifacts within the TTL.
   * Compile failure returns HTTP 200 with a `compileError` field, never 4xx/5xx.
4. **Execute against each test case.** A `nsjail` child process is spawned per test:
   * No new namespaces (the host doesn't have `CAP_SYS_ADMIN` on most managed platforms), but rlimits, seccomp, and unprivileged-UID workdir isolation are all in force.
   * stdin is the test input, stdout/stderr are captured.
   * Tests within a submission are throttled by `PER_SUBMISSION_CONCURRENCY` (default `1` — serial — for the cleanest timing). The whole service is throttled by `GLOBAL_SUBMIT_CONCURRENCY` (default = CPU count).
5. **Compare.** Output is normalized per `compareMode` and diffed against the expected output. Each case yields a verdict: `AC`, `WA`, `TLE`, `MLE`, `RE`, `CE`, or `IE`.
6. **Aggregate + cleanup.** Results are summarized and the workdir is removed.

The seccomp policy lives in [`policy.kafel`](./policy.kafel) and is compiled to BPF by nsjail at runtime.

---

## Getting started

### Prerequisites

| Tool | Why |
|---|---|
| **Docker 20+** | The recommended path. Bundles every compiler, runtime, and `nsjail` itself. |
| Node.js 20+, Python 3, PyPy 3, g++ 14 | Only if you're running outside Docker. The seccomp + nsjail story is much harder without the image. |
| Linux host | `nsjail` is Linux-only. macOS / Windows users should use Docker. |

### Run with Docker (recommended)

```bash
git clone https://github.com/WMOJ/wmoj-judge.git
cd wmoj-judge

# 1. Build the image (3-stage build, ~1.2 GB final size)
docker build -t wmoj-judge .

# 2. Pick a shared secret to use for X-Judge-Token
export JUDGE_SHARED_SECRET="$(openssl rand -hex 32)"

# 3. Run the container
docker run --rm -p 4001:4001 \
  -e JUDGE_SHARED_SECRET="$JUDGE_SHARED_SECRET" \
  -e AUTH_STRICT=true \
  wmoj-judge
```

The service listens on `http://localhost:4001`. Verify:

```bash
curl http://localhost:4001/health
# → {"status":"ok"}
```

> **Hold on to that `$JUDGE_SHARED_SECRET` value** — you need to put the same string into `wmoj-app`'s `JUDGE_SHARED_SECRET` env var so the two services authenticate each other.

### Run from source

Useful if you're hacking on the judge itself. **You still need a Linux host** with `python3`, `pypy3`, `g++ 14+`, and an installed `nsjail` binary — without those, most submissions will fail.

```bash
git clone https://github.com/WMOJ/wmoj-judge.git
cd wmoj-judge

# Optional .env.local — see Configuration section for all variables
cat > .env.local <<EOF
JUDGE_SHARED_SECRET=$(openssl rand -hex 32)
AUTH_STRICT=true
EOF

npm install
npm run dev      # tsx watch src/server.ts
```

The dev script enables hot reload. For a production-style local run:

```bash
npm run build
npm run start
```

---

## Integrating with `wmoj-app`

`wmoj-app` (the Next.js front-end) is the canonical client. Wiring it up:

1. Pick a shared secret. Generate a long random string — `openssl rand -hex 32` is fine.
2. Set it as `JUDGE_SHARED_SECRET` on the **judge** (this repo).
3. Set the **same** string as `JUDGE_SHARED_SECRET` on the **app** (`wmoj-app/main/.env.local`).
4. Set `NEXT_PUBLIC_JUDGE_URL` on the app to wherever the judge listens (e.g. `http://localhost:4001` for local dev, `https://judge.example.com` for prod).
5. The app's `/api/*` route handlers will send every judge request with `X-Judge-Token: <secret>`. The judge's `auth` middleware will compare it in constant time.

The same secret unlocks `/submit`, `/generate-tests`, and `/health` (auth gates everything except `/health`).

> If you set `AUTH_STRICT=false`, requests without a valid token are **logged but allowed through**. This is useful for the first deployment of a new secret, but you should flip it to `true` as soon as you've confirmed every caller is authed.

---

## Language support

The Docker image ships with the following toolchain. Language IDs in the `language` field of `/submit` requests:

| ID | Display | Runtime / compiler | Source filename | Compile command | Run command |
|---|---|---|---|---|---|
| `python3` | Python 3 | CPython 3 (Debian Trixie) | `Main.py` | _(none)_ | `python3 -u Main.py` |
| `pypy3`   | PyPy 3   | PyPy 3 (Debian Trixie)    | `Main.py` | _(none)_ | `pypy3 -u Main.py` |
| `cpp14`   | C++14    | g++ 14.x                  | `Main.cpp` | `g++ -O2 -std=c++14 Main.cpp -o a.out` | `./a.out` |
| `cpp17`   | C++17    | g++ 14.x                  | `Main.cpp` | `g++ -O2 -std=c++17 Main.cpp -o a.out` | `./a.out` |
| `cpp20`   | C++20    | g++ 14.x                  | `Main.cpp` | `g++ -O2 -std=c++20 Main.cpp -o a.out` | `./a.out` |
| `cpp23`   | C++23    | g++ 14.x                  | `Main.cpp` | `g++ -O2 -std=c++23 Main.cpp -o a.out` | `./a.out` |

Legacy aliases `python` → `python3` and `cpp` → `cpp17` are still accepted for compatibility.

> **Java was removed** as of v0.2.0. The JVM's threading model didn't fit cleanly inside the seccomp policy, and adding it back is not currently a priority.

The full language matrix lives in [`languages.json`](./languages.json) — that's the source of truth, and the executors load it at boot.

---

## API reference

Every endpoint speaks JSON. Auth (when enabled) is enforced via the `X-Judge-Token: <JUDGE_SHARED_SECRET>` header.

### `POST /submit`

Compile a single source file and run it against an array of test cases.

**Request body**:

```json
{
  "language": "python3",
  "code": "n = int(input())\nprint(n * 2)",
  "input":  ["5", "10", "100"],
  "output": ["10", "20", "200"],
  "timeLimit":   2000,
  "memoryLimit": 256,
  "compareMode": "trim-trailing"
}
```

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `language` | string | yes | — | One of the IDs in [Language support](#language-support). |
| `code` | string | yes | — | Source code. ≤ 100 KB. |
| `input` | string[] | yes | — | Per-test stdin. ≤ 200 entries, each ≤ 1 MB. |
| `output` | string[] | yes | — | Per-test expected stdout. Must match `input.length`. |
| `timeLimit` | number (ms) | no | `5000` | CPU-time limit per test. |
| `memoryLimit` | number (MB) | no | `256` (`384` for `pypy3`) | Virtual address space cap (`RLIMIT_AS`). |
| `compareMode` | string | no | `trim-trailing` | One of `exact`, `trim-trailing`, `whitespace`, `float-epsilon`. |

**Response** (HTTP 200, even on compile/runtime errors):

```json
{
  "summary": { "total": 3, "passed": 3, "failed": 0 },
  "results": [
    {
      "index": 0,
      "verdict": "AC",
      "passed": true,
      "exitCode": 0,
      "expected": "10",
      "received": "10",
      "stderr": "",
      "stdout": "10",
      "timedOut": false,
      "timeMs": 32,
      "cpuMs": 18,
      "memKb": 8192
    }
  ]
}
```

If compilation fails, the response is:

```json
{
  "summary": { "total": 3, "passed": 0, "failed": 3 },
  "results": [],
  "compileError": "Main.cpp: In function 'int main()':\n…"
}
```

Verdicts: `AC` (accepted), `WA` (wrong answer), `TLE` (CPU-time exceeded), `MLE` (memory limit exceeded), `RE` (runtime error / non-zero exit / signal), `CE` (compile error — only ever appears when `compileError` is set), `IE` (internal judge error).

### `POST /generate-tests`

Run a C++ "generator" program and parse its output as JSON arrays of inputs/outputs. Useful for problem setters bulk-creating test cases.

**Request body**:

```json
{
  "language": "cpp17",
  "code": "/* C++ that prints input JSON to stdout and output JSON to stderr */"
}
```

`language` is optional; defaults to `cpp17`. `cpp14` is the only other accepted value.

**Response**:

```json
{
  "input":  ["case_1_in",  "case_2_in"],
  "output": ["case_1_out", "case_2_out"],
  "inputJson":  "[\"case_1_in\",\"case_2_in\"]",
  "outputJson": "[\"case_1_out\",\"case_2_out\"]"
}
```

### `GET /health`

Reports whether the toolchain (`python3`, `pypy3`, `g++`) is reachable. Cached for 30 s. **Not** auth-gated.

```bash
curl http://localhost:4001/health
# 200 → {"status":"ok"}
# 503 → {"status":"degraded","reason":"<which tool failed>"}
```

---

## Configuration

Every variable below is optional except `JUDGE_SHARED_SECRET` in production. Anything you don't set takes the default.

### Required (in production)

| Variable | Purpose |
|---|---|
| `JUDGE_SHARED_SECRET` | The shared token. Must be **identical** to the value in `wmoj-app`'s `.env.local`. The judge will refuse to boot in `NODE_ENV=production` if this is unset. |

### Auth & networking

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_STRICT` | `false` | When `true`, missing or wrong `X-Judge-Token` returns `401`. When `false`, it's logged as a warning but allowed through (use during initial rollout only). |
| `PORT` (or `JUDGE_PORT`) | `4001` | TCP port to listen on. Some PaaS providers inject `JUDGE_PORT` instead. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `RATE_LIMIT_MAX` | `60` | Max requests per `(IP, token)` pair within a window. |

### Sandbox & concurrency

| Variable | Default | Purpose |
|---|---|---|
| `UID_POOL_SIZE` | `16` | Number of unprivileged UIDs available for sandboxed children. The Dockerfile pre-creates exactly this many users (UIDs 1000–1015). If you raise this, you also need to add more users in your image. |
| `GLOBAL_SUBMIT_CONCURRENCY` | CPU count | Max concurrent `/submit` requests in flight at once. |
| `PER_SUBMISSION_CONCURRENCY` | `1` | Test cases run in parallel within a single submission. Default `1` keeps timing deterministic; raise it on multi-core hardware if you're OK with noisier wall-clock numbers. |
| `NSJAIL_BIN` | `/usr/local/bin/nsjail` | Path to the `nsjail` binary. Override only if you've installed it elsewhere. |
| `SECCOMP_POLICY` | `/app/policy.kafel` | Path to the kafel-format seccomp policy. |

### Compile cache

| Variable | Default | Purpose |
|---|---|---|
| `COMPILE_CACHE_DIR` | `/tmp/judge-cache` | Where compiled artifacts live. |
| `COMPILE_CACHE_TTL_MS` | `900000` (15 min) | How long an entry is reusable before re-compile. |

### Logging

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | One of pino's levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `NODE_ENV` | `development` | Setting `production` enables the strict `JUDGE_SHARED_SECRET` requirement at boot. |

### Example `.env.local`

```dotenv
# Required
JUDGE_SHARED_SECRET=replace-with-a-32-byte-random-hex-string
AUTH_STRICT=true

# Optional overrides — defaults are fine for most deployments
# PORT=4001
# UID_POOL_SIZE=16
# GLOBAL_SUBMIT_CONCURRENCY=4
# PER_SUBMISSION_CONCURRENCY=1
# COMPILE_CACHE_TTL_MS=900000
# COMPILE_CACHE_DIR=/tmp/judge-cache
# RATE_LIMIT_WINDOW_MS=60000
# RATE_LIMIT_MAX=60
# LOG_LEVEL=info
# NSJAIL_BIN=/usr/local/bin/nsjail
# SECCOMP_POLICY=/app/policy.kafel
```

---

## Sandbox & security model

The sandbox layers several Linux primitives. None of them is sufficient on its own; they're meant to be defense in depth.

| Layer | What it does | How |
|---|---|---|
| **Unprivileged UID** | The Node process drops to UID `1000` at container start. Children inherit it. They can't `setuid` away. | `USER 1000` in Dockerfile + a UID pool that gates concurrency. |
| **Per-submission tmpdir** | Every submission gets its own `0700` directory owned by the running UID. No cross-submission visibility. | `src/util/workdir.ts`. |
| **rlimits** | Bounds CPU time, virtual address space, FDs, processes, file size, core dumps. | `nsjail --rlimit_*` flags. |
| **seccomp BPF** | Kills (or, more precisely, returns ENOSYS to) any syscall not on the allowlist. | [`policy.kafel`](./policy.kafel) — `DEFAULT ERRNO(38)`, with explicit `DENY EPERM` for sockets/ptrace/mount/module-loading/etc., and explicit `ALLOW` for the syscalls all six runtimes need. |
| **Minimal env** | The child sees only `PATH`, `LANG`, `LC_ALL`, `PYTHONUNBUFFERED`. The shared secret and other host env vars are scrubbed. | `src/sandbox/minimalEnv.ts`. |

**Verdicts depend on CPU time, not wall clock.** Wall-clock TLE was previously flaky under load (judge GC pauses, nsjail setup, kafel BPF compilation could all push a clean submission past the limit). The current logic prioritizes the kernel-reported child CPU time and falls back to a 3× wall-clock backstop only when CPU is somehow under-budget.

> **Things the sandbox does NOT defend against**: side-channel timing attacks against other tenants, physical resource exhaustion of the host (you should run the judge on its own VM), and bugs in nsjail / seccomp filter generation. Treat the judge as an isolation perimeter, not a guarantee.

---

## Performance & tuning

* **Compile cache makes repeated submissions cheap.** A second submission of the exact same source skips compilation; only the `g++` step is cached, not the per-test execution.
* **`PER_SUBMISSION_CONCURRENCY=1` is intentional.** Running 200 tests in parallel on a 4-core box would inflate wall time and produce noisy verdicts. Raise it deliberately, with hardware in mind.
* **`GLOBAL_SUBMIT_CONCURRENCY` matches CPU count by default** — that's a sensible ceiling for compile + execution. Raise it if your container has more cores than `os.cpus()` reports.
* **`UID_POOL_SIZE` is the hard ceiling.** If `GLOBAL_SUBMIT_CONCURRENCY=64` but `UID_POOL_SIZE=16`, only 16 sandboxes will ever run at once and the rest will queue silently.
* **Express body parser is set to 250 MB**, but `requestCaps` middleware enforces the real per-field limits before route handlers see the body.

---

## Deploying

The judge is happiest on Linux containers (Render, Fly.io, Railway, AWS Fargate, plain EC2, …). Anywhere you can run a Docker image.

A typical Render deploy:

1. Connect this repo as a Web Service.
2. Build command: `(none — Docker handles it)`.
3. Use the Dockerfile in the repo.
4. Set environment variables in the dashboard:
   * `JUDGE_SHARED_SECRET` — the same value used by your `wmoj-app` deployment.
   * `AUTH_STRICT=true` — once you've confirmed all callers are authed.
   * Any of the optional overrides above.
5. Health check path: `/health` (returns 200/JSON).

Because Render-style platforms don't grant `CAP_SYS_ADMIN` or `CAP_SETPCAP`, the Dockerfile is set up to:
* Run as UID `1000` (not root) so nsjail can short-circuit the `prctl(PR_SET_SECUREBITS)` it would otherwise need `CAP_SETPCAP` for.
* Use `--disable_clone_new*` for namespaces that aren't available without `CAP_SYS_ADMIN`.

If you're on a host that *does* grant the privileged caps and want stronger isolation (separate user / mount / network namespaces), drop the relevant `--disable_clone_new*` flags from `src/sandbox/nsjail.ts`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `JUDGE_SHARED_SECRET is required in production` at boot | `NODE_ENV=production` and the env var is unset | Set the variable. |
| Every request returns `401 unauthorized` | The caller's `X-Judge-Token` doesn't match the judge's `JUDGE_SHARED_SECRET` | Print both values and compare byte-for-byte. Whitespace, trailing newlines, and quote characters are common culprits. |
| `/health` returns `503 degraded` | One of `python3` / `pypy3` / `g++` isn't on the `PATH` | Likely you're running outside Docker without all toolchains installed. Use the Docker image. |
| Submissions hang at "queued" forever | `UID_POOL_SIZE=0` or every UID is occupied by stuck workdirs | Look for `judge-*` directories in `/tmp` from a prior crash; the workdir reaper sweeps them on startup. |
| Compile cache returns stale binaries after editing the compiler | Cache key is `(language, code, argv)` — argv changes when you change flags | Delete `/tmp/judge-cache/`, or shorten `COMPILE_CACHE_TTL_MS`. |
| Verdict is `IE` (internal error) | Could be many things — usually nsjail spawn failure | `LOG_LEVEL=debug` and check the request log; the nsjail stderr is captured in `result.stderr`. |
| Random TLE under load | `PER_SUBMISSION_CONCURRENCY > 1` on a small machine | Drop it back to `1`. |
| `permission denied` writing to `/tmp/judge-*` from inside the container | UID mismatch — container is running as a UID not in the pre-created pool | Don't override `USER` in `docker run`. The image runs as UID `1000` by design. |

---

## License & contributions

Issues and pull requests welcome. Two friendly asks:

1. If you're touching `policy.kafel`, please describe in the PR which syscalls you're allowing/denying and why — the policy is the only thing standing between user code and the host kernel.
2. If you're adding a language, update `languages.json`, add an executor under `src/executors/`, install the runtime in the `runtime` stage of the Dockerfile, and verify the seccomp policy is permissive enough for the new runtime's startup probes.
