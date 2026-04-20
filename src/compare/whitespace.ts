/**
 * Whitespace-insensitive comparison.
 *
 * Collapses all whitespace runs (including newlines) to a single space and
 * trims both ends before comparing. This is the legacy behaviour preserved
 * as an opt-in mode; it is NOT the default.
 */
export function compareWhitespace(expected: string, received: string): boolean {
  return collapse(expected) === collapse(received);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
