import type { Executor, Language } from "../types";
import { pythonExecutor } from "./python";
import { pypyExecutor } from "./pypy";
import { createCppExecutor } from "./cpp";
import { createJavaExecutor } from "./java";
import { logger } from "../util/logger";

const cpp14Executor = createCppExecutor("cpp14");
const cpp17Executor = createCppExecutor("cpp17");
const cpp20Executor = createCppExecutor("cpp20");
const cpp23Executor = createCppExecutor("cpp23");
const java8Executor = createJavaExecutor("java8");
const javaLatestExecutor = createJavaExecutor("java-latest");

// Process-lifetime flags so legacy-code warnings fire at most once per
// language per judge instance rather than on every request.
let warnedLegacyPython = false;
let warnedLegacyCpp = false;
let warnedLegacyJava = false;

/**
 * Resolve an Executor for a submission language.
 *
 * Accepts the canonical 8-language set plus the three legacy codes that
 * the wmoj-app may still send during the cutover window:
 *   - "python" -> routed to the python3 executor
 *   - "cpp"    -> routed to the cpp17 executor
 *   - "java"   -> routed to the java8 executor (backfills existing
 *                 submissions that predate the java8/java-latest split)
 *
 * Each legacy route emits a single warn-level log line per process on
 * first use (via the shared pino logger so it shows up in the same
 * structured stream as everything else). No silent drops; unknown
 * codes throw so the caller can turn them into a 400.
 */
export function executorFor(
  language: Language | "python" | "cpp" | "java",
): Executor {
  switch (language) {
    case "python3":
      return pythonExecutor;
    case "pypy3":
      return pypyExecutor;
    case "cpp14":
      return cpp14Executor;
    case "cpp17":
      return cpp17Executor;
    case "cpp20":
      return cpp20Executor;
    case "cpp23":
      return cpp23Executor;
    case "java8":
      return java8Executor;
    case "java-latest":
      return javaLatestExecutor;
    case "python":
      if (!warnedLegacyPython) {
        warnedLegacyPython = true;
        logger.warn(
          'deprecation: language code "python" is legacy; map to "python3"',
        );
      }
      return pythonExecutor;
    case "cpp":
      if (!warnedLegacyCpp) {
        warnedLegacyCpp = true;
        logger.warn(
          'deprecation: language code "cpp" is legacy; map to "cpp17"',
        );
      }
      return cpp17Executor;
    case "java":
      if (!warnedLegacyJava) {
        warnedLegacyJava = true;
        logger.warn(
          'deprecation: language code "java" is legacy; map to "java8"',
        );
      }
      return java8Executor;
    default: {
      const _exhaustive: never = language;
      void _exhaustive;
      throw new Error(`unsupported language: ${String(language)}`);
    }
  }
}
