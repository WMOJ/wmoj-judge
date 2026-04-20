import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import type { Executor, Language } from "../types";
import languages from "../../languages.json";
import { buildChildEnv } from "../sandbox/minimalEnv";

type CppStandard = "cpp14" | "cpp17" | "cpp20" | "cpp23";

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
      const env = buildChildEnv(standard satisfies Language);
      return runCompile(argv, workDir, env);
    },

    buildRunCommand(_workDir: string, _filename: string): { argv: string[] } {
      return { argv: [...spec.run.argv] };
    },
  };
}

function runCompile(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  return new Promise((resolve) => {
    if (argv.length === 0) {
      resolve({ ok: false, stderr: "empty compile argv" });
      return;
    }
    const [cmd, ...args] = argv as [string, ...string[]];
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, stderr: `${err.message}\n${stderr}` });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        // g++ writes diagnostics to stderr; include stdout in case a future
        // flag sends errors there.
        const combined = stderr + (stdout ? `\n${stdout}` : "");
        resolve({ ok: false, stderr: combined });
      }
    });
  });
}
