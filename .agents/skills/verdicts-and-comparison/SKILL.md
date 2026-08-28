---
name: verdicts-and-comparison
description: Changes how wmoj-judge decides a verdict or compares output — gradeCase in src/verdict as the only place a verdict is decided, the load-bearing TLE/MLE/RE/IE/WA ordering and the 9-step kill ladder behind it, why a RunOutcome ok:false throws a 500 instead of ever being graded, the RLIMIT_AS rationale behind the two MLE rules and their clean-exit gating, how effectiveMemLimitMb is actually computed, the single MEM_LIMIT_RSS_RATIO, the measurement fixtures the ladder is tested from, and the exact semantics of all four comparators. Use whenever someone wants to change, debug, review, or extend a verdict, gradeCase, the kill ladder, an MLE or TLE rule, a measurement fixture, effectiveMemoryLimitMb, a comparator, compareMode, or src/compare/.
---

# Verdicts and output comparison in wmoj-judge

**`gradeCase` in `src/verdict/index.ts` is the only place a verdict is decided.** It takes a
`RunMeasurement` — the raw facts about one run — plus the limits the route enforced, and returns the
`TestResult`. Every threshold, every ordering, and every "was it a timeout" question is inside it.

The sandbox measures and says nothing about what the numbers mean. `runSandboxed` used to classify a
`killedBy` of its own, `submit.ts` re-derived the memory rules from the same numbers, and the 0.98
RSS ratio was declared in one file and imported by the other. That is all one module now, over plain
data, with no kernel and no `config` involved — which is what lets the whole ladder be replayed from
JSON.

`src/compare/` decides pass/fail when no custom checker is supplied. A checker replaces the
comparator entirely — see the `custom-checkers` skill.

## The interface

```ts
gradeCase({ index, expected, run, limits }, judge): Promise<TestResult>

interface CaseLimits { timeLimitMs: number; memLimitMb: number }   // already clamped
type Judge = (received: string) => Promise<Judgement>
type Judgement =
  | { passed: boolean; checkerMessage?: string }
  | { checkerFailed: true; checkerMessage?: string }
```

Two things about `judge` are load-bearing:

- **It is invoked only when the run finished cleanly** — `exitCode === 0` and no kill class. A
  crashed or timed-out program never reaches a comparator or a checker. Unchanged from before
  checkers existed.
- **A judge that throws rejects `gradeCase`.** That is the checker-sandbox judge-fault path: the
  per-case task lets it propagate to the route's `catch` and it becomes a 500. Catching it inside
  the judge and returning `checkerFailed` would turn the judge's own machinery breaking into `IE`,
  a problem-configuration fault billed to a problem that is fine.

`judgeCase` (`src/judge/judgeCase.ts`) builds the judge per case: `compare(compareMode, expected, received)` with no checker,
or `runChecker(...)` with one. `captureMeasurements` uses a `trim-trailing` judge.

## A judge fault is never a verdict

`runSandboxed` returns `RunOutcome`:

```ts
type RunOutcome = { ok: true; run: RunMeasurement } | { ok: false; sandboxError: string }
```

`ok: false` — this was an optional `sandboxError` field on the old `SandboxResult` — means the
**judge's own** machinery failed: nsjail or the jail runner could not be spawned, nsjail bailed
before executing anything (an unreadable or uncompilable `--seccomp_policy`, a missing `--cwd`), the
run exceeded its absolute deadline, or no resource report survived. Nothing of the user's code ran,
so there is nothing to grade. The caller **throws**, the route's `catch` returns `500 {error}`, and
no `results[]` is produced at all.

Do **not** grade it, and do **not** reuse `IE`, which is documented as checker-only. This is not
hypothetical: with an uncompilable `policy.kafel`, nsjail exits 255 with its diagnostic on fd 3, so
the child's stdout and stderr are both empty, `exitCode !== 0` held, and **every test case of every
submission came back `RE` on a clean HTTP 200** while `/health` still reported `ok`.

The union exists because the optional field was ignorable, and `/health` ignored it — a launch that
exits 0 with no resource report looks healthy on every other field. Behind `ok` there is no way to
reach `run` without having looked. `runChecker` carries the same shape back as `CheckerRun` for the
same reason.

## The verdict order is load-bearing

```
TLE → MLE → RE → IE → WA/AC
```

```ts
if (killClass === "TO") return "TLE";
if (isMemoryLimitExceeded(run, killClass)) return "MLE";
if (run.exitCode !== 0 || killClass === "SIG") return "RE";
if (checkerFailed) return "IE";
return passed ? "AC" : "WA";
```

