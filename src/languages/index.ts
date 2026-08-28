import * as path from "path";
import table from "../../languages.json";

/**
 * Everything the judge knows about a language, derived from
 * `languages.json` — the language registry.
 *
 * Before this module the same six languages were spelled out in five
 * places: the JSON, the `Language` union in `types.ts`, `ALL_LANGUAGES`
 * and `compileArgvFor` in `routes/submit.ts`, the `executorFor` switch,
 * and the toolchain probes `/health` hand-picked. Only two of those were
 * compile-checked; forgetting `ALL_LANGUAGES` left a clean build in which
 * every submission in the new language 400'd. Here the JSON is the single
 * fact and everything else is a projection of it, so adding a language is
 * a JSON edit plus the things no TypeScript can know about — the
 * toolchain in the `Dockerfile` and the syscalls it needs in
 * `policy.kafel`.
 *
 * Deliberately depends on nothing: no `config`, no Express, no logger.
 * It is pure data over the JSON, which is what lets `submit.ts`,
 * `checker/`, `routes/generateTests.ts`, `liveness/` and the measurement
 * capture tool all read the same table without importing each other.
 */

/** Derived from the JSON's keys: adding an entry adds a member; nothing else to edit. */
export type Language = keyof typeof table;

/**
 * One entry of `languages.json`, as the module requires it to be shaped.
 *
 * The assignment below is the schema check: `resolveJsonModule` types the
 * import from the file's actual contents, so an entry that loses `run`,
 * or spells `filename` wrong, fails `tsc` at this line rather than
 * surfacing as an `undefined` argv at the first submission. Optional
 * here means optional in the schema — `compile`/`artifacts` for
 * interpreted languages, `memoryFloorMb` for everything except pypy3.
 */
interface LanguageEntry {
  readonly filename: string;
  readonly run: readonly string[];
  readonly probe: readonly string[];
  readonly compile?: { readonly cc: string; readonly std: string };
  readonly artifacts?: readonly string[];
  readonly memoryFloorMb?: number;
}

const entries: Readonly<Record<Language, LanguageEntry>> = table;

export interface LanguageSpec {
  readonly id: Language;
  readonly filename: string;
  /** null for interpreted languages — no compile step, no cache entry. */
  readonly compileArgv: readonly string[] | null;
  /**
   * What the compile step produces and the compile cache stores. Empty
   * for interpreted languages. Consumed by the cache; declared here so
   * the schema does not change again when it is.
   */
  readonly artifacts: readonly string[];
  readonly runArgv: readonly string[];
  /**
   * The language's minimum enforced memory cap, or undefined when it sets
   * none. A FLOOR, not a default: `effectiveMemLimitMb` takes
   * `max(requested, floor)`, because every real client always sends a
   * number and a default would therefore never apply. pypy3 sets 384
   * because PyPy's baseline RSS is ~60 MB against CPython's ~14 MB, so a
   * PyPy submission under a 256 MB cap spends a quarter of its budget
   * before running a line of user code.
   */
  readonly memoryFloorMb: number | undefined;
}

/**
 * The one place a g++ line is built. Submissions, checkers and generators
 * all come through here; three hand-spelled copies had already drifted
 * (`c++17` vs `gnu++17`, one with `-fmax-errors`, absolute vs relative
 * paths).
 *
 * `-fmax-errors=50` bounds the diagnostics **at the source**:
 * `runCompile`'s capped collectors bound what the judge keeps, this
 * bounds what g++ spends CPU producing — which matters because none of
 * the three compiles is sandboxed or timed.
 *
 * `src` and `out` are names relative to the workdir, which every caller
 * passes as the child's `cwd`. That is what makes a diagnostic read
 * `Checker.cpp:3:1: error:` instead of naming a `/tmp/judge-<nanoid>`
 * path back to the caller — the text goes straight into an HTTP body.
 */
export function cppCompileArgv(
  cc: string,
  std: string,
  src: string,
  out: string,
): string[] {
  return [cc, "-O2", `-std=${std}`, "-fmax-errors=50", src, "-o", out];
}

/**
 * Is this an accepted `/submit` language code?
 *
 * Membership in the JSON is the whole definition, so a language cannot be
 * runnable-but-unaccepted (or the reverse) the way it could when
 * `submit.ts` kept its own list. The legacy `python`/`cpp` aliases are
 * NOT members: `/submit` rejects them with `Unsupported language: <code>`.
 * `/generate-tests` keeps its own, deliberately different list which
 * still accepts bare `cpp`.
 */
export function isLanguage(x: unknown): x is Language {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(table, x);
}

/**
 * Every language, in the JSON's order.
 *
 * Filtered through `isLanguage` rather than cast: `Object.keys` is typed
 * `string[]` because a value may carry properties its type does not
 * declare, and the type guard is the same membership test the route
 * validates with, so the two cannot disagree.
 */
