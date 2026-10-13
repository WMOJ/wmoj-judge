import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import table from "../../languages.json";
import {
  ALL_LANGUAGES,
  cppCompileArgv,
  isLanguage,
  languageSpec,
  runPlan,
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

const JAVA: readonly Language[] = ["java11", "java17", "java21"];

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
  // Java is back as three versioned codes; a bare `java` names none of them.
  assert.equal(isLanguage("java"), false);
  assert.equal(isLanguage("java8"), false);
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

test("only the runtimes with a large baseline declare a memory floor", () => {
  assert.equal(languageSpec("pypy3").memoryFloorMb, 384);
  for (const id of JAVA) {
    assert.equal(languageSpec(id).memoryFloorMb, 256, `${id} needs room for the JVM itself`);
  }
  for (const id of ALL_LANGUAGES) {
    if (id === "pypy3" || JAVA.includes(id)) continue;
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
  assert.equal(
    probes.length,
    6,
    "python3, pypy3, one g++ for all four C++ entries, and one per Java version",
  );
  assert.deepEqual(
    probes.map((p) => p.name),
    ["python3", "pypy3", "g++", "java11", "java17", "java21"],
    "the names appear in /health's reason string",
  );
  assert.equal(
    new Set(probes.map((p) => [p.bin, ...p.args].join(" "))).size,
    probes.length,
    "each probe must run a different command",
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
  // A probe covers a binary either by running it or — the Java probes,
  // which `test -x` instead of booting a JVM — by naming it as an argument.
  const covered = new Set(toolchainProbes().flatMap((p) => [p.bin, ...p.args]));
  for (const id of ALL_LANGUAGES) {
    const spec = languageSpec(id);
    const bin = spec.compileArgv === null ? spec.runArgv[0] : spec.compileArgv[0];
    assert.ok(
      bin !== undefined && covered.has(bin),
      `${id} runs ${String(bin)}, which nothing probes`,
    );
  }
});

test("a Java probe never boots a JVM", () => {
  // Three `java -version` every 30 s against a 2 s timeout on a ~0.1-CPU
  // host is a health check that goes degraded under load. The probe
  // checks that both launchers exist and are executable, and nothing more.
  for (const probe of toolchainProbes()) {
    if (!probe.name.startsWith("java")) continue;
    assert.equal(probe.bin, "/usr/bin/test");
    const version = probe.name.slice("java".length);
    assert.deepEqual(
      [...probe.args],
      ["-x", `/opt/java/${version}/bin/java`, "-a", "-x", `/opt/java/${version}/bin/javac`],
    );
  }
});

test("every Java version compiles with its own javac into one cached directory", () => {
  for (const id of JAVA) {
    const spec = languageSpec(id);
    const home = `/opt/java/${id.slice("java".length)}`;
    const argv = [...(spec.compileArgv ?? [])];
    assert.equal(argv[0], `${home}/bin/javac`);
    assert.equal(spec.filename, "Main.java");
    assert.equal(argv[argv.length - 1], "Main.java", "the source is named relatively");
    // `-d classes` is what makes the artifact ONE name: javac emits a
    // class file per class, nested and anonymous ones included, and the
    // compile cache stores only what `artifacts` lists.
    assert.deepEqual(argv.slice(-3, -1), ["-d", "classes"]);
    assert.deepEqual([...spec.artifacts], ["classes"]);
    // An unbounded javac sizes its heap from the HOST's RAM.
    assert.ok(argv.some((arg) => /^-J-Xmx\d+m$/.test(arg)), `${id}'s javac heap must be capped`);
  }
});

test("a JVM run plan caps the heap below the limit and raises the address space above it", () => {
  for (const id of JAVA) {
    const spec = languageSpec(id);
    const plan = runPlan(spec, 256);
    assert.ok(plan.argv.includes("-Xmx192m"), `${id}: heap is the limit minus the JVM's own 64 MB`);
    assert.ok(
      !plan.argv.some((arg) => arg.includes("<HEAP_MB>")),
      `${id}: the placeholder must never reach java`,
    );
    assert.ok(
      plan.addressSpaceMb !== undefined && plan.addressSpaceMb > 256,
      `${id}: HotSpot cannot start under an address-space cap equal to the limit`,
    );
    // Both numbers track the ENFORCED limit.
    assert.ok(runPlan(spec, 384).argv.includes("-Xmx320m"));
    assert.equal(
      (runPlan(spec, 384).addressSpaceMb ?? 0) - (plan.addressSpaceMb ?? 0),
      128,
    );
    // A host ceiling below the JVM's own overhead must not ask for a
    // negative heap.
    assert.ok(runPlan(spec, 32).argv.includes("-Xmx16m"));
    // The template itself is untouched: the plan is a copy.
    assert.ok(spec.runArgv.includes("-Xmx<HEAP_MB>m"));
  }
});

test("every other language runs its argv as written, under the limit itself", () => {
  for (const id of ALL_LANGUAGES) {
    if (JAVA.includes(id)) continue;
    const spec = languageSpec(id);
    const plan = runPlan(spec, 256);
    assert.deepEqual([...plan.argv], [...spec.runArgv]);
    assert.equal(
      plan.addressSpaceMb,
      undefined,
      `${id} must stay under --rlimit_as == the enforced limit, or a refused allocation stops meaning MLE`,
    );
  }
});