**MLE must be tested before the `exitCode !== 0` branch.** Memory limits are enforced with
`--rlimit_as`, which caps **virtual address space, not resident memory**. Hitting it does not
trigger a kill: `malloc`/`new` simply *fail*, the program throws or aborts, and it exits non-zero all
by itself — which is indistinguishable from a runtime error unless you read its stderr first. Peak
RSS cannot rescue the classification either, because RSS stays *below* the cap precisely because the
allocation was refused. Move the `exitCode` check up and every out-of-memory submission is labelled
`RE` again.

`IE` sits after the program's own failures because those are more specific: a checker that could not
answer is a problem-configuration fault, but a case that TLE'd never reached the checker anyway.

`CE` exists in the `Verdict` union and is **never produced**. Compile failures leave the route early
as `compileError` / `checkerError` on an HTTP 200, and `wmoj-app` synthesizes its own `CE`.

## The kill ladder, in order

`KillClass` is `"TO" | "OOM" | "SIG" | null`, decided by `classifyKill(run, limits)` — **internal to
the verdict module**. It is not on `TestResult` and not on `RunMeasurement`; it is an intermediate,
and `timedOut` is the only part of it the API exposes. The ladder short-circuits top to bottom:

1. `run.nodeTimerFired` → `TO` (the judge's last-resort SIGKILL; a stuck nsjail or kernel)
2. `run.cpuMs >= timeLimitMs` → `TO` — **the authoritative gate**
3. clean exit (`exitCode === 0`, `runnerSignal === null`) → `null`
4. jail wall `>= 3 * timeLimitMs` → `TO` (blocked on syscalls without burning CPU)
5. `run.maxRssKb >= memLimitMb * 1024 * MEM_LIMIT_RSS_RATIO` → `OOM`
6. `decodeJailExit(run.exitCode)` is `signalled`: SIGXCPU (24) → `TO`; SIGKILL (9) with the jail wall
   already past the budget → `TO`; anything else → `SIG`
7. `run.runnerSignal !== null` → `SIG`
8. `decodeJailExit` is `none` (`exitCode === null`) → `SIG`
9. otherwise → `null`

**Step 3 sits after step 2** so a program that finished but overspent its budget stays a TLE.
**Step 5 sits after step 3** so a solution that used its whole memory budget and exited cleanly stays
an AC. Both are bugs that have already been fixed once; reordering either brings one back, and
`test/unit/verdict.test.ts` has a named case per step for exactly that.

Step 6 is why the ladder decodes at all. In `--mode o` nsjail's own exit status **is** the jailed
child's fate — the child's code, or `128 + WTERMSIG`, or 255 when it could not `execve` — while
Node's `runnerSignal` describes what killed *nsjail*, which is `null` in every one of those cases.
Any code that infers "the child was killed" from `runnerSignal` alone is wrong. `decodeJailExit` in
`src/sandbox/exitStatus.ts` is the single decoder; `classifyCheckerResult` uses it too, and adds a
*policy* on top (below).

Note what step 6's SIGKILL arm carries in practice: nsjail sets `RLIMIT_CPU` with soft equal to hard,
and Linux delivers **SIGKILL, not SIGXCPU**, when both are reached at once. So a real CPU timeout
arrives as exit **137** over budget, not 152. The SIGXCPU arm is kept and is exercised by a derived
fixture.

Steps 1 and 2 read fields that can be **absent**. `cpuMs`, `maxRssKb` and `jailWallMs` are omitted —
not zeroed — when no resource report survived, which happens exactly when the judge force-killed the
process group (the runner is in that group and dies with it). `cpuMs: 0` and "we never measured
cpuMs" are different facts; collapsing them is how the nsjail-3.3 accounting regression stayed
invisible for the life of the pin. Step 1 decides those runs without needing a number.

## The two MLE rules

`isMemoryLimitExceeded(run, killClass)` is true when **either**:

1. `killClass === "OOM"` — the ladder's step 5 saw peak RSS at the cap;
2. the run did **not** finish cleanly **and** `run.stderr` matches
   `/std::bad_alloc|bad_array_new_length|Cannot allocate memory|MemoryError|\bKilled\b/` — the
   `RLIMIT_AS` case, where the allocation was refused rather than the process killed.

**There used to be a third rule** — "peak RSS at ≥ 98% of the enforced cap" — sitting between them,
and it is gone. It was evaluated only on a non-clean run, which is exactly the condition under which
the ladder had already run its own RSS step against the same number and the same ratio: every case
it could have matched arrives already carrying `OOM`, and every case where the ladder returned `TO`
first is a TLE before memory is consulted. `submit.ts` already described it as a duplicate. Deleting
it changes no verdict — the goldens and the measurement fixtures say so — and removes the second copy
of the ratio that let the two drift.

**Rule 2 is gated on the run not having finished cleanly:**

```ts
if (killClass === "OOM") return true;
if (run.exitCode === 0 && killClass === null) return false;   // ← the gate
```

A program that `exit(0)`'d fit inside its budget by definition, however close to the ceiling it got,
and must never be downgraded from `AC`. Remove that line and every tight-but-correct solution starts
failing with `MLE` — including one that merely *prints* the word `MemoryError`.

`\bKilled\b` is the fragile part: a word-boundary match against arbitrary user stderr, so a program
that legitimately prints "Killed" and then exits non-zero is misreported as `MLE`. It is a deliberate
trade — the OOM killer's message is the only signal available in that case — but do not widen the
pattern and do not drop the word boundary.

A plain `SIGSEGV` from a null-pointer bug has low RSS and no allocation signature, so it correctly
stays `RE`. That is the behaviour any change here must preserve.

**`MEM_LIMIT_RSS_RATIO` (0.98) is now declared exactly once**, unexported, in `src/verdict/index.ts`,
and used by step 5 alone. The 2% band exists because the kernel samples RSS at page granularity and a
process being torn down rarely reports the round number exactly; `maxRssKb` is the peak of the whole
**jail tree**, nsjail's own few MB included, so it can only ever over-report.

**Maturity.** `maxRssKb` was `0` on every run for the entire life of the nsjail 3.3 pin — the old
code scraped it out of a log line nsjail 3.3 does not emit. All 3,457 stored test cases carry
`cpuMs: 0` and `memKb: 0`, only ever `AC`/`WA`, with 94 real timeouts recorded as `WA`. Rule 1 reads
real `ru_maxrss` now and will fire for the first time: treat it as unproven code. How often it *can*
fire is also open: RSS cannot exceed the address space `--rlimit_as` caps, and the ~4 MB of library
pages that are mapped but never touched is nearly the whole 2% band at a 256 MB cap, so a program
that fills its space may still land under the threshold and be graded by rule 2 instead. The
`rss-over-cap` fixture pins step 5 at a 1024 MB cap for exactly that reason.

## What `limits.memLimitMb` actually is

`effectiveMemLimitMb(requestedMb, ceilingMb)` in `submit.ts` computes it. It is a **pure function**
and the ceiling is a parameter: clamping is the route's job (the verdict module imports nothing from
`config` and never learns that a ceiling exists). The route calls it with
`config.HOST_MEMORY_CEILING_MB`, hands the result to the sandbox and to `gradeCase`, and reports it
back as `effectiveMemoryLimitMb`:

