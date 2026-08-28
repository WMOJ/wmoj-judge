import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Diff a fresh measurement capture against the committed fixtures.
 *
 *   npx tsx test/tools/diffMeasurements.ts fresh.json test/fixtures/measurements
 *
 * A fixture is only as true as its last capture. The nsjail-3.3 log
 * scraper matched nothing for the entire life of the pin, so `cpuMs` and
 * `memKb` were `0` on every run and every RSS-based rule was dead — with
 * no error, no log line, and a green test suite the whole time. This tool
 * is what makes that class of drift loud: CI re-captures inside a freshly
 * built image whenever anything under `Dockerfile`, `policy.kafel`,
 * `src/sandbox/**`, `src/verdict/**` or `src/tools/**` changes, and a
 * sandbox that has started reporting something different fails the build
 * instead of quietly passing a stale suite.
 *
 * What it compares is deliberately narrow: the fields a correct judge
 * reproduces byte for byte on any host. `timeMs`, `cpuMs` and `memKb` are
 * measurements — no two runs agree on them and pinning them would make
 * the job flap — so they are excluded from `result`, and only the
 * PRESENCE of `cpuMs` on the run is checked, because "absent" carries the
 * real fact (the group was force-killed before the runner could report)
 * while its value does not.
 *
 * `derived/` is not compared. Those fixtures are hand-made from a
 * captured one by a documented transformation, for the ladder branches no
 * program can reach on this host; a capture cannot produce them and their
 * absence from a fresh run is not drift.
 */

/** Fields of `result` that are measurements rather than facts. */
const MEASURED_RESULT_FIELDS = new Set(["timeMs", "cpuMs", "memKb"]);

/** Fields of `run` compared by value. `cpuMs` is compared by presence. */
const COMPARED_RUN_FIELDS = [
  "exitCode",
  "runnerSignal",
  "nodeTimerFired",
  "stdout",
  "stderr",
  "truncated",
] as const;

interface Difference {
  scenario: string;
  field: string;
  expected: string;
  actual: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One captured fixture, narrowed only as far as this tool reads it. A
 * malformed or half-written file must name itself here rather than
 * surface as `Cannot read properties of undefined` inside a comparison.
 */
interface CapturedShape {
  name: string;
  outcome: Record<string, unknown>;
  result: Record<string, unknown>;
}

function narrow(value: unknown, where: string): CapturedShape {
  if (!isRecord(value)) throw new Error(`${where}: not an object`);
  const { name, outcome, result } = value;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${where}: missing a string 'name'`);
  }
  if (!isRecord(outcome)) throw new Error(`${where}: missing an 'outcome' object`);
  if (!isRecord(result)) throw new Error(`${where}: missing a 'result' object`);
  return { name, outcome, result };
}

function loadFresh(file: string): CapturedShape[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON array of captured scenarios`);
  }
  return parsed.map((entry, i) => narrow(entry, `${file}[${String(i)}]`));
}

function loadFixtures(dir: string): Map<string, CapturedShape> {
  if (!existsSync(dir)) {
    throw new Error(`${dir}: no committed fixtures to diff against`);
  }
  const byName = new Map<string, CapturedShape>();
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    // Top level only: `derived/` is hand-made and has no fresh counterpart.
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    const full = path.join(dir, file.name);
    const fixture = narrow(JSON.parse(readFileSync(full, "utf8")), full);
    byName.set(fixture.name, fixture);
  }
  return byName;
}