export const ALL_LANGUAGES: readonly Language[] =
  Object.keys(entries).filter(isLanguage);

/**
 * Build one spec, and refuse a table that cannot produce one.
 *
 * The throws run at import time, which is boot: `config.ts` sets the
 * precedent that a malformed value stops the judge rather than silently
 * becoming a different one. A compiled language whose `artifacts` list is
 * empty has nothing to name after `-o`, and a language with no `run` argv
 * cannot be executed at all — both are broken for every submission in
 * that language, so neither may wait for the first one to arrive.
 */
function buildSpec(id: Language): LanguageSpec {
  const entry = entries[id];
  if (entry.run.length === 0) {
    throw new Error(`languages.json: ${id}.run is empty`);
  }
  const artifacts = entry.artifacts ?? [];
  const compile = entry.compile;
  if (compile === undefined) {
    return {
      id,
      filename: entry.filename,
      compileArgv: null,
      artifacts,
      runArgv: entry.run,
      memoryFloorMb: entry.memoryFloorMb,
    };
  }
  const artifact = artifacts[0];
  if (artifact === undefined) {
    throw new Error(`languages.json: ${id} has a compile step but no artifacts`);
  }
  return {
    id,
    filename: entry.filename,
    compileArgv: cppCompileArgv(compile.cc, compile.std, entry.filename, artifact),
    artifacts,
    runArgv: entry.run,
    memoryFloorMb: entry.memoryFloorMb,
  };
}

const SPECS = new Map<Language, LanguageSpec>(
  ALL_LANGUAGES.map((id) => [id, buildSpec(id)]),
);

export function languageSpec(id: Language): LanguageSpec {
  const spec = SPECS.get(id);
  if (spec === undefined) {
    // Unreachable: the map is built from the same keys `Language` is
    // derived from. A typed guard rather than a non-null assertion.
    throw new Error(`languages.json: no entry for ${id}`);
  }
  return spec;
}

/**
 * The compile settings problem-setter code is built with: the `cpp17`
 * entry's, i.e. the same dialect a contestant's `cpp17` submission gets.
 *
 * Checkers and generators used to be compiled with a hand-spelled
 * `-std=gnu++17` that matched neither `/submit` nor each other. Every
 * problem-setter program stored in production — 56 generators, 7 checkers
 * and this repo's reference checker, 64 of 64 — compiles clean under both
 * dialects with g++ 14.2.0, and none is testlib-derived, so there is no
 * reason to keep a second dialect alive. See
 * `docs/adr/0003-problem-setter-code-compiles-under-the-submission-dialect.md`.
 */
function setterCompile(): { readonly cc: string; readonly std: string } {
  const compile = entries.cpp17.compile;
  if (compile === undefined) {
    throw new Error("languages.json: cpp17 has no compile step");
  }
  return compile;
}

const SETTER_COMPILE = setterCompile();

/** Problem-setter compile (checkers, generators): the cpp17 entry's cc/std. */
export function setterCompileArgv(src: string, out: string): string[] {
  return cppCompileArgv(SETTER_COMPILE.cc, SETTER_COMPILE.std, src, out);
}

/** One toolchain probe: the binary to run and the flag that makes it exit 0. */
export interface ToolchainProbe {
  readonly name: string;
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * One probe per DISTINCT binary in the table — python3, pypy3 and g++
 * today, since the four C++ entries share one `cc`.
 *
 * The binaries come from `languages.json` rather than being spelled out
 * in `liveness/`, because that is what submissions actually execute:
 * probing a bare `python3`/`g++` resolved through PATH, as `/health` once
 * did, means the probe can pass against a completely different binary
 * from the absolute `/usr/bin/...` path every run and compile uses.
 *
 * The name is the binary's basename, so it is stable across a path change
 * and matches what `/health` has always put in its `reason` string. Two
 * entries naming the same binary collapse to the first one's probe args;
 * a language whose runtime needs a different version flag needs a
 * different binary anyway.
 */
export function toolchainProbes(): readonly ToolchainProbe[] {
  const probes = new Map<string, ToolchainProbe>();
  for (const id of ALL_LANGUAGES) {
    const entry = entries[id];
    // A compiled language's toolchain is its COMPILER; its run argv is
    // `./a.out`, which does not exist until something compiles it.
    const bin = entry.compile?.cc ?? entry.run[0];
    if (bin === undefined) {
      // Unreachable: `buildSpec` already refused an empty run argv at
      // import time. A typed guard rather than a non-null assertion.
      throw new Error(`languages.json: ${id}.run is empty`);
    }
    if (!probes.has(bin)) {
      probes.set(bin, { name: path.basename(bin), bin, args: entry.probe });
    }
  }
  return [...probes.values()];
}