```
max( 1, floor( min( max(payload.memoryLimit ?? 0, languages.json memoryFloorMb ?? 0) || 256,
                    HOST_MEMORY_CEILING_MB ) ) )
```

Three things are load-bearing about that expression:

- **`max`, not `??`, for the language floor.** `wmoj-app` sends `problem.memory_limit || 256` and
  `judge.sh` takes `memLimitMb` positionally, so `payload.memoryLimit` is never `undefined` in
  production and a `??` chain short-circuits on its first term. That made `pypy3`'s 384 MB entry dead
  for every real request: PyPy's baseline RSS is ~60 MB against CPython's ~14 MB, so a PyPy solution
  that fits comfortably in 256 MB of *user* data hit `--rlimit_as 256`, raised `MemoryError`, matched
  rule 2, and was graded `MLE` while the CPython equivalent passed.
- **`floor`.** The sandbox applies `Math.max(1, Math.floor(memLimitMb))`, so without it a
  `memoryLimit` of 300.75 was advertised as the enforced cap while 300 MB was enforced, and the RSS
  threshold was computed against a cap that never existed.
- **The clamp is to the *enforced* cap, not the requested one.** Comparing RSS against a 1024 MB
  request would make `MLE` unreachable on a 512 MB host.

## The checker's ≥ 128 policy

