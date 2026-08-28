import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import type { RunMeasurement, TestResult } from "../../src/types";
import { compare } from "../../src/compare";
import { gradeCase, type CaseLimits, type Judge } from "../../src/verdict";

/**
 * Produce the derived measurement fixtures from the captured ones.
 *
 *   npx tsx test/tools/deriveMeasurements.ts            # (re)write derived/
 *   npx tsx test/tools/deriveMeasurements.ts --check    # exit 1 if stale
 *
 * The kill ladder has branches no program can reach on this host: a
 * SIGXCPU with no resource report (Linux sends SIGKILL, not SIGXCPU, when
 * `RLIMIT_CPU`'s soft and hard limits are equal, as nsjail sets them), a
 * SIGSYS (`policy.kafel`'s default action is `ERRNO`, never `KILL`), a
 * SIGKILL that lands inside the budget, a runner that was itself
 * signalled. A fixture for each is still worth having — they are the
 * branches a reorder would silently break — so each is made from a real
 * capture by changing the one or two fields that select the branch, and
 * `gradeCase` decides the recorded `result` exactly as it would for a
 * captured file. The transformation is written into the fixture so a
 * reader can see it is not a recording.
 *
 * This tool exists so that claim stays true. A derived fixture edited by
 * hand, or one whose base was recaptured with a different `stderr`, would
 * still replay green — `gradeCase` is self-consistent over any input — but
 * would no longer be what it says it is. `--check` regenerates every file
 * into memory and compares it with what is committed; CI runs it beside
 * the unit suite, so the derived directory can only be changed through
 * this file.
 */

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures", "measurements");
const DERIVED_DIR = path.join(FIXTURES_DIR, "derived");

/** A captured fixture, narrowed to what a derivation reads. */
interface CapturedFixture {
  limits: CaseLimits;
  expected: string;
  outcome: { ok: true; run: RunMeasurement };
}

interface DerivedFixture {
  name: string;
  intended: TestResult["verdict"];
  note: string;
  requires: never[];
  derivedFrom: string;
  transformation: string;
  limits: CaseLimits;
  expected: string;
  outcome: { ok: true; run: RunMeasurement };
  result: TestResult;
}

interface Derivation {
  name: string;
  from: string;
  intended: TestResult["verdict"];
  note: string;
  /** Prose for the fixture file; must say the same thing `apply` does. */
  transformation: string;
  apply: (run: RunMeasurement, limits: CaseLimits) => void;
}

/**
 * "No report survived" means every field the report carries is absent,
 * not just the three the ladder reads — a half-present report is a shape
 * `interpretRun` never produces.
 */
function dropReport(run: RunMeasurement): void {
  delete run.cpuMs;
  delete run.maxRssKb;
  delete run.jailWallMs;
  delete run.nsjailExit;
  delete run.nsjailSignal;
}

