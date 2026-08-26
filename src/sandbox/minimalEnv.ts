import type { Language } from "../types";

/**
 * Fallback PATH for child processes, used only when the judge's own
 * PATH is unset. Covers the toolchain locations used by the Docker
 * runtime stage (python3, pypy3, g++).
 *
 * NOTE: in practice this is never used. `buildChildEnv` below passes
 * `process.env.PATH` through verbatim, so children see exactly the
 * judge's PATH — not a narrowed one. Everything else in the child env
 * IS a strict allow-list.
 */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type Lang = Language | "python" | "cpp";

/**
 * Build the environment map passed to user code (and to compilers,
 * which also go through minimalEnv per the plan).
 *
 * Strict allow-list:
 *   - PATH              canonical set of binary dirs
 *   - LANG, LC_ALL      force C.UTF-8 for deterministic locale
 *   - PYTHONUNBUFFERED  always on — prevents stdout deadlocks
 *
 * No other variables from `process.env` are leaked.
 */
export function buildChildEnv(_lang: Lang): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? DEFAULT_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };

  return env;
}
