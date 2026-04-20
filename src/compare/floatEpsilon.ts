/**
 * Float-epsilon comparison.
 *
 * Tokenizes both strings by any whitespace run. Token counts must match.
 * For each token pair: if BOTH parse as finite floats, they are considered
 * equal when |a - b| <= max(EPS, EPS * max(|a|, |b|)). Otherwise the tokens
 * must be byte-equal.
 */
const EPS = 1e-6;

export function compareFloatEpsilon(expected: string, received: string): boolean {
  const e = tokenize(expected);
  const r = tokenize(received);
  if (e.length !== r.length) return false;
  for (let i = 0; i < e.length; i++) {
    const eTok = e[i]!;
    const rTok = r[i]!;
    const eNum = parseFloatStrict(eTok);
    const rNum = parseFloatStrict(rTok);
    if (eNum !== null && rNum !== null) {
      const diff = Math.abs(eNum - rNum);
      const tol = Math.max(EPS, EPS * Math.max(Math.abs(eNum), Math.abs(rNum)));
      if (!(diff <= tol)) return false;
    } else if (eTok !== rTok) {
      return false;
    }
  }
  return true;
}

function tokenize(s: string): string[] {
  // Trim to avoid leading/trailing empty tokens from split.
  const trimmed = s.replace(/^\s+|\s+$/g, "");
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

function parseFloatStrict(tok: string): number | null {
  // Reject empty, or anything that isn't a finite number by JS rules
  // while still parsing via Number (which rejects trailing garbage unlike parseFloat).
  if (tok.length === 0) return null;
  const n = Number(tok);
  if (!Number.isFinite(n)) return null;
  return n;
}
