import { Router, type Request, type Response } from "express";
import { promises as fs } from "fs";
import type {
  SubmitRequest,
  SubmitResponse,
  TestResult,
  CompareMode,
  Language,
  Verdict,
  SandboxResult,
} from "../types";
import { config } from "../config";
import { submitSemaphore } from "../queue/globalSemaphore";
import { createPool } from "../queue/workerPool";
import { compileCache, cacheKey } from "../cache/compileCache";
import { runSandboxed } from "../sandbox/nsjail";
import { acquireUid, releaseUid } from "../queue/uidPoolSingleton";
import { createWorkdir, cleanupWorkdir } from "../util/workdir";
import { executorFor } from "../executors";
import { compare } from "../compare";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";
import languagesJson from "../../languages.json";

const ALL_LANGUAGES: readonly (Language | "python" | "cpp" | "java")[] = [
  "python3",
  "pypy3",
  "cpp14",
  "cpp17",
  "cpp20",
  "cpp23",
  "java8",
  "java-latest",
  "python",
  "cpp",
  "java",
];

const ALL_COMPARE_MODES: readonly CompareMode[] = [
  "exact",
  "trim-trailing",
  "whitespace",
  "float-epsilon",
];

/**
 * Shape-check a /submit payload. Returns a validated SubmitRequest or
 * an error message. No field coercion happens here — the body must
 * already match the contract.
 */
function validateSubmit(body: unknown): { ok: true; value: SubmitRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid payload: body must be an object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.language !== "string") {
    return { ok: false, error: "Invalid payload: 'language' must be a string" };
  }
  if (!ALL_LANGUAGES.includes(b.language as Language | "python" | "cpp" | "java")) {
    return { ok: false, error: `Unsupported language: ${b.language}` };
  }
  if (typeof b.code !== "string") {
    return { ok: false, error: "Invalid payload: 'code' must be a string" };
  }
  if (!Array.isArray(b.input) || !b.input.every((x) => typeof x === "string")) {
    return { ok: false, error: "Invalid payload: 'input' must be string[]" };
  }
  if (!Array.isArray(b.output) || !b.output.every((x) => typeof x === "string")) {
    return { ok: false, error: "Invalid payload: 'output' must be string[]" };
  }
  if (b.input.length !== b.output.length) {
    return { ok: false, error: "'input' and 'output' arrays must be the same length" };
  }
  if (b.timeLimit !== undefined && (typeof b.timeLimit !== "number" || !Number.isFinite(b.timeLimit) || b.timeLimit <= 0)) {
    return { ok: false, error: "'timeLimit' must be a positive number (ms)" };
  }
  if (b.memoryLimit !== undefined && (typeof b.memoryLimit !== "number" || !Number.isFinite(b.memoryLimit) || b.memoryLimit <= 0)) {
    return { ok: false, error: "'memoryLimit' must be a positive number (MB)" };
  }
  if (b.compareMode !== undefined) {
    if (typeof b.compareMode !== "string" || !ALL_COMPARE_MODES.includes(b.compareMode as CompareMode)) {
      return { ok: false, error: `'compareMode' must be one of ${ALL_COMPARE_MODES.join(", ")}` };
    }
  }

  return {
    ok: true,
    value: {
      language: b.language as Language | "python" | "cpp" | "java",
      code: b.code,
      input: b.input as string[],
      output: b.output as string[],
      timeLimit: b.timeLimit as number | undefined,
      memoryLimit: b.memoryLimit as number | undefined,
      compareMode: b.compareMode as CompareMode | undefined,
    },
  };
}

/**
 * Map a legacy language code to its current equivalent. Deprecation
 * warnings are emitted once per process by `executorFor` in
 * `src/executors/index.ts` -- the single entry point for language
 * dispatch -- so this function stays silent to avoid double-logging.
 *
 * Legacy cutover mapping:
 *   "python" -> "python3"
 *   "cpp"    -> "cpp17"
 *   "java"   -> "java8"   (backfills pre-split submissions to OpenJDK 8)
 */
function normalizeLanguage(
  lang: Language | "python" | "cpp" | "java",
): Language {
  if (lang === "python") return "python3";
  if (lang === "cpp") return "cpp17";
  if (lang === "java") return "java8";
  return lang;
}

/**
 * Return the compile argv for a canonical language, or an empty array for
 * interpreted languages (python3, pypy3) which have no compile step. Used
 * as input to the compile-cache key so artifacts are invalidated whenever
 * compiler flags change — and so python/pypy submissions with identical
 * source share a cache entry.
 */
function compileArgvFor(language: Language): readonly string[] {
  const spec = languagesJson[language];
  if (spec && spec.compile && Array.isArray(spec.compile.argv)) {
    return spec.compile.argv;
  }
  return [];
}

