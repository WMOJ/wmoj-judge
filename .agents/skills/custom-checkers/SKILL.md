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
removed after each case (`fs.rm` with `recursive: true`, or a directory left behind is unremovable):
200 cases × 3 files × up to 1 MB would not fit on a 512 MB host.

Those filenames carry a per-call `nanoid`. They used to be derived only from the case index, and the
contestant's program runs at the same UID in the same workdir strictly *before* the next case's files
are written — so on case 0 it could `mkdir("checker-received-1.txt")` (`mkdir`/`chmod` are ALLOWed by
`policy.kafel`), `writeFile` failed `EISDIR` on case 1, and a contestant heading for `WA` could
reliably convert their own submission into an HTTP 500. Do not make the names predictable again.

Before spawning, `fs.access(checker.out, X_OK)` proves the binary is still there and runnable, so
"the checker never ran" is **detected** rather than inferred from an exit code — `unlink` is ALLOWed
too, so a submission can delete `checker.out` on case 0.

> ⚠️ **The exit codes are testlib's. The argument order is NOT.** Upstream `testlib.h` binds
> `argv[2]` to the **participant's** output and `argv[3]` to the **jury's** answer — the reverse of
> the order above. A checker lifted from a testlib problem therefore validates the jury's own answer,
> which is valid by construction, so it exits 0 on every case and **every submission to that problem
> silently scores 100%**. `checkerError` does not catch it (the checker compiles fine) and nothing in
> the response distinguishes it from an easy problem. Swap the two answer files when adapting one,
> and never describe the *argument order* as "the testlib convention".

**4. Run through the same `runSandboxed` path as submissions** — a buggy checker must not hang or
escape the judge — with its own generous limits: **10 s CPU, 256 MB**. They exist only so a broken
checker cannot wedge the judge, not to constrain it.

**5. Only when the contestant's program finished cleanly.** A TLE, MLE, or RE case never reaches the
checker at all, because a case can only pass when `exitCode === 0 && killedBy === null`.

## Exit codes

The testlib/DMOJ **exit-code** convention, mapped by `classifyCheckerResult`:

| Exit | Meaning | Outcome | Verdict |
|---|---|---|---|
| `0` | accepted | `accepted` | the case passes |
| `1` | wrong answer | `rejected` | `WA` |
| `2` | presentation error | `rejected` | `WA` — WMOJ has no PE verdict |
| `3` | checker internal error | `internal-error` | **`IE`** |
| other non-zero **below 128** | a code the checker chose | `rejected` | `WA` |
| **`>= 128`**, 255 included | it died or was never exec'd | `internal-error` | **`IE`** |
| killed (TLE/OOM/signal), or the harness could not run it | — | `internal-error` | **`IE`** |

`IE` is the only verdict a checker can produce that is not about the submission. It means *your*
problem or test data is broken, and it is never folded into WA — a broken checker must be visible,
not blamed on the student. An `IE` case still counts as failed in `summary`.

**The `>= 128` row is load-bearing and easy to delete by accident.** nsjail runs in `--mode o`, where
its own exit status *is* the child's fate: `128 + WTERMSIG` when a signal killed it, and **255** when
it could not `execve` the checker at all. nsjail itself exits *normally* in both cases, so Node's
`signal` is `null` and `killedBy` can be `null` too — which is why the old
`killedBy !== null || exitCode === null` test missed every checker that segfaulted (139), aborted
(134), tripped seccomp (159), or had been deleted by the contestant (255). All of them fell through
to `default: rejected`, so the whole problem was graded **`WA`** — with no `IE` anywhere and, when
the checker's stderr was empty, no `checkerMessage` either. The problem looked healthy; the student
looked wrong. `classifyKill` decodes `128 + n` now as well, so most of these arrive as
`killedBy === "SIG"`; `classifyCheckerResult` keeps its own check as belt-and-braces, because the
cost of being wrong here is invisible mass-misgrading. The testlib convention only uses 0–7, so
`>= 128` can never collide with a code a checker deliberately chose.

**A harness failure is `IE` too.** `runChecker` catches everything — a scratch-file `ENOSPC`, the
`X_OK` check failing — and returns `internal-error` with `exitCode: null` and a
`checker harness error: …` message, which is exactly what "the checker could not answer" means. One
bad case must not reject and take every already-computed verdict down with it.

**The one exception is a `sandboxError`**, returned on `CheckerVerdict.sandboxError` alongside
`outcome: "internal-error"` as a safe default for callers that ignore it. That is the *judge's*
sandbox failing, not the problem's configuration, so `submit.ts` throws on it and the route returns
`500 {error}`. Never map a `sandboxError` to `IE` — see `verdicts-and-comparison`.

**The checker's stdout is completely ignored.** This is an exit-code-only protocol, not the full
testlib result-file protocol. Do not write a result file and do not expect one to be read.

**stderr is the message channel.** It is trimmed, truncated to **1024 UTF-8 bytes total** on a byte
boundary, and returned per case as `TestResult.checkerMessage`. The key is **omitted entirely** when
there is no checker or it said nothing, so no-checker responses stay byte-identical to what they were
before checkers existed. Say *why* an answer was rejected there — students see it.

Three details of `truncateBytes` that are each there for a reason:

- The 15-byte `"… (truncated)"` marker is counted **against** the 1024, not appended on top of it.
  Appending it afterwards made a 1400-byte message come back as 1039 bytes from a function whose
  JSDoc, whose constant, and whose `types.ts` contract all said 1024.
- Exactly **one** trailing U+FFFD is stripped, which is all a byte-boundary cut can ever leave. A
  repeated `/…+$/` ate replacement characters the checker legitimately produced — likely, since
  `runSandboxed` already maps its malformed bytes and NULs to U+FFFD — and a message made entirely of
  them collapsed to a bare marker with no content at all.
- The string is `slice`d before `Buffer.from`, so keeping 1 KB does not materialise the checker's
  whole 64 KiB of stderr. Safe because a UTF-16 code unit is never fewer than one UTF-8 byte.

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
- Never merge `checkerError` into `compileError`, and never return 4xx for either. Every failure path
  in `compileChecker`, `fs.writeFile` of `Checker.cpp` included, must resolve `{ok:false, stderr}`
  rather than reject — a rejection there is a 500 where the contract promises a 200.
- Never read the checker's stdout, or add a result-file protocol without changing both repos.
- Never let a checker's `IE` be reported as `WA` — a broken problem must stay visible. That includes
  exit `>= 128`, which is nsjail reporting the checker's *death*, not a verdict it chose.
- Never let a `sandboxError` become `IE` — that one is the judge's fault, and it throws.
- Never describe the argument order as testlib's, and never make the scratch filenames predictable.
- Never assume a checker gets a case that TLE'd, MLE'd, or crashed; it does not.
- Never put anything secret in checker source — a submission can read it.
- Never expect partial scores. The judge has no such verdict; all scoring lives in `wmoj-app`.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
changed exit-code mapping, a new truncation limit, a moved compile step, a fixture that no longer
matches — update it as part of your change. This skill is only useful while it is accurate.
