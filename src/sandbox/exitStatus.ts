/**
 * The single decoder of nsjail's exit status.
 *
 * nsjail runs in `--mode o`, where **its own exit status IS the jailed
 * child's fate**: the child's own code for a normal exit, `128 + WTERMSIG`
 * when a signal killed it, and 255 when nsjail could not `execve` the
 * child at all. `wmoj-jailrun` mirrors that status, so it is what Node
 * sees. Node's own `signal` argument describes what killed the RUNNER,
 * which is `null` in every one of those cases — any code that infers
 * "the child was killed" from that signal alone is wrong.
 *
 * This module exists because three places used to decode that encoding
 * and disagreed about where the signal range ends:
 *
 *   - the kill ladder tested `exitCode > 128 && exitCode <= 128 + 64`;
 *   - the checker treated `exitCode >= 128` as "could not answer";
 *   - nsjail's own setup failure (exit 255) had a third path of its own.
 *
 * One decoder makes the disagreement unrepresentable. The checker keeps
 * an additional *policy* on top of it — an `exited` code at or above 128
 * is still "the checker could not answer", because those codes are
 * reserved for this encoding and a checker cannot legitimately choose
 * them — which is a rule about checker trustworthiness, not a second
 * decoder, and `classifyCheckerResult` documents it as such.
 */

export type JailExit =
  | { kind: "exited"; code: number }
  | { kind: "signalled"; signal: number }
  /** `exitCode === null`: the runner itself was signalled, or nothing ran. */
  | { kind: "none" };

/** SIGKILL — nsjail's own `--time_limit` wall backstop, and the group kill. */
export const SIGKILL = 9;
/** SIGXCPU — `RLIMIT_CPU` firing inside the jail. Unambiguously a timeout. */
export const SIGXCPU = 24;
/** SIGSYS — a syscall outside `policy.kafel` under a `KILL` action. */
export const SIGSYS = 31;

/**
 * Decode one exit status into what actually ended the run.
 *
 * `> 128 && <= 192` is a signal; **128 itself is a chosen exit code**,
 * because `WTERMSIG` is never 0 — a program that `exit(128)`s has said
 * something, however unconventional, and calling that "signal 0" would
 * invent a signal that cannot exist. The upper bound is 128 + 64, past
 * the highest real-time signal Linux defines, so nsjail's own 255 stays
 * an `exited` code and keeps its distinct meaning ("could not execve").
 */
export function decodeJailExit(exitCode: number | null): JailExit {
  if (exitCode === null) return { kind: "none" };
  if (exitCode > 128 && exitCode <= 128 + 64) {
    return { kind: "signalled", signal: exitCode - 128 };
  }
  return { kind: "exited", code: exitCode };
}
