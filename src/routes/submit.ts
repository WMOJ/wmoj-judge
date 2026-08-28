import { Router, type Request, type Response } from "express";
import type {
  SubmitRequest,
  SubmitResponse,
  CompareMode,
} from "../types";
import { config } from "../config";
import { submitSemaphore } from "../queue/globalSemaphore";
import { compileCache, cacheKey } from "../cache/compileCache";
import type { CaseLimits } from "../verdict";
import { isLanguage, languageSpec } from "../languages";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { runCompile } from "../util/compile";
import { compileChecker } from "../checker";
import {
  judgeAllCases,
  productionJudgeDeps,
  type CaseInput,
  type Grading,
} from "../judge/judgeCase";
import { withWorkspace } from "../workspace";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";

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
  // Membership in `languages.json` IS the accepted set — the route no
  // longer keeps its own list to forget to update, and the legacy
  // `python`/`cpp` codes are gone with it. Both known wmoj-app call sites
  // send canonical codes; `/generate-tests` keeps accepting bare `cpp`
  // because `judge.sh` still sends it there.
  if (!isLanguage(b.language)) {
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
  // A submission with nothing to run is a malformed REQUEST, not a
  // gradeable submission. Accepting it returned `{summary:{0,0,0},
  // results:[]}` — the compile-error shape minus `compileError` — and
  // `wmoj-app`'s `isPassed` requires `total > 0`, so every solution to a
  // problem saved with no test data, including correct ones, was
  // recorded as a non-passing submission with nothing anywhere to
  // explain why. `judge.sh` already guards `n >= 1`; the judge did not.
  if (b.input.length === 0) {
    return { ok: false, error: "'input' must contain at least one test case" };
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
  // `checker` is optional and backwards compatible: absent, null, or
  // blank all mean "no checker", i.e. exactly the pre-checker byte
  // comparison. Only a wrong TYPE is a 400.
  if (b.checker !== undefined && b.checker !== null && typeof b.checker !== "string") {
    return { ok: false, error: "'checker' must be a string (C++ source) when provided" };
  }
  const checker =
    typeof b.checker === "string" && b.checker.trim().length > 0
      ? b.checker
      : undefined;

  return {
    ok: true,
    value: {
      language: b.language,
      code: b.code,
      input: b.input as string[],
      output: b.output as string[],
      timeLimit: b.timeLimit as number | undefined,
      memoryLimit: b.memoryLimit as number | undefined,
      compareMode: b.compareMode as CompareMode | undefined,
      checker,
    },
  };
}

/**
 * Clamp a submission's requested memory cap to what the host can
 * actually back. A problem may legitimately DECLARE 1024 MB; on a
 * 512 MB box that limit could never be enforced — the container's OOM
 * killer would fire first and produce a confusing crash. Enforcing
 * `min(requested, ceilingMb)` means the judge's own accounting stays
 * authoritative and the failure is a clean MLE.
 *
 * The ceiling is a PARAMETER rather than a read of
 * `config.HOST_MEMORY_CEILING_MB` so this is a pure function of its
 * inputs and the one place the env is consulted is the route below.
 * Clamping stays here, at the route: the verdict module is handed the
 * already-enforced limits and never learns that a ceiling exists.
 *
 * The result is floored to a whole MB because that is what the sandbox
 * enforces (`Math.max(1, Math.floor(memLimitMb))` in `nsjail.ts`).
 * Without the floor a `memoryLimit` of 300.75 was advertised back as
 * `effectiveMemoryLimitMb: 300.75` — a field both `types.ts` and
 * `AGENTS.md` define as "the cap actually enforced" — while 300 MB was
 * applied, and the RSS threshold was computed against a cap that had
 * never existed. `memoryLimit` is deliberately still accepted as any
 * positive finite number: rounding it makes the two agree, and rejecting
 * it would be a contract change for a shape no client sends.
 */
export function effectiveMemLimitMb(
  requestedMb: number,
  ceilingMb: number,
): number {
  return Math.max(1, Math.floor(Math.min(requestedMb, ceilingMb)));
}

/** Narrow an unknown thrown value to an Error without a custom class. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const submitRouter: Router = Router();

/**
 * POST /submit — main judging endpoint. Flow:
 *  1. validate payload  2. resolve the language spec and the limits
 *  3. acquire a global semaphore slot  4. lease a workspace
 *  5. write the source; for a COMPILED language check the compile cache
 *     and compile on a miss (compile fail → HTTP 200 with compileError)
 *  6. store the language's artifacts in the cache
 *  7. compile the custom checker once, if one was supplied
 *     (checker compile fail → HTTP 200 with checkerError)
 *  8. `judgeAllCases` runs and grades every case, settling all of them
 *  9. summarize and return 200.
 *
 * A judge fault at step 8 aborts the whole submission with `500 {error}`
 * rather than being graded — `judgeAllCases` returns it as `ok: false`
 * and this route rethrows it into the `catch` below.
 */
submitRouter.post("/", async (req: Request, res: Response) => {
  // Refuse new work during drain. Must run BEFORE any resource acquisition
  // (semaphore / workspace / sandbox spawn) so SIGTERM can actually
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

  const language = payload.language;
  const spec = languageSpec(language);
  const compareMode: CompareMode = payload.compareMode ?? "trim-trailing";
  const checkerSource = payload.checker;
  const timeLimitMs = payload.timeLimit ?? 5000;
  // Requested memory cap: the LARGER of what the request asked for and
  // the language's floor (e.g. pypy3 → 384 MB), falling back to 256 MB
  // when neither is set. `max` rather than `??` because both real clients
  // always send a number — `wmoj-app` sends `problem.memory_limit || 256`
  // and `judge.sh` takes `memLimitMb` as a required positional argument —
  // so `payload.memoryLimit ?? floor` would short-circuit on its first
  // term for every request either client has ever made, and every PyPy
  // submission would run at the problem's cap. What is actually applied
  // to the sandbox is that value clamped to the host ceiling; it is
  // reported back as `effectiveMemoryLimitMb`.
  const requestedMemLimitMb =
    Math.max(payload.memoryLimit ?? 0, spec.memoryFloorMb ?? 0) || 256;
  const memLimitMb = effectiveMemLimitMb(
    requestedMemLimitMb,
    config.HOST_MEMORY_CEILING_MB,
  );
  // Built once, not per case: every case of a submission is graded
  // against the same enforced budget, and the judge takes the limits as
  // a parameter precisely so the clamping stays here, at the route,
  // where `config` belongs.
  const limits: CaseLimits = { timeLimitMs, memLimitMb };
  // A checker REPLACES compareMode; which one is in force is decided
  // once, here, rather than re-derived per case.
  const grading: Grading =
    checkerSource === undefined
      ? { kind: "compare", mode: compareMode }
      : { kind: "checker" };
  const cases: CaseInput[] = payload.input.map((input, index) => ({
    index,
    input,
    expected: payload.output[index] ?? "",
  }));

  logger.info(
    {
      language,
      codeLen: payload.code.length,
      cases: payload.input.length,
      timeLimitMs,
      requestedMemLimitMb,
      memLimitMb,
      compareMode: checkerSource ? "custom-checker" : compareMode,
      checkerLen: checkerSource?.length ?? 0,
    },
    "submit: received",
  );

  // Whole /submit runs under the global semaphore. No work should happen
  // outside this closure (validation excepted) — it's what bounds load.
  await submitSemaphore(async () => {
    try {
      await withWorkspace("submit", async (ws) => {
        await ws.write(spec.filename, payload.code);

        // INTERPRETED LANGUAGES SKIP THE CACHE ENTIRELY (there is no
        // compile step to memoize). They used to key on the empty argv,
        // so two identical Python submissions shared an entry — and a
        // "hit" then cost a recursive copy plus a chown to save one
        // `writeFile` of at most 100 KB, on a box with ~0.1 CPU. See
        // `docs/adr/0004-interpreted-languages-bypass-the-compile-cache.md`.
        if (spec.compileArgv !== null) {
          const key = cacheKey(language, payload.code, spec.compileArgv);
          const hit = await compileCache.get(key);
          if (hit) {
            await ws.copyIn(hit.dir, hit.artifacts);
          } else {
            // Compilation runs OUTSIDE nsjail: this is the judge
            // transforming source, not executing user-provided
            // behaviour. The child still gets the four-variable env from
            // `buildChildEnv` so a malicious `#include` or pragma cannot
            // read host variables.
            const compileRes = await runCompile(
              spec.compileArgv,
              ws.dir,
              buildChildEnv(),
            );
            if (!compileRes.ok) {
              // Compile fail → HTTP 200 with compileError per contract.
              const response: SubmitResponse = {
                summary: { total: 0, passed: 0, failed: 0 },
                results: [],
                effectiveMemoryLimitMb: memLimitMb,
                compileError: compileRes.stderr,
              };
              res.status(200).json(response);
              return;
            }
            // Successful compile → store the language's ARTIFACTS in the
            // cache; nothing else in the workspace goes with them. Cache
            // errors must not fail the submission.
            await compileCache
              .put(key, ws.dir, spec.artifacts)
              .catch((err) => logger.warn({ err }, "submit: compile cache put failed"));
          }
        }

        // Custom checker: compiled ONCE per submission, never per case.
        // Compiling here rather than earlier means the g++ run is
        // skipped entirely when the user's own code failed to compile.
        if (checkerSource !== undefined) {
          const checkerCompile = await compileChecker(ws, checkerSource);
          if (!checkerCompile.ok) {
            // A broken checker is a PROBLEM-CONFIGURATION fault, not the
            // user's. Same HTTP 200 + empty-summary shape as
            // compileError, but a distinct field: wmoj-app turns
            // `compileError` into a user-facing CE and must never blame
            // the student for this.
            logger.error(
              { stderr: checkerCompile.stderr.slice(0, 2000) },
              "submit: checker failed to compile",
            );
            const response: SubmitResponse = {
              summary: { total: 0, passed: 0, failed: 0 },
              results: [],
              effectiveMemoryLimitMb: memLimitMb,
              checkerError: checkerCompile.stderr,
            };
            res.status(200).json(response);
            return;
          }
        }

        const out = await judgeAllCases(
          productionJudgeDeps,
          ws,
          { argv: spec.runArgv, limits },
          grading,
          cases,
          config.PER_SUBMISSION_CONCURRENCY,
        );
        // A judge fault. Every case has settled by the time this
        // resolves, so throwing here cannot leave work running against
        // the workspace the lease is about to tear down.
        if (!out.ok) throw out.error;

        const summary = {
          total: out.results.length,
          passed: out.results.filter((r) => r.passed).length,
          failed: out.results.filter((r) => !r.passed).length,
        };

        const response: SubmitResponse = {
          summary,
          results: out.results,
          effectiveMemoryLimitMb: memLimitMb,
        };
        res.status(200).json(response);
      });
    } catch (err) {
      logger.error({ err }, "submit: unexpected failure");
      if (!res.headersSent) {
        res.status(500).json({ error: asError(err).message });
      }
    }
  });
});
