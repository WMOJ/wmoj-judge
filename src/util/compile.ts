import { spawn } from "child_process";

/**
 * Cap on how much of a compiler's stdout/stderr the judge keeps, per stream.
 *
 * Nothing else bounds this text: it goes straight into an HTTP body as
 * `compileError` / `checkerError` / the 400's `error`, while the log line that
 * merely *records* it truncates at 2000 chars. Source is capped at 100 KB but can
 * still be engineered for diagnostic volume — deep template instantiation,
 * repeated `_Pragma("message(…)")` — making g++ exit quickly and cheaply while
 * emitting hundreds of MB of stderr. That is not the "compile bomb OOMs the
 * service" hazard (which is about g++'s own resources, and whose remedy is
 * sandboxing the compile): here it is the *judge's* heap that grows, a compile
 * timeout would not help, and past V8's max string length `stderr += …` throws
 * `RangeError` synchronously inside a stream `'data'` handler — an uncaught
 * exception, not a rejected promise. 64 KB is far more diagnostics than any
 * human reads.
 */
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/** Appended when a stream hit `MAX_DIAGNOSTIC_BYTES`. */
const DIAGNOSTICS_TRUNCATED = "\n[diagnostics truncated by the judge]\n";

/**
 * Attach a capped, decode-once collector to a compiler's stdio stream and
 * return a function that decodes everything collected.
 *
 * Buffers are accumulated and decoded **once**, at close, matching
 * `sandbox/nsjail.ts`. Decoding per chunk (`stderr += chunk.toString()`) decodes
 * each 64 KB pipe chunk in isolation, so a multi-byte sequence straddling a
 * chunk boundary becomes U+FFFD on both sides — `buildChildEnv` sets
 * `LC_ALL=C.UTF-8` and g++ quotes every identifier with U+2018/U+2019, so
 * multi-byte sequences occur about once per diagnostic line. Compiler output is
 * the one place a student reads raw judge bytes, and it was showing them
 * replacement characters.
 *
 * `stream` is nullable because `ChildProcess.prototype.spawn` returns early on
 * UV_EMFILE/UV_ENFILE *before* assigning `stdout`/`stderr`; a bare
 * `child.stderr.on(…)` would then throw a TypeError synchronously inside the
 * `new Promise` executor, rejecting where every caller expects a discriminated
 * `{ok:false}` — surfacing as a 500 instead of the compile-failure channel each
 * route's contract promises. The `'error'` event still fires and resolves the
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

export type CompileResult = { ok: true } | { ok: false; stderr: string };

/**
 * Spawn a compiler and resolve a discriminated result. Never rejects: every
 * failure path, spawn errors included, comes back as `{ok:false, stderr}`,
 * because each caller's contract turns a failed compile into a 200 or a 400
 * rather than a 500.
 *
 * The single implementation for all three g++ invocations in this service —
 * a submission (`executors/cpp.ts`), a generator (`routes/generateTests.ts`)
 * and a checker (`checker/index.ts`). All three spawn g++ outside nsjail and
 * put its diagnostics into an HTTP body; sharing one function is what stops
 * them drifting into three different truncation, decoding and
 * failure-reporting behaviours for the same compiler.
 *
 * stdout is piped, so it MUST be drained: with `stdio: [.., "pipe", ..]` and no
 * listener the pipe fills at 64 KB and g++ blocks on write forever, hanging the
 * request with a UID-pool slot held.
 */
export function runCompile(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CompileResult> {
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
      resolve({ ok: false, stderr: `spawn error: ${err.message}\n${readStderr()}` });
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      // g++ writes diagnostics to stderr; include stdout in case a flag sends
      // errors there.
      const stdout = readStdout();
      const combined = readStderr() + (stdout ? `\n${stdout}` : "");
      if (combined.trim().length > 0) {
        resolve({ ok: false, stderr: combined });
        return;
      }
      // A failure with no diagnostics at all — g++ killed by the OOM killer or
      // a signal, or exiting non-zero without printing. The caller puts this
      // string straight into the body `wmoj-app` renders, so an empty one is a
      // compile error with no explanation. Say what actually happened.
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
