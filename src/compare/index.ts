import type { CompareMode } from "../types";
import { compareExact } from "./exact";
import { compareTrimTrailing } from "./trimTrailing";
import { compareWhitespace } from "./whitespace";
import { compareFloatEpsilon } from "./floatEpsilon";

/**
 * Top-level compare entrypoint. Dispatches to the requested strategy.
 *
 * The default mode ("trim-trailing") is the competitive-programming standard:
 * line-oriented, trailing whitespace and trailing empty lines ignored, but
 * all other bytes significant. Callers pass `mode` from the submission
 * payload; if the caller passes undefined, they should default to
 * "trim-trailing" upstream — this function's parameter is typed as required
 * to keep the dispatch total.
 */
export function compare(
  mode: CompareMode,
  expected: string,
  received: string
): boolean {
  switch (mode) {
    case "exact":
      return compareExact(expected, received);
    case "trim-trailing":
      return compareTrimTrailing(expected, received);
    case "whitespace":
      return compareWhitespace(expected, received);
    case "float-epsilon":
      return compareFloatEpsilon(expected, received);
    default: {
      // Exhaustiveness guard: if a new mode is added to CompareMode without
      // a case here, TypeScript will flag this line.
      const _exhaustive: never = mode;
      void _exhaustive;
      return compareTrimTrailing(expected, received);
    }
  }
}
