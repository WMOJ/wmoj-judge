import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import type { Executor, Language } from "../types";
import languages from "../../languages.json";
import { buildChildEnv } from "../sandbox/minimalEnv";

type CppStandard = "cpp14" | "cpp17" | "cpp20" | "cpp23";

/**
 * Cap on how much of a compiler's stdout/stderr we keep, per stream.
 *
 * Nothing else bounds this text: it goes straight into the HTTP 200
 * body as `compileError`, while the log line that merely *records* it
 * truncates at 2000 chars. A ≤100 KB submission engineered for
 * diagnostic volume — deep template instantiation, repeated
 * `_Pragma("message(…)")` — makes g++ exit quickly and cheaply while
 * emitting hundreds of MB of stderr. That is not the documented
 * "compile bomb OOMs the service" hazard (which is about g++'s own
 * resources and whose remedy is sandboxing the compile): here it is the
 * *judge's* heap that grows, a compile timeout would not help, and past
 * V8's max string length `stderr += …` throws `RangeError`
 * synchronously inside a stream `'data'` handler — an uncaught
 * exception, not a rejected promise. 64 KB is far more diagnostics than
 * any human reads.
 */
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** Appended when a stream hit `MAX_DIAGNOSTIC_BYTES`. */
const DIAGNOSTICS_TRUNCATED = "\n[diagnostics truncated by the judge]\n";

/**
 * Attach a capped, decode-once collector to a compiler's stdio stream
 * and return a function that decodes everything collected.
 *
 * Buffers are accumulated and decoded **once**, at close, matching
 * `sandbox/nsjail.ts`. Decoding per chunk (`stderr += chunk.toString()`)
 * decodes each 64 KB pipe chunk in isolation, so a multi-byte sequence
 * straddling a chunk boundary becomes U+FFFD on both sides —
 * `buildChildEnv` sets `LC_ALL=C.UTF-8` and g++ quotes every identifier
 * with U+2018/U+2019, so multi-byte sequences occur about once per
 * diagnostic line. Compiler output is the one place a student reads raw
 * judge bytes, and it was showing them replacement characters.
 *
 * `stream` is nullable because `ChildProcess.prototype.spawn` returns
 * early on UV_EMFILE/UV_ENFILE *before* assigning `stdout`/`stderr`; a
 * bare `child.stderr.on(…)` would then throw a TypeError synchronously
 * inside the `new Promise` executor, rejecting where every caller here
 * expects a discriminated `{ok:false}` — surfacing as a 500 instead of
 * a `compileError`. The `'error'` event still fires and resolves the
 * result object.
 */
function collectCapped(stream: NodeJS.ReadableStream | null): () => string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;

  stream?.on("data", (chunk: Buffer) => {
    const room = MAX_DIAGNOSTIC_BYTES - bytes;
    if (room <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      bytes = MAX_DIAGNOSTIC_BYTES;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  });

  return () => {
    const text = Buffer.concat(chunks).toString("utf8");
    return truncated ? `${text}${DIAGNOSTICS_TRUNCATED}` : text;
  };
}

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

    const readStdout = collectCapped(child.stdout);
    const readStderr = collectCapped(child.stderr);

    child.on("error", (err) => {
      resolve({ ok: false, stderr: `${err.message}\n${readStderr()}` });
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // g++ writes diagnostics to stderr; include stdout in case a future
      // flag sends errors there.
      const stdout = readStdout();
      const combined = readStderr() + (stdout ? `\n${stdout}` : "");
      if (combined.trim().length > 0) {
        resolve({ ok: false, stderr: combined });
        return;
      }
      // A failure with no diagnostics at all — g++ killed by the OOM
      // killer or a signal, or exiting non-zero without printing. The
      // caller puts this string straight into `compileError`, and
      // `wmoj-app` renders it as the student's CE message, so an empty
      // one is a CE with no explanation. Say what actually happened.
      resolve({
        ok: false,
        stderr:
          signal !== null
            ? `g++ was killed by ${signal}`
            : `g++ exited ${code} with no diagnostics`,
      });
    });
  });
}
