import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { RunOutcome, TestResult } from "../types";
import { config } from "../config";
import { compare } from "../compare";
import { runCompile } from "../util/compile";
import { runSandboxed } from "../sandbox/nsjail";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { gradeCase, type CaseLimits, type Judge } from "../verdict";
import languagesJson from "../../languages.json";

/**
 * Capture the measurement fixtures the verdict module is tested against.
 *
 * Every branch of the kill ladder is a fact about a real Linux kernel:
 * what `RLIMIT_CPU` does when the soft and hard limits are equal, what
 * `RLIMIT_AS` does to a `new[]` too big to satisfy, what nsjail puts in
 * its exit status when the child dies by a signal. None of that can be
 * invented in a unit test without inventing the answer along with it. So
 * this tool runs the real programs in the real sandbox, records the
 * `RunOutcome` and the `TestResult` it grades to, and the committed
 * result becomes the input to `test/unit/verdict.test.ts` — where the
 * ladder is then exercised with no kernel involved at all.
 *
 * It runs INSIDE the image, because that is where nsjail is:
 *
 *   docker run --rm -e LOG_LEVEL=silent -e JUDGE_SHARED_SECRET=x \
 *     --entrypoint node <image> dist/tools/captureMeasurements.js > fresh.json
 *
 * On an emulated arm64 host add `-e NODE_ENV=development
 * -e UNSAFE_DISABLE_SECCOMP=true`; see the `requires` tags below for what
 * that host then cannot verify.
 *
 * `server.ts` never imports this. It ships in `dist/` deliberately and is
 * the one exception to "nothing in src/ that is not needed at runtime",
 * for the reason above: it needs the sandbox.
 *
 * The JSON array is the ONLY thing written to stdout — progress and
 * failures go to stderr — so the CI job can redirect it straight to a
 * file. `--entrypoint node` bypasses tini, which is correct here: there
 * is nothing to reap, every jail is force-killed by `runSandboxed`'s own
 * `finally`.
 */

/**
 * Something a scenario depends on that an emulated arm64 host cannot
 * give. Same vocabulary as the end-to-end transcripts' `requires`:
 *
 *  - `rlimit_as` — `RLIMIT_AS` is silently not enforced under QEMU user
 *    mode, so an allocation that must fail instead succeeds and MLE
 *    cannot fire;
 *  - `seccomp` — the amd64 BPF program cannot be installed on an arm64
 *    kernel, so nothing is filtered and a denied syscall succeeds;
 *  - `native` — a byte-clean stderr. The emulator writes its own
 *    diagnostics into the guest's stderr (`qemu: uncaught target signal
 *    11 (Segmentation fault) - core dumped`), which a fixture that pins
 *    an empty stderr cannot survive.
 *
 * A tagged scenario is still CAPTURED on such a host — the numbers are
 * useful — but its intended verdict is not asserted, and it is named on
 * stderr as unverified. On CI, where seccomp is enforced and the image
 * runs natively, every scenario is asserted.
 */
type Requirement = "rlimit_as" | "seccomp" | "native";

/** The program a scenario runs: C++ to compile, or an argv to exec. */
type CaptureProgram =
  | { readonly kind: "cpp"; readonly source: string }
  | { readonly kind: "argv"; readonly argv: readonly string[] };

interface CaptureScenario {
  readonly name: string;
  /** The verdict this scenario exists to produce. Asserted. */
  readonly intended: TestResult["verdict"];
  /** Which ladder branch or memory rule it pins. Printed, never asserted. */
  readonly note: string;
  readonly requires: readonly Requirement[];
  readonly program: CaptureProgram;
  /** Compared against the program's stdout with `trim-trailing`. */
  readonly expected: string;
  readonly limits: CaseLimits;
  /** Lowered only where the point is the truncation flag, not the cap. */
  readonly maxStdoutBytes?: number;
}

/** One recorded fixture, as split into `test/fixtures/measurements/`. */
interface CapturedFixture {
  name: string;
  intended: TestResult["verdict"];
  note: string;
  requires: readonly Requirement[];
  limits: CaseLimits;
  expected: string;
  outcome: RunOutcome;
  result: TestResult;
}

