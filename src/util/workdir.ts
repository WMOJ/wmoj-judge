import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger";

/**
 * Prefix used for every per-submission working directory. Also used by
 * `startupSweep()` to identify stale directories on boot.
 */
const WORKDIR_PREFIX = "judge-";

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
 * sandboxed child process can read or write inside it. Node itself runs
 * as root and can still access it for setup and teardown.
 */
export async function createWorkdir(uid: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), WORKDIR_PREFIX));
  try {
    // Only attempt chown when running as root. On Render we run Node
    // as an unprivileged UID (so nsjail's orig_euid != 0 early-return
    // bypasses the CAP_SETPCAP-requiring prctl); that UID can't chown
    // to foreign UIDs. In that mode the mkdtemp'd dir is already owned
    // by our process UID, which is the same UID the sandbox child will
    // run as, so no chown is needed.
    const effectiveUid =
      typeof process.geteuid === "function" ? process.geteuid() : 0;
    if (effectiveUid === 0 && uid !== 0) {
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
 * that does not exist. Always removes the path from the active set so
 * shutdown doesn't try to clean it a second time.
 */
export async function cleanupWorkdir(dir: string): Promise<void> {
  activeWorkdirs.delete(dir);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn(
      { err, dir },
      "failed to remove workdir; continuing",
    );
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
 * Boot-time sweep: remove any `/tmp/judge-*` directories left behind
 * by a previous process (crashed or killed before cleanup).
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
