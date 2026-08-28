import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Every golden transcript the judge's externally observable behaviour is
 * pinned by, and the vocabulary a transcript is written in.
 *
 * A **golden transcript** is one recorded `/submit` or `/generate-tests`
 * exchange: the exact request, the status, and the parts of the response
 * that are byte-stable. `capture.ts` records them against a live judge;
 * `replay.test.ts` re-POSTs them and diffs. Everything a transcript
 * cannot compare byte-for-byte is described rather than recorded, in one
 * of two ways:
 *
 *  - **patterns** — a regex source for a field whose text is stable in
 *    shape but not in bytes (a g++ diagnostic, a Python traceback that
 *    carries the per-submission workdir path). Matched with the `m` flag,
 *    because g++ prints `Main.cpp: In function 'int main()':` first and
 *    the interesting line is the second one.
 *  - **measured** — a predicate for a number no two runs agree on
 *    (`cpuMs`, `memKb`, `timeMs`) or a string too big to commit
 *    (2 MiB of stdout). Written as `<op><value>`: `">=0"`, `">0"`,
 *    `">=500"`, `"===1048576"`.
 *
 * Between them those two also say which fields are NOT compared, so a
 * fixture needs nothing beyond them to describe its own projection — see
 * `projectResponse`. Everything else in the body, including the ABSENCE
 * of a key (`truncated` and `checkerMessage` are omitted when empty, and
 * `checkerError` must never arrive alongside `compileError`), is compared
 * exactly.
 */

export type Endpoint = "/submit" | "/generate-tests";

/**
 * A kernel capability a transcript depends on. Both are unavailable under
 * QEMU on an arm64 host, where `/health` reports `seccomp: "disabled"`:
 * `RLIMIT_AS` is silently not enforced (so MLE cannot fire) and the amd64
 * BPF program cannot be installed (so nothing is filtered).
 */
export type Requirement = "rlimit_as" | "seccomp";

/** A predicate over one measured number, as `<op><value>`. */
export type Predicate = `${">=" | ">" | "<=" | "<" | "==="}${number}`;

/**
 * What a predicate can be attached to on a `TestResult`: the three
 * measured numbers, or the LENGTH of a captured stream (used where the
 * bytes themselves are too big to commit).
 */
export type MeasuredKey =
  | "cpuMs"
  | "memKb"
  | "timeMs"
  | "stdout.length"
  | "received.length";

export type ResultMeasurements = Partial<Record<MeasuredKey, Predicate>>;

/** Predicates for each result, index-aligned with `results`. */
export interface Measured {
  results: ResultMeasurements[];
}

/**
 * Regex sources keyed by a response path: a top-level field
 * (`compileError`) or one result's field (`results[0].stderr`).
 */
export type Patterns = Readonly<Record<string, string>>;

/**
 * A `/submit` body. `language` and `compareMode` are typed as `string`
 * rather than the union in `types.ts` on purpose: several scenarios exist
 * precisely to pin what the judge does with a value the union forbids
 * (`"java"`), or with a legacy alias the union still allows but the
 * request should be seen to spell out (`"cpp"`).
 */
export interface SubmitRequestBody {
  language: string;
  code: string;
  input: string[];
  output: string[];
  timeLimit?: number;
  memoryLimit?: number;
  compareMode?: string;
  checker?: string;
}

export interface GenerateTestsRequestBody {
  code: string;
  language?: string;
}

export interface Scenario {
  readonly name: string;
  readonly endpoint: Endpoint;
  readonly request: SubmitRequestBody | GenerateTestsRequestBody;
  readonly requires: readonly Requirement[];
  /**
   * What this transcript is supposed to show, in one line. Never
   * asserted — `capture.ts` prints it beside what the judge actually did
   * so a human can confirm the baseline is what the judge SHOULD do, not
   * merely what it does.
   */
  readonly intended: string;
  readonly patterns?: Patterns;
  /** Overrides merged over `DEFAULT_MEASURED`, applied to every result. */
  readonly measured?: ResultMeasurements;
}

/** One recorded transcript, as committed under `test/fixtures/e2e/`. */
export interface Fixture {
  name: string;
  endpoint: Endpoint;
  request: SubmitRequestBody | GenerateTestsRequestBody;
  requires: Requirement[];
  status: number;
  /** The response body with every non-deterministic field projected out. */
  response: unknown;
  patterns: Record<string, string>;
  measured: Measured;
}

