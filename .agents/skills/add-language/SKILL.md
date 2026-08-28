---
name: add-language
description: Adds, removes, or changes a language in wmoj-judge — the languages.json schema, the eight places a language must be registered including the one the TypeScript compiler does NOT check for you, the Executor interface, per-language memory defaults, the legacy python/cpp aliases, and how a compiler-flag change interacts with the compile cache and /generate-tests. Use whenever someone wants to add, remove, rename, upgrade, or reconfigure a language, a compiler, a compile flag, a language runtime, a C++ standard, or languages.json.
---

# Adding or changing a language in wmoj-judge

`languages.json` at the repo root is the source of truth for what the judge can run. Six IDs exist
today: `python3`, `pypy3`, `cpp14`, `cpp17`, `cpp20`, `cpp23`. Java was removed; the JVM references
still scattered through `policy.kafel` are historical.

Registering a language means touching eight things, and **only two of them are enforced by the
compiler**. The rest fail at runtime, and one of them fails on every single submission.

## `languages.json` schema

```json
"cpp17": {
  "filename": "Main.cpp",
  "compile": { "argv": ["/usr/bin/g++", "-O2", "-std=c++17", "Main.cpp", "-o", "a.out"] },
  "run":     { "argv": ["./a.out"] }
},
"pypy3": {
  "filename": "Main.py",
  "compile": null,
  "run": { "argv": ["/usr/bin/pypy3", "-u", "Main.py"] },
  "memoryLimitMb": 384
}
```

| Key | Meaning |
|---|---|
| `filename` | what the source is written to in the workdir; the compile/run argv reference it by that name |
| `compile` | `{argv}` or **`null`** for interpreted languages. Absolute binary path; argv is relative to the workdir, which nsjail sets as cwd |
| `run.argv` | how to start the program. `./a.out` for compiled, `<interpreter> -u <file>` for interpreted — `-u` matters, unbuffered output prevents stdout deadlocks |
| `memoryLimitMb` | optional per-language default cap |

**There is no version field, no time multiplier, and no memory adder.** A language gets one flat
memory default and the same time limit as everything else; do not invent extra keys, because nothing
reads them.

`pypy3` sets `memoryLimitMb: 384` because PyPy's baseline RSS is ~60 MB against CPython's ~14 MB. A
PyPy submission under a 256 MB cap spends a quarter of its budget before running a line of user code.

## The eight-step checklist

**1. Add the entry to `languages.json`** using the schema above.

**2. Add the ID to the `Language` union in `src/types.ts`.** This is what makes the two `switch`
statements below compile-checked.

**3. Write `src/executors/<lang>.ts`** implementing the `Executor` interface:

```ts
interface Executor {
  filename(code: string): string;
  prepare(workDir: string, code: string): Promise<void>;
  compile(workDir: string): Promise<{ok: true} | {ok: false; stderr: string}>;
  buildRunCommand(workDir: string, filename: string): { argv: string[] };
}
```

Read everything from `languages.json` — `createCppExecutor(standard)` is the model. `compile()` for
an interpreted language resolves `{ok: true}` without spawning anything. Compilation runs **outside
nsjail** with a scrubbed env from `buildChildEnv()`, which takes no argument and returns the same
four variables for every language. It used to accept a `lang` it ignored; if a language ever needs
its own env, add the parameter back and make it mean something rather than reinstating the lie.

**4. Add the `case` to `executorFor` in `src/executors/index.ts`.** Compile-enforced: the `default`
branch assigns to `const _exhaustive: never`, so a missing case is a build error.

**5. Add the ID to `ALL_LANGUAGES` in `src/routes/submit.ts`. ⚠️ This is NOT compile-checked.** It
is a plain `readonly (Language | "python" | "cpp")[]` literal used by `validateSubmit`. Forget it and
`tsc` stays perfectly clean while **every submission in the new language 400s** with
`Unsupported language: <id>`. This is the single most likely way to ship a broken language.

