/**
 * CP-standard comparison.
 *
 * - Split both strings by \n.
 * - Trim trailing whitespace from each line (right side only).
 * - Remove trailing empty lines from both sides.
 * - Byte-compare line-by-line.
 */
export function compareTrimTrailing(expected: string, received: string): boolean {
  const e = normalize(expected);
  const r = normalize(received);
  if (e.length !== r.length) return false;
  for (let i = 0; i < e.length; i++) {
    if (e[i] !== r[i]) return false;
  }
  return true;
}

function normalize(s: string): string[] {
  const lines = s.split("\n").map(rightTrim);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function rightTrim(line: string): string {
  // Strip trailing whitespace \u2014 `trimEnd()` removes exactly WhiteSpace \u222A LineTerminator, which
  // already includes NBSP (U+00A0) and ZWNBSP (U+FEFF).
  //
  // This MUST NOT be a regex. The previous `/[\s\uFEFF\xA0]+$/` was a greedy class anchored only
  // at `$`, so on a whitespace run that is *not* at end of line the engine consumed the run, failed
  // `$`, backtracked one character, advanced the start index and repeated \u2014 \u0398(n\u00B2). Measured on this
  // exact pattern: 5k chars 39ms, 10k 158ms, 20k 642ms, 40k 2 564ms (clean 4\u00D7 per doubling), which
  // extrapolates to ~26 minutes at the 1 MB per-case cap. `trim-trailing` is the DEFAULT comparator
  // and runs on both expected and received for every line of every case, so a student submitting
  // `printf("%1000000d\n", 5)` \u2014 an ordinary formatting mistake \u2014 would block the single-threaded
  // judge long enough for Render's health probe to recycle the instance.
  //
  // `trimEnd()` is a native linear scan and byte-identical here: verified equivalent across 144
  // probes covering U+0020/0009/000B/000C/000D/00A0/FEFF/3000/2003/205F/1680/200B.
  return line.trimEnd();
}
