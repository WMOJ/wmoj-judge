import { promises as fs } from "fs";
import path from "path";
import type { Executor, Language } from "../types";
import languages from "../../languages.json";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { runCompile } from "../util/compile";

/**
 * The four C++ standards this factory serves. Derived from `Language` via
 * `Extract` so a standard `types.ts` does not know about collapses to
 * `never` and fails at every call site, instead of reaching
 * `languages[standard]` as an undefined lookup. This is the check that
 * `buildChildEnv(standard satisfies Language)` used to carry incidentally,
 * before `buildChildEnv` stopped taking a language at all.
 */
type CppStandard = Extract<Language, "cpp14" | "cpp17" | "cpp20" | "cpp23">;

/**
 * Build a C++ executor bound to a specific standard (c++14, c++17,
 * c++20, or c++23).
 *
 * The language code for legacy "cpp" submissions is mapped to cpp17 inside
 * executors/index.ts — this module is standards-agnostic and reads the
 * correct compile/run argv (including the `-std=c++<N>` flag) from
 * languages.json.
 *
 * Compilation is trusted: we run g++ OUTSIDE nsjail because it is the
 * judge transforming source, not executing user-provided behaviour. The
 * child still gets a scrubbed env from sandbox/minimalEnv so a malicious
 * `#include` or pragma cannot read host variables.
 */
export function createCppExecutor(standard: CppStandard): Executor {
  const spec = languages[standard];

  return {
    filename(_code: string): string {
      return spec.filename;
    },

    async prepare(workDir: string, code: string): Promise<void> {
      const filePath = path.join(workDir, spec.filename);
      await fs.writeFile(filePath, code, "utf8");
    },

    async compile(
      workDir: string
    ): Promise<{ ok: true } | { ok: false; stderr: string }> {
      const argv = spec.compile.argv;
      const env = buildChildEnv();
      return runCompile(argv, workDir, env);
    },

    buildRunCommand(_workDir: string, _filename: string): { argv: string[] } {
      return { argv: [...spec.run.argv] };
    },
  };
}
