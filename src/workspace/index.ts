import { promises as fs } from "fs";
import * as path from "path";
import { uidPool } from "../queue/uidPoolSingleton";
import { createWorkdir, cleanupWorkdir, isRootNode } from "../util/workdir";
import { enterRequest, exitRequest } from "../util/shutdown";
import { logger } from "../util/logger";

/**
 * The per-submission workspace: one leased directory, one pool slot and
 * one in-flight bracket, acquired and released as a single thing.
 *
 * Both judging routes used to assemble this by hand — two nullable
 * locals, a pool acquire, a `createWorkdir`, a `finally` — and the
 * chown-when-root rule had three implementations that disagreed
 * (recursive in `/submit`, two named files in `/generate-tests`, none in
 * the checker). A lease that is spelled out at its call sites is a lease
 * a new call site can spell differently, and the parts it leaks (the
 * uid, the raw path) are exactly the parts nothing outside should hold.
 */

/** The two collaborators of a lease: a slot in, a slot out. */
export interface UidPool {
  acquire(): Promise<number>;
  release(uid: number): void;
}

export interface Workspace {
  /** Absolute path of the leased 0700 directory. The sandbox's cwd. */
  readonly dir: string;
  /** Prefix for sandbox labels: "submit", "generator". */
  readonly label: string;
  /** Write a file into the workspace and hand it to the pool uid when Node is root. Returns the absolute path. */
  write(name: string, contents: string): Promise<string>;
  /** Copy named files in from another directory (a compile-cache hit), chowning each. */
  copyIn(fromDir: string, names: readonly string[]): Promise<void>;
  /** Remove scratch files; tolerant of a name that became a directory (the checker case). */
  remove(names: readonly string[]): Promise<void>;
  path(name: string): string;
}

/**
 * Hand one path to the pool uid.
 *
 * The whole chown rule, in one place. It is a **no-op unless Node is
 * root**: on Render the judge runs as UID 1000 and nsjail is invoked
 * without `--user`, so the sandboxed child already runs as the UID that
 * created these files, and a non-root process cannot chown to a foreign
 * UID anyway (`fs.chown` succeeds only for CAP_CHOWN or a matching UID).
 * It exists for the root-Node development path, where the workdir itself
 * was chowned by `createWorkdir` and a file written afterwards would
 * otherwise be the one thing in it the pool UID does not own.
 *
 * A failure is logged, not thrown: losing the chown costs nothing on the
 * only host that reaches this line as root, whereas failing the
 * submission for it would turn a cosmetic ownership problem into a 500.
 */
async function handToPoolUid(target: string, uid: number): Promise<void> {
  if (!isRootNode) return;
  try {
    await fs.chown(target, uid, uid);
  } catch (err) {
    logger.warn({ err, target, uid }, "workspace: chown failed; continuing");
  }
}

/** Build the caller-facing handle over an already-created directory. */
function makeWorkspace(dir: string, label: string, uid: number): Workspace {
  const resolve = (name: string): string => path.join(dir, name);

  return {
    dir,
    label,
    path: resolve,

    async write(name: string, contents: string): Promise<string> {
      const target = resolve(name);
      await fs.writeFile(target, contents, "utf8");
      await handToPoolUid(target, uid);
      return target;
    },

    async copyIn(fromDir: string, names: readonly string[]): Promise<void> {
      for (const name of names) {
        const target = resolve(name);
        // `recursive` and `force` so this copies whatever the compile
        // step declared as an artifact, over whatever is already there.
        // Serial, not `Promise.all`: the list is one binary today and
        // this runs on a ~0.1 CPU box where a fan-out of copies buys
        // nothing.
        await fs.cp(path.join(fromDir, name), target, {
          recursive: true,
          force: true,
        });
        await handToPoolUid(target, uid);
      }
    },

    async remove(names: readonly string[]): Promise<void> {
      // `recursive` because a scratch path could be a DIRECTORY: the
      // contestant's program runs at the same UID in the same directory
      // and `mkdir` is ALLOWed by `policy.kafel`, and a plain `fs.rm`
      // cannot remove one at all. Failures are swallowed because the
      // lease's teardown removes the whole directory regardless — this
      // call only bounds peak disk *during* a submission (200 cases x
      // 3 files x up to 1 MB on a 512 MB host).
      await Promise.all(
        names.map((name) =>
          fs.rm(resolve(name), { force: true, recursive: true }).catch(() => {}),
        ),
      );
    },
  };
}

/**
 * Lease a workspace for the duration of `fn`.
 *
 * Owns, in order: enterRequest() → uidPool.acquire() → createWorkdir(uid)
 * → fn → cleanupWorkdir → uidPool.release → exitRequest(). Every step
 * runs on every path, including a throw from any earlier step.
 *
 * TEARDOWN BEGINS THE INSTANT `fn` SETTLES. Everything `fn` starts
 * against the workspace must be awaited inside it: a task still running
 * when `fn` resolves finds its directory gone and its pool slot handed
 * to another submission. That is the failure 56b986e closed — p-limit
 * has no cancellation — and `judgeAllCases` honours this by settling
 * every case before it returns. A caller that fans out must do the same.
 *
 * enterRequest/exitRequest here is what makes the drain wait for JUDGING
 * to finish rather than for the client to hang up: the response-lifecycle
 * gate in `server.ts` drops its count on `'close'`, which a disconnect
 * fires while the sandbox is still running. Double-counting is
 * documented safe — the drain waits for the counter to reach zero, so
 * two brackets simply make it wait for the later of the two.
 *
 * The uid never leaves this module. `createWorkdir(uid)` and the
 * chown-when-root rule are the only things that ever used it; every
 * submission runs as UID 1000 regardless, so the pool is a concurrency
 * gate and a caller holding its number could only misuse it.
 */
export async function withWorkspace<T>(
  label: string,
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  return leaseWorkspace(uidPool, label, fn);
}

/**
 * `withWorkspace` over an explicit pool.
 *
 * Exported for `test/unit/workspace.test.ts`, which needs a pool of size
 * 1 to prove that the second lease waits for the first — the property
 * that makes this the judge's true concurrency ceiling. The
 * process-wide singleton has 16 slots and is shared with whatever else
 * the test process imported, so asserting queueing through it would be
 * asserting nothing. Production has exactly one pool; this is the same
 * adapter, not a second one.
 */
export async function leaseWorkspace<T>(
  pool: UidPool,
  label: string,
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  enterRequest();
  let uid: number | null = null;
  let dir: string | null = null;
  try {
    uid = await pool.acquire();
    dir = await createWorkdir(uid);
    return await fn(makeWorkspace(dir, label, uid));
  } finally {
    // Each step is guarded on its own so that a failure in one still
    // runs the ones after it, and so that nothing thrown here can
    // replace the error the caller is already propagating — a `finally`
    // that throws discards it, which would turn a real judge fault into
    // "cannot remove directory".
    if (dir !== null) {
      try {
        await cleanupWorkdir(dir);
      } catch (err) {
        logger.warn({ err, dir, label }, "workspace: cleanup failed");
      }
    }
    if (uid !== null) {
      try {
        pool.release(uid);
      } catch (err) {
        // A pool slot that is never returned shrinks the judge's
        // concurrency ceiling permanently, with no other symptom.
        logger.error({ err, label }, "workspace: uid release failed");
      }
    }
    exitRequest();
  }
}
