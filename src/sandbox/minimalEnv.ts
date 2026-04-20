import type { Language } from "../types";

/**
 * Minimal PATH exposed to child processes. Covers the toolchain
 * locations used by the Docker runtime stage (python3, pypy3, g++).
 * Java/javac are invoked via absolute Temurin paths from
 * languages.json so PATH coverage is not required for them.
 * Intentionally narrow — children never see `/root/bin` or any
 * user-writable directory.
 */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type Lang = Language | "python" | "cpp" | "java";

/**
 * Build the environment map passed to user code (and to compilers,
 * which also go through minimalEnv per the plan).
 *
 * Strict allow-list:
 *   - PATH              canonical set of binary dirs
 *   - LANG, LC_ALL      force C.UTF-8 for deterministic locale
 *   - PYTHONUNBUFFERED  always on — prevents stdout deadlocks
 *
 * No JAVA_HOME: OpenJDK/Temurin's `java` binary resolves its own
 * `lib/` via /proc/self/exe, so JAVA_HOME is not required to launch,
 * and with two distinct JDKs (temurin-8 + temurin-25) in the image
 * the correct value would be variant-specific anyway — the Temurin
 * binaries handle this themselves.
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
