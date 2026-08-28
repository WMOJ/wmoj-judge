---
name: add-language
description: Adds, removes, or changes a language in wmoj-judge — the languages.json schema field by field, what src/languages derives from it (the Language type, the accepted /submit codes, the compile line, the memory floor, the liveness probes), the three things that are NOT derived and still need a hand, and how a compile-flag change interacts with the compile cache and /generate-tests. Use whenever someone wants to add, remove, rename, upgrade, or reconfigure a language, a compiler, a compile flag, a language runtime, a C++ standard, or languages.json.
---

# Adding or changing a language in wmoj-judge

`languages.json` at the repo root is the source of truth, and `src/languages` derives everything
else from it. Six IDs exist today: `python3`, `pypy3`, `cpp14`, `cpp17`, `cpp20`, `cpp23`. Java was
removed; the JVM references still scattered through `policy.kafel` are historical.

Adding one is a **JSON edit plus three things no compiler can know about** — the toolchain in the
`Dockerfile`, the syscalls the runtime needs in `policy.kafel`, and an end-to-end golden captured on
CI. Nothing else is a registration point. This used to be an eight-place checklist in which the one
place that mattered most — `submit.ts`'s hand-kept `ALL_LANGUAGES` — was **not** compile-checked, so
forgetting it left a perfectly clean build in which every submission in the new language 400'd.

## `languages.json` schema

```json
"cpp17": {
  "filename": "Main.cpp",
  "compile": { "cc": "/usr/bin/g++", "std": "c++17" },
  "artifacts": ["a.out"],
  "run": ["./a.out"],
  "probe": ["--version"]
},
"pypy3": {
  "filename": "Main.py",
  "run": ["/usr/bin/pypy3", "-u", "Main.py"],
  "probe": ["--version"],
  "memoryFloorMb": 384
}
```

| Key | Meaning |
|---|---|
| `filename` | what the submission source is written to in the workdir; the compile and run argv name it relatively |
| `compile` | `{cc, std}`, or **absent** for an interpreted language. `cc` is an absolute binary path; the module assembles the argv (see below) |
| `artifacts` | what the compile step produces and the compile cache stores. Absent/empty for interpreted languages; a compiled language with an empty list **throws at boot** |
| `run` | how to start the program. `["./a.out"]` for compiled, `[<absolute interpreter>, "-u", <file>]` for interpreted — `-u` matters, unbuffered output prevents stdout deadlocks |
| `probe` | the version flag the liveness check passes to the binary, e.g. `["-V"]` or `["--version"]`. It must exit 0 |
| `memoryFloorMb` | optional MINIMUM enforced cap. A floor, not a default: `effectiveMemLimitMb` takes `max(requested, floor)` |

**There is no version field, no time multiplier and no memory adder.** A language gets one memory
floor and the same time limit as everything else; do not invent extra keys, because nothing reads
them — and an entry missing a key the schema *does* require (`filename`, `run`, `probe`) is a `tsc`
error at `src/languages/index.ts`'s `entries` assignment, not a runtime surprise.

`pypy3` sets `memoryFloorMb: 384` because PyPy's baseline RSS is ~60 MB against CPython's ~14 MB. A
PyPy submission under a 256 MB cap spends a quarter of its budget before running a line of user code.
A consequence worth knowing: a problem cannot declare a limit *tighter* than a language's floor.

## What the JSON derives

Everything in this list follows from the entry. None of it is a place to edit.

| Derived | Where | Consequence |
|---|---|---|
| `Language` | `keyof typeof table` | the union in `types.ts` is a re-export; adding a key adds a member |
| accepted `/submit` codes | `isLanguage`, used by `validateSubmit` | membership in the JSON *is* the accepted set; an unknown code is `400 Unsupported language: <code>` |
| `ALL_LANGUAGES` | `Object.keys` filtered through `isLanguage` | no hand-kept list to forget |
| the compile line | `cppCompileArgv(cc, std, filename, artifacts[0])` | `[cc, "-O2", "-std=<std>", "-fmax-errors=50", <src>, "-o", <out>]` |
| the checker and generator compile | `setterCompileArgv`, the `cpp17` entry's `cc`/`std` | problem-setter code gets the submission dialect — ADR 0003 |
| the memory floor | `LanguageSpec.memoryFloorMb` | read once, at the route, into `effectiveMemoryLimitMb` |
| the liveness probes | `toolchainProbes()` | one probe per **distinct binary** (four C++ entries share one `g++`), named by basename, run at boot and on `/health`'s fast cadence |

