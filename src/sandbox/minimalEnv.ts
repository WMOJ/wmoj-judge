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

/**
 * Build the environment map passed to user code (and to compilers,
 * which also go through minimalEnv per the plan).
 *
 * Strict allow-list, and the SAME allow-list for every language:
 *   - PATH              canonical set of binary dirs
 *   - LANG, LC_ALL      force C.UTF-8 for deterministic locale
 *   - PYTHONUNBUFFERED  always on — prevents stdout deadlocks
 *
 * No other variables from `process.env` are leaked.
 *
 * This deliberately takes NO language argument. It used to take one and
 * ignore it, which was worse than useless: `routes/health.ts` documented
 * the parameter as selecting a "language-flavoured env map" and every
 * probe passed one, so the health endpoint advertised a capability that
 * did not exist. Nor is per-language flavouring implementable behind this
 * signature as the call sites stand — `sandbox/nsjail.ts` builds the env
 * nsjail forwards to EVERY jailed child, whatever the submission's
 * language, so there is one env or there is a lie. The four variables
 * above are the env allow-list `AGENTS.md` documents, and widening or
 * varying it is a security decision, not a convenience.
 */
export function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? DEFAULT_PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };

  return env;
}