const DERIVATIONS: readonly Derivation[] = [
  {
    name: "sigxcpu-no-report",
    from: "rlimit-cpu-kill",
    intended: "TLE",
    note: "ladder step 6 with nothing else to go on — SIGXCPU decoded from the exit status alone",
    transformation:
      "exitCode: 152 (128+SIGXCPU); the whole resource report removed; parentWallMs: 12 so no earlier step can decide it",
    apply: (run) => {
      run.exitCode = 152;
      dropReport(run);
      run.parentWallMs = 12;
    },
  },
  {
    name: "sigsys-denied",
    from: "segfault",
    intended: "RE",
    note: "ladder step 6 — SIGSYS (128+31), unreachable on this policy because its DEFAULT is ERRNO, not KILL",
    transformation: "exitCode: 159",
    apply: (run) => {
      run.exitCode = 159;
    },
  },
  {
    name: "sigkill-in-budget",
    from: "segfault",
    intended: "RE",
    note: "ladder step 6 — a SIGKILL inside the budget stays a runtime error",
    transformation: "exitCode: 137; jailWallMs: 100",
    apply: (run) => {
      run.exitCode = 137;
      run.jailWallMs = 100;
    },
  },
  {
    name: "sigkill-over-budget",
    from: "segfault",
    intended: "TLE",
    note: "ladder step 6 — a SIGKILL on a run that already outlived its budget is a timeout",
    transformation: "exitCode: 137; jailWallMs: 5000",
    apply: (run) => {
      run.exitCode = 137;
      run.jailWallMs = 5000;
    },
  },
  {
    name: "wall-backstop",
    from: "nonzero-exit",
    intended: "TLE",
    note: "ladder step 4 — the wall backstop on a program that burned no CPU",
    transformation: "jailWallMs: 7000",
    apply: (run) => {
      run.jailWallMs = 7000;
    },
  },
  {
    name: "runner-signalled",
    from: "clean-exit",
    intended: "RE",
    note: "ladder step 7 — the runner itself was signalled, so nothing of the program is trustworthy",
    transformation: "exitCode: null; runnerSignal: SIGKILL",
    apply: (run) => {
      run.exitCode = null;
      run.runnerSignal = "SIGKILL";
    },
  },
  {
    name: "rss-99-clean",
    from: "clean-exit",
    intended: "AC",
    note: "ladder step 5 after step 3 — 99% of the cap on a clean exit is still AC",
    transformation: "maxRssKb: floor(0.99 * memLimitMb * 1024)",
    apply: (run, limits) => {
      run.maxRssKb = Math.floor(0.99 * limits.memLimitMb * 1024);
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one captured fixture. Narrowed just far enough to derive from: the
 * unit suite validates the full shape, and a derivation over a corrupt
 * base should fail there with the base's name, not here with a stack.
 */
function readCaptured(name: string): CapturedFixture {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(`${file}: the captured base of a derivation is missing`);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.limits) || !isRecord(parsed.outcome)) {
    throw new Error(`${file}: not a measurement fixture`);
  }
  const { limits, expected, outcome } = parsed;
  if (
    typeof limits.timeLimitMs !== "number" ||
    typeof limits.memLimitMb !== "number" ||
    typeof expected !== "string" ||
    outcome.ok !== true ||
    !isRecord(outcome.run)
  ) {
    throw new Error(`${file}: not an ok:true measurement fixture`);
  }
  return {
    limits: { timeLimitMs: limits.timeLimitMs, memLimitMb: limits.memLimitMb },
    expected,
    // The unit suite narrows this field by field; here the base has
    // already been replayed green by that suite before anyone derives
    // from it, and re-stating every field would be a second validator
    // that could disagree with the first.
    outcome: { ok: true, run: outcome.run as unknown as RunMeasurement },
  };
}

function trimTrailingJudge(expected: string): Judge {
  return async (received) => ({
    passed: compare("trim-trailing", expected, received),
  });
}

async function derive(d: Derivation): Promise<DerivedFixture> {
  const base = readCaptured(d.from);
  const run: RunMeasurement = { ...base.outcome.run };
  d.apply(run, base.limits);
  const result = await gradeCase(
    { index: 0, expected: base.expected, run, limits: base.limits },
    trimTrailingJudge(base.expected),
  );
  if (result.verdict !== d.intended) {
    throw new Error(
      `${d.name}: derived from ${d.from} and graded ${result.verdict}, ` +
        `but the derivation says ${d.intended}. Either the transformation ` +
        "no longer selects that ladder branch or the ladder changed; fix " +
        "one, do not commit the file.",
    );
  }
  return {
    name: d.name,
    intended: d.intended,
    note: d.note,
    requires: [],
    derivedFrom: d.from,
    transformation: d.transformation,
    limits: base.limits,
    expected: base.expected,
    outcome: { ok: true, run },
    result,
  };
}

function serialize(fixture: DerivedFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const d of DERIVATIONS) {
    const file = path.join(DERIVED_DIR, `${d.name}.json`);
    const text = serialize(await derive(d));
    if (check) {
      const committed = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (committed === text) {
        process.stderr.write(`ok     ${d.name}\n`);
      } else {
        stale += 1;
        process.stderr.write(
          `STALE  ${d.name}: ${committed === null ? "missing" : "differs from its derivation"}\n`,
        );
      }
    } else {
      writeFileSync(file, text);
      process.stderr.write(`wrote  ${d.name} <- ${d.from} (${d.intended})\n`);
    }
  }
  if (stale > 0) {
    process.stderr.write(
      `${String(stale)} derived fixture(s) are not what deriveMeasurements.ts ` +
        "produces. Re-run it without --check and commit the result.\n",
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
