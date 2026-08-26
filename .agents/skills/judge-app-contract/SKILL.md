---
name: judge-app-contract
description: Changes the HTTP contract between wmoj-judge and its only client wmoj-app — the exact /submit and /generate-tests schemas including every TestResult field, the four call sites in wmoj-app plus the CLI client that hardcodes the caps, the deploy ordering, and the drift that already exists between the repos. Use whenever someone wants to add, rename, remove, or change a request field, a response field, a verdict string, an env-var name, an endpoint, or anything both repos must agree on.
---

# The wmoj-judge ↔ wmoj-app contract

`wmoj-judge` has exactly one client. Every field below is a cross-repo interface: changing it without
changing `wmoj-app` in the same window breaks production, and `wmoj-app` stores judge responses as
`jsonb` forever, so old shapes have to keep parsing.

Verdict strings, field names, and HTTP status codes are all part of the contract. The status codes
are the part people get wrong — see the compile-error rule below.

## `POST /submit`

Request:

```ts
{
  language: "python3"|"pypy3"|"cpp14"|"cpp17"|"cpp20"|"cpp23"|"python"|"cpp",
  code: string,
  input: string[],           // equal length
  output: string[],          // equal length
  timeLimit?: number,        // ms, default 5000, no upper bound
  memoryLimit?: number,      // MB, default = language default ?? 256
  compareMode?: "exact"|"trim-trailing"|"whitespace"|"float-epsilon",
  checker?: string           // C++ source; absent/null/blank ⇒ byte comparison
}
```

Response, HTTP **200**:

```ts
{
  summary: { total: number, passed: number, failed: number },
  results: TestResult[],
  effectiveMemoryLimitMb: number,   // present on EVERY 200
  compileError?: string,            // user's code failed to compile
  checkerError?: string             // the problem's checker failed to compile
}
```

`TestResult`, every field, always present except the last:

| Field | Type | Notes |
|---|---|---|
| `index` | `number` | 0-based; `results` is sorted by it |
| `exitCode` | `number \| null` | `null` when the sandbox never got a code |
| `passed` | `boolean` | `exitCode === 0 && killedBy === null` **and** checker accepted / `compare` matched |
| `expected` | `string` | echoed from the request |
| `received` | `string` | same value as `stdout` |
| `stderr` | `string` | the child's real stderr, byte-clean |
| `stdout` | `string` | |
| `timedOut` | `boolean` | `killedBy === "TO"` |
| `verdict` | `"AC"\|"WA"\|"TLE"\|"MLE"\|"RE"\|"CE"\|"IE"` | `CE` is declared and never produced |
| `timeMs` | `number` | wall, from nsjail; `0` if the log did not parse |
| `cpuMs` | `number` | the TLE-authoritative measure; `0` if the log did not parse |
| `memKb` | `number` | peak RSS; `0` if the log did not parse |
| `checkerMessage` | `string?` | **key omitted entirely** when there is no checker or it said nothing |

**A compile error is HTTP 200**, with `{summary:{0,0,0}, results:[], effectiveMemoryLimitMb,
compileError}`. **A checker compile error is HTTP 200** with a separate top-level `checkerError`.
Never merge them: `wmoj-app` synthesizes a user-facing `CE` from `compileError`, and a broken checker
is a problem-configuration fault that must never reach a student as their own compile error.
`wmoj-app` branches on `checkerError` **before** `compileError` and stores no submission row for it.

4xx/5xx means the request or the judge is wrong, never the user's code. `413` comes from
`requestCaps` with a `reason`; `401` from strict auth; `503` while draining.

## `POST /generate-tests`

`{code, language?}` → `{inputJson, outputJson, input: string[], output: string[]}`. The generator
prints a JSON array of inputs to **stdout** and expected outputs to **stderr**, equal length.
**A compile failure here is 400, not 200** — the opposite of `/submit`, and deliberate: a generator
is admin input, not a student's. `language` is validated (`cpp`/`cpp14`/`cpp17` only) and then
ignored; compilation is always `-O2 -std=gnu++17`.

## `GET /health`

