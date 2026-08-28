import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { RATE_LIMIT_ADVICE, health, isRateLimited, judgeUrl, post } from "./client";
import {
  SCENARIOS,
  projectResponse,
  resolveMeasured,
  resolvePath,
  satisfiesPredicate,
  type Fixture,
} from "./scenarios";

/**
 * Replay every committed golden transcript against a running judge.
 *
 * This is the gate that says a refactor changed no verdict. It compares
 * the status, deep-equals every deterministic field of the response
 * (including the ABSENCE of keys the judge omits when empty), matches the
 * declared patterns, and checks the measured numbers against their
 * predicates.
 *
 * The fixtures are captured on an x86_64 runner. On an arm64 laptop the
 * judge runs under QEMU with `UNSAFE_DISABLE_SECCOMP=true`, where
 * `RLIMIT_AS` is not enforced and no syscall filter is installed, so every
 * fixture that depends on either is skipped **by name with its reason** —
 * which is also why a verdict-affecting change is not verified until CI
 * is green.
 */

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "e2e");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(FIXTURES_DIR, file), "utf8"),
      );
      if (!isFixtureShaped(parsed)) {
        throw new Error(`malformed golden transcript: ${file}`);
      }
      return parsed;
    });
}

/**
 * Shape-check one parsed fixture. A hand-edited or half-written
 * transcript must name itself here rather than surface as a
 * `Cannot read properties of undefined` in the middle of an
 * unrelated-looking assertion.
 */
function isFixtureShaped(value: unknown): value is Fixture {
  if (!isRecord(value)) return false;
  const measured = value["measured"];
  return (
    typeof value["name"] === "string" &&
    typeof value["status"] === "number" &&
    Array.isArray(value["requires"]) &&
    isRecord(value["patterns"]) &&
    isRecord(measured) &&
    Array.isArray(measured["results"])
  );
}

/**
 * Read `seccomp` off `/health`. A judge that is not `ok` cannot produce a
 * comparable transcript — a missing toolchain or a sandbox that will not
 * launch would turn every fixture into a mass failure that says nothing
 * about the change under test — so this fails the suite with the judge's
 * own reason instead.
 */
async function seccompMode(): Promise<string> {
  const { status, body } = await health();
  if (status !== 200 || !isRecord(body)) {
    throw new Error(
      `judge at ${judgeUrl()} is not healthy (HTTP ${status}): ${JSON.stringify(body)}`,
    );
  }
  const seccomp = body["seccomp"];
  if (typeof seccomp !== "string") {
    throw new Error(`/health did not report seccomp: ${JSON.stringify(body)}`);
  }
  return seccomp;
}

function resultsOf(body: unknown): unknown[] | undefined {
  if (!isRecord(body)) return undefined;
  const results = body["results"];
  return Array.isArray(results) ? results : undefined;
}

const fixtures = loadFixtures();

if (fixtures.length === 0) {
  // An empty fixture directory must be a RED suite. A `for` loop over
  // nothing is a green run that proves nothing, and this suite's whole
  // job is to be the thing that noticed.
  test("golden transcripts are present", () => {
    assert.fail(
      `no golden transcripts in ${FIXTURES_DIR}. They are captured on an ` +
        "x86_64 runner and committed; see `npm run capture:e2e`.",
    );
  });
} else {
  test("every scenario has a golden transcript, and every transcript a scenario", () => {
    // A scenario added without a re-capture is a case nobody is checking,
    // and a fixture whose scenario is gone is replayed forever while
    // explaining nothing. Both are silent unless something says so.
    const captured = new Set(fixtures.map((f) => f.name));
    const declared = new Set(SCENARIOS.map((s) => s.name));
    assert.deepEqual(
      {
        missing: [...declared].filter((name) => !captured.has(name)),
        stale: [...captured].filter((name) => !declared.has(name)),
      },
      { missing: [], stale: [] },
      "run `npm run capture:e2e` against a judge on an amd64 kernel and commit the result",
    );
  });

  describe("golden transcripts", async () => {
    const seccomp = await seccompMode();

    for (const fixture of fixtures) {
      const needsRealKernel = fixture.requires.length > 0 && seccomp === "disabled";
      const reason = needsRealKernel
        ? `needs ${fixture.requires.join(" + ")} on an amd64 kernel; this judge reports seccomp: disabled`
        : undefined;
      const name =
        reason === undefined ? fixture.name : `${fixture.name} — skipped: ${reason}`;

      test(name, { skip: reason }, async () => {
        const exchange = await post(fixture.endpoint, fixture.request);

        // Distinguished from a real status change: a 429 says nothing
        // about the judge's behaviour, and it would otherwise fail every
        // remaining transcript with a misleading diff.
        assert.ok(
          !isRateLimited(exchange) || fixture.status === 429,
          RATE_LIMIT_ADVICE,
        );

        assert.equal(
          exchange.status,
          fixture.status,
          `status changed; body was ${JSON.stringify(exchange.body).slice(0, 400)}`,
        );

        assert.deepStrictEqual(
          projectResponse(exchange.body, fixture.patterns, fixture.measured),
          fixture.response,
        );

        for (const [jsonPath, source] of Object.entries(fixture.patterns)) {
          const value = resolvePath(exchange.body, jsonPath);
          assert.equal(
            typeof value,
            "string",
            `${jsonPath} is missing or not a string: ${JSON.stringify(value)?.slice(0, 200)}`,
          );
          assert.match(String(value), new RegExp(source, "m"));
        }

        const results = resultsOf(exchange.body) ?? [];
        assert.equal(
          fixture.measured.results.length,
          results.length,
          "the fixture's predicates are not index-aligned with the live results",
        );

        for (const [index, predicates] of fixture.measured.results.entries()) {
          const result = results[index];
          for (const [key, predicate] of Object.entries(predicates)) {
            const actual = resolveMeasured(result, key);
            assert.notEqual(
              actual,
              undefined,
              `results[${index}].${key} is missing from the response`,
            );
            assert.ok(
              satisfiesPredicate(Number(actual), predicate),
              `results[${index}].${key} = ${String(actual)} fails ${predicate}`,
            );
          }

          // A contract invariant of every result, and the one field pair
          // no fixture needs to record: `received` IS `stdout`.
          if (isRecord(result)) {
            const { stdout, received } = result;
            if (typeof stdout === "string" || typeof received === "string") {
              assert.equal(received, stdout, `results[${index}]: received must equal stdout`);
            }
          }
        }
      });
    }
  });
}