`classifyCheckerResult(run: RunMeasurement)` uses the same `decodeJailExit`, and adds one rule on top
that is **a policy, not a second decoder**: an `exited` code at or above 128 is `internal-error`,
because 128-and-up are reserved for the `128 + WTERMSIG` encoding and nsjail's own 255, so a checker
cannot legitimately choose one. Without it a checker that segfaulted (139), aborted (134) or could
not be exec'd (255) fell through to `default: rejected`, the whole problem graded `WA`, and — with an
empty checker stderr — there was no `checkerMessage` either. The problem looked healthy; the student
looked wrong.

The kill ladder is deliberately **not** consulted for a checker: it applies the *submission's*
limits, which are not the checker's. Every way a checker is actually killed still lands on
`internal-error` — `RLIMIT_CPU` and `RLIMIT_AS` both end in a signal, the judge's last-resort kill
sets `nodeTimerFired`, a signalled runner sets `runnerSignal`.

## `TestResult.truncated`

`RunMeasurement.truncated` is copied onto `TestResult.truncated` by `gradeCase`, and the key is
**omitted** when nothing was dropped so ordinary responses stay byte-identical. It means
`stdout`/`stderr`/`received` are a *prefix*: the sandbox drains and discards past 1 MiB of stdout and
64 KiB of stderr instead of accumulating an unbounded `for(;;) puts("x")` in the Node heap of a
512 MB container. It does not change the verdict — the cap sits above the largest expected output
`requestCaps` accepts, so a truncated run could not have been `AC` — it exists so a `WA` whose
`received` disagrees with what the program printed is explainable. `checkerMessage` is omitted the
same way when the checker said nothing.

## The four comparators

Used only when no `checker` is supplied. `compare(mode, expected, received)` dispatches with a
`never`-guarded switch, so a new `CompareMode` without a `case` is a build error.

| Mode | Semantics |
|---|---|
| `exact` | `expected === received`. Byte for byte, newlines included |
| **`trim-trailing`** (default) | split on `\n`, right-trim each line (`[\s﻿\xA0]+$`), drop trailing empty lines from both sides, compare the line arrays. **Leading and interior whitespace stay significant** |
| `whitespace` | collapse every whitespace run to one space, trim both ends, compare. Legacy opt-in, not the default |
| `float-epsilon` | tokenize on whitespace runs; token counts must match. When **both** tokens parse as finite numbers, accept if `\|a-b\| <= max(EPS, EPS*max(\|a\|,\|b\|))` with `EPS = 1e-6`; otherwise the tokens must be byte-equal |

`float-epsilon`'s tolerance is **hybrid absolute-and-relative and not configurable per request** —
there is no epsilon field in `SubmitRequest`. A problem that needs a different tolerance needs a
custom checker, not a new mode.

`trim-trailing` is the competitive-programming standard and the default whenever `compareMode` is
absent. Note that `wmoj-app` never sends `compareMode` at all, so in practice every WMOJ submission
runs `trim-trailing` and the other three modes are unreachable through the product — see
`judge-app-contract` before assuming a mode change has any user-visible effect.

Comparators must stay **linear**. The trailing-whitespace regex was once quadratic, and one ordinary
`printf("%1000000d")` blocked the event loop for ~26 minutes.

## Adding a comparison mode

Four steps, and one of them the compiler does not check:

1. Add the ID to `CompareMode` in `src/types.ts`.
2. Add `src/compare/<mode>.ts` exporting a `(expected, received) => boolean`.
3. Add the `case` in `src/compare/index.ts` — **compile-enforced** by the `never` guard.
4. Add the ID to **`ALL_COMPARE_MODES` in `src/routes/submit.ts` — NOT compile-checked.** Forget it
   and `tsc` is clean while every request using the new mode 400s.

## The measurement fixtures

`test/fixtures/measurements/*.json` is what the ladder is tested from, and every one of them is a
real run recorded from a real kernel. Each carries `{name, intended, note, requires, limits,
expected, outcome, result}`: the `RunOutcome` a program produced and the `TestResult` `gradeCase`
graded it to. `test/unit/verdict.test.ts` replays every file through `gradeCase` and deep-equals
`result` (minus `timeMs`/`cpuMs`/`memKb`, which no two runs agree on), then builds its
step-by-step ladder cases by loading a named fixture and changing **one** field.

`test/fixtures/measurements/derived/*.json` are produced by `test/tools/deriveMeasurements.ts` from
a captured one, by a transformation written into the file (`derivedFrom`, `transformation`), for the
branches no program can reach on this host: SIGXCPU with no report, a SIGKILL inside and over budget,
a SIGSYS that `policy.kafel` cannot actually produce (its `DEFAULT` is `ERRNO`, not `KILL`), a
signalled runner, 99% RSS on a clean exit. They are replayed exactly like the captured ones. After a
recapture, re-run the tool; CI's `unit` job runs it with `--check` and fails when the committed files
are not what it produces, so a derived fixture cannot be edited by hand.