**6. Install the toolchain in the Dockerfile's *runtime* stage** (`FROM node:20-trixie-slim AS
runtime`), not the builder stage. Installing it in the builder stage produces an image that builds
fine and cannot run the language.

**7. Add a `/health` probe** in `src/routes/health.ts`. The judge **refuses to boot** unless every
probed toolchain is on `PATH`, which is how a missing runtime surfaces as a clear boot failure rather
than as mysterious per-submission `IE`s.

**8. Verify `policy.kafel` covers the runtime's startup syscalls.** A new runtime that calls
something outside the ALLOW block gets `ENOSYS` from `DEFAULT ERRNO(38)` — usually harmless, since
that is precisely the "not supported, try the older syscall" semantic — but verify it actually starts
inside the sandbox before shipping. See the `sandbox-changes` skill before widening the allowlist.

## The compile-enforced / not-enforced asymmetry

| Registration point | Enforced by `tsc`? | Failure if you forget it |
|---|---|---|
| `Language` union, `types.ts` | — | the two switches stop compiling (this is the point) |
| `executorFor` switch, `executors/index.ts` | **yes**, `never` guard | build error |
| `compare` switch, `compare/index.ts` | **yes**, `never` guard | build error |
| **`ALL_LANGUAGES`, `submit.ts`** | **NO** | clean build, **400 on every submission** |
| **`ALL_COMPARE_MODES`, `submit.ts`** | **NO** | clean build, 400 on every request using the new mode |
| `languages.json` | — | runtime crash resolving the spec |
| Dockerfile runtime stage | — | boot failure from the `/health` probe |
| `/health` probe | — | no boot failure; a missing runtime becomes runtime errors |

Adding a **comparison mode** has the same shape: `CompareMode` in `types.ts`, a file under
`src/compare/`, a compile-enforced `case` in `compare/index.ts`, and the **not**-compile-checked
`ALL_COMPARE_MODES`. See `verdicts-and-comparison` for the semantics.

## Legacy aliases

`python` → `python3` and `cpp` → `cpp17` are still accepted for the wmoj-app cutover. They are
**hardcoded in three places and are deliberately not in `languages.json`**: `normalizeLanguage` and
`ALL_LANGUAGES` in `routes/submit.ts`, and `executorFor` in `executors/index.ts`, which logs a
deprecation warning once per process per alias. Removing them is a cross-repo breaking change —
see `judge-app-contract`.

## Compiler flags and the compile cache

The cache key is `sha256(language ‖ code ‖ compileArgv)`, so **changing a compile flag invalidates
correctly on its own** — you do not need to clear anything. Interpreted languages key on an empty
argv, which is why two identical Python submissions share an entry.

`/generate-tests` is the exception to all of this: it **always** compiles with a hardcoded
`/usr/bin/g++ -O2 -std=gnu++17`, ignores the `language` field after validating it, and accepts only
`cpp`/`cpp14`/`cpp17` — so it rejects `cpp20` and `cpp23`, which `/submit` accepts. A new language is
not automatically usable for generators, and generators do not pick up flag changes made in
`languages.json`.

## Never

- Never add a language without adding it to `ALL_LANGUAGES` — the compiler will not catch it.
- Never install a runtime in the Dockerfile's builder stage instead of the runtime stage.
- Never add fields to `languages.json` that nothing reads (versions, multipliers, adders).
- Never remove a legacy alias without coordinating with `wmoj-app`; it is a breaking change.
- Never widen `policy.kafel` to make a new runtime start before reading `sandbox-changes`.
- Never assume `/generate-tests` follows `languages.json`. It does not.
- Never claim a language works because `npm run build` passed — build it in Docker and submit to it.

---

**Keeping this current:** if you find anything here that is outdated, stale, wrong, or missing — a
new registration point, a schema key, a changed alias policy, a compile-check that became enforced —
update it as part of your change. This skill is only useful while it is accurate.
