import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import type { CompileCache } from "../types";
import { config } from "../config";
import { logger } from "../util/logger";

/**
 * Compute the cache key for a compilation. Must produce the same digest
 * for identical (language, source, compile-argv) tuples across restarts
 * so that cache files survive process churn.
 */
export function cacheKey(
  language: string,
  code: string,
  compileArgv: readonly string[],
): string {
  const h = createHash("sha256");
  h.update(language);
  h.update("\x00");
  h.update(code);
  h.update("\x00");
  h.update(JSON.stringify(compileArgv));
  return h.digest("hex");
}

interface CacheEntry {
  /** Absolute path to the directory holding the cached artifact. */
  dir: string;
  /** Epoch millis at which this entry expires and becomes evictable. */
  expiresAt: number;
}

/**
 * Copy a directory tree. Used to seed a submission workdir from a
 * cached artifact directory. Relies on Node's native recursive cp
 * (available since 16.7) — no external deps.
 */
async function copyDir(src: string, dst: string): Promise<void> {
  await fs.cp(src, dst, { recursive: true, force: true });
}

/**
 * TTL-evicting compile cache. Artifacts live under
 * `config.COMPILE_CACHE_DIR/<key>/` and are reclaimed either on expiry
 * (checked every 60s) or when `shutdown()` is called.
 */
class DiskCompileCache implements CompileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private evictionTimer: NodeJS.Timeout | null = null;
  private bootstrapped = false;

  constructor(
    private readonly baseDir: string,
    private readonly ttlMs: number,
  ) {}

  /** Create the cache directory if absent. Idempotent. */
  private async ensureBase(): Promise<void> {
    if (this.bootstrapped) return;
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    this.bootstrapped = true;
  }

  /**
   * Return the path to a cached artifact directory for `key`, or null
   * if there is no live entry. Callers should copy the contents into
   * their own workdir; the cache directory must not be mutated.
   */
  async get(key: string): Promise<string | null> {
    await this.ensureBase();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    return entry.dir;
  }

  /**
   * Copy `artifactDir` into the cache under `key` and return the new
   * cached path. Overwrites any existing entry for the same key.
   *
   * Atomic staging: write into a temp dir, then rm+rename. Concurrent
   * readers (`fs.cp` from the cache path in routes/submit.ts) therefore
   * see either the previous complete artifact or the new complete one,
   * never a half-populated directory. The small rm→rename window still
   * exists but a reader that races it just gets a cache miss from
   * `get()` (which re-checks the in-memory map) — harmless.
   */
  async put(key: string, artifactDir: string): Promise<string> {
    await this.ensureBase();
    const dst = path.join(this.baseDir, key);
    const tmp = path.join(
      this.baseDir,
      `${key}.tmp-${randomBytes(8).toString("hex")}`,
    );
    try {
      await copyDir(artifactDir, tmp);
      // fs.rename cannot replace a non-empty directory on POSIX; remove
      // any existing entry first, then move the staged dir into place.
      await fs.rm(dst, { recursive: true, force: true }).catch(() => {});
      await fs.rename(tmp, dst);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    this.entries.set(key, { dir: dst, expiresAt: Date.now() + this.ttlMs });
    return dst;
  }

  /**
   * Start the background eviction sweep. Called once from `server.ts`.
   */
  start(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      this.evictExpired().catch((err) => {
        logger.warn({ err }, "compile cache: eviction sweep failed");
      });
    }, 60_000);
    // Don't hold the event loop open.
    this.evictionTimer.unref();
  }

  /**
   * Remove expired entries both from the in-memory map and from disk.
   * Called both by the background timer and by `shutdown()`.
   */
  private async evictExpired(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) toRemove.push(key);
    }
    for (const key of toRemove) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      this.entries.delete(key);
      await fs.rm(entry.dir, { recursive: true, force: true }).catch((err) => {
        logger.warn(
          { err, dir: entry.dir },
          "compile cache: failed to remove expired entry",
        );
      });
    }
  }

  /**
   * Stop the eviction timer. Called from shutdown.ts. Does not touch
   * on-disk artifacts — they're safe to leave for the next boot.
   */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
}

/**
 * Singleton compile cache. Configured from `config.COMPILE_CACHE_DIR`
 * and `config.COMPILE_CACHE_TTL_MS`.
 */
export const compileCache = new DiskCompileCache(
  config.COMPILE_CACHE_DIR,
  config.COMPILE_CACHE_TTL_MS,
);

/** Start the background eviction timer. Call once at boot. */
export function startCompileCache(): void {
  compileCache.start();
}

/** Stop the background eviction timer. Call from shutdown. */
export function stopCompileCache(): void {
  compileCache.shutdown();
}
