---
name: verdicts-and-comparison
description: Changes how wmoj-judge decides a verdict or compares output — the load-bearing TLE/MLE/RE/IE/WA ordering in deriveVerdict, why a sandboxError throws a 500 instead of ever being graded, the RLIMIT_AS rationale behind the three MLE rules and their clean-exit gating, how effectiveMemLimitMb is actually computed, the 0.98 MEM_LIMIT_RSS_RATIO shared across two files, and the exact semantics of all four comparators. Use whenever someone wants to change, debug, review, or extend a verdict, deriveVerdict, isMemoryLimitExceeded, sandboxError, an MLE or TLE rule, effectiveMemoryLimitMb, a comparator, compareMode, or src/compare/.
---

# Verdicts and output comparison in wmoj-judge

`deriveVerdict` in `src/routes/submit.ts` turns a `SandboxResult` plus a pass/fail into one of
`AC | WA | TLE | MLE | RE | IE`. The order of its checks encodes two bugs that have already been
fixed once each; changing the order reintroduces them.

`src/compare/` decides pass/fail when no custom checker is supplied. A checker replaces the
comparator entirely — see the `custom-checkers` skill.

## A `sandboxError` is never a verdict

`SandboxResult.sandboxError` is set only when the **judge's own** machinery failed: nsjail or the
jail runner could not be spawned, nsjail bailed before executing anything (an unreadable or
uncompilable `--seccomp_policy`, a missing `--cwd`), or no resource report survived. Nothing of the
user's code ran, so there is nothing to grade. The per-case task in `submit.ts` **throws**, the
route's `catch` returns `500 {error}` — the documented "the judge is wrong" channel — and no
`results[]` is produced at all.

Do **not** grade it, and do **not** reuse `IE`, which is documented as checker-only. This is not
hypothetical: with an uncompilable `policy.kafel`, nsjail exits 255 with its diagnostic on fd 3, so
the child's stdout and stderr are both empty, `exitCode !== 0` holds, and **every test case of every
submission came back `RE` on a clean HTTP 200** while `/health` still reported `ok`. Students saw
"Runtime Error" on correct code and the status page said the judge was fine.

`runChecker` carries the same fault back as `CheckerVerdict.sandboxError` for the same reason: the
checker's sandbox failing is the judge breaking, not the problem being misconfigured.

## The verdict order is load-bearing

```
TLE → MLE → RE → IE → WA/AC
```

```ts
if (sb.killedBy === "TO") return "TLE";
if (isMemoryLimitExceeded(sb, enforcedMemLimitMb)) return "MLE";
if (sb.exitCode !== 0 || sb.killedBy === "SIG") return "RE";
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

## The three MLE rules

**These rules have never fired.** `sb.memKb` was `0` on every run for the entire life of the nsjail
3.3 pin — the old code scraped it out of nsjail's log and nsjail 3.3 emits no such line. All 3,457
stored test cases carry `cpuMs: 0` and `memKb: 0`, only ever `AC`/`WA`, with 94 real timeouts
recorded as `WA`. Rules 1 and 2 now read real `ru_maxrss` and will fire for the first time: treat
them as unproven code, not battle-tested code.

`isMemoryLimitExceeded(sb, enforcedMemLimitMb)` is true when **any** of:

1. `sb.killedBy === "OOM"` — `classifyKill` saw peak RSS at the cap. (Its other former source,
   "nsjail reported a memory limit exceeded", went away with the log scraper: nsjail 3.3 never
   emitted that phrase, so it had never fired either.)
2. `sb.memKb >= floor(enforcedMemLimitMb * 1024) * MEM_LIMIT_RSS_RATIO` — peak RSS at **≥ 98%** of
   the *enforced* cap. The 2% band exists because the kernel samples RSS at page granularity and a
   process being torn down rarely reports the round number exactly. `memKb` is the peak of the whole
   **jail tree**, nsjail's own few MB included, so it can only ever over-report; and this rule
   duplicates `classifyKill`'s own RSS step, so an over-cap run normally arrives already carrying
   `killedBy === "OOM"` and is caught by rule 1.
3. `sb.stderr` matches `/std::bad_alloc|bad_array_new_length|Cannot allocate memory|MemoryError|\bKilled\b/`
   — the `RLIMIT_AS` case, where the allocation was refused rather than the process killed.

**Rules 2 and 3 are gated on the run not having finished cleanly:**

```ts
if (sb.killedBy === "OOM") return true;
if (sb.exitCode === 0 && sb.killedBy === null) return false;   // ← the gate
```

A program that `exit(0)`'d fit inside its budget by definition, however close to the ceiling it got,
and must never be downgraded from `AC`. Remove that line and every tight-but-correct solution starts
failing with `MLE`.

Rule 3's `\bKilled\b` is the fragile one: it is a word-boundary match against arbitrary user stderr,
so a program that legitimately prints the word "Killed" and then exits non-zero is misreported as
`MLE`. It is a deliberate trade — the OOM killer's message is the only signal available in that case
— but do not widen the pattern, and do not drop the word boundary.

A plain `SIGSEGV` from a null-pointer bug has low RSS and no allocation signature, so it correctly
stays `RE`. That is the behaviour any change here must preserve.

**`MEM_LIMIT_RSS_RATIO` (0.98) is cross-file coupling.** It is declared and exported in
`src/sandbox/nsjail.ts`, used there by `classifyKill`'s peak-RSS step, and imported by `submit.ts`
for MLE rule 2. The sandbox and the verdict layer must agree on the threshold; changing it in one place only
is not possible, but changing its value shifts both at once — check both call sites.

## What `enforcedMemLimitMb` actually is

`effectiveMemLimitMb()` in `submit.ts` computes it, and it is the value handed to the sandbox, to
`isMemoryLimitExceeded`, and back to the client as `effectiveMemoryLimitMb`:

```
floor( min( max(payload.memoryLimit ?? 0, languages.json memoryLimitMb ?? 0) || 256,
            HOST_MEMORY_CEILING_MB ) )        // and at least 1