/**
 * `cpuMs` is `">=0"` rather than `">0"` because a run that is killed by
 * Node's last-resort timer leaves no resource report at all; the
 * scenarios where CPU time is the point state their own floor.
 */
export const DEFAULT_MEASURED: ResultMeasurements = {
  cpuMs: ">=0",
  memKb: ">0",
  timeMs: ">0",
};

const PROGRAMS_DIR = path.join(__dirname, "programs");
const REPO_ROOT = path.join(__dirname, "..", "..");

/** Read a scenario program at declaration time, so a missing one fails loudly. */
function program(file: string): string {
  return readFileSync(path.join(PROGRAMS_DIR, file), "utf8");
}

/**
 * The reference checker shipped in the repo. Read from `examples/` rather
 * than copied so a transcript cannot drift from the checker an admin is
 * told to start from.
 */
const REFERENCE_CHECKER = readFileSync(
  path.join(REPO_ROOT, "examples", "checkers", "any-valid-pair.cpp"),
  "utf8",
);

const SUM_INPUT = ["1 2\n", "10 20\n", "-5 5\n"];
const SUM_OUTPUT = ["3\n", "30\n", "0\n"];

/** One byte past `MAX_INPUT_BYTES_PER_CASE`. */
const OVERSIZED_INPUT = "a".repeat(1_000_001);

