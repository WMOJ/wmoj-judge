import { promises as fs } from "fs";
import path from "path";
import type { Executor } from "../types";
import languages from "../../languages.json";

const SPEC = languages.pypy3;

/**
 * PyPy 3 executor. Interpreted — no compile step.
 */
export const pypyExecutor: Executor = {
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