const SCENARIOS: readonly CaptureScenario[] = [
  {
    name: "clean-exit",
    intended: "AC",
    note: "ladder step 3 — a clean exit inside its budget classifies as nothing",
    requires: [],
    program: {
      kind: "cpp",
      source: '#include <cstdio>\nint main() { std::puts("42"); return 0; }\n',
    },
    expected: "42\n",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "clean-exit-wrong",
    intended: "WA",
    note: "ladder step 3 with the judge saying no — the WA half of the same branch",
    requires: [],
    program: {
      kind: "cpp",
      source: '#include <cstdio>\nint main() { std::puts("41"); return 0; }\n',
    },
    expected: "42\n",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "cpu-burn",
    intended: "TLE",
    // The distinct half of step 2: the program FINISHED, exit 0, and is
    // still a TLE because it overspent. If step 3 were ever moved above
    // step 2 this is the fixture that would catch it.
    note: "ladder step 2 before step 3 — burns ~1s of CPU then exit(0) on a 500ms limit",
    requires: [],
    program: {
      kind: "cpp",
      source:
        "#include <ctime>\n" +
        "int main() {\n" +
        "  // Spin on CPU time, not wall time, so the fixture pins the CPU gate\n" +
        "  // and stays reproducible on a throttled host.\n" +
        "  std::clock_t start = std::clock();\n" +
        "  volatile unsigned long long x = 1;\n" +
        "  while (std::clock() - start < CLOCKS_PER_SEC) x = x * 1103515245ULL + 12345ULL;\n" +
        "  return 0;\n" +
        "}\n",
    },
    expected: "",
    limits: { timeLimitMs: 500, memLimitMb: 256 },
  },
  {
    name: "rlimit-cpu-kill",
    intended: "TLE",
    // nsjail sets RLIMIT_CPU with soft == hard, and Linux delivers
    // SIGKILL rather than SIGXCPU when both are reached at once —
    // observed natively on the x86_64 runner and under emulation alike.
    // So this pins the SIGKILL-over-budget arm of step 6, and the SIGXCPU
    // arm is exercised by a derived fixture instead.
    note: "ladder step 6 — the kernel's RLIMIT_CPU kill, exit 137 already over budget",
    requires: [],
    program: {
      kind: "cpp",
      source:
        "int main() {\n" +
        "  volatile unsigned long long x = 1;\n" +
        "  for (;;) x = x * 1103515245ULL + 12345ULL;\n" +
        "}\n",
    },
    expected: "",
    limits: { timeLimitMs: 500, memLimitMb: 256 },
  },
  {
    name: "node-timer-kill",
    intended: "TLE",
    // The only path on which NO resource report survives: the runner is
    // in the process group we destroy, so it dies before it can write.
    // `cpuMs` is absent rather than 0, and step 1 decides without it.
    note: "ladder step 1 — the judge's last-resort SIGKILL timer, no report at all",
    requires: [],
    program: {
      kind: "cpp",
      source: "#include <unistd.h>\nint main() { sleep(10); return 0; }\n",
    },
    expected: "",
    limits: { timeLimitMs: 500, memLimitMb: 256 },
  },
  {
    name: "sleepy-finished",
    intended: "AC",
    // Wall time is 4x the limit and CPU time is ~0. Step 3 returns before
    // step 4 can see the wall, which is what keeps a program that blocked
    // on I/O and then answered correctly an AC.
    note: "ladder step 3 before step 4 — sleeps 2s against a 500ms limit and still passes",
    requires: [],
    program: {
      kind: "cpp",
      source:
        "#include <cstdio>\n#include <unistd.h>\n" +
        'int main() { sleep(2); std::puts("done"); return 0; }\n',
    },
    expected: "done\n",
    limits: { timeLimitMs: 500, memLimitMb: 256 },
  },
  {
    name: "rss-over-cap",
    intended: "MLE",
    // Ladder step 5 on its own: fill the address space one MiB at a time,
    // touching every page, until `--rlimit_as` refuses the next chunk,
    // then exit non-zero with NOTHING on stderr — so the RSS step is the
    // only rule that can call this MLE. The cap is 1024 MB rather than the
    // 256 MB every other scenario uses because RSS can never exceed the
    // address space, and the loader plus libc/libstdc++ map ~6 MB of it
    // (5.7 MB of LOAD segments in this image) of which only a couple of
    // MB are ever resident: at 256 MB that mapped-but-untouched remainder
    // is within a megabyte of the whole 2% band, so whether a program
    // that fills its space reaches the threshold is a coin flip. At
    // 1024 MB the band is 20 MB and the outcome is not in doubt.
    // The loop is bounded so a host that does not enforce RLIMIT_AS (an
    // emulated arm64 laptop) cannot run away; there it lands over the cap
    // by the bound instead of by refusal.
    //
    // Every store goes through `volatile`. With -O2 g++ deletes a `new[]`
    // whose bytes are written and never read — the whole allocation, not
    // just the stores — and the first version of this scenario compiled
    // to `return 1;`.
    note: "ladder step 5 — RSS at the cap on a run that filled its address space and exited by itself",
    requires: ["rlimit_as"],
    program: {
      kind: "cpp",
      source:
        "#include <cstddef>\n" +
        "#include <new>\n" +
        "int main() {\n" +
        "  const std::size_t chunk = static_cast<std::size_t>(1) << 20;\n" +
        "  const std::size_t bound = static_cast<std::size_t>(1024 + 64) << 20;\n" +
        "  for (std::size_t total = 0; total < bound; total += chunk) {\n" +
        "    volatile char* p = new (std::nothrow) char[chunk];\n" +
        "    if (p == nullptr) break;\n" +
        "    for (std::size_t i = 0; i < chunk; i += 4096) p[i] = 1;\n" +
        "  }\n" +
        "  return 1;\n" +
        "}\n",
    },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 1024 },
  },
  {
    name: "refused-allocation",
    intended: "MLE",
    // The common case on this host: `--rlimit_as` caps ADDRESS SPACE, so
    // `new` fails instead of the kernel killing anything. The program
    // aborts by itself and looks exactly like a runtime error unless its
    // stderr is read — which is the whole reason MLE is tested before the
    // `exitCode !== 0` branch. Same program as the `mle-refused-allocation`
    // golden: it reads the memory back and prints it, so -O2 cannot delete
    // the allocation (see `rss-over-cap`).
    note: "memory — a refused allocation, exit 134 with std::bad_alloc on stderr",
    requires: ["rlimit_as"],
    program: {
      kind: "cpp",
      source:
        "#include <cstddef>\n" +
        "#include <cstdio>\n" +
        "int main() {\n" +
        "  const std::size_t n = static_cast<std::size_t>(600) << 20;\n" +
        "  char* p = new char[n];\n" +
        "  for (std::size_t i = 0; i < n; i += 4096) p[i] = 1;\n" +
        "  std::printf(\"%d\\n\", static_cast<int>(p[0]));\n" +
        "  return 0;\n" +
        "}\n",
    },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "segfault",
    intended: "RE",
    note: "ladder step 6 — SIGSEGV as nsjail's 128+11, low RSS and no allocation text",
    requires: ["native"],
    program: {
      kind: "cpp",
      source:
        "// `p` is itself volatile so the LOAD of the pointer is a volatile\n" +
        "// access: without that, -O2's -fisolate-erroneous-paths-dereference\n" +
        "// can replace the store with __builtin_trap, raising SIGILL (132)\n" +
        "// instead of the SIGSEGV this fixture pins.\n" +
        "static int* volatile p = nullptr;\n" +
        "int main() { *p = 1; return 0; }\n",
    },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "abort",
    intended: "RE",
    // Same exit code as `refused-allocation` (134) and a different
    // verdict, because the only thing separating them is the stderr rule.
    note: "ladder step 6 — SIGABRT as 128+6, exit 134 with NO allocation text",
    requires: ["native"],
    program: {
      kind: "cpp",
      source: "#include <cstdlib>\nint main() { std::abort(); }\n",
    },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "nonzero-exit",
    intended: "RE",
    note: "ladder step 9 — a chosen non-zero exit is no kill class at all, and still RE",
    requires: [],
    program: { kind: "cpp", source: "int main() { return 7; }\n" },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "seccomp-socket-denied",
    intended: "AC",
    // `policy.kafel` has no KILL action anywhere — `socket` sits in the
    // explicit ERRNO(1) block and DEFAULT is ERRNO(38) — so exit 159
    // (128+SIGSYS) is unreachable and this pins the load-bearing fact
    // instead: the network is blocked by seccomp alone. The SIGSYS decode
    // is exercised by a derived fixture.
    note: "seccomp — socket() returns -1/EPERM rather than killing the process",
    requires: ["seccomp"],
    program: {
      kind: "cpp",
      source:
        "#include <cerrno>\n#include <cstdio>\n#include <sys/socket.h>\n" +
        "int main() {\n" +
        "  errno = 0;\n" +
        "  int fd = socket(AF_INET, SOCK_STREAM, 0);\n" +
        '  std::printf("fd=%d errno=%d\\n", fd, fd < 0 ? errno : 0);\n' +
        "  return 0;\n" +
        "}\n",
    },
    expected: "fd=-1 errno=1\n",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
  },
  {
    name: "truncated",
    intended: "WA",
    // The cap is lowered from the production 1 MiB so the fixture stays a
    // few hundred bytes instead of a megabyte of 'x' committed to git.
    // What it pins is the FLAG's path — capped stream to
    // `RunMeasurement.truncated` to `TestResult.truncated`, present only
    // when something was dropped — which is independent of the cap's
    // value. The production cap itself is pinned end-to-end by the
    // `truncated-stdout` golden transcript.
    note: "truncation — output past the stdout cap is a prefix, flagged, and cannot be AC",
    requires: [],
    program: {
      kind: "cpp",
      source:
        "#include <cstdio>\n" +
        "int main() {\n" +
        "  for (int i = 0; i < 4096; i++) std::putchar('x');\n" +
        "  return 0;\n" +
        "}\n",
    },
    expected: "",
    limits: { timeLimitMs: 2000, memLimitMb: 256 },
    maxStdoutBytes: 256,
  },
  {
    name: "selfcheck",
    intended: "TLE",
    // The exact probe `sandboxSelfCheck` runs at boot. Until the liveness
    // module restores the ladder assertion in production, THIS fixture
    // plus `verdict.test.ts` is what proves the probe's CPU burn really
    // does grade TLE — the half the boot check stopped asserting.
    note: "ladder step 2 — the boot liveness probe's own shell loop against its 50ms budget",
    requires: [],
    program: {
      kind: "argv",
      argv: ["/bin/sh", "-c", "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done"],
    },
    expected: "",
    limits: { timeLimitMs: 50, memLimitMb: 128 },
  },
];