Unauthenticated by design, for Render's probe. `200 {status:"ok", version}` or
`503 {status:"degraded", reason, version}`. `status` is what every caller reads; `version` is the
deployment marker (`RENDER_GIT_COMMIT`, else package version + process start time). Adding a field
here is safe; changing `status` is not.

## Auth and env

Header is **`X-Judge-Token`**, not `Authorization`. `JUDGE_SHARED_SECRET` must be byte-identical on
both sides — the compare is constant-time, and a length mismatch short-circuits before
`timingSafeEqual`. `AUTH_STRICT` must be `true` in production; it defaults to fail-open, letting a
**missing** token through, not just a wrong one. Renaming either variable is a cross-repo change plus
a Render dashboard change, in that order.

## The call sites in `wmoj-app`

| Path | Endpoint |
|---|---|
| `main/src/app/api/problems/[id]/submit/route.ts` | `POST /submit` |
| `main/src/app/api/admin/problems/generator/generate/route.ts` | `POST /generate-tests` |
| `main/src/app/api/manager/problems/generator/generate/route.ts` | `POST /generate-tests` |
| `main/src/app/api/status/health/route.ts` | `GET /health` |

**The two generator routes are byte-identical twins.** Changing one and not the other is the classic
miss in that repo — grep the twin path every time.

There is a fifth client outside the app: **`wmoj-app/.agents/skills/add-problem/scripts/judge.sh`**,
the CLI used to author problems. It hardcodes this judge's caps (`MAX_CASES=200`,
`MAX_BYTES_PER_CASE=1000000`, `MAX_CODE_BYTES=100000`) and branches on `compileError`, `checkerError`,
and `effectiveMemoryLimitMb`. **Changing a cap means editing that script too**, or every problem
authored through the skill is validated against stale numbers.

## Deploy ordering

- **Additive change** (a new optional request field, a new response field): deploy the **judge
  first**, then `wmoj-app`. The judge ignores fields it does not know and the app tolerates fields it
  does not read, so the intermediate state is safe in that direction only.
- **Breaking change** (renaming or removing a field, changing a status code, changing a verdict
  string): ship a **dual-accept release** first — the judge accepts both shapes — then move
  `wmoj-app`, then remove the old shape in a third release. Never do it in one step; a Render deploy
  restarts the service and can drop an in-flight `/submit`.
- **Stored submissions are historical `jsonb` in `wmoj-app`.** Never make an existing optional field
  required, and never repurpose a field name — old rows still carry the old meaning and are rendered
  by the same components.
- Do not push to `wmoj-judge` while a bulk problem import is running; the redeploy drops in-flight
  requests.

## Drift that already exists

Verified, and worth knowing before you "fix" something that looks unused:

- **`compareMode` is entirely unused by `wmoj-app`** — zero occurrences repo-wide. Every WMOJ
  submission therefore runs the default `trim-trailing`, and `exact`, `whitespace`, and
  `float-epsilon` are unreachable through the product. A change to those comparators has no
  user-visible effect until the app starts sending the field.
- **`effectiveMemoryLimitMb` is forwarded but never read** by any client except `judge.sh`.
- **`checkerMessage` is dropped in four of six submission views** — only `SubmitClient.tsx` and
  `SubmissionsClient.tsx` render it, so a checker's explanation is invisible in the staff views.
- The **verdict-string unions match `types.ts` exactly**; there is no drift there.

## Never

- Never return 4xx for a user compile error, and never merge `compileError` with `checkerError`.
- Never remove or rename a `TestResult` field, or make an existing optional field required — stored
  submissions still carry the old shape.
- Never change one generator route without changing its twin.
- Never change a size cap without updating `judge.sh` in `wmoj-app`.
- Never make a breaking change in a single release; dual-accept, migrate, then remove.
- Never rename `X-Judge-Token` or `JUDGE_SHARED_SECRET` without changing both repos and Render.
- Never assume a `compareMode` change is user-visible — the app does not send the field.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
new field, a moved call site, a cap that changed, drift that got fixed or got worse — update it as
part of your change, on both sides. This skill is only useful while it is accurate.