/** One case past `MAX_INPUT_CASES`. */
const TOO_MANY_INPUTS = Array<string>(201).fill("1 2\n");
const TOO_MANY_OUTPUTS = Array<string>(201).fill("3\n");

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "ac-cpp17",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: SUM_INPUT,
      output: SUM_OUTPUT,
    },
    requires: [],
    intended: "3x AC",
  },
  {
    name: "ac-python3",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("sum.py"),
      input: SUM_INPUT,
      output: SUM_OUTPUT,
    },
    requires: [],
    intended: "3x AC",
    // An interpreter start alone is milliseconds of real CPU, so this is
    // where a return to the `cpuMs: 0` regression would show up first.
    measured: { cpuMs: ">0" },
  },
  {
    name: "ac-pypy3-floor",
    endpoint: "/submit",
    request: {
      language: "pypy3",
      code: program("sum.py"),
      input: SUM_INPUT,
      output: SUM_OUTPUT,
      memoryLimit: 256,
    },
    requires: [],
    intended: "3x AC; effectiveMemoryLimitMb 384 (the pypy3 floor beats the request)",
    measured: { cpuMs: ">0" },
  },
  {
    name: "ac-ceiling-clamp",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: SUM_INPUT,
      output: SUM_OUTPUT,
      memoryLimit: 1024,
    },
    requires: [],
    intended: "3x AC; effectiveMemoryLimitMb 384 (clamped to the host ceiling)",
  },
  {
    name: "ac-fractional-limit",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: SUM_INPUT,
      output: SUM_OUTPUT,
      memoryLimit: 300.75,
    },
    requires: [],
    intended: "3x AC; effectiveMemoryLimitMb 300 (floored, so advertised == enforced)",
  },
  {
    name: "wa-trim-trailing",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum-trailing-space.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "AC — the default comparator ignores the trailing space",
  },
  {
    name: "wa-exact",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum-trailing-space.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
      compareMode: "exact",
    },
    requires: [],
    intended: "WA — the same output, byte-compared",
  },
  {
    name: "wa-float-epsilon",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("one-third.py"),
      input: ["1\n"],
      output: ["0.333333333\n"],
      compareMode: "exact",
    },
    requires: [],
    intended: "WA — 0.3333333 is not byte-equal to 0.333333333",
    measured: { cpuMs: ">0" },
  },
  {
    name: "ac-float-epsilon",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("one-third.py"),
      input: ["1\n"],
      output: ["0.333333333\n"],
      compareMode: "float-epsilon",
    },
    requires: [],
    intended: "AC — the same pair, inside the 1e-6 tolerance",
    measured: { cpuMs: ">0" },
  },
  {
    name: "re-nonzero-correct-output",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("nonzero-correct-output.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "RE with passed:false — correct output does not rescue a non-zero exit",
  },
  {
    name: "re-segfault",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("segfault.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "RE, exitCode 139 (nsjail reports 128 + SIGSEGV)",
  },
  {
    name: "re-python-exception",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("raise-value-error.py"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "RE with the traceback on stderr",
    // The traceback names the per-submission workdir, which carries a
    // nanoid: only the exception is stable.
    patterns: { "results[0].stderr": "ValueError" },
    measured: { cpuMs: ">0" },
  },
  {
    name: "tle-cpu-burn",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("cpu-burn.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
      timeLimit: 500,
    },
    requires: [],
    intended: "TLE with timedOut:true, from the authoritative CPU-time gate",
    measured: { cpuMs: ">=500" },
  },
  {
    name: "tle-sleep-killed",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("sleep-10.py"),
      input: ["1 2\n"],
      output: ["3\n"],
      timeLimit: 500,
    },
    requires: [],
    intended: "TLE — no CPU is consumed, so Node's SIGKILL timer ends it and no report survives",
    // Killed by the process-group SIGKILL: the jail runner never writes a
    // report, so cpuMs and memKb are both 0 and only wall time exists.
    measured: { cpuMs: ">=0", memKb: ">=0" },
  },
  {
    name: "sleepy-but-finished",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("sleep-2-then-print.py"),
      input: ["1 2\n"],
      output: ["3\n"],
      timeLimit: 500,
    },
    requires: [],
    intended: "AC — the clean-exit guard beats the 3x wall backstop",
    measured: { cpuMs: ">0" },
  },
  {
    name: "mle-refused-allocation",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("refuse-allocation.cpp"),
      input: ["1\n"],
      output: ["1\n"],
      timeLimit: 2000,
      memoryLimit: 256,
    },
    requires: ["rlimit_as"],
    intended: "MLE, exit 134, std::bad_alloc on stderr (RLIMIT_AS refuses, never kills)",
  },
  {
    name: "mle-python-memoryerror",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("memoryerror.py"),
      input: ["1\n"],
      output: ["1\n"],
      timeLimit: 2000,
      memoryLimit: 256,
    },
    requires: ["rlimit_as"],
    intended: "MLE — MemoryError is the interpreted-language allocation signature",
    measured: { cpuMs: ">0" },
  },
  {
    name: "seccomp-socket-denied",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("socket-denied.cpp"),
      input: ["1\n"],
      output: ["fd=-1 errno=1\n"],
    },
    requires: ["seccomp"],
    intended:
      "AC — socket() is refused with EPERM by policy.kafel's ERRNO(1) block; " +
      "an unfiltered judge prints a live fd here and this goes WA",
  },
  {
    name: "truncated-stdout",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("truncated-stdout.cpp"),
      input: ["1\n"],
      output: ["x\n"],
    },
    requires: [],
    intended: "WA with truncated:true and exactly 1 MiB retained",
    // The 1 MiB of `x` is described, not committed: the length is the
    // whole assertion, and `stdout === received` is checked for every
    // result by the replay itself.
    measured: {
      "stdout.length": "===1048576",
      "received.length": "===1048576",
    },
  },
  {
    name: "nul-in-output",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("nul-in-output.cpp"),
      input: ["1\n"],
      output: ["0\n"],
    },
    requires: [],
    intended: "WA with received U+FFFD — a NUL would be unstorable in jsonb",
  },
  {
    name: "empty-input-stays-empty",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("stdin-repr.py"),
      input: [""],
      output: ["''\n"],
    },
    requires: [],
    intended: "AC — an empty input must not become one blank line",
    measured: { cpuMs: ">0" },
  },
  {
    name: "input-newline-appended",
    endpoint: "/submit",
    request: {
      language: "python3",
      code: program("stdin-repr.py"),
      input: ["1 2"],
      output: ["'1 2\\n'\n"],
    },
    requires: [],
    intended: "AC — a non-empty input with no trailing newline gets one",
    measured: { cpuMs: ">0" },
  },
  {
    name: "compile-error",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("missing-semicolon.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "HTTP 200 with summary 0/0/0, no results, and compileError",
    // A compile error is HTTP 200 on this endpoint: wmoj-app synthesizes
    // the user-facing CE. The diagnostic text moves with the compiler, so
    // only its first-line shape is pinned.
    patterns: { compileError: "^Main\\.cpp:\\d+:\\d+: error" },
  },
  {
    name: "checker-accept-reject",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("print-pair.cpp"),
      input: ["3 3\n1 2 5\n", "3 9\n1 2 7\n"],
      output: ["1 2", "2 3"],
      checker: REFERENCE_CHECKER,
    },
    requires: [],
    intended:
      "case 0 AC (a different valid pair is accepted), case 1 WA with the checker's explanation",
  },
  {
    name: "checker-internal-error",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("print-pair.cpp"),
      input: ["3 3\n1 2 5\n"],
      output: ["1 2"],
      checker: program("checker-internal-error.cpp"),
    },
    requires: [],
    intended: "IE with checkerMessage, counted as failed — a problem fault, not the student's",
  },
  {
    name: "checker-crash",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("print-pair.cpp"),
      input: ["3 3\n1 2 5\n"],
      output: ["1 2"],
      checker: program("checker-crash.cpp"),
    },
    requires: [],
    intended: "IE with no checkerMessage — a checker that died by a signal never answered",
  },
  {
    name: "checker-compile-error",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("print-pair.cpp"),
      input: ["3 3\n1 2 5\n"],
      output: ["1 2"],
      checker: program("checker-broken.cpp"),
    },
    requires: [],
    intended: "HTTP 200 with checkerError and NO compileError — the student compiled fine",
    patterns: { checkerError: "(^|/)Checker\\.cpp:\\d+:\\d+: error" },
  },
  {
    name: "checker-not-run-on-crash",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("segfault.cpp"),
      input: ["3 3\n1 2 5\n"],
      output: ["1 2"],
      checker: program("checker-accept.cpp"),
    },
    requires: [],
    intended: "RE with no checkerMessage — a crashed run never reaches the checker",
  },
  {
    name: "400-bad-language",
    endpoint: "/submit",
    request: {
      language: "java",
      code: program("sum.cpp"),
      input: ["1 2\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "400 — Java was removed",
  },
  {
    name: "400-unequal-arrays",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: ["1 2\n", "3 4\n"],
      output: ["3\n"],
    },
    requires: [],
    intended: "400 — input and output must be the same length",
  },
  {
    name: "413-too-many-cases",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: TOO_MANY_INPUTS,
      output: TOO_MANY_OUTPUTS,
    },
    requires: [],
    intended: '413 {reason: "too many test cases (max 200)"} from requestCaps, before the route',
  },
  {
    name: "413-input-too-large",
    endpoint: "/submit",
    request: {
      language: "cpp17",
      code: program("sum.cpp"),
      input: [OVERSIZED_INPUT],
      output: ["3\n"],
    },
    requires: [],
    intended: '413 {reason: "input[0] exceeds 1MB"}',
  },
  {
    name: "generator-ok",
    endpoint: "/generate-tests",
    request: {
      // "cpp" on purpose: this is the language code judge.sh sends, and
      // it stays accepted here after /submit's aliases are removed.
      language: "cpp",
      code: program("generator-ok.cpp"),
    },
    requires: [],
    intended: "200 with inputJson/outputJson and the coerced input/output arrays",
  },
  {
    name: "generator-nonzero-exit",
    endpoint: "/generate-tests",
    request: { language: "cpp", code: program("generator-nonzero-exit.cpp") },
    requires: [],
    intended: "400 naming the generator's exit code (the text changes in the verdict commit)",
  },
  {
    name: "generator-bad-json",
    endpoint: "/generate-tests",
    request: { language: "cpp", code: program("generator-bad-json.cpp") },
    requires: [],
    intended: "400 Invalid JSON on stdout, echoing the raw streams",
  },
  {
    name: "generator-too-many-cases",
    endpoint: "/generate-tests",
    request: { language: "cpp", code: program("generator-too-many-cases.cpp") },
    requires: [],
    intended:
      '400 {reason: "too many test cases (max 200)"} — the judge refuses to hand an admin ' +
      "data /submit would reject",
  },
  {
    name: "generator-compile-error",
    endpoint: "/generate-tests",
    request: { language: "cpp", code: program("generator-broken.cpp") },
    requires: [],
    intended: "400 — a generator compile failure is 400, the opposite of /submit's 200",
    patterns: { error: "(^|/)Generator\\.cpp:\\d+:\\d+: error" },
  },
];