```

Three things are load-bearing about that expression:

- **`max`, not `??`, for the language floor.** `wmoj-app` sends `problem.memory_limit || 256` and
  `judge.sh` takes `memLimitMb` positionally, so `payload.memoryLimit` is never `undefined` in
  production and a `??` chain short-circuits on its first term. That made `pypy3`'s 384 MB entry dead
  for every real request: PyPy's baseline RSS is ~60 MB against CPython's ~14 MB, so a PyPy solution
  that fits comfortably in 256 MB of *user* data hit `--rlimit_as 256`, raised `MemoryError`, matched
  rule 3, and was graded `MLE` while the CPython equivalent passed.
- **`floor`.** The sandbox applies `Math.max(1, Math.floor(memLimitMb))`, so without it a
  `memoryLimit` of 300.75 was advertised as the enforced cap while 300 MB was enforced, and rule 2
  computed its threshold against a cap that never existed.
- **The clamp is to the *enforced* cap, not the requested one.** Comparing RSS against a 1024 MB
  request would make `MLE` unreachable on a 512 MB host.

## `classifyKill` produces the input

`killedBy` is `"TO" | "OOM" | "SIG" | null`, decided by `classifyKill` in `src/sandbox/nsjail.ts`
from **real measurements**, not from nsjail's log — the log scraper and its six regexes are gone, and
nsjail's fd-3 log is now diagnostic only. `TO` comes from the authoritative CPU-time gate
(`wait4()`'s `rusage`), from Node's last-resort timer, from the wall backstop, or from a decoded
SIGXCPU; `OOM` from the peak-RSS check; `SIG` from a decoded fatal signal or an unexplained one.

nsjail runs in `--mode o`, where **its own exit status is the child's fate**: the child's code, or
`128 + WTERMSIG` when a signal killed it, or 255 when it could not `execve` at all. Node's `signal`
argument describes what killed *nsjail*, which is `null` in every one of those cases — so any code
that infers "killed" from `signal` alone is wrong. `classifyKill` decodes the `128 + n` status; so
does `classifyCheckerResult`, independently, because a checker misclassified here is silently
mass-misgraded (see `custom-checkers`).

`deriveVerdict` reads `killedBy` three times — for `TLE`, via rule 1 of MLE, and for `RE`. If the
runner's report stops arriving, `cpuMs` and `memKb` fall back to `0` and both the TLE gate and MLE
rule 2 stop firing — but that case now sets `sandboxError` and becomes a 500 rather than a silent
mass-`RE`. See the `sandbox-changes` skill.

## `TestResult.truncated`

`SandboxResult.truncated` is copied onto `TestResult.truncated` by `buildResult`, and the key is
**omitted** when nothing was dropped so ordinary responses stay byte-identical. It means
`stdout`/`stderr`/`received` are a *prefix*: the sandbox drains and discards past 1 MiB of stdout and
64 KiB of stderr instead of accumulating an unbounded `for(;;) puts("x")` in the Node heap of a
512 MB container. It does not change the verdict — the cap sits above the largest expected output
`requestCaps` accepts, so a truncated run could not have been `AC` — it exists so a `WA` whose
`received` disagrees with what the program printed is explainable.

## The four comparators

Used only when no `checker` is supplied. `compare(mode, expected, received)` dispatches with a
`never`-guarded switch, so a new `CompareMode` without a `case` is a build error.

| Mode | Semantics |
|---|---|
| `exact` | `expected === received`. Byte for byte, newlines included |
| **`trim-trailing`** (default) | split on `\n`, right-trim each line (`[\s﻿\xA0]+$`), drop trailing empty lines from both sides, compare the line arrays. **Leading and interior whitespace stay significant** |
| `whitespace` | collapse every whitespace run to one space, trim both ends, compare. Legacy opt-in, not the default |
| `float-epsilon` | tokenize on whitespace runs; token counts must match. When **both** tokens parse as finite numbers, accept if `|a-b| <= max(EPS, EPS*max(|a|,|b|))` with `EPS = 1e-6`; otherwise the tokens must be byte-equal |

`float-epsilon`'s tolerance is **hybrid absolute-and-relative and not configurable per request** —
there is no epsilon field in `SubmitRequest`. A problem that needs a different tolerance needs a
custom checker, not a new mode.

`trim-trailing` is the competitive-programming standard and the default whenever `compareMode` is
absent. Note that `wmoj-app` never sends `compareMode` at all, so in practice every WMOJ submission
runs `trim-trailing` and the other three modes are unreachable through the product — see
`judge-app-contract` before assuming a mode change has any user-visible effect.

## Adding a comparison mode

Four steps, and one of them the compiler does not check:

1. Add the ID to `CompareMode` in `src/types.ts`.
2. Add `src/compare/<mode>.ts` exporting a `(expected, received) => boolean`.
3. Add the `case` in `src/compare/index.ts` — **compile-enforced** by the `never` guard.
4. Add the ID to **`ALL_COMPARE_MODES` in `src/routes/submit.ts` — NOT compile-checked.** Forget it
   and `tsc` is clean while every request using the new mode 400s.

## Never

- Never reorder `deriveVerdict`'s checks, and never move the `exitCode !== 0` branch above MLE.
- Never remove the clean-exit gate in `isMemoryLimitExceeded` — it is what keeps tight-but-correct
  solutions at `AC`.
- Never grade a `sandboxError`, and never map one onto `IE`. It throws and becomes a 500.
- Never compare RSS against the *requested* memory limit instead of the enforced one, and never drop
  the `floor` or the language-floor `max` from `effectiveMemLimitMb`.
- Never infer "the child was killed" from Node's `signal` — in `--mode o` it describes nsjail, not
  the jailed process.
- Never let a per-case task reject. They resolve a discriminated `CaseOutcome`, the route
  `allSettled`s **all** of them, and only then decides between a 200 and a throw. `Promise.all`'s
  first-rejection behaviour tore down the workdir and released the UID while up to 199 queued tasks
  were still spawning nsjail against that deleted directory under a reissued UID, outside the
  semaphore and with `inFlight` already back at 0. A judge fault still aborts the whole submission —
  it just cannot do it while siblings are live.
- Never change `MEM_LIMIT_RSS_RATIO` without checking both `nsjail.ts` and `submit.ts`.
- Never widen the allocation-failure regex, or drop the `\b` around `Killed`.
- Never make `CE` a produced verdict — compile failures are `compileError`/`checkerError`.
- Never add early exit on first failure; every case runs, and callers depend on a full `results[]`.
- Never add a `CompareMode` without adding it to `ALL_COMPARE_MODES`.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
changed verdict order, a new MLE signal, a different ratio, a comparator whose semantics shifted —
update it as part of your change. This skill is only useful while it is accurate.
