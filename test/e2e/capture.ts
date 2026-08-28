import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { RATE_LIMIT_ADVICE, isRateLimited, judgeUrl, post } from "./client";
import {
  DEFAULT_MEASURED,
  SCENARIOS,
  projectResponse,
  type Fixture,
  type Measured,
  type Scenario,
} from "./scenarios";

/**
 * Record every scenario against a RUNNING judge and write the golden
 * transcripts under `test/fixtures/e2e/`.
 *
 * This tool **records; it does not judge**. It asserts nothing about a
 * verdict, because a capture that enforced the intended outcome could
 * only ever confirm what it already believed. What it prints instead is a
 * table of what the judge actually did beside what the scenario says it
 * should do — the one point in this pipeline where a human confirms the
 * baseline is right rather than merely reproducible.
 *
 * Capture belongs on an x86_64 runner. On an arm64 host the fixtures
 * tagged `rlimit_as` or `seccomp` record emulated behaviour (no MLE, no
 * syscall filter) and must be discarded.
 */

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "e2e");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One predicate set per result, so a fixture's `measured` is index-aligned
 * with the `results` it was captured from. A body with no `results` (a
 * 4xx, a compile error, `/generate-tests`) records an empty list.
 */
function measurementsFor(scenario: Scenario, body: unknown): Measured {
  const results = isRecord(body) ? body["results"] : undefined;
  if (!Array.isArray(results)) return { results: [] };
  const perResult = { ...DEFAULT_MEASURED, ...scenario.measured };
  return { results: results.map(() => ({ ...perResult })) };
}

/** A one-line summary of what the judge did, for the review table. */
function outcomeOf(body: unknown): string {
  if (!isRecord(body)) return "non-JSON body";
  const results = body["results"];
  if (Array.isArray(results) && results.length > 0) {
    return results
      .map((r: unknown) => (isRecord(r) ? String(r["verdict"]) : "?"))
      .join(",");
  }
  for (const field of ["compileError", "checkerError", "error", "reason"]) {
    const value = body[field];
    if (typeof value === "string") {
      return `${field}: ${value.split("\n")[0] ?? ""}`.slice(0, 60);
    }
  }
  if (Array.isArray(body["input"])) return `${body["input"].length} generated cases`;
  return "(no results)";
}

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  process.stdout.write(`capturing ${SCENARIOS.length} scenarios from ${judgeUrl()}\n\n`);

  for (const scenario of SCENARIOS) {
    const exchange = await post(scenario.endpoint, scenario.request);
    // Recording a 429 as a golden transcript would bake the rate limiter's
    // refusal in as the judge's answer, and every scenario after it too.
    if (isRateLimited(exchange)) {
      throw new Error(`${scenario.name}: ${RATE_LIMIT_ADVICE}`);
    }
    // A 5xx is the JUDGE being wrong — a sandbox fault, never a verdict —
    // so it is never a baseline. Recording one would pin a judge fault as
    // this scenario's correct behaviour and every later replay would
    // demand it back. (Under QEMU on arm64 the jail runner does crash
    // sporadically; on the amd64 runner this should never fire.)
    if (exchange.status >= 500) {
      throw new Error(
        `${scenario.name}: judge fault (HTTP ${exchange.status}) ` +
          `${JSON.stringify(exchange.body).slice(0, 300)} — nothing was graded, so there is ` +
          "nothing to record; re-run the capture",
      );
    }
    const patterns = { ...scenario.patterns };
    const measured = measurementsFor(scenario, exchange.body);
    const fixture: Fixture = {
      name: scenario.name,
      endpoint: scenario.endpoint,
      request: scenario.request,
      requires: [...scenario.requires],
      status: exchange.status,
      response: projectResponse(exchange.body, patterns, measured),
      patterns,
      measured,
    };
    writeFileSync(
      path.join(FIXTURES_DIR, `${scenario.name}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${scenario.name.padEnd(26)} ${String(exchange.status).padEnd(4)} ${outcomeOf(
        exchange.body,
      ).padEnd(34)} | intended: ${scenario.intended}\n`,
    );
  }

  // A fixture no scenario declares is replayed forever and explains
  // nothing; say so rather than leaving it to be discovered on a failure.
  const declared = new Set(SCENARIOS.map((s) => `${s.name}.json`));
  const stale = readdirSync(FIXTURES_DIR).filter(
    (file) => file.endsWith(".json") && !declared.has(file),
  );
  if (stale.length > 0) {
    process.stdout.write(
      `\nWARNING: ${stale.length} fixture(s) in ${FIXTURES_DIR} are not declared in scenarios.ts: ${stale.join(", ")}\n`,
    );
  }

  process.stdout.write(`\nwrote ${SCENARIOS.length} fixtures to ${FIXTURES_DIR}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`capture failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
