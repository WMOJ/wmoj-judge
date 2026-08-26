import type { Executor, Language } from "../types";
import { pythonExecutor } from "./python";
import { pypyExecutor } from "./pypy";
import { createCppExecutor } from "./cpp";

const cpp14Executor = createCppExecutor("cpp14");
const cpp17Executor = createCppExecutor("cpp17");
const cpp20Executor = createCppExecutor("cpp20");
const cpp23Executor = createCppExecutor("cpp23");

/**
 * Resolve an Executor for a submission language.
 *
 * Takes a **canonical** `Language` only. The two legacy codes the
 * wmoj-app may still send during the cutover window — `"python"` and
 * `"cpp"` — are mapped, and their once-per-process deprecation warning
 * emitted, by `normalizeLanguage` in `routes/submit.ts`, which is the
 * only thing that ever sees the raw request value.
 *
 * This function used to carry `case "python"` / `case "cpp"` branches
 * with those warnings in them, and they were **dead**: the sole call
 * site normalises first, so neither branch ever executed and no
 * deprecation warning was ever emitted for any request in the life of
 * the alias. That is the one signal that would say whether the cutover
 * is finished, and removing the aliases is listed in `AGENTS.md` as a
 * decision — which was being made blind. Narrowing the parameter to
 * `Language` is what keeps it from silently coming back: passing a raw
 * request value here is now a compile error.
 *
 * Unknown codes throw so the caller can turn them into a 400.
 */
export function executorFor(language: Language): Executor {
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
    default: {
      const _exhaustive: never = language;
      void _exhaustive;
      throw new Error(`unsupported language: ${String(language)}`);
    }
  }
}
