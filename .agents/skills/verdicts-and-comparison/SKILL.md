---
name: verdicts-and-comparison
description: Changes how wmoj-judge decides a verdict or compares output — the load-bearing TLE/MLE/RE/IE/WA ordering in deriveVerdict, the RLIMIT_AS rationale behind the three MLE rules and their clean-exit gating, the 0.98 MEM_LIMIT_RSS_RATIO shared across two files, and the exact semantics of all four comparators. Use whenever someone wants to change, debug, review, or extend a verdict, deriveVerdict, isMemoryLimitExceeded, an MLE or TLE rule, a comparator, compareMode, or src/compare/.
---

# Verdicts and output comparison in wmoj-judge

`deriveVerdict` in `src/routes/submit.ts` turns a `SandboxResult` plus a pass/fail into one of
`AC | WA | TLE | MLE | RE | IE`. The order of its checks encodes two bugs that have already been
fixed once each; changing the order reintroduces them.

`src/compare/` decides pass/fail when no custom checker is supplied. A checker replaces the
comparator entirely — see the `custom-checkers` skill.

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

`isMemoryLimitExceeded(sb, enforcedMemLimitMb)` is true when **any** of:

1. `sb.killedBy === "OOM"` — the sandbox already classified it: nsjail reported a memory limit
   **exceeded**, or `classifyKill` saw peak RSS at the cap.
2. `sb.memKb >= floor(enforcedMemLimitMb * 1024) * MEM_LIMIT_RSS_RATIO` — peak RSS at **≥ 98%** of
   the *enforced* cap. The 2% band exists because the kernel samples RSS at page granularity and a
   process being torn down rarely reports the round number exactly.
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
`src/sandbox/nsjail.ts`, used there by `classifyKill` step 7, and imported by `submit.ts` for MLE
rule 2. The sandbox and the verdict layer must agree on the threshold; changing it in one place only
is not possible, but changing its value shifts both at once — check both call sites.

The `enforcedMemLimitMb` passed in is the **clamped** value
(`min(requested, HOST_MEMORY_CEILING_MB)`), not what the client asked for. Comparing RSS against the
requested cap would make a 1024 MB request unable to ever produce `MLE` on a 512 MB host.

## `classifyKill` produces the input

`killedBy` is `"TO" | "OOM" | "SIG" | null`, decided in `src/sandbox/nsjail.ts` from nsjail's parsed
log. `TO` comes from the authoritative CPU-time gate; `OOM` from nsjail's own report or the RSS
check; `SIG` from any unexplained fatal signal. `deriveVerdict` reads it three times — for `TLE`, via
rule 1 of MLE, and for `RE`. If `parseNsjailStderr` stops matching nsjail's log format, `cpuMs` and
`memKb` silently become `0`, and both TLE and MLE rule 2 stop firing with no error. See the
`sandbox-changes` skill.

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
- Never compare RSS against the *requested* memory limit instead of the enforced one.
- Never change `MEM_LIMIT_RSS_RATIO` without checking both `nsjail.ts` and `submit.ts`.
- Never widen the allocation-failure regex, or drop the `\b` around `Killed`.
- Never make `CE` a produced verdict — compile failures are `compileError`/`checkerError`.
- Never add early exit on first failure; every case runs, and callers depend on a full `results[]`.
- Never add a `CompareMode` without adding it to `ALL_COMPARE_MODES`.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
changed verdict order, a new MLE signal, a different ratio, a comparator whose semantics shifted —
update it as part of your change. This skill is only useful while it is accurate.
