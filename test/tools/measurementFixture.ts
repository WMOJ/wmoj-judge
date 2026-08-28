import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { RunMeasurement } from "../../src/types";
import type { CaseLimits } from "../../src/verdict";

/**
 * The one reader of `test/fixtures/measurements/*.json`.
 *
 * Both consumers — the ladder suite that replays every file, and the tool
 * that derives the unreachable-branch fixtures from captured ones — need
 * the same thing: a `RunMeasurement` built from parsed JSON without a
 * cast. A fixture whose `run` lost its `exitCode` would replay as
 * `exitCode: undefined` and grade something that never happened, on a
 * suite that looked green; naming each field is what turns a corrupt
 * file into a message that says which field and which file. Two copies of
 * that narrowing would be two places for the schema to drift.
 */

export const MEASUREMENTS_DIR = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "measurements",
);
export const DERIVED_MEASUREMENTS_DIR = path.join(MEASUREMENTS_DIR, "derived");

/**
 * One captured (or derived) measurement fixture, narrowed to the fields
 * the code reads. The file also carries `intended`, `note` and `requires`
 * for a human; the assertion is `result`.
 */
export interface MeasurementFixture {
  name: string;
  limits: CaseLimits;
  expected: string;
  run: RunMeasurement;
  /**
   * The recorded `TestResult`, kept as a plain record: it is only ever
   * deep-equalled against a freshly graded one, and typing it as
   * `TestResult` would need a cast that asserts the very shape the ladder
   * suite exists to verify.
   */
  result: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one required number, naming the field when it is not one. */
function num(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number") {
    throw new Error(`${where}: '${key}' must be a number`);
  }
  return value;
}

/** Read one optional number. Absent stays absent — that is the fact. */
function optionalNum(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number | undefined {
  if (!(key in source)) return undefined;
  return num(source, key, where);
}

/**
 * Build a `RunMeasurement` from parsed JSON, field by field.
 *
 * `runnerSignal` is the one narrowing that cannot be exhaustive —
 * `NodeJS.Signals` is a literal union of every signal name — so it is
 * checked as a string and asserted, which is as far as JSON can be
 * validated without restating the kernel's signal table here.
 */
function narrowRun(value: unknown, where: string): RunMeasurement {
  if (!isRecord(value)) throw new Error(`${where}: 'outcome.run' is not an object`);
  const exitCode = value.exitCode;
  if (!(typeof exitCode === "number" || exitCode === null)) {
    throw new Error(`${where}: 'exitCode' must be a number or null`);
  }
  const rawSignal = value.runnerSignal;
  if (!(typeof rawSignal === "string" || rawSignal === null)) {
    throw new Error(`${where}: 'runnerSignal' must be a string or null`);
  }
  const stdout = value.stdout;
  const stderr = value.stderr;
  const truncated = value.truncated;
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw new Error(`${where}: 'stdout'/'stderr' must be strings`);
  }
  if (typeof truncated !== "boolean") {
    throw new Error(`${where}: 'truncated' must be a boolean`);
  }
  const nodeTimerFired = value.nodeTimerFired;
  if (typeof nodeTimerFired !== "boolean") {
    throw new Error(`${where}: 'nodeTimerFired' must be a boolean`);
  }

  const run: RunMeasurement = {
    exitCode,
    runnerSignal: rawSignal === null ? null : (rawSignal as NodeJS.Signals),
    parentWallMs: num(value, "parentWallMs", where),
    nodeTimerFired,
    stdout,
    stderr,
    truncated,
  };
  // Assigned only when present: an absent `cpuMs` means no resource
  // report survived, and writing `undefined` into the key would make
  // `"cpuMs" in run` answer that question wrong.
  const cpuMs = optionalNum(value, "cpuMs", where);
  if (cpuMs !== undefined) run.cpuMs = cpuMs;
  const maxRssKb = optionalNum(value, "maxRssKb", where);
  if (maxRssKb !== undefined) run.maxRssKb = maxRssKb;
  const jailWallMs = optionalNum(value, "jailWallMs", where);
  if (jailWallMs !== undefined) run.jailWallMs = jailWallMs;
  const nsjailExit = optionalNum(value, "nsjailExit", where);
  if (nsjailExit !== undefined) run.nsjailExit = nsjailExit;
  const nsjailSignal = optionalNum(value, "nsjailSignal", where);
  if (nsjailSignal !== undefined) run.nsjailSignal = nsjailSignal;
  return run;
}

/**
 * Shape-check one parsed fixture. A hand-edited or half-written file must
 * name itself here rather than surface as a `Cannot read properties of
 * undefined` in the middle of an unrelated-looking assertion.
 */
export function narrowMeasurementFixture(
  value: unknown,
  where: string,
): MeasurementFixture {
  if (!isRecord(value)) throw new Error(`${where}: not an object`);
  const { name, limits, expected, outcome, result } = value;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${where}: missing a string 'name'`);
  }
  if (!isRecord(limits)) throw new Error(`${where}: missing a 'limits' object`);
  if (typeof expected !== "string") {
    throw new Error(`${where}: missing a string 'expected'`);
  }
  // A judge fault is never a fixture: nothing of the program ran, so
  // there is no verdict to pin. `captureMeasurements` refuses to record
  // one, and a file carrying one is corrupt.
  if (!isRecord(outcome) || outcome.ok !== true) {
    throw new Error(`${where}: 'outcome' must be an ok:true run measurement`);
  }
  if (!isRecord(result) || typeof result.verdict !== "string") {
    throw new Error(`${where}: missing a 'result' with a verdict`);
  }
  return {
    name,
    limits: {
      timeLimitMs: num(limits, "timeLimitMs", where),
      memLimitMb: num(limits, "memLimitMb", where),
    },
    expected,
    run: narrowRun(outcome.run, where),
    result,
  };
}

/** Read one fixture file by path. */
export function readMeasurementFixture(file: string): MeasurementFixture {
  return narrowMeasurementFixture(JSON.parse(readFileSync(file, "utf8")), file);
}

/**
 * Every fixture in a directory, sorted by file name. Throws — rather than
 * returning `[]` — when the directory is missing or empty, so a suite
 * built on it fails instead of passing on nothing.
 */
export function loadMeasurementFixtures(dir: string): MeasurementFixture[] {
  if (!existsSync(dir)) {
    throw new Error(
      `${dir} does not exist. The measurement fixtures are captured inside the ` +
        "image by dist/tools/captureMeasurements.js on the x86_64 CI runner; " +
        "the derived ones come from test/tools/deriveMeasurements.ts. Without " +
        "both directories the kill ladder is not covered at all, so this " +
        "fails rather than passing on nothing.",
    );
  }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`${dir} contains no fixtures — see the message above.`);
  }
  return files.map((file) => readMeasurementFixture(path.join(dir, file)));
}
