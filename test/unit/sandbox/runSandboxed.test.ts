import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `runSandboxed`'s settle path, driven by a fake `wmoj-jailrun` so no
 * nsjail is needed. Everything `interpretRun` decides is covered in
 * `interpretRun.test.ts`; what is covered HERE is the one thing that
 * function cannot see — whether the bytes the runner wrote reached it at
 * all, which depends on the order in which the event loop observes the
 * runner's exit and its report pipe.
 *
 * The runner is located as `dirname(NSJAIL_BIN)/wmoj-jailrun`, and
 * `config` reads `NSJAIL_BIN` exactly once, at its first import. So there
 * is ONE directory for the whole file, the env is pointed at it before
 * `src/sandbox/nsjail` is imported (lazily, inside each test), and each
 * test rewrites the runner script in place. The fake ignores the nsjail
 * argv entirely: the argv is `interpretRun`'s and nsjail's business.
 */

const REPORT =
  "WMOJ-JAILRUN v1 exit=0 signal=0 cpu_us=1000 maxrss_kb=1024 wall_us=2000";

let runnerDir: string | null = null;

async function runnerDirectory(): Promise<string> {
  if (runnerDir === null) {
    runnerDir = await fs.mkdtemp(path.join(os.tmpdir(), "jailrun-fake-"));
    await fs.writeFile(path.join(runnerDir, "nsjail"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    process.env["NSJAIL_BIN"] = path.join(runnerDir, "nsjail");
  }
  return runnerDir;
}

/** Write the fake runner's body and return the directory to run in. */
async function installFakeRunner(script: string): Promise<string> {
  const dir = await runnerDirectory();
  await fs.writeFile(path.join(dir, "wmoj-jailrun"), `#!/bin/sh\n${script}\n`, {
    mode: 0o755,
  });
  return dir;
}

/** Imported after the env is set; `config` reads `NSJAIL_BIN` at import. */
async function sandbox(): Promise<typeof import("../../../src/sandbox/nsjail")> {
  return import("../../../src/sandbox/nsjail");
}

after(async () => {
  if (runnerDir !== null) {
    await fs.rm(runnerDir, { recursive: true, force: true });
  }
});

test("a report that reaches Node after 'exit' is not discarded by the drain timer", async () => {
  // The real runner writes its report and then exits, so the bytes are
  // always in the pipe before the exit is observable — but libuv can
  // reap the runner inside a SIGCHLD callback one poll batch before it
  // reads the pipe, and a 0.1-CPU host throttled between the two batches
  // hands the drain timer the win. From Node's side that is
  // indistinguishable from a report written after the exit, which is
  // what this fake does: it hands fd 4 to a background child that writes
  // the report well after the 250 ms drain, and exits at once. A settle
  // that destroys the report pipe on the drain timer turns this finished
  // run into "no resource report" — an HTTP 500 for a run that was fine.
  const dir = await installFakeRunner(
    `( sleep 0.6; printf '${REPORT}\\n' >&"$1" ) &\nexit 0`,
  );
  const { runSandboxed } = await sandbox();
  const outcome = await runSandboxed({
    argv: ["./a.out"],
    cwd: dir,
    label: "test:late-report",
    timeLimitMs: 2000,
    memLimitMb: 64,
    stdin: "",
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.run.exitCode, 0);
  assert.equal(outcome.run.cpuMs, 1);
  assert.equal(outcome.run.maxRssKb, 1024);
  assert.equal(outcome.run.nodeTimerFired, false);
});

test("a descendant holding stdout open does not hold the run open once the report is in", async () => {
  // The other half of the same rule, and the reason the drain timer
  // exists at all: fds 1/2 CAN be held by a descendant forever (no PID
  // namespace, `clone` allowed), so the run must settle without waiting
  // for their EOF. The report is written before the runner exits, exactly
  // as the real runner does it; the sleeper closes its copy of fd 4 so it
  // holds only the streams a descendant can actually hold.
  const dir = await installFakeRunner(
    `printf '${REPORT}\\n' >&"$1"\n( exec 4>&-; sleep 30 ) &\nexit 0`,
  );
  const { runSandboxed } = await sandbox();
  const started = Date.now();
  const outcome = await runSandboxed({
    argv: ["./a.out"],
    cwd: dir,
    label: "test:held-stdout",
    timeLimitMs: 2000,
    memLimitMb: 64,
    stdin: "",
  });
  const elapsedMs = Date.now() - started;
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) return;
  assert.equal(outcome.run.cpuMs, 1);
  assert.equal(outcome.run.nodeTimerFired, false);
  // Well under the sleeper's 30 s and under the 7 s kill timer: the
  // drain, not a descendant, decided when this settled.
  assert.ok(elapsedMs < 5000, `settled after ${String(elapsedMs)} ms`);
});

test("a runner that exits without ever writing a report is a judge fault", async () => {
  // Nothing held fd 4 and nothing wrote to it: its EOF arrives with the
  // exit, and the empty report is the dead-reporter case commit 13a1afb
  // made /health notice. Waiting for the report's EOF must not turn this
  // into a hang — it is the absence the fault path exists to name.
  const dir = await installFakeRunner("exit 0");
  const { runSandboxed } = await sandbox();
  const outcome = await runSandboxed({
    argv: ["./a.out"],
    cwd: dir,
    label: "test:no-report",
    timeLimitMs: 2000,
    memLimitMb: 64,
    stdin: "",
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.sandboxError, /no resource report/);
});
