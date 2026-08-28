import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import table from "../../languages.json";
import {
  ALL_LANGUAGES,
  cppCompileArgv,
  isLanguage,
  languageSpec,
  setterCompileArgv,
  toolchainProbes,
  type Language,
} from "../../src/languages";

/**
 * The language registry is the one place "which languages exist" is
 * written down, and everything else — the accepted `/submit` codes, the
 * compile line, the memory floor, the liveness probes — is a projection
 * of it. These cases pin the projections, because each of them used to be
 * a hand-kept copy and each failed silently in its own way: a language
 * missing from `submit.ts`'s list 400'd every submission on a clean
 * build; a compile line spelled a fourth time drifted to a different
 * dialect; a probe named a bare `g++` that PATH could resolve to a
 * different binary from the one every compile uses.
 */

const CPP_STANDARDS: Readonly<Record<string, string>> = {
  cpp14: "c++14",
  cpp17: "c++17",
  cpp20: "c++20",
  cpp23: "c++23",
};

const INTERPRETED: readonly Language[] = ["python3", "pypy3"];

test("every key of languages.json resolves to a spec, and nothing else does", () => {
  const keys = Object.keys(table);
  assert.deepEqual([...ALL_LANGUAGES], keys);
  for (const key of keys) {
    assert.ok(isLanguage(key), `${key} is a JSON key but not a Language`);
  }
  for (const id of ALL_LANGUAGES) {
    assert.equal(languageSpec(id).id, id);
  }
});

test("isLanguage rejects the legacy aliases and every non-language value", () => {
  // The whole point of the alias removal: `/submit` answers
  // `Unsupported language: python` rather than silently judging as
  // python3. `/generate-tests` keeps its own list and still takes "cpp".
  assert.equal(isLanguage("python"), false);
  assert.equal(isLanguage("cpp"), false);
  assert.equal(isLanguage("java"), false);
  assert.equal(isLanguage(""), false);
  assert.equal(isLanguage(42), false);
  assert.equal(isLanguage(null), false);
  assert.equal(isLanguage(undefined), false);
  // `hasOwnProperty`, not `in`: an inherited name is not a language.
  assert.equal(isLanguage("toString"), false);
  assert.equal(isLanguage("__proto__"), false);
});

test("interpreted languages have no compile step and no artifacts", () => {
  for (const id of INTERPRETED) {
    const spec = languageSpec(id);
    assert.equal(spec.compileArgv, null, `${id} must not compile`);
    assert.deepEqual([...spec.artifacts], [], `${id} produces no artifact`);
    assert.equal(spec.filename, "Main.py");
    // `-u`: unbuffered, or a program that fills the pipe and waits
    // deadlocks against a judge that reads only at exit.
    assert.ok(spec.runArgv.includes("-u"), `${id} must run unbuffered`);
    assert.ok(
      path.isAbsolute(spec.runArgv[0] ?? ""),
      `${id} must name its interpreter by absolute path`,
    );
  }
});

test("every C++ standard produces the one seven-element compile line", () => {
  for (const [id, std] of Object.entries(CPP_STANDARDS)) {
    assert.ok(isLanguage(id));
    const spec = languageSpec(id);
    assert.deepEqual(
      spec.compileArgv === null ? null : [...spec.compileArgv],
      ["/usr/bin/g++", "-O2", `-std=${std}`, "-fmax-errors=50", "Main.cpp", "-o", "a.out"],
    );
    assert.deepEqual([...spec.artifacts], ["a.out"]);
    assert.deepEqual([...spec.runArgv], ["./a.out"]);
    assert.equal(spec.filename, "Main.cpp");
  }
});

test("the compile argv names the source and the artifact by relative name", () => {
  // Relative, because the compile runs with the workdir as cwd: that is
  // what keeps `/tmp/judge-<nanoid>` out of the `compileError` and
  // `checkerError` strings that go straight into an HTTP body.
  const spec = languageSpec("cpp20");
  for (const arg of spec.compileArgv ?? []) {
    assert.ok(
      !arg.includes("/tmp"),
      `the compile line must not carry a workdir path: ${arg}`,
    );
  }
  assert.deepEqual(
    cppCompileArgv("/usr/bin/g++", "c++20", "Main.cpp", "a.out"),
    [...(spec.compileArgv ?? [])],
  );
});

test("pypy3 is the only language with a memory floor, and it is 384", () => {
  assert.equal(languageSpec("pypy3").memoryFloorMb, 384);
  for (const id of ALL_LANGUAGES) {
    if (id === "pypy3") continue;
    assert.equal(
      languageSpec(id).memoryFloorMb,
      undefined,
      `${id} must not declare a memory floor`,
    );
  }
});

test("the problem-setter compile is the submission dialect, from the cpp17 entry", () => {
  // The audit behind this: 64 of 64 stored checkers and generators
  // compile clean under `-std=c++17`, so there is no second dialect.
  assert.deepEqual(
    setterCompileArgv("Checker.cpp", "checker"),
    cppCompileArgv("/usr/bin/g++", "c++17", "Checker.cpp", "checker"),
  );
  assert.deepEqual(setterCompileArgv("Checker.cpp", "checker"), [
    "/usr/bin/g++",
    "-O2",
    "-std=c++17",
    "-fmax-errors=50",
    "Checker.cpp",
    "-o",
    "checker",
  ]);
});

test("there is one toolchain probe per distinct binary, each an absolute path", () => {
  const probes = toolchainProbes();
  assert.equal(probes.length, 3, "python3, pypy3 and one g++ for all four C++ entries");
  assert.deepEqual(
    probes.map((p) => p.name),
    ["python3", "pypy3", "g++"],
    "the names appear in /health's reason string",
  );
  assert.equal(
    new Set(probes.map((p) => p.bin)).size,
    probes.length,
    "each probe must name a different binary",
  );
  for (const probe of probes) {
    assert.ok(
      path.isAbsolute(probe.bin),
      `${probe.name} must be probed at the absolute path submissions use, not via PATH`,
    );
    assert.ok(probe.args.length > 0, `${probe.name} needs a version flag`);
  }
});

test("every probed binary is one a language actually runs or compiles with", () => {
  const bins = new Set(toolchainProbes().map((p) => p.bin));
  for (const id of ALL_LANGUAGES) {
    const spec = languageSpec(id);
    const bin = spec.compileArgv === null ? spec.runArgv[0] : spec.compileArgv[0];
    assert.ok(
      bin !== undefined && bins.has(bin),
      `${id} runs ${String(bin)}, which nothing probes`,
    );
  }
});
