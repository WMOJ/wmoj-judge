import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger";
import { WORKDIR_PREFIX } from "../config";

/**
 * `WORKDIR_PREFIX` is the prefix used for every per-submission working
 * directory, and it is also what `startupSweep()` matches on to
 * identify stale directories at boot.
 *
 * It is defined in `config.ts` rather than here because
 * `COMPILE_CACHE_DIR` is derived from it — the compile cache lives
 * under `os.tmpdir()` with this same prefix precisely so that
 * `startupSweep()` reclaims it too, which is its only cross-restart
 * reclamation path. Importing in this direction keeps the two literals
 * from drifting without closing a require cycle through `logger.ts`.
 */

/**
 * Tracks every workdir this process has created so shutdown.ts can
 * clean them all up if the process dies mid-request. Workdirs removed
 * via `cleanupWorkdir()` are deleted from the set.
 */
const activeWorkdirs = new Set<string>();

/**
 * Create a fresh, private working directory for a submission and
 * transfer ownership to the pool UID.
 *
 * The returned path is mode 0700 and owned by `uid:uid`, so only the
 * sandboxed child process can read or write inside it. On Render, Node
 * itself runs as UID 1000 -- the same UID the child gets -- so it can
 * still access the directory for setup and teardown without a chown.
 */
/**
 * True when Node is running as root (effective UID 0). Captured once at module
 * load.
 *
 * On Render, Node runs as UID 1000, so this is false and every chown keyed on
 * it becomes a no-op: a non-root process cannot chown to a foreign UID, and
 * chowning to its own UID would just spam EPERM (`fs.chown` succeeds only for
 * CAP_CHOWN or a matching UID). Because the workdir was `mkdtemp`'d by us and
 * the sandbox inherits our UID (no `--user` flag), files are already owned by
 * the process that will execute them.
 */
export const isRootNode: boolean =
  typeof process.geteuid === "function" && process.geteuid() === 0;

export async function createWorkdir(uid: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), WORKDIR_PREFIX));
  try {
    // Only attempt chown when running as root. On Render we run Node
    // as an unprivileged UID (so nsjail's orig_euid != 0 early-return
    // bypasses the CAP_SETPCAP-requiring prctl); that UID can't chown
    // to foreign UIDs. In that mode the mkdtemp'd dir is already owned
    // by our process UID, which is the same UID the sandbox child will
    // run as, so no chown is needed.
    if (isRootNode && uid !== 0) {
      await fs.chown(dir, uid, uid);
    }
    await fs.chmod(dir, 0o700);
  } catch (err) {
    // Setup failed — we own this dir, so remove it before propagating.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  activeWorkdirs.add(dir);
  return dir;
}

/**
 * Recursively remove a working directory. Safe to call with a path
 * that does not exist. The path leaves the active set only once it is
 * actually gone, so a directory that could not be removed is still
 * offered to the shutdown sweep.
 *
 * The un-tracking used to happen unconditionally, *before* the removal
 * was attempted, and the failure was swallowed with a warn.
 * `fs.rm({force: true})` only ignores ENOENT — not EACCES/EBUSY/EIO —
 * and `chmod` is on the seccomp allowlist, so a submission that writes
 * a large file into its workdir and calls `chmod(".", 0)` before
 * exiting cleanly made the `rm` fail EACCES on a path nothing would
 * ever retry: shutdown had already lost it, and `startupSweep()` hits
 * the same EACCES on every future boot. On a container whose /tmp
 * shares the 512 MB budget that is permanently undeletable space until
 * `mkdtemp` fails and every submission 500s.
 *
 * Hence the one retry: restore owner rwx (we are the owner — the
 * directory was created by this process, and on Render the child runs
 * as the same UID) and try again before giving up.
 */
export async function cleanupWorkdir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    activeWorkdirs.delete(dir);
    return;
  } catch (err) {
    logger.warn({ err, dir }, "failed to remove workdir; retrying after chmod");
  }

  try {
    await fs.chmod(dir, 0o700);
    await fs.rm(dir, { recursive: true, force: true });
    activeWorkdirs.delete(dir);
  } catch (err) {
    // Still tracked, so shutdown.ts gets one more attempt at it.
    logger.warn({ err, dir }, "failed to remove workdir; leaving it tracked");
  }
}

/**
 * Return the list of workdirs currently in flight. Used by shutdown
 * to clean up everything that is mid-request when SIGTERM arrives.
 */
export function listActiveWorkdirs(): string[] {
  return Array.from(activeWorkdirs);
}

/**
 * Boot-time sweep: remove any `<os.tmpdir()>/judge-*` entries left
 * behind by a previous process (crashed or killed before cleanup).
 * That set deliberately includes `COMPILE_CACHE_DIR`, which is rooted
 * at the same tmpdir under the same prefix — this sweep is the compile
 * cache's only cross-restart reclamation.
 *
 * Safe to call unconditionally at startup. Any failure is logged but
 * not thrown — the judge should still boot even if one stale directory
 * cannot be removed.
 */
export async function startupSweep(): Promise<void> {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.readdir(tmp);
  } catch (err) {
    logger.warn({ err, tmp }, "startup sweep: could not read tmpdir");
    return;
  }

  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(WORKDIR_PREFIX)) continue;
    const full = path.join(tmp, name);
    try {
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      logger.warn(
        { err, path: full },
        "startup sweep: failed to remove stale workdir",
      );
    }
  }

  if (removed > 0) {
    logger.info({ removed }, "startup sweep removed stale workdirs");
  }
}
