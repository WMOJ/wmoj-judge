import { promises as fs } from "fs";
import path from "path";
import type { Executor } from "../types";
import languages from "../../languages.json";

const SPEC = languages.python3;

/**
 * Python 3 executor. Interpreted — no compile step.
 *
 * Also used as the target for the legacy "python" language code (mapping
 * lives in executors/index.ts).
 */
export const pythonExecutor: Executor = {
  filename(_code: string): string {
    return SPEC.filename;
  },

  async prepare(workDir: string, code: string): Promise<void> {
    const filePath = path.join(workDir, SPEC.filename);
    await fs.writeFile(filePath, code, "utf8");
  },

  async compile(_workDir: string): Promise<{ ok: true } | { ok: false; stderr: string }> {
    return { ok: true };
  },

  buildRunCommand(_workDir: string, _filename: string): { argv: string[] } {
    return { argv: [...SPEC.run.argv] };
  },
};
