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
  // Strip trailing whitespace characters (space, tab, \r, vertical tab, form feed, NBSP).
  return line.replace(/[\s\uFEFF\xA0]+$/, "");
}
