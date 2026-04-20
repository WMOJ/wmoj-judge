import type { Language } from "../types";

/**
 * Minimal PATH exposed to child processes. Covers the toolchain
 * locations used by the Docker runtime stage (python3, pypy3, g++,
 * java, javac). Intentionally narrow — children never see `/root/bin`
 * or any user-writable directory.
 */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Default JAVA_HOME for the openjdk-17 packages installed in the
 * Docker runtime. Overridable via the process environment so dev
 * machines with a different JDK layout still work.
 */
const DEFAULT_JAVA_HOME = "/usr/lib/jvm/java-17-openjdk-amd64";

type Lang = Language | "python" | "cpp";

/**
 * Build the environment map passed to user code (and to compilers,
 * which also go through minimalEnv per the plan).
 *
 * Strict allow-list:
 *   - PATH              canonical set of binary dirs
 *   - LANG, LC_ALL      force C.UTF-8 for deterministic locale
 *   - PYTHONUNBUFFERED  always on — prevents stdout deadlocks
 *   - JAVA_HOME         java only
 *
 * No other variables from `process.env` are leaked.
 */
export function buildChildEnv(lang: Lang): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? DEFAULT_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };

  if (lang === "java") {
    env.JAVA_HOME = process.env.JAVA_HOME ?? DEFAULT_JAVA_HOME;
  }

  return env;
}
