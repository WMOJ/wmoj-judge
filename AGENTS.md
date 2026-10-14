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
npm run build       # tsc → dist/ — builds AND typechecks src/
npm run typecheck   # tsc over src/ AND test/ (tsconfig.test.json), emits nothing
npm test            # node:test unit suite in test/unit — pure modules, no container
npm run test:e2e    # replays test/fixtures/e2e against JUDGE_URL; needs a running judge
docker build --platform=linux/amd64 -t wmoj-judge .   # nsjail is Linux-only: Docker or nothing
```

**No lint, no format script.** Three gates: `build`, `typecheck`, `test`; CI runs them plus the e2e
goldens against the amd64 image on every push. MLE and seccomp behaviour exists only on an amd64
kernel (arm64 skips those fixtures), so **a verdict-affecting change is not verified until CI is
green.** The judge **refuses to boot** unless every `src/liveness` check passes — one that cannot
measure must not accept submissions.

## Skills

Trigger-scoped detail lives in `.agents/skills/` (`.claude` symlinks to it). Load the matching
skill *before* touching the area; each holds failure modes this file has no room for.
`sandbox-changes` (`src/sandbox/**`, `policy.kafel`, `Dockerfile`) · `custom-checkers`
(`src/checker/`, the `checker` field) · `add-language` (a language or a compiler flag) ·
`verdicts-and-comparison` (`gradeCase`, the MLE rules, `src/compare/`) · `judge-app-contract`
(any request/response field, env-var name, or verdict string) · `request-pipeline` (`server.ts`,
middleware, size caps, concurrency, `config.ts`, shutdown) · `run-judge-locally` (building, booting
or smoke-testing the container, env vars, Apple Silicon, pairing it with a local `wmoj-app`).

## API

`POST /submit` and `POST /generate-tests` sit behind rate limit → auth → body parser → size caps,
in that order; `GET /health` is unauthenticated by design. Every field, status code and verdict
string is a cross-repo interface → **`judge-app-contract`**.

`/submit` takes `{language, code, input[], output[], timeLimit?, memoryLimit?, compareMode?,
checker?}` and returns 200 `{summary:{total,passed,failed}, results[], effectiveMemoryLimitMb}` —
the last being the cap actually enforced, after the language floor and the **384 MB** host ceiling.

> **A compile error is HTTP 200** — `{summary:{0,0,0}, results:[], compileError}`. **A checker that
> fails to compile is HTTP 200 with a separate top-level `checkerError`.** Never merge the two:
> `wmoj-app` synthesizes a user-facing `CE` from `compileError`, and a broken checker is a
> problem-configuration fault, not the student's. 4xx/5xx means the request or the judge is wrong,
> never the user's code. (`/generate-tests` is the deliberate opposite: a broken generator is 400.)

## Sandbox

**Deliberately weaker than a textbook sandbox**, stripped down to run unprivileged. Active: seccomp
BPF (`policy.kafel`), rlimits, a per-submission `0700` tmpdir, a 4-var env allowlist (`PATH`,
`LANG`, `LC_ALL`, `PYTHONUNBUFFERED`). Disabled: all seven namespaces, chroot, `--user`/`--group`,
cgroups. So every submission runs as **UID 1000 — the same UID as the Node process** — network is
blocked by **seccomp alone**, and cross-submission isolation does not hold. **Compilation is not
sandboxed at all**: `g++` is spawned directly, and only the *run* step goes through nsjail. Every
flag, rlimit and seccomp rule prevents one specific failure, and the known weaknesses are listed,
not fixed — don't rediscover them → **`sandbox-changes`**.

## Verdicts

`Verdict = AC | WA | TLE | MLE | RE | CE | IE`. **`gradeCase` in `src/verdict` is the only place a
verdict is decided; the sandbox reports measurements and nothing else** → `verdicts-and-comparison`.

- `IE` comes **only** from a custom checker that could not answer — never show a student `WA` for it.
- **`CE` is declared but never produced** — `wmoj-app` synthesizes it from `compileError`.
- **No early exit** — every case runs after a failure, serially, and TLE is decided on CPU time.
- Partial scoring, subtasks and interactive problems are unsupported; scoring lives in `wmoj-app`.

## Languages

`languages.json` is the source of truth; `src/languages` derives the rest: `python3`, `pypy3` (384 MB
floor), `cpp14/17/20/23`. Adding one → **`add-language`**. `/generate-tests` alone takes bare `cpp`.
**Never add Java or any JVM language while this is hosted on Render.** Tried and rolled back: the
host-wide per-UID task limit stops every jailed thread, so the JVM cannot boot — yet CI stays green.

## Concurrency & config

All in-process promise scheduling: a `/submit` semaphore, serial cases within a submission, and a
16-UID pool that is the true ceiling. Backpressure is **queue-never-reject** → `request-pipeline`.
`src/config.ts` is the env boundary — everything else imports the frozen `config`, `.env.example`
documents every variable, and **a malformed value throws at boot**. `AUTH_STRICT` is fail-open
outside production, CORS is `*` and the shared secret is the only gate, so **never call this service
from browser code**: `wmoj-app` calls it only from server-side route handlers, with
**`X-Judge-Token`** carrying a `JUDGE_SHARED_SECRET` that must be identical on both sides.

## Code conventions

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

---

## Maintenance

Keep this file current, and keep it at or under **150 lines**. AGENTS.md is updated in the same
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
