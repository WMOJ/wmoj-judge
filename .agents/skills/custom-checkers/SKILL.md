---
name: custom-checkers
description: Works on wmoj-judge's custom-checker path for problems whose answer is not unique — the hardcoded g++ compile line and why it bypasses Executor.compile(), the once-per-submission compile ordering the compile cache depends on, the per-case three-file invocation and its limits, the testlib exit-code table and its IE cases, and the checkerMessage truncation rules. Use whenever someone wants to write, debug, change, review, or extend a checker, the checker field of POST /submit, src/checker/, checkerError, or IE verdicts.
---

# Custom checkers in wmoj-judge

A checker grades problems whose answer is not unique ("print any valid arrangement"). It is C++
source sent in the `checker` field of `POST /submit`, compiled once and run once per test case. When
a checker is supplied it **replaces `compareMode` entirely** — the byte comparison never runs.

Backwards compatibility is mandatory: absent, `null`, or blank all mean "no checker", i.e. exactly
the pre-checker byte comparison. Every live problem today ships without one and none of them may
change behaviour.

## How a checker runs

**1. Compiled once per submission, never per case**, with a hardcoded invocation:

```
/usr/bin/g++ -O2 -std=gnu++17 Checker.cpp -o checker.out
```

This is deliberately **not** routed through `Executor.compile()`. That interface takes only a
workdir and builds the single hardcoded `Main.cpp` from `languages.json`, so it cannot compile a
second file at all. Like the generator's, this compile runs **outside nsjail** — problem-setter
source is the same trust boundary `/generate-tests` already assumed — but with a scrubbed child env.

**2. Compiled AFTER the compile cache has been populated. This ordering is load-bearing.** The cache
stores the *whole workdir* keyed on `sha256(language ‖ code ‖ compileArgv)`. A `checker.out` sitting
in the workdir at `put()` time would be handed to a different problem whose contestant happened to
submit the same source, and that problem would then be graded by the wrong checker. A natural-looking
"compile everything up front" refactor breaks this silently. Compiling here also means the g++ run is
skipped entirely when the user's own code failed to compile.

**3. Invoked per case** as `./checker.out <input> <expected> <received>` — three real files written
into the workdir, passed **relative** to it because nsjail sets it as cwd. The scratch files are
removed after each case: 200 cases × 3 files × up to 1 MB would not fit on a 512 MB host.

**4. Run through the same `runSandboxed` path as submissions** — a buggy checker must not hang or
escape the judge — with its own generous limits: **10 s CPU, 256 MB**. They exist only so a broken
checker cannot wedge the judge, not to constrain it.

**5. Only when the contestant's program finished cleanly.** A TLE, MLE, or RE case never reaches the
checker at all, because a case can only pass when `exitCode === 0 && killedBy === null`.

## Exit codes

The testlib/DMOJ convention, mapped by `classifyCheckerResult`:

| Exit | Meaning | Outcome | Verdict |
|---|---|---|---|
| `0` | accepted | `accepted` | the case passes |
| `1` | wrong answer | `rejected` | `WA` |
| `2` | presentation error | `rejected` | `WA` — WMOJ has no PE verdict |
| `3` | checker internal error | `internal-error` | **`IE`** |
| any other non-zero | — | `rejected` | `WA` |
| killed (TLE/OOM/signal) or never ran | — | `internal-error` | **`IE`** |

`IE` is the only verdict a checker can produce that is not about the submission. It means *your*
problem or test data is broken, and it is never folded into WA — a broken checker must be visible,
not blamed on the student. An `IE` case still counts as failed in `summary`.

**The checker's stdout is completely ignored.** This is an exit-code-only protocol, not the full
testlib result-file protocol. Do not write a result file and do not expect one to be read.

**stderr is the message channel.** It is trimmed, truncated to **1024 UTF-8 bytes** on a byte
boundary (partial multi-byte sequences dropped, `"… (truncated)"` appended), and returned per case as
`TestResult.checkerMessage`. The key is **omitted entirely** when there is no checker or it said
nothing, so no-checker responses stay byte-identical to what they were before checkers existed. Say
*why* an answer was rejected there — students see it.

## A checker that fails to compile

HTTP **200** with a top-level `checkerError`, exactly parallel to `compileError`:

```json
{ "summary": {"total":0,"passed":0,"failed":0}, "results": [],
  "effectiveMemoryLimitMb": 256, "checkerError": "…g++ diagnostics…" }
```

**Never reuse `compileError` for this.** `wmoj-app` synthesizes a user-facing `CE` from that field,
and a broken checker is a problem-configuration fault, not the student's. Merging the two makes a
misconfigured problem look like every submitter's own compile error.

## Writing and testing one

`examples/checkers/any-valid-pair.cpp` is a working reference checker; its header comment is the
short version of this file. `examples/checkers/fixtures/` holds eight files covering one case per
exit code (`pair.accept.out`, `pair.reject.out`, `pair.presentation.out`,
`impossible.badjury.out`, plus their `.in`/`.expected`).

**There is no runner script.** The fixtures are invoked by hand:

```bash
g++ -O2 -std=gnu++17 examples/checkers/any-valid-pair.cpp -o /tmp/checker.out
cd examples/checkers/fixtures && /tmp/checker.out pair.in pair.expected pair.accept.out; echo $?
```

End-to-end, test through the live judge with the `checker` field populated, and prove **both** halves:
a genuinely wrong answer is rejected, **and** a correct-but-byte-different answer scores 100%. The
second is the entire reason the checker exists and the easy one to skip.

## The `checker.out` overwrite hazard

The contestant's program runs as the same UID with write access to the same workdir, and
`PER_SUBMISSION_CONCURRENCY = 1` means `checker.out` is never running while the submission is. So on
test case 0 a submission can read `Checker.cpp` to leak the validation logic, and replace
`checker.out` with something that exits 0 — making every subsequent case AC. Assume the checker
source is public and never put a secret in it. Do not "fix" this by loosening anything in the
sandbox; see the `sandbox-changes` skill for why `/app` and the workdir are writable at all.

## Never

- Never route the checker compile through `Executor.compile()` — it can only build `Main.cpp`.
- Never compile the checker before the compile cache `put()`, and never cache a workdir containing
  `checker.out`.
- Never merge `checkerError` into `compileError`, and never return 4xx for either.
- Never read the checker's stdout, or add a result-file protocol without changing both repos.
- Never let a checker's `IE` be reported as `WA` — a broken problem must stay visible.
- Never assume a checker gets a case that TLE'd, MLE'd, or crashed; it does not.
- Never put anything secret in checker source — a submission can read it.
- Never expect partial scores. The judge has no such verdict; all scoring lives in `wmoj-app`.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
changed exit-code mapping, a new truncation limit, a moved compile step, a fixture that no longer
matches — update it as part of your change. This skill is only useful while it is accurate.
