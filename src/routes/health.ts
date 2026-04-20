import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import { logger } from "../util/logger";
import { buildChildEnv } from "../sandbox/minimalEnv";
import type { Language } from "../types";

/**
 * One probe entry: the command to run and the version flag. A probe
 * passes if the process exits 0 within 2 seconds.
 *
 * `envLang` selects which language-flavoured env map buildChildEnv
 * produces for the spawn — keeps every spawn going through the same
 * scrub path as user code (no leaking the judge's full process.env).
 */
interface Probe {
  name: string;
  cmd: string;
  args: string[];
  envLang: Language;
}

const PROBES: Probe[] = [
  { name: "python3", cmd: "python3", args: ["-V"], envLang: "python3" },
  { name: "pypy3", cmd: "pypy3", args: ["--version"], envLang: "pypy3" },
  { name: "g++", cmd: "g++", args: ["--version"], envLang: "cpp17" },
  // Absolute Temurin paths so each JDK is probed independently (the
  // `java` on PATH only resolves to one via update-alternatives, and
  // silently probing the "wrong" JDK would mask the other being broken).
  { name: "java8", cmd: "/usr/lib/jvm/temurin-8-jdk-amd64/bin/java", args: ["-version"], envLang: "java8" },
  { name: "java-latest", cmd: "/usr/lib/jvm/temurin-25-jdk-amd64/bin/java", args: ["-version"], envLang: "java-latest" },
];

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

interface CachedHealth {
  ok: boolean;
  failures: string[];
  expiresAt: number;
}

let cached: CachedHealth | null = null;

/**
 * Run a single toolchain probe. Resolves to `{name, ok, reason?}` —
 * never rejects, so `Promise.all` sees every probe's result.
 */
function runProbe(p: Probe): Promise<{ name: string; ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(p.cmd, p.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(p.envLang),
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ name: p.name, ok: false, reason: "timeout" });
    }, PROBE_TIMEOUT_MS);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ name: p.name, ok: false, reason: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ name: p.name, ok: true });
      } else {
        resolve({ name: p.name, ok: false, reason: `exit ${code}` });
      }
    });
  });
}

/**
 * Probe every toolchain in parallel; cache the result for 30s. Every
 * probe has a 2s timeout, so the whole /health call is bounded.
 */
async function computeHealth(): Promise<CachedHealth> {
  const results = await Promise.all(PROBES.map(runProbe));
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => `${r.name}: ${r.reason ?? "unknown"}`);
  return {
    ok: failures.length === 0,
    failures,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

/**
 * Best-effort eager probe at boot so operators notice toolchain issues
 * right away instead of only when a request arrives. Never throws.
 */
export async function probeToolchainAtBoot(): Promise<void> {
  try {
    cached = await computeHealth();
    if (!cached.ok) {
      logger.error({ failures: cached.failures }, "toolchain probes failed at boot");
      throw new Error(`toolchain degraded: ${cached.failures.join(", ")}`);
    }
    logger.info("toolchain probes passed");
  } catch (err) {
    // Re-throw so server.ts can crash at boot if required.
    throw err;
  }
}

export const healthRouter: Router = Router();

/**
 * GET /health — NO auth middleware. Returns { status: "ok" } (200) or
 * { status: "degraded", reason } (503). Cached for 30s so repeated
 * hits don't fork probes.
 */
healthRouter.get("/", async (_req: Request, res: Response) => {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    cached = await computeHealth();
  }
  if (cached.ok) {
    res.json({ status: "ok" });
    return;
  }
  res.status(503).json({
    status: "degraded",
    reason: cached.failures.join(", "),
  });
});