A compiled language's probe is its **compiler**, not its run argv: `./a.out` does not exist until
something builds it.

## The three things that are NOT derived

**1. The toolchain in the `Dockerfile`, in the *runtime* stage** (`FROM node:20-trixie-slim AS
runtime`), not the builder stage. Installing it in the builder produces an image that builds fine
and cannot run the language. The judge then **refuses to boot** — the probe derived above fails —
which is the intended way for this to surface.

**2. The syscalls the runtime needs in `policy.kafel`.** `DEFAULT` is `ERRNO(38)`, i.e. `ENOSYS`, so
an unlisted syscall is refused rather than killed and a new runtime tends to fail in a confusing
place — a startup that hangs, an interpreter that reports a missing feature — rather than with a
clear denial. Do not guess and do not widen the allowlist to make something start: read
`sandbox-changes` first, then find out empirically the way the `seccomp-socket-denied` golden does.
Write a small program in the new language that performs the operation you are unsure about and
prints what it got back (`fd=-1 errno=1`), submit it to a container built with the real policy, and
compare against the same program on a container started with `UNSAFE_DISABLE_SECCOMP=true`. That is
a check that can distinguish "blocked" from "did not run"; `strace` inside the jail cannot, because
`ptrace` is not in the allowlist either.

**3. An end-to-end golden transcript for the new language,** captured on CI. Add a scenario to
`test/e2e/scenarios.ts` (an AC and, where the language has one, its allocation-failure signature —
`mle-python-memoryerror` is the model), then have CI capture and commit the fixture on an x86_64
runner. A language with no golden is a language whose verdicts nothing checks. `npm test` alone
cannot: the unit suite has no kernel, and `test/unit/languages.test.ts` only pins the projections
above.

## Compiler flags and the compile cache

The cache key is `sha256(language ‖ code ‖ compileArgv)`, so **changing a flag invalidates correctly
on its own** — you do not need to clear anything, and the 15-minute TTL absorbs the miss. Interpreted
languages skip the cache entirely — no key, no entry (ADR 0004).

Because there is now one `cppCompileArgv`, a flag added there changes **every** compile: submissions,
custom checkers and `/generate-tests` generators alike. That is the point — the three used to be
hand-spelled and had already drifted to different dialects — but it does mean a flag that suits
submissions and not problem-setter code has nowhere to hide. If that ever happens, the honest fix is
a second named line beside `setterCompileArgv`, with the reason in its JSDoc.

`/generate-tests` keeps its own accepted list, `["cpp", "cpp14", "cpp17"]`, deliberately different
from `/submit`'s: `wmoj-app`'s `judge.sh` sends bare `"cpp"` there and nowhere else, and `cpp20`/
`cpp23` are accepted by `/submit` and refused there. It validates the field and then ignores it —
every generator is built with `setterCompileArgv` — so **a new language is not automatically usable
for generators.**

## Never

- Never install a runtime in the Dockerfile's builder stage instead of the runtime stage.
- Never add fields to `languages.json` that nothing reads (versions, multipliers, adders).
- Never re-introduce a hand-kept list of language codes anywhere; membership in the JSON is the set.
- Never widen `policy.kafel` to make a new runtime start before reading `sandbox-changes`.
- Never assume `/generate-tests` follows `languages.json`. It compiles with the setter line only.
- Never bring back a `python`/`cpp`-style alias in `/submit` without `judge-app-contract`: the two
  that existed were removed once both wmoj-app call sites were confirmed to send canonical codes.
- Never claim a language works because `npm run build` passed — build the image and submit to it.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
new schema key, something that stopped being derived, a changed compile line — update it as part of
your change. This skill is only useful while it is accurate.
