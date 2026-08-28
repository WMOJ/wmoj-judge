import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DiskCompileCache, cacheKey } from "../../src/cache/compileCache";

/**
 * The compile cache against a real temp directory. Every case here is a
 * failure that has already happened once in production or in review: a
 * live map entry whose directory vanished underneath it (the eviction
 * sweep, a half-failed put, anything with write access to /tmp), a TTL
 * that expires between `put` and `get`, and two submissions of the same
 * source racing to `put` the same key.
 */

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "judge-cache-test-"));
}

async function artifact(content: string): Promise<string> {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "a.out"), content);
  return dir;
}

async function withCache(
  ttlMs: number,
  body: (cache: DiskCompileCache, base: string) => Promise<void>,
): Promise<void> {
  const base = path.join(await tmpDir(), "cache");
  const cache = new DiskCompileCache(base, ttlMs);
  try {
    await body(cache, base);
  } finally {
    cache.shutdown();
    await fs.rm(path.dirname(base), { recursive: true, force: true });
  }
}

test("cacheKey is stable and sensitive to every part of the tuple", () => {
  const argv = ["/usr/bin/g++", "-O2"];
  const k = cacheKey("cpp17", "int main(){}", argv);
  assert.equal(k, cacheKey("cpp17", "int main(){}", [...argv]));
  assert.notEqual(k, cacheKey("cpp20", "int main(){}", argv));
  assert.notEqual(k, cacheKey("cpp17", "int main(){ }", argv));
  assert.notEqual(k, cacheKey("cpp17", "int main(){}", [...argv, "-fmax-errors=50"]));
  assert.match(k, /^[0-9a-f]{64}$/);
});

test("a cold key is a miss", async () => {
  await withCache(60_000, async (cache) => {
    assert.equal(await cache.get("nope"), null);
  });
});

test("put then get returns a directory holding the artifact, inside the cache base", async () => {
  await withCache(60_000, async (cache, base) => {
    const src = await artifact("binary");
    const stored = await cache.put("k1", src);
    assert.equal(path.dirname(stored), base);
    assert.equal(await cache.get("k1"), stored);
    assert.equal(await fs.readFile(path.join(stored, "a.out"), "utf8"), "binary");
    await fs.rm(src, { recursive: true, force: true });
  });
});

test("a live entry whose directory was removed underneath is a miss, not a 500", async () => {
  await withCache(60_000, async (cache) => {
    const src = await artifact("binary");
    const stored = await cache.put("k2", src);
    await fs.rm(stored, { recursive: true, force: true });
    assert.equal(await cache.get("k2"), null);
    await fs.rm(src, { recursive: true, force: true });
  });
});

test("an expired entry is a miss on get, and its directory is gone", async () => {
  await withCache(1, async (cache) => {
    const src = await artifact("binary");
    const stored = await cache.put("k3", src);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await cache.get("k3"), null);
    await assert.rejects(fs.access(stored), "the expired directory must be removed");
    await fs.rm(src, { recursive: true, force: true });
  });
});

test("evictExpired removes expired entries from disk without a get", async () => {
  await withCache(1, async (cache) => {
    const src = await artifact("binary");
    const stored = await cache.put("k4", src);
    await new Promise((r) => setTimeout(r, 5));
    await cache.evictExpired();
    await assert.rejects(fs.access(stored));
    assert.equal(await cache.get("k4"), null);
    await fs.rm(src, { recursive: true, force: true });
  });
});

test("two concurrent puts for one key leave one directory and both resolve to it", async () => {
  await withCache(60_000, async (cache, base) => {
    const a = await artifact("same bytes");
    const b = await artifact("same bytes");
    const [pa, pb] = await Promise.all([cache.put("k5", a), cache.put("k5", b)]);
    assert.equal(pa, pb);
    const entries = await fs.readdir(base);
    assert.deepEqual(entries, ["k5"], "no staging directory may be left behind");
    assert.equal(await cache.get("k5"), pa);
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  });
});

test("a put whose source does not exist rejects and leaves no entry", async () => {
  await withCache(60_000, async (cache, base) => {
    await assert.rejects(cache.put("k6", path.join(base, "does-not-exist")));
    assert.equal(await cache.get("k6"), null);
    const entries = (await fs.readdir(base)).filter((e) => e.startsWith("k6"));
    assert.deepEqual(entries, []);
  });
});
