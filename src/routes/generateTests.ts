import { Router, type Request, type Response } from "express";
import { promises as fs } from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { runSandboxed } from "../sandbox/nsjail";
import { acquireUid, releaseUid } from "../queue/uidPoolSingleton";
import { buildChildEnv } from "../sandbox/minimalEnv";
import { createWorkdir, cleanupWorkdir } from "../util/workdir";
import { logger } from "../util/logger";
import { isDraining } from "../util/shutdown";

/**
 * Looser resource limits for the generator: it runs trusted admin code
 * whose whole job is to produce a batch of test cases. Still no network
 * and still sandboxed via nsjail — cheap insurance.
 */
const GENERATOR_TIME_LIMIT_MS = 60_000;
const GENERATOR_MEM_LIMIT_MB = 1024;

/**
 * True when Node is running as root. On Render we run as UID 1000 so
 * this is false and every chown below becomes a no-op -- same rationale
 * as in routes/submit.ts. Saves a syscall and avoids spamming EPERM.
 */
const isRootNode: boolean =
  typeof process.geteuid === "function" && process.geteuid() === 0;

/**
 * Compile a generator's C++ source. Compilation runs OUTSIDE nsjail
 * (it's a trusted `g++` invocation on admin-submitted source, same
 * trust boundary as the existing /generate-tests endpoint) but uses
 * `minimalEnv` to scrub the child environment.
 */
function compileGenerator(
  workDir: string,
  srcPath: string,
  outPath: string,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  return new Promise((resolve) => {
    const env = buildChildEnv("cpp17");
    const child = spawn(
      "/usr/bin/g++",
      ["-O2", "-std=gnu++17", srcPath, "-o", outPath],
      { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ ok: false, stderr: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr: stderr || `g++ exited ${code}` });
    });
  });
}

/**
 * Coerce an arbitrary JSON value to a string. Matches the existing
 * server.js behavior so the response is byte-identical to today.
 */
function coerceToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v ?? "");
  }
}

export const generateTestsRouter: Router = Router();

/**
 * POST /generate-tests — admin-only: compile a C++ generator, run it
 * inside nsjail with generous limits, parse stdout as the input JSON
 * array and stderr as the output JSON array, coerce to strings.
 *
 * Response shape is byte-identical to the previous server.js version:
 * { inputJson, outputJson, input: string[], output: string[] }.
 */
generateTestsRouter.post("/", async (req: Request, res: Response) => {
  // Refuse new work during drain. Must run BEFORE any resource acquisition
  // (UID / workdir / compile / sandbox spawn) so SIGTERM can actually
  // quiesce the judge within the drain window.
  if (isDraining()) {
    res.status(503).json({ error: "shutting down" });
    return;
  }

  const body = req.body ?? {};
  const { language, code } = body as { language?: string; code?: string };

  if (!code || (language && language !== "cpp" && language !== "cpp14" && language !== "cpp17")) {
    res.status(400).json({
      error: "Invalid payload. Required: code (C++). language must be cpp/cpp14/cpp17 if provided.",
    });
    return;
  }

  let uid: number | null = null;
  let workDir: string | null = null;

  try {
    uid = await acquireUid();
    workDir = await createWorkdir(uid);

    const srcPath = path.join(workDir, "Generator.cpp");
    const outPath = path.join(workDir, "gen.out");
    await fs.writeFile(srcPath, code, "utf8");
    // Make sure the pool UID can read the source and write the binary.
    // Only meaningful when Node runs as root; under unprivileged Node
    // (Render) the files are already owned by the running UID.
    if (isRootNode) await fs.chown(srcPath, uid, uid).catch(() => {});

    const compileRes = await compileGenerator(workDir, srcPath, outPath);
    if (!compileRes.ok) {
      res.status(400).json({ error: `Compilation failed\n${compileRes.stderr}` });
      return;
    }
    if (isRootNode) await fs.chown(outPath, uid, uid).catch(() => {});

    const sandboxRes = await runSandboxed({
      argv: ["./gen.out"],
      cwd: workDir,
      uid,
      gid: uid,
      timeLimitMs: GENERATOR_TIME_LIMIT_MS,
      memLimitMb: GENERATOR_MEM_LIMIT_MB,
      stdin: "",
    });

    if (sandboxRes.exitCode !== 0 || sandboxRes.killedBy !== null) {
      res.status(400).json({
        error: `Generator exited with code ${sandboxRes.exitCode} (${sandboxRes.killedBy ?? "ok"})`,
        inputJson: sandboxRes.stdout,
        outputJson: sandboxRes.stderr,
      });
      return;
    }

    const inputRaw = sandboxRes.stdout;
    const outputRaw = sandboxRes.stderr;

    let inputArr: unknown;
    let outputArr: unknown;
    try {
      inputArr = JSON.parse(inputRaw);
    } catch (e) {
      res.status(400).json({
        error: `Invalid JSON on stdout: ${(e as Error).message}`,
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }
    try {
      outputArr = JSON.parse(outputRaw);
    } catch (e) {
      res.status(400).json({
        error: `Invalid JSON on stderr: ${(e as Error).message}`,
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }

    if (!Array.isArray(inputArr) || !Array.isArray(outputArr)) {
      res.status(400).json({
        error: "Both stdout and stderr must be JSON arrays",
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }
    if (inputArr.length !== outputArr.length) {
      res.status(400).json({
        error: "Input and output arrays must be the same length",
        inputJson: inputRaw,
        outputJson: outputRaw,
      });
      return;
    }

    const input = inputArr.map(coerceToString);
    const output = outputArr.map(coerceToString);

    res.json({ inputJson: inputRaw, outputJson: outputRaw, input, output });
  } catch (err) {
    logger.error({ err }, "generate-tests: unexpected failure");
    res.status(500).json({ error: (err as Error).message });
  } finally {
    if (workDir) await cleanupWorkdir(workDir);
    if (uid !== null) releaseUid(uid);
  }
});