const PREDICATE_RE = /^(>=|<=|===|>|<)(-?\d+(?:\.\d+)?)$/;
const RESULT_PATH_RE = /^results\[(\d+)\]\.(.+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The response fields a fixture does NOT compare byte-for-byte, derived
 * from the fixture's own `patterns` and `measured`. Keeping the
 * projection derivable means capture and replay cannot disagree about it,
 * and a fixture stays readable as "everything, minus what it says".
 */
function omittedResultKeys(
  index: number,
  patterns: Patterns,
  measured: Measured,
): Set<string> {
  const omitted = new Set<string>();
  for (const key of Object.keys(measured.results[index] ?? {})) {
    // "stdout.length" describes the field "stdout".
    omitted.add(key.split(".")[0] ?? key);
  }
  for (const jsonPath of Object.keys(patterns)) {
    const match = RESULT_PATH_RE.exec(jsonPath);
    if (match !== null && Number(match[1]) === index && match[2] !== undefined) {
      omitted.add(match[2]);
    }
  }
  return omitted;
}

/**
 * Strip every non-deterministic field from a response body, leaving what a
 * transcript compares with deep equality. Used by BOTH capture and replay,
 * so what is recorded and what is checked are the same projection.
 */
export function projectResponse(
  body: unknown,
  patterns: Patterns,
  measured: Measured,
): unknown {
  if (!isRecord(body)) return body;

  const omittedTopLevel = new Set(
    Object.keys(patterns).filter((jsonPath) => RESULT_PATH_RE.exec(jsonPath) === null),
  );

  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (omittedTopLevel.has(key)) continue;
    if (key === "results" && Array.isArray(value)) {
      projected[key] = value.map((result: unknown, index: number) => {
        if (!isRecord(result)) return result;
        const omitted = omittedResultKeys(index, patterns, measured);
        const kept: Record<string, unknown> = {};
        for (const [field, fieldValue] of Object.entries(result)) {
          if (!omitted.has(field)) kept[field] = fieldValue;
        }
        return kept;
      });
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

/** Resolve a pattern path against a live response body. */
export function resolvePath(body: unknown, jsonPath: string): unknown {
  if (!isRecord(body)) return undefined;
  const match = RESULT_PATH_RE.exec(jsonPath);
  if (match === null) return body[jsonPath];

  const results = body["results"];
  const index = Number(match[1]);
  const field = match[2];
  if (!Array.isArray(results) || field === undefined) return undefined;
  const result: unknown = results[index];
  return isRecord(result) ? result[field] : undefined;
}

/**
 * Resolve a measured key against one result. Takes a plain `string`, not
 * a `MeasuredKey`: the key comes back off a fixture as a string, and a key
 * this does not recognise must fail the replay loudly (as `undefined`)
 * rather than be cast into looking valid.
 */
export function resolveMeasured(
  result: unknown,
  key: string,
): number | undefined {
  if (!isRecord(result)) return undefined;
  const [field, accessor] = key.split(".");
  if (field === undefined) return undefined;
  const value = result[field];
  if (accessor === "length") {
    return typeof value === "string" ? value.length : undefined;
  }
  return typeof value === "number" ? value : undefined;
}

/**
 * Evaluate `<op><value>`. Throws on a malformed predicate rather than
 * silently passing: a check that cannot fail is not a check.
 */
export function satisfiesPredicate(actual: number, predicate: string): boolean {
  const match = PREDICATE_RE.exec(predicate);
  if (match === null) {
    throw new Error(`malformed measured predicate: ${JSON.stringify(predicate)}`);
  }
  const [, op, raw] = match;
  const expected = Number(raw);
  switch (op) {
    case ">=":
      return actual >= expected;
    case "<=":
      return actual <= expected;
    case "===":
      return actual === expected;
    case ">":
      return actual > expected;
    case "<":
      return actual < expected;
    default:
      throw new Error(`unhandled predicate operator: ${String(op)}`);
  }
}
