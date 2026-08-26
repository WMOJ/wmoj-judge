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
 * `config.COMPILE_CACHE_DIR/<key>/` and are reclaimed on expiry, by the
 * sweep that runs every 60s. Nothing reclaims them at shutdown — the
 * process exits and `startupSweep()` removes the whole `judge-` prefixed
 * tree (which the default cache dir, `/tmp/judge-cache`, sits inside)
 * before the next boot repopulates it.
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
    // A live map entry is not proof the artifact is still on disk: the
    // eviction sweep, a `put()` that failed part-way, or anything else
    // with write access to /tmp can remove the directory underneath it.
    // The caller's next move is `fs.cp()` from this path, which rejects
    // ENOENT and turns a submission that compiled perfectly into a 500 —
    // or, worse, copies a partially-removed tree and grades every case
    // `RE` on a clean 200. A missing directory must be a cache MISS, so
    // the submission simply recompiles.
    try {
      await fs.access(entry.dir);
    } catch {
      this.entries.delete(key);
      return null;
    }
    return entry.dir;
  }

  /**
   * Copy `artifactDir` into the cache under `key` and return the cached
   * path.
   *
   * Atomic staging: write into a temp dir, then rename it into place.
   * Concurrent readers (`fs.cp` from the cache path in
   * routes/submit.ts) therefore see either no entry at all or one
   * complete artifact, never a half-populated directory.
   *
   * `key` is a content hash of (language, source, compile argv), so
   * whatever already sits at `dst` is byte-identical to what we just
   * staged. That is why this NEVER removes an existing `dst`: the
   * previous version did, and the resulting rm-then-rename window was
   * open while the map entry still pointed at `dst`, so a third
   * submission of the same source could `fs.cp` from a directory being
   * deleted (500), copy a tree with the source but no binary (`RE` on
   * every case, HTTP 200), or — if the rename then failed on a full
   * /tmp — leave the entry pointing at a directory that no longer
   * exists, 500ing every submission of that source for the rest of the
   * 15-minute TTL with no self-healing. The loser of the race discards
   * its own staging directory and adopts the winner's tree.
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
      try {
        await fs.rename(tmp, dst);
      } catch (err) {
        // POSIX rename refuses to replace a non-empty directory. That
        // means a concurrent put() for the same content hash got there
        // first; keep its identical tree and drop ours.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EISDIR") {
          throw err;
        }
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      // Whatever is at `dst` after a failed put is not something we can
      // vouch for, and submit.ts only logs this rejection at warn — so
      // drop the entry rather than leaving a live pointer to it.
      this.entries.delete(key);
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
   * Only ever called by the background timer started in `start()`.
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
   * on-disk artifacts: the next boot's `startupSweep()` removes them,
   * because every `judge-` prefixed entry under os.tmpdir() goes, and
   * the default cache dir is `/tmp/judge-cache`.
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

/** Stop the background eviction timer. Called by `shutdown()` in util/shutdown.ts. */
export function stopCompileCache(): void {
  compileCache.shutdown();
}
