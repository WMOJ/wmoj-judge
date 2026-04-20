import type { Executor, Language } from "../types";
import { pythonExecutor } from "./python";
import { pypyExecutor } from "./pypy";
import { createCppExecutor } from "./cpp";
import { javaExecutor } from "./java";

const cpp14Executor = createCppExecutor("cpp14");
const cpp17Executor = createCppExecutor("cpp17");

// Process-lifetime flags so legacy-code warnings fire at most once per
// language per judge instance rather than on every request.
let warnedLegacyPython = false;
let warnedLegacyCpp = false;

/**
 * Resolve an Executor for a submission language.
 *
 * Accepts the canonical 5-language set plus the two legacy codes that the
 * wmoj-app may still send during the cutover window:
 *   - "python" → routed to the python3 executor
 *   - "cpp"    → routed to the cpp17 executor
 *
 * Each legacy route emits a single warn-level log line per process on
 * first use. No silent drops; unknown codes throw so the caller can turn
 * them into a 400.
 */
export function executorFor(language: Language | "python" | "cpp"): Executor {
  switch (language) {
    case "python3":
      return pythonExecutor;
    case "pypy3":
      return pypyExecutor;
    case "cpp14":
      return cpp14Executor;
    case "cpp17":
      return cpp17Executor;
    case "java":
      return javaExecutor;
    case "python":
      if (!warnedLegacyPython) {
        warnedLegacyPython = true;
        // Use console.warn here rather than the pino logger to avoid a
        // circular dependency — the logger module is wired up by teammate
        // A / C and may not be initialised when the first executor lookup
        // happens during a health probe.
        // eslint-disable-next-line no-console
        console.warn(
          '[judge] deprecation: language code "python" is legacy; map to "python3"'
        );
      }
      return pythonExecutor;
    case "cpp":
      if (!warnedLegacyCpp) {
        warnedLegacyCpp = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[judge] deprecation: language code "cpp" is legacy; map to "cpp17"'
        );
      }
      return cpp17Executor;
    default: {
      const _exhaustive: never = language;
      void _exhaustive;
      throw new Error(`unsupported language: ${String(language)}`);
    }
  }
}