**To add a fixture**, add a scenario to `SCENARIOS` in `src/tools/captureMeasurements.ts` — name,
`intended` verdict, `note`, `requires`, the C++ source or argv, the expected output and the limits —
then capture it *inside the image*, because that is where nsjail is:

```bash
docker build --platform=linux/amd64 -t wmoj-judge:dev .
docker run --rm -e LOG_LEVEL=silent -e JUDGE_SHARED_SECRET=x \
  --entrypoint node wmoj-judge:dev dist/tools/captureMeasurements.js > fresh.json
```

The tool **asserts each scenario's intended verdict** and exits 1 naming any that differ, so a
scenario whose program does not do what its author thought fails at capture time rather than
becoming a fixture that pins the wrong answer. It refuses to run unless `LOG_LEVEL=silent`: pino
writes to stdout and the JSON array must be the only thing there.

On an emulated arm64 host (`seccomp: "disabled"`) scenarios tagged `rlimit_as`, `seccomp` or `native`
are captured but **not** asserted, and are named on stderr as unverified — `RLIMIT_AS` is not
enforced, no filter is installed, and QEMU writes its own diagnostics into the guest's stderr. The
x86_64 CI runner asserts all of them, and **the committed fixtures come from there**, never from a
laptop.

CI re-captures and diffs on every change under `Dockerfile`, `policy.kafel`, `src/sandbox/**`,
`src/verdict/**`, `src/tools/**` or the fixtures themselves, and nightly:

```bash
npx tsx test/tools/diffMeasurements.ts fresh.json test/fixtures/measurements
```

That compares only what a correct judge reproduces on any host — `ok`, the run's `exitCode`,
`runnerSignal`, `nodeTimerFired`, `stdout`, `stderr`, `truncated`, the **presence** of `cpuMs`, and
every field of `result` except the three measured numbers — plus missing and extra scenarios in both
directions. `derived/` is not compared; a capture cannot produce it. A fixture is only as true as its
last capture, and the log scraper that matched nothing did so for the life of the pin with a green
suite the whole time.

## Never

- Never reorder the verdict checks, and never move the `exitCode !== 0` branch above MLE.
- Never reorder the kill ladder — in particular never move step 3 above step 2, or step 5 above
  step 3.
- Never remove the clean-exit gate in `isMemoryLimitExceeded` — it is what keeps tight-but-correct
  solutions at `AC`.
- Never grade an `ok: false` `RunOutcome`, and never map one onto `IE`. It throws and becomes a 500.
- Never read `run.cpuMs ?? 0` inside a ladder step. Absent means "never measured", and treating it as
  zero silently disables the gate that reads it.
- Never compare RSS against the *requested* memory limit instead of the enforced one, and never drop
  the `floor` or the language-floor `max` from `effectiveMemLimitMb`.
- Never let `src/verdict` import `config`. Limits arrive as parameters; that is what makes the module
  replayable from a file.
- Never infer "the child was killed" from `run.runnerSignal` — in `--mode o` it describes nsjail, not
  the jailed process. Decode the exit status with `decodeJailExit`.
- Never call the judge on a run that did not finish cleanly, and never catch a judge's throw inside
  `gradeCase`.
- Never let a per-case task reject. They resolve a discriminated `CaseOutcome`, `judgeAllCases`
  `allSettled`s **all** of them, and only then decides between a 200 and a throw. `Promise.all`'s
  first-rejection behaviour tore down the workdir and released the UID while up to 199 queued tasks
  were still spawning nsjail against that deleted directory under a reissued UID, outside the
  semaphore and with `inFlight` already back at 0. A judge fault still aborts the whole submission —
  it just cannot do it while siblings are live.
- Never re-introduce a second copy of `MEM_LIMIT_RSS_RATIO`.
- Never widen the allocation-failure regex, or drop the `\b` around `Killed`.
- Never make `CE` a produced verdict — compile failures are `compileError`/`checkerError`.
- Never add early exit on first failure; every case runs, and callers depend on a full `results[]`.
- Never add a `CompareMode` without adding it to `ALL_COMPARE_MODES`.
- Never commit a measurement fixture captured on an arm64 laptop.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
changed verdict order, a new ladder step, a different ratio, a comparator whose semantics shifted, a
fixture convention that moved — update it as part of your change. This skill is only useful while it
is accurate.
