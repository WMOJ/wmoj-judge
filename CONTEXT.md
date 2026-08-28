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

## Machinery

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
