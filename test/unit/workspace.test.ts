import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createUidPool } from "../../src/sandbox/uidPool";
import { inFlightCount } from "../../src/util/shutdown";
import { leaseWorkspace, type Workspace } from "../../src/workspace";

/**
 * The workspace lease against a real temp directory and a real UID pool.
 *
 * Three properties are load-bearing and every one of them was, before
 * this module, a rule spelled out separately in each route:
 *
 *  - the directory and the pool slot are released on EVERY path, a throw
 *    included. A leaked slot shrinks the judge's true concurrency
 *    ceiling permanently, with no other symptom.
 *  - the in-flight counter is bracketed around the JUDGING. The
 *    response-lifecycle gate in `server.ts` drops its count when the
 *    client disconnects, so without this bracket a SIGTERM arriving
 *    after a `curl` gave up saw `inFlight: 0` and deleted the workdir
 *    out from under a running sandbox.
 *  - a second lease WAITS when the pool is empty, rather than running
 *    unslotted.
 *
 * The pool is injected (`leaseWorkspace`) rather than the process-wide
 * singleton's 16 slots, so "the second one waits" is provable at size 1.
 */

/** Marker for "this promise has not settled yet". */
const PENDING = Symbol("pending");

/**
 * Resolve to the promise's value if it settles within one macrotask, or
 * to `PENDING`. `setImmediate` fires after the microtask queue drains.
 */
function raceToPending<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    p,
    new Promise<typeof PENDING>((resolve) => {
      setImmediate(() => resolve(PENDING));
    }),
  ]);
}

/** A lease over its own single-slot pool, so no case can affect another. */
function lease<T>(fn: (ws: Workspace) => Promise<T>): Promise<T> {
  return leaseWorkspace(createUidPool(1), "submit", fn);
}

test("the workspace directory exists at 0700 inside the lease and is gone after", async () => {
  const seen = await lease(async (ws) => {
    const stat = await fs.stat(ws.dir);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.mode & 0o777, 0o700, "only the judge may read the workdir");
    assert.equal(path.dirname(ws.dir), os.tmpdir());
    assert.equal(ws.label, "submit");
    return ws.dir;
  });
  await assert.rejects(
    fs.access(seen),
    "the leased directory must not outlive the lease",
  );
});

test("a throw inside the lease still removes the directory and returns the slot", async () => {
  const pool = createUidPool(1);
  let leaked = "";
  const boom = new Error("judge fault");

  await assert.rejects(
    leaseWorkspace(pool, "submit", async (ws) => {
      leaked = ws.dir;
      throw boom;
    }),
    // The ORIGINAL error propagates: a `finally` that threw would
    // discard it and report "cannot remove directory" instead.
    (err: unknown) => err === boom,
  );

  await assert.rejects(fs.access(leaked));
  // The slot is back: a pool of one that never released would leave this
  // acquire pending forever.
  assert.notEqual(await raceToPending(pool.acquire()), PENDING);
});

test("the in-flight counter is bracketed around the lease, on both paths", async () => {
  assert.equal(inFlightCount(), 0, "cases must start from a quiet counter");

  await lease(async () => {
    assert.equal(inFlightCount(), 1, "the drain must wait for judging");
  });
  assert.equal(inFlightCount(), 0);

  await assert.rejects(
    lease(async () => {
      assert.equal(inFlightCount(), 1);
      throw new Error("judge fault");
    }),
  );
  assert.equal(inFlightCount(), 0, "a fault must not pin the drain open");
});

test("write creates the file and returns its absolute path", async () => {
  await lease(async (ws) => {
    const written = await ws.write("Main.cpp", "int main(){}");
    assert.equal(written, path.join(ws.dir, "Main.cpp"));
    assert.equal(written, ws.path("Main.cpp"));
    assert.equal(await fs.readFile(written, "utf8"), "int main(){}");
  });
});

test("copyIn brings in the named files and nothing else", async () => {
  // A compile-cache hit copies exactly the artifacts the entry names;
  // anything else in the source directory belongs to whoever put it
  // there, not to this submission.
  const from = await fs.mkdtemp(path.join(os.tmpdir(), "judge-copyin-test-"));
  try {
    await fs.writeFile(path.join(from, "a.out"), "binary");
    await fs.writeFile(path.join(from, "Main.cpp"), "someone else's source");
    await lease(async (ws) => {
      await ws.copyIn(from, ["a.out"]);
      assert.deepEqual(await fs.readdir(ws.dir), ["a.out"]);
      assert.equal(await fs.readFile(ws.path("a.out"), "utf8"), "binary");
    });
  } finally {
    await fs.rm(from, { recursive: true, force: true });
  }
});

test("copyIn of an artifact that is not in the source directory rejects", async () => {
  // A cache entry that promises a binary it does not have must fail the
  // submission loudly rather than run against a missing `a.out` and
  // grade every case `RE` on a clean 200.
  const from = await fs.mkdtemp(path.join(os.tmpdir(), "judge-copyin-test-"));
  try {
    await assert.rejects(
      lease(async (ws) => {
        await ws.copyIn(from, ["a.out"]);
      }),
    );
  } finally {
    await fs.rm(from, { recursive: true, force: true });
  }
});

test("remove deletes a scratch name that became a directory, and tolerates a missing one", async () => {
  // The contestant's program runs at the same UID in the same directory
  // and `mkdir` is ALLOWed by `policy.kafel`. A removal that cannot
  // remove a directory leaves up to 3 MB per case behind on a 512 MB
  // host — and a `rm` that threw on it would turn a graded case into a
  // 500.
  await lease(async (ws) => {
    await fs.mkdir(ws.path("checker-0-received.txt"));
    await fs.writeFile(ws.path("checker-0-received.txt/decoy"), "x");
    await fs.writeFile(ws.path("checker-0-input.txt"), "1 2");

    await ws.remove([
      "checker-0-received.txt",
      "checker-0-input.txt",
      "never-existed.txt",
    ]);

    assert.deepEqual(await fs.readdir(ws.dir), []);
  });
});

test("with one slot in the pool, the second lease waits for the first", async () => {
  const pool = createUidPool(1);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  let secondEntered = false;
  const first = leaseWorkspace(pool, "submit", async () => held);
  const second = leaseWorkspace(pool, "submit", async () => {
    secondEntered = true;
  });

  assert.equal(await raceToPending(second), PENDING);
  assert.equal(secondEntered, false, "the pool is the concurrency ceiling");

  release();
  await first;
  await second;
  assert.equal(secondEntered, true);
  assert.equal(inFlightCount(), 0);
});
