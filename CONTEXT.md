# wmoj-judge

The execution half of WMOJ: a stateless service that runs one submission at a time inside a
sandbox and returns a verdict per case in the same response. This file names the concepts the
code, comments and tests use; `AGENTS.md` explains the constraints.

## Judging

**Submission**: One student program plus the cases it is graded against — one `POST /submit`.
_Avoid_: job, request (when the grading is meant)

**Case**: One `(input, expected output)` pair.
_Avoid_: test (ambiguous with the test suite)

**Run**: One execution of a program inside the sandbox.
_Avoid_: execution, spawn

**Measurement**: The raw facts the sandbox reports about a run — exit status, signals, CPU, peak
RSS, wall, captured streams. Carries no verdict.
_Avoid_: result, SandboxResult

**Kill class**: What ended a run — `TO`, `OOM`, `SIG`, or none — decided by the ladder in the
verdict module from a measurement and the enforced limits. Internal to that module.
_Avoid_: killedBy (as a public field)

**Judgement**: Whether a run's output is acceptable, from a comparator or a checker.
_Avoid_: comparison result, checker result

**Verdict**: `AC | WA | TLE | MLE | RE | CE | IE`. `CE` is never produced by the judge; wmoj-app
synthesises it from `compileError`.
_Avoid_: status, outcome

**Judge fault**: The judge's own machinery failing — the sandbox could not run, or ran nothing of
the user's. HTTP 500, never a verdict.
_Avoid_: internal error (that is `IE`)

**Problem fault**: A problem-configuration failure — the checker will not compile (`checkerError`)
or could not answer (`IE`). Never the student's.

**Language spec**: Everything the judge knows about one language, derived from its `languages.json`
entry by `src/languages` — filename, compile line, artifacts, run line, memory floor.
_Avoid_: executor

**Memory floor**: The least memory a language is ever given (`memoryFloorMb`; PyPy's 384 MB),
applied as `max(requested, floor)`.
_Avoid_: language default

**Host ceiling**: `HOST_MEMORY_CEILING_MB` (384) — the most any submission is given on this box.

**Effective limit**: The cap actually enforced and reported: `max(1, floor(min(max(requested,
floor) || 256, ceiling)))`.

## Machinery

**Test-data budget**: The caps on how much test data one request may carry, and the one walk
(`src/budget`) that decides whether a body fits — `/submit` 413s on it and `/generate-tests` 400s on
it, from the same answer.
_Avoid_: request caps (for the decision; `requestCaps` is only the middleware)

**Workspace**: The leased per-submission directory plus its pool UID and in-flight bracket, held
for exactly the duration of `withWorkspace`'s callback (`src/workspace`). Teardown begins the
instant the callback settles.
_Avoid_: workdir (for the lease; `createWorkdir` is only the directory)

**Artifact**: A file a compile step produces and the compile cache stores, named by the language
spec (`a.out`). Nothing else in a workspace ever enters the cache.

**Drain**: The 25 s window after `SIGTERM` in which routes 503 and in-flight work finishes.

**Liveness**: Whether the judge can grade correctly right now — one list of checks in
`src/liveness`, asserted at boot and served by `/health` on two cadences.
_Avoid_: health check (for the module), probe (for the whole)

## Verification

**Golden transcript**: A recorded `/submit` or `/generate-tests` exchange, replayed against a live
container (`test/fixtures/e2e`).
_Avoid_: snapshot

**Measurement fixture**: A recorded measurement plus the `TestResult` it must grade to, replayed
in-process (`test/fixtures/measurements`). A *derived* one is computed from a captured one by
`test/tools/deriveMeasurements.ts` for a branch no program on this host can reach.