/**
 * Per-language default memoryLimitMb (e.g. pypy3 → 384) from
 * languages.json. Returns undefined when the entry doesn't set one;
 * callers then fall back to the global 256 MB default. PyPy baseline
 * RSS is ~60 MB vs CPython's ~14 MB, so PyPy submissions need more
 * headroom under a 256 MB cap — see the pypy-investigator writeup.
 */
function languageMemoryDefaultMb(language: Language): number | undefined {
  const spec = languagesJson[language] as { memoryLimitMb?: number };
  return typeof spec.memoryLimitMb === "number" ? spec.memoryLimitMb : undefined;
}

/**
 * Per-language extra VA-space headroom added on top of the effective
 * memoryLimitMb when computing nsjail's --rlimit_as. Used for the JVM,
 * which reserves ~1.2 GB of virtual address space at startup
 * (CompressedClassSpace, ReservedCodeCache, metaspace) regardless of
 * the working heap size. The user-visible memory cap is still enforced
 * via `-Xmx<memLimitMb>m` in the java run argv.
 */
function languageRlimitAsExtraMb(language: Language): number {
  const spec = languagesJson[language] as { rlimitAsExtraMb?: number };
  return typeof spec.rlimitAsExtraMb === "number" ? spec.rlimitAsExtraMb : 0;
}

/**
 * Substitute the literal placeholder "<MEM>" in a run argv with the
 * effective memLimitMb. Used by the Java variants (languages.json sets
 * `-Xmx<MEM>m`) so the JVM heap cap tracks whatever memoryLimit the
 * submission asked for (or the language/judge default). Non-Java argvs
 * contain no "<MEM>" and pass through unchanged.
 */
function substituteMemory(argv: readonly string[], memLimitMb: number): string[] {
  const mem = String(memLimitMb);
  return argv.map((a) => a.replace(/<MEM>/g, mem));
}

/**
 * Derive the competitive-programming verdict from a sandbox result
 * plus the compare() outcome. Exhaustive per the plan.
 */
function deriveVerdict(sb: SandboxResult, passed: boolean): Verdict {
  if (sb.killedBy === "TO") return "TLE";
  if (sb.killedBy === "OOM") return "MLE";
  if (sb.exitCode !== 0 || sb.killedBy === "SIG") return "RE";
  return passed ? "AC" : "WA";
}

/**
 * Build the TestResult for one test case from the sandbox result.
 * Centralizes the "shape" of a result so it can't drift between cases.
 */
function buildResult(
  index: number,
  expected: string,
  sb: SandboxResult,
  passed: boolean,
  verdict: Verdict,
): TestResult {
  return {
    index,
    exitCode: sb.exitCode,
    passed,
    expected,
    received: sb.stdout,
    stderr: sb.stderr,
    stdout: sb.stdout,
    timedOut: sb.killedBy === "TO",
    verdict,
    timeMs: sb.timeMs,
    cpuMs: sb.cpuMs,
    memKb: sb.memKb,
  };
}

export const submitRouter: Router = Router();

/**
 * POST /submit — main judging endpoint. Flow:
 *  1. validate payload  2. normalize legacy lang
 *  3. acquire global semaphore slot  4. acquire UID + workdir
 *  5. check compile cache → compile if miss (compile fail → HTTP 200 with compileError)
 *  6. put artifact in cache  7. per-submission worker pool runs each test
 *  8. each test: nsjail → compare → verdict
 *  9. sort by index, summarize, cleanup, return 200.
 */