/**
 * The compile line for C++ scenarios, taken from `languages.json` rather
 * than spelled out here so a fixture is always captured with the flags a
 * real `cpp17` submission gets. `-O2` matters: the segfault scenario's
 * comment is about what -O2 does to a null store.
 */
function cppCompileArgv(srcPath: string, outPath: string): string[] {
  const argv = languagesJson.cpp17.compile.argv;
  return argv.map((arg) => {
    if (arg === "Main.cpp") return srcPath;
    if (arg === "a.out") return outPath;
    return arg;
  });
}

/** Progress and diagnostics. Never stdout — that carries the JSON. */
function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Compile if needed and run one scenario, then grade it with the same
 * `gradeCase` the route uses and a `trim-trailing` judge — the comparator
 * every real WMOJ submission is graded with.
 */
async function capture(scenario: CaptureScenario): Promise<CapturedFixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-"));
  try {
    let argv: string[];
    if (scenario.program.kind === "argv") {
      argv = [...scenario.program.argv];
    } else {
      const srcPath = path.join(dir, "Main.cpp");
      const outPath = path.join(dir, "a.out");
      await fs.writeFile(srcPath, scenario.program.source, "utf8");
      const compiled = await runCompile(
        cppCompileArgv(srcPath, outPath),
        dir,
        buildChildEnv(),
      );
      if (!compiled.ok) {
        throw new Error(
          `${scenario.name}: the scenario's own source did not compile\n${compiled.stderr}`,
        );
      }
      argv = [outPath];
    }

    const outcome = await runSandboxed({
      argv,
      cwd: dir,
      label: `capture:${scenario.name}`,
      timeLimitMs: scenario.limits.timeLimitMs,
      memLimitMb: scenario.limits.memLimitMb,
      stdin: "",
      ...(scenario.maxStdoutBytes === undefined
        ? {}
        : { maxStdoutBytes: scenario.maxStdoutBytes }),
    });

    // A judge fault is never a fixture: it means the capture ITSELF is
    // broken (no nsjail, an uncompilable policy), and recording it would
    // pin the broken state as the expected one.
    if (!outcome.ok) {
      throw new Error(
        `${scenario.name}: sandbox failure while capturing — ${outcome.sandboxError}`,
      );
    }

    const judge: Judge = async (received) => ({
      passed: compare("trim-trailing", scenario.expected, received),
    });
    const result = await gradeCase(
      { index: 0, expected: scenario.expected, run: outcome.run, limits: scenario.limits },
      judge,
    );

    return {
      name: scenario.name,
      intended: scenario.intended,
      note: scenario.note,
      requires: scenario.requires,
      limits: scenario.limits,
      expected: scenario.expected,
      outcome,
      result,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One line per scenario on stderr, so a human can read the run. */
function describe(fixture: CapturedFixture, asserted: boolean): string {
  const run = fixture.outcome.ok ? fixture.outcome.run : undefined;
  const measured =
    run?.cpuMs === undefined
      ? "no report"
      : `cpu=${String(run.cpuMs)}ms rss=${String(run.maxRssKb ?? 0)}kb`;
  const mark = fixture.result.verdict === fixture.intended ? "ok " : "DIFF";
  const suffix = asserted ? "" : " (unverified on this host)";
  return (
    `${mark} ${fixture.name}: intended ${fixture.intended}, got ` +
    `${fixture.result.verdict} (exit ${String(fixture.result.exitCode)}, ${measured})${suffix}`
  );
}

async function main(): Promise<void> {
  // pino writes to stdout, and stdout is the fixture payload. A single
  // info line from any module this imports would corrupt the JSON the CI
  // job redirects to a file, so refuse rather than emit something that
  // parses as neither.
  if (config.LOG_LEVEL !== "silent") {
    note(
      `captureMeasurements: LOG_LEVEL is "${config.LOG_LEVEL}", but the JSON array ` +
        "must be the only thing on stdout and pino logs there too. " +
        "Re-run with LOG_LEVEL=silent.",
    );
    // `process.exitCode` rather than `process.exit()`: when stdout or
    // stderr is a pipe (it is, under `docker run ... > fresh.json`),
    // `process.exit` can truncate a write that has not drained, and the
    // one thing this branch must not do is exit non-zero with no reason
    // printed.
    process.exitCode = 2;
    return;
  }

  // An emulated arm64 host does not enforce RLIMIT_AS and installs no
  // seccomp filter, so the tagged scenarios below run but prove nothing.
  // The x86_64 CI runner is `enforced` and asserts every one of them.
  const enforced = config.SECCOMP_STATUS === "enforced";
  if (!enforced) {
    note(
      "captureMeasurements: seccomp is disabled, so this host is emulated: " +
        "scenarios tagged rlimit_as/seccomp/native are captured but NOT asserted.",
    );
  }

  const fixtures: CapturedFixture[] = [];
  const differed: string[] = [];
  const unverified: string[] = [];

  for (const scenario of SCENARIOS) {
    const fixture = await capture(scenario);
    const asserted = enforced || scenario.requires.length === 0;
    note(describe(fixture, asserted));
    if (fixture.result.verdict !== fixture.intended) {
      if (asserted) {
        differed.push(
          `${fixture.name}: intended ${fixture.intended}, graded ${fixture.result.verdict}`,
        );
      } else {
        unverified.push(fixture.name);
      }
    } else if (!asserted) {
      unverified.push(fixture.name);
    }
    fixtures.push(fixture);
  }

  // Written whatever happened: a capture that disagrees with its intent
  // is exactly the run whose numbers a human needs to look at.
  process.stdout.write(`${JSON.stringify(fixtures, null, 2)}\n`);

  if (unverified.length > 0) {
    note(`captureMeasurements: unverified on this host: ${unverified.join(", ")}`);
  }
  if (differed.length > 0) {
    note("captureMeasurements: scenarios whose verdict is not what they exist to show:");
    for (const line of differed) note(`  - ${line}`);
    process.exitCode = 1;
    return;
  }
  note(`captureMeasurements: ${String(fixtures.length)} scenarios captured`);
}

main().catch((err: unknown) => {
  note(`captureMeasurements: ${(err as Error).message}`);
  process.exitCode = 1;
});
