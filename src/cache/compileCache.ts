import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
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
  /** Absolute path to the directory holding the cached artifacts. */
  dir: string;
  /** The names stored under `dir` — the artifact list `put` was given. */
  artifacts: readonly string[];
  /** Epoch millis at which this entry expires and becomes evictable. */
  expiresAt: number;
}

/**
 * A live cache entry: where the artifacts are, and which ones.
 *
 * The names come back with the directory because the cache is the only
 * thing that knows what it stored, and a caller that had to guess would
 * be back to copying the whole tree.
 */
export interface CacheHit {
  readonly dir: string;
  readonly artifacts: readonly string[];
}

/**
 * TTL-evicting compile cache. Artifacts live under `baseDir/<key>/`
 * (`config.COMPILE_CACHE_DIR` in production) and are reclaimed on expiry, by the
 * sweep that runs every 60s. Nothing reclaims them at shutdown — the
 * process exits and `startupSweep()` removes the whole `judge-` prefixed
 * tree (which the default cache dir, `/tmp/judge-cache`, sits inside)
 * before the next boot repopulates it.
 */
export class DiskCompileCache {
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
   * Return the cached artifacts for `key`, or null if there is no live
   * entry. Callers copy the named files into their own workspace; the
   * cache directory must not be mutated.
   */
  async get(key: string): Promise<CacheHit | null> {
    await this.ensureBase();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    // A live map entry is not proof the artifacts are still on disk: the
    // eviction sweep, a `put()` that failed part-way, or anything else
    // with write access to /tmp can remove the directory underneath it.
    // The caller's next move is a copy out of this path, which rejects
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
    return { dir: entry.dir, artifacts: entry.artifacts };
  }

  /**
   * Copy ONLY `artifacts` out of `fromDir` into the cache under `key`,
   * and return the cached path.
   *
   * Anything else in the workspace — a checker binary, the source, the
   * per-case scratch files — never enters the cache. It used to store
   * the whole workdir, which is why `compileChecker` carried a "MUST be
   * called after `put()`" ordering constraint: a `checker.out` present
   * at `put()` time was handed to a different problem whose contestant
   * submitted the same source, and that problem was then graded by the
   * wrong checker. A named list removes the hazard instead of
   * documenting it.
   *
   * Atomic staging: write into a temp dir, then rename it into place.
   * Concurrent readers (`copyIn` from the cache path in
   * routes/submit.ts) therefore see either no entry at all or one
   * complete set of artifacts, never a half-populated directory.
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
  async put(
    key: string,
    fromDir: string,
    artifacts: readonly string[],
  ): Promise<string> {
    await this.ensureBase();
    const dst = path.join(this.baseDir, key);
    const tmp = path.join(
      this.baseDir,
      `${key}.tmp-${randomBytes(8).toString("hex")}`,
    );
    try {
      await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
      for (const name of artifacts) {
        // `recursive` so an artifact that is a directory (none today —
        // `languages.json` declares `a.out`) is stored whole rather
        // than rejected. A missing artifact rejects, which is the
        // `catch` below: a cache entry that promises a binary it does
        // not have would grade every case `RE` on a clean 200.
        await fs.cp(path.join(fromDir, name), path.join(tmp, name), {
          recursive: true,
          force: true,
        });
      }
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
    this.entries.set(key, {
      dir: dst,
      artifacts: [...artifacts],
      expiresAt: Date.now() + this.ttlMs,
    });
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
   * Called by the background timer started in `start()`, and directly by
   * `test/unit/compileCache.test.ts`, which is the only reason it is not
   * private: the sweep is the one path that reclaims disk while the
   * process lives, and a test that had to wait for a 60 s interval to
   * exercise it would never run.
   */
  async evictExpired(): Promise<void> {
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