submitRouter.post("/", async (req: Request, res: Response) => {
  // Refuse new work during drain. Must run BEFORE any resource acquisition
  // (semaphore / UID / workdir / sandbox spawn) so SIGTERM can actually
  // quiesce the judge within the drain window.
  if (isDraining()) {
    res.status(503).json({ error: "shutting down" });
    return;
  }

  const validation = validateSubmit(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const payload = validation.value;

  const language = normalizeLanguage(payload.language);
  const compareMode: CompareMode = payload.compareMode ?? "trim-trailing";
  const timeLimitMs = payload.timeLimit ?? 5000;
  // Effective memory cap precedence: request override → per-language
  // default (e.g. pypy3 → 384 MB) → global default 256 MB.
  const memLimitMb =
    payload.memoryLimit ?? languageMemoryDefaultMb(language) ?? 256;
  // --rlimit_as bump (JVM needs ~1.2 GB VA-space regardless of heap).
  const rlimitAsMb = memLimitMb + languageRlimitAsExtraMb(language);

  logger.info(
    {
      language,
      codeLen: payload.code.length,
      cases: payload.input.length,
      timeLimitMs,
      memLimitMb,
      rlimitAsMb,
      compareMode,
    },
    "submit: received",
  );

  // Whole /submit runs under the global semaphore. No work should happen
  // outside this closure (validation excepted) — it's what bounds load.
  await submitSemaphore(async () => {
    let uid: number | null = null;
    let workDir: string | null = null;
    try {
      const executor = executorFor(language);
      const filename = executor.filename(payload.code);

      uid = await acquireUid();
      workDir = await createWorkdir(uid);

      await executor.prepare(workDir, payload.code);
      // The files the executor just wrote are owned by root; hand them to the pool UID.
      await chownTree(workDir, uid).catch((err) => {
        logger.warn({ err, workDir }, "submit: chown tree failed; continuing");
      });

      const runCmdRaw = executor.buildRunCommand(workDir, filename);
      // Resolve "<MEM>" placeholders (used by java8 / java-latest argv
      // in languages.json to pin `-Xmx<MEM>m`) against the effective
      // memory limit. Non-Java argvs pass through unchanged.
      const runCmd = { argv: substituteMemory(runCmdRaw.argv, memLimitMb) };

      // Cache key covers (language, source, compile argv) per the plan.
      // Interpreted languages (python3/pypy3) have no compile step, so we
      // key on the empty array — matches the "no compile argv" semantics.
      const compileArgv = compileArgvFor(language);
      const key = cacheKey(language, payload.code, compileArgv);

      const cachedDir = await compileCache.get(key);
      if (cachedDir) {
        // Copy cached artifact into workdir; re-chown to pool UID.
        await fs.cp(cachedDir, workDir, { recursive: true, force: true });
        await chownTree(workDir, uid).catch(() => {});
      } else {
        const compileRes = await executor.compile(workDir);
        if (!compileRes.ok) {
          // Compile fail → HTTP 200 with compileError per contract.
          const response: SubmitResponse = {
            summary: { total: 0, passed: 0, failed: 0 },
            results: [],
            compileError: compileRes.stderr,
          };
          res.status(200).json(response);
          return;
        }
        // Successful compile → store in cache. Cache errors must not fail the submission.
        await compileCache
          .put(key, workDir)
          .catch((err) => logger.warn({ err }, "submit: compile cache put failed"));
        await chownTree(workDir, uid).catch(() => {});
      }

      // Per-submission pool: bound test-case parallelism within this submission.
      const pool = createPool(config.PER_SUBMISSION_CONCURRENCY);

      const resultPromises = payload.input.map((rawInput, i) =>
        pool.run(async (): Promise<TestResult> => {
          const stdin = rawInput.endsWith("\n") ? rawInput : rawInput + "\n";
          const expected = payload.output[i] ?? "";
          const sandboxRes = await runSandboxed({
            argv: runCmd.argv,
            cwd: workDir as string,
            uid: uid as number,
            gid: uid as number,
            timeLimitMs,
            memLimitMb,
            rlimitAsMb,
            stdin,
          });
          const passed =
            sandboxRes.exitCode === 0 &&
            sandboxRes.killedBy === null &&
            compare(compareMode, expected, sandboxRes.stdout);
          const verdict = deriveVerdict(sandboxRes, passed);
          return buildResult(i, expected, sandboxRes, passed, verdict);
        }),
      );

      const results = (await Promise.all(resultPromises)).sort(
        (a, b) => a.index - b.index,
      );

      const summary = {
        total: results.length,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
      };

      const response: SubmitResponse = { summary, results };
      res.status(200).json(response);
    } catch (err) {
      logger.error({ err }, "submit: unexpected failure");
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      }
    } finally {
      if (workDir) await cleanupWorkdir(workDir);
      if (uid !== null) releaseUid(uid);
    }
  });
});

/**
 * True when Node is running as root (effective UID 0). Captured once at
 * module load. On Render we run Node as UID 1000 so this is false, and
 * every chownTree below becomes a no-op -- a non-root process cannot
 * chown to a foreign UID, and even chowning to our own UID would just
 * spam EPERM (fs.chown only succeeds for CAP_CHOWN or matching UID).
 * Because the workdir was mkdtemp'd by us and the sandbox inherits our
 * UID (no --user flag), files are already owned by the process that
 * will execute them -- no chown needed.
 */
const isRootNode: boolean =
  typeof process.geteuid === "function" && process.geteuid() === 0;

/**
 * Recursively chown every entry under `dir` to `uid:uid`. Used after
 * `executor.prepare()` so the sandboxed pool UID can read/execute what
 * Node (running as root) just wrote. No-op when Node is unprivileged
 * (see `isRootNode`).
 */
async function chownTree(dir: string, uid: number): Promise<void> {
  if (!isRootNode) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await fs.chown(dir, uid, uid).catch(() => {});
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    await fs.chown(full, uid, uid).catch(() => {});
    if (entry.isDirectory()) {
      await chownTree(full, uid);
    }
  }
}