/** Render a value for a diff line without ever printing `[object Object]`. */
function show(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function compareRun(
  scenario: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  out: Difference[],
): void {
  for (const field of COMPARED_RUN_FIELDS) {
    if (show(expected[field]) !== show(actual[field])) {
      out.push({
        scenario,
        field: `outcome.run.${field}`,
        expected: show(expected[field]),
        actual: show(actual[field]),
      });
    }
  }
  // Presence, not value: an absent `cpuMs` means no resource report
  // survived, which happens on exactly one path (the judge force-killed
  // the group). A report that started or stopped arriving is drift; the
  // number itself is not.
  const had = "cpuMs" in expected;
  const has = "cpuMs" in actual;
  if (had !== has) {
    out.push({
      scenario,
      field: "outcome.run.cpuMs (presence)",
      expected: had ? "present" : "absent",
      actual: has ? "present" : "absent",
    });
  }
}

function compareOne(
  expected: CapturedShape,
  actual: CapturedShape,
  out: Difference[],
): void {
  const name = expected.name;
  if (show(expected.outcome.ok) !== show(actual.outcome.ok)) {
    out.push({
      scenario: name,
      field: "outcome.ok",
      expected: show(expected.outcome.ok),
      actual: show(actual.outcome.ok),
    });
    // Nothing below is comparable across the two arms of the union.
    return;
  }

  if (expected.outcome.ok === true) {
    const expectedRun = expected.outcome.run;
    const actualRun = actual.outcome.run;
    if (!isRecord(expectedRun) || !isRecord(actualRun)) {
      out.push({
        scenario: name,
        field: "outcome.run",
        expected: isRecord(expectedRun) ? "an object" : show(expectedRun),
        actual: isRecord(actualRun) ? "an object" : show(actualRun),
      });
    } else {
      compareRun(name, expectedRun, actualRun, out);
    }
  }

  // Every key of `result` except the measured numbers, in BOTH
  // directions, so a field that appeared (or an omitted-when-empty key
  // like `truncated` that stopped being omitted) is a difference too.
  const fields = new Set([
    ...Object.keys(expected.result),
    ...Object.keys(actual.result),
  ]);
  for (const field of fields) {
    if (MEASURED_RESULT_FIELDS.has(field)) continue;
    if (show(expected.result[field]) !== show(actual.result[field])) {
      out.push({
        scenario: name,
        field: `result.${field}`,
        expected: show(expected.result[field]),
        actual: show(actual.result[field]),
      });
    }
  }
}

function main(): void {
  const [, , freshFile, fixturesDir] = process.argv;
  if (freshFile === undefined || fixturesDir === undefined) {
    process.stderr.write(
      "usage: diffMeasurements <fresh.json> <fixtures-dir>\n",
    );
    process.exitCode = 2;
    return;
  }

  const fresh = loadFresh(freshFile);
  const committed = loadFixtures(fixturesDir);
  const differences: Difference[] = [];

  const seen = new Set<string>();
  for (const actual of fresh) {
    seen.add(actual.name);
    const expected = committed.get(actual.name);
    if (expected === undefined) {
      // A new scenario is drift until someone commits its fixture:
      // otherwise the corpus silently stops covering what the tool runs.
      differences.push({
        scenario: actual.name,
        field: "(fixture)",
        expected: "a committed fixture",
        actual: "none — captured but not committed",
      });
      continue;
    }
    compareOne(expected, actual, differences);
  }
  for (const name of committed.keys()) {
    if (seen.has(name)) continue;
    differences.push({
      scenario: name,
      field: "(scenario)",
      expected: "captured by captureMeasurements",
      actual: "none — the fixture is committed but nothing produces it",
    });
  }

  if (differences.length === 0) {
    process.stdout.write(
      `diffMeasurements: ${String(fresh.length)} scenarios match the committed fixtures\n`,
    );
    return;
  }

  process.stderr.write(
    `diffMeasurements: ${String(differences.length)} difference(s) between ` +
      `${freshFile} and ${fixturesDir}\n`,
  );
  for (const d of differences) {
    process.stderr.write(
      `  ${d.scenario} · ${d.field}\n      committed: ${d.expected}\n      fresh:     ${d.actual}\n`,
    );
  }
  // Set rather than called: `process.exit()` can truncate the diff above
  // when stderr is a pipe, and a CI failure with no diff printed is a
  // failure nobody can act on.
  process.exitCode = 1;
}

main();
