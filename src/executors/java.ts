import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import type { Executor } from "../types";
import languages from "../../languages.json";
import { buildChildEnv } from "../sandbox/minimalEnv";

type JavaVariant = "java8" | "java-latest";

/**
 * Detect the declared public class name in Java source so the file can be
 * written with the matching name (javac will reject a mismatch).
 *
 * Matches `public class Foo`, `public final class Foo`, or
 * `final public class Foo`. We pick the FIRST match; if no `public` class
 * is declared we fall back to "Main" so the program still compiles when
 * the user wrote a single default-visibility class named Main.
 *
 * Class-name detection is version-agnostic — the same regex works for
 * java8 and java-latest sources; only the javac/java binaries differ.
 */
export function detectJavaClassName(code: string): string {
  // Covers: `public class X`, `public final class X`, `public  class X`, etc.
  // Line/block comments containing the literal "public class" are a known
  // edge case we accept — the competitive-programming convention is one
  // class per file with no such tricks, and javac will surface any
  // mismatch as a normal compile error.
  const pattern =
    /public\s+(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const match = pattern.exec(code);
  if (match && match[1]) {
    return match[1];
  }
  return "Main";
}

/**
 * Substitute occurrences of the literal placeholder "<CLASS>" in an argv
 * template with the detected class name. Used for javac and java argv
 * coming from languages.json.
 */
function substClass(argv: readonly string[], className: string): string[] {
  return argv.map((a) => a.replace(/<CLASS>/g, className));
}

/**
 * Build a Java executor bound to a specific variant (java8 or
 * java-latest). Each variant picks up its own javac + java binary paths
 * from languages.json; class-name detection is shared.
 */
export function createJavaExecutor(variant: JavaVariant): Executor {
  const spec = languages[variant];

  return {
    filename(code: string): string {
      return `${detectJavaClassName(code)}.java`;
    },

    async prepare(workDir: string, code: string): Promise<void> {
      const fname = this.filename(code);
      await fs.writeFile(path.join(workDir, fname), code, "utf8");
    },

    async compile(
      workDir: string
    ): Promise<{ ok: true } | { ok: false; stderr: string }> {
      // Re-derive the class name from the source we just wrote. Reading the
      // file back guarantees we use exactly the bytes on disk; alternatives
      // (caching through the Executor object) would leak state across calls.
      const className = await detectClassNameFromWorkdir(workDir);
      const argv = substClass(spec.compile.argv, className);
      return runCompile(argv, workDir, buildChildEnv(variant));
    },

    buildRunCommand(_workDir: string, filename: string): { argv: string[] } {
      // filename is "<ClassName>.java" as returned by filename(code).
      const className = filename.replace(/\.java$/, "");
      return { argv: substClass(spec.run.argv, className) };
    },
  };
}

async function detectClassNameFromWorkdir(workDir: string): Promise<string> {
  const entries = await fs.readdir(workDir);
  const javaFile = entries.find((f) => f.endsWith(".java"));
  if (!javaFile) return "Main";
  const source = await fs.readFile(path.join(workDir, javaFile), "utf8");
  return detectJavaClassName(source);
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
        const combined = stderr + (stdout ? `\n${stdout}` : "");
        resolve({ ok: false, stderr: combined });
      }
    });
  });
}
