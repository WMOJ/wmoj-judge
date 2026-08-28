---
name: run-judge-locally
description: Builds, boots and exercises wmoj-judge in its Docker container on a developer machine — the linux/amd64 pin, the UNSAFE_DISABLE_SECCOMP escape hatch that Apple Silicon needs and its production guard, the exact /health and /submit calls with X-Judge-Token, what emulation breaks (RLIMIT_AS, so no MLE), and how to point a local wmoj-app at it. Use whenever someone wants to run, start, boot, serve, smoke-test, reproduce a verdict against, or debug the judge locally, or to pair a local judge with a local wmoj-app.
---

# Running wmoj-judge locally

The judge only runs inside its Docker image: nsjail is Linux-only and the image carries every
compiler, the sandbox and the seccomp policy. There is no `.env` loading anywhere in the start path
(no `dotenv`, no `--env-file`), so **every variable is passed with `docker run -e`**.

Work out which host you are on before anything else, because it decides whether the sandbox can run
at all. What matters is the CPU architecture, **not** the operating system — Docker always runs the
container on a Linux kernel, so an Intel Mac and a Windows/WSL2 box are both amd64 Linux hosts as
far as the judge is concerned. Determine it, do not assume it:

```bash
docker info --format '{{.Architecture}}'   # x86_64 => amd64,  aarch64 => arm64
```

| Host | Sandbox | What to do |
|---|---|---|
| amd64 (`x86_64`): Intel/AMD Linux, Intel Mac, Windows + WSL2 | seccomp installs normally | Run the image as-is. Nothing special. |
| arm64 (`aarch64`): Apple Silicon, arm64 Linux, arm64 cloud VMs | **seccomp cannot install** | Needs `UNSAFE_DISABLE_SECCOMP=true`; read the whole escape-hatch section below. |

Only two of these were exercised on real hardware: amd64 Linux (the Render target) and arm64 macOS.
The amd64 path is one code path regardless of which OS hosts the Docker VM, so Intel Mac and WSL2
follow the amd64 row, but say so honestly if someone reports otherwise.

## Why arm64 is different

`policy.kafel` is written against the **amd64** syscall table, so every `FROM` in the `Dockerfile`
pins `--platform=linux/amd64` (a native arm64 build fails to compile the policy with
`Undefined identifier 'umount'`). On an arm64 host that image therefore runs under QEMU user-mode
emulation, and QEMU cannot install an amd64 BPF program on an arm64 kernel:

```
[W] prepareAndCommit():81 prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER) failed: Invalid argument
[F] runChild():483 Launching child process failed
```

nsjail exits 255, the `sandbox-launch` and `sandbox-measures` liveness checks fail, and the judge
**refuses to boot**:

```
{"level":50,...,"failures":["sandbox-launch: sandbox launch failed: /bin/true exited 255","sandbox-measures: sandbox self-check could not run: nsjail failed to start the jail (exit 255)"],"msg":"liveness checks failed at boot"}
{"level":50,...,"msg":"fatal: boot failed"}
```

That refusal is correct and must stay: it replaced a judge that booted green and graded every
submission `RE`.

**Already ruled out, do not retry any of these.** `--security-opt seccomp=unconfined` and
`--privileged` both fail identically. It is not Docker's own seccomp profile: the container kernel
lists every action in `/proc/sys/kernel/seccomp/actions_avail`. `uname -m` reports `x86_64` inside
the container, but that is the emulator lying. One command confirms the whole chain (`/bin/sh` is
dash, so no bashisms):

```bash
FLAGS="--mode o --disable_clone_newuser --disable_clone_newnet --disable_clone_newns --disable_clone_newpid --disable_clone_newipc --disable_clone_newuts --disable_clone_newcgroup --keep_caps --cwd /tmp"
docker run --rm --platform=linux/amd64 --entrypoint /bin/sh wmoj-judge:local -c "
  nsjail $FLAGS -- /bin/true >/dev/null 2>&1; echo no-seccomp-exit=\$?
  nsjail $FLAGS --seccomp_policy /app/policy.kafel -- /bin/true >/dev/null 2>&1; echo with-seccomp-exit=\$?"
# no-seccomp-exit=0
# with-seccomp-exit=255
```

A trivial `DEFAULT ALLOW` policy fails the same way, so it is the architecture, not the policy's
contents.

## Build

```bash
docker build --platform=linux/amd64 -t wmoj-judge:local .
```

Slow under emulation on the first build (tens of minutes: nsjail, kafel and `wmoj-jailrun` are all
compiled from source). `cc: internal compiler error: Segmentation fault` while compiling kafel is a
known flaky QEMU failure — **retry the build**, it is not a code problem. Layers cache, so a
source-only change rebuilds in well under a minute.

## Run

On amd64 Linux:

```bash
docker run --rm --name wmoj-judge-local -p 4001:4001 \
  -e JUDGE_SHARED_SECRET=dev-local-secret \
  -e AUTH_STRICT=true \
  wmoj-judge:local
```

On arm64, two more variables. **`NODE_ENV=development` is mandatory**, not cosmetic: the Dockerfile
bakes `NODE_ENV=production`, and `config.ts` throws at import time if `UNSAFE_DISABLE_SECCOMP` is
set in production. Without it the container exits 1 with the guard's message.

```bash
docker run --rm --name wmoj-judge-local -p 4001:4001 --platform=linux/amd64 \
  -e NODE_ENV=development \
  -e UNSAFE_DISABLE_SECCOMP=true \
  -e JUDGE_SHARED_SECRET=dev-local-secret \
  -e AUTH_STRICT=true \
  wmoj-judge:local
```

Set `AUTH_STRICT=true` explicitly. It defaults to `IS_PROD`, so `NODE_ENV=development` silently turns
the token check off, and in soft mode a *missing* token is let through too — which hides a
secret mismatch between the judge and `wmoj-app` until production.

Boot takes ~20 s under emulation, mostly the `sandbox-measures` liveness check. Expect these
lines:

```
{"level":40,...,"seccomp":"disabled",...,"msg":"!!!!! SECCOMP FILTER DISABLED (UNSAFE_DISABLE_SECCOMP=true) !!!!! ..."}
{"level":30,...,"cpuMs":2039,...,"msg":"liveness: sandbox measured"}
{"level":30,...,"msg":"liveness checks passed"}
{"level":30,...,"port":4001,"authStrict":true,"seccomp":"disabled",...,"msg":"judge listening"}
```

## Verify

```bash
curl -s http://localhost:4001/health
# {"status":"ok","version":"0.2.0+2026-08-27T00:22:17.276Z","seccomp":"disabled"}
```

`seccomp` is `"enforced"` or `"disabled"` and is present on every `/health` response including the
503s. It is the only way to tell an unfiltered judge from a real one from outside the box, since both
answer `{"status":"ok"}`.

Then grade something. The auth header is **`X-Judge-Token`**, not `Authorization`.

```bash
curl -s -X POST http://localhost:4001/submit \
  -H 'Content-Type: application/json' -H 'X-Judge-Token: dev-local-secret' \
  -d '{"language":"python3","code":"a,b=map(int,input().split())\nprint(a+b)\n",
       "input":["1 2\n","10 20\n"],"output":["3\n","30\n"],"timeLimit":20000}'
```

```json
{"summary":{"total":2,"passed":2,"failed":0},"results":[{"index":0,"exitCode":0,"passed":true,
"expected":"3\n","received":"3\n","stderr":"","stdout":"3\n","timedOut":false,"verdict":"AC",
"timeMs":212,"cpuMs":208,"memKb":31752}, ...],"effectiveMemoryLimitMb":256}
```

Change `print(a+b)` to `print(a-b)` and both cases come back `WA`. Full request and response schemas
live in **`judge-app-contract`**; read it before relying on any field.

The proper smoke test after a boot is the golden-transcript replay:

```bash
JUDGE_URL=http://localhost:4001 JUDGE_SHARED_SECRET=dev-local-secret npm run test:e2e
```

It re-POSTs every recorded `/submit` and `/generate-tests` exchange in `test/fixtures/e2e` and diffs
the answers. On arm64 the fixtures tagged `rlimit_as`, `seccomp` or `native` (the MLE ones, the
seccomp-denied socket, and the runs whose stderr QEMU pollutes — a signal death prints
`qemu: uncaught target signal …`, PyPy warns about the emulated `/proc/cpuinfo`) are skipped **by
name**, because emulation cannot reproduce them — CI replays those on an amd64 kernel. Start the
container with `-e RATE_LIMIT_MAX=1000` if you capture and replay within the same minute: the
default 60/min bucket is shared by both gated routes and a capture plus a replay is 75 requests.

Measured on an M1 Pro under emulation, for calibration: python3 ~210 ms/case, pypy3 ~220 ms/case, a
`bits/stdc++.h` C++ submission ~6.7 s end to end (nearly all of it g++). Give `timeLimit` plenty of
headroom locally and **never calibrate a problem's real time limit here**.

## What emulation breaks, beyond seccomp

**`RLIMIT_AS` is not enforced under QEMU, so MLE cannot fire.** Verified on this hardware: inside the
emulated amd64 container a child launched with `--rlimit_as 64` reads back
`getrlimit(RLIMIT_AS) == (-1, -1)` and allocates 400 MB happily; the same nsjail invocation run
natively reads back `(67108864, 67108864)` and raises `MemoryError`. A memory hog therefore exits 0
locally and is graded on its output (`WA`, usually) instead of `MLE`. QEMU ignores `RLIMIT_AS`
because it needs the address space itself.

`RLIMIT_CPU` and `RLIMIT_NOFILE` **do** come through, `wmoj-jailrun` reports real `cpuMs`/`memKb`,
and TLE works. Anything touching the MLE rules in `src/verdict` cannot be verified on an arm64
machine — check it on real amd64 hardware, which is what the CI `e2e` and `recapture-measurements`
jobs do.

The measurement fixtures in `test/fixtures/measurements` are recorded by a tool that runs *inside*
the image, because it needs nsjail:

```bash
docker run --rm -e LOG_LEVEL=silent -e JUDGE_SHARED_SECRET=x \
  -e NODE_ENV=development -e UNSAFE_DISABLE_SECCOMP=true \
  --entrypoint node wmoj-judge:local dist/tools/captureMeasurements.js > fresh.json
```

(`LOG_LEVEL=silent` because pino writes to stdout and the JSON must be the only thing there.) On
arm64 it records every scenario but only asserts the ones that do not need `rlimit_as`/`seccomp`;
the committed set is captured on the x86_64 runner and reviewed by hand.

## The escape hatch, precisely

`UNSAFE_DISABLE_SECCOMP=true` removes `--seccomp_policy` from the nsjail argv and nothing else.

**Gone:** syscall filtering, entirely. An unfiltered submission can open sockets and reach the
network, and can `ptrace`/`process_vm_readv` any other process sharing UID 1000, the judge included.
Confirm for yourself that it really is off — a submission of `import socket; socket.socket()` prints
a live fd instead of failing, and `policy.kafel` puts `socket` in its `ERRNO(1)` denylist.

**Still in force:** every rlimit (`RLIMIT_AS` where the kernel honours it, `CPU`, `NPROC`, `NOFILE`,
`FSIZE`, `CORE`), `--mode o` with all seven namespaces disabled, no-new-privs, the unprivileged
capability-less UID 1000, the four-variable env allowlist, the per-submission `0700` workdir, and the
process-group kill. Resource accounting and TLE are unaffected.

Guards, all three of which are load-bearing:

1. Off by default (`boolEnv("UNSAFE_DISABLE_SECCOMP", false)`).
2. `config.ts` **throws at module import** when it is set with `NODE_ENV=production`, so the process
   exits 1 before Express is constructed. It is a hard failure, not a warning, and it matches how
   every other rejected env value behaves at this boundary.
3. `server.ts` logs the banner before the boot probes, and `/health` reports `seccomp: "disabled"`.

The liveness checks are **not** weakened. `sandbox-launch` still runs a real jailed `/bin/true` in
both modes and `sandbox-measures` still demands a measured, non-zero `cpuMs` that grades `TLE`; the
only difference is that the `fs.access(SECCOMP_POLICY)` readability check is skipped when no policy
is going to be installed. `sandbox-launch` also fails on `ok: false` from `runSandboxed`, so a runner
that launches but writes no resource report makes `/health` degraded within 30 s instead of ok, and
a reporter whose numbers are zero makes it degraded within 5 min. Never bypass either check to make
something boot.

Never run this mode anywhere other people can reach, and never as a way to make a submission work.
If you need genuine production behaviour, run the image on an amd64 Linux host.

## Pairing with a local wmoj-app

The Next.js app lives in `wmoj-app/main/`, not the repo root. Put both of these in
`wmoj-app/main/.env.local`:

```
NEXT_PUBLIC_JUDGE_URL=http://localhost:4001
JUDGE_SHARED_SECRET=dev-local-secret
```

`JUDGE_SHARED_SECRET` must be **byte-identical** to the judge's; the compare is constant-time and a
length mismatch short-circuits. `NEXT_PUBLIC_JUDGE_URL` already defaults to `http://localhost:4001`
in all four call sites, so it is really the secret that has to be right.

Then `cd wmoj-app/main && npm run dev` and check the proxy:

```bash
curl -s http://localhost:3000/api/status/health
# {"status":"online"}
```

That proves routing only — `/health` is unauthenticated by design. To prove the secret, hit the judge
directly: the right token returns 200 and a wrong one returns 401.

## Failure modes

| Symptom | Cause |
|---|---|
| `fatal: boot failed`, `sandbox launch failed: /bin/true exited 255` | arm64 host without `UNSAFE_DISABLE_SECCOMP=true`. |
| Exit 1, `UNSAFE_DISABLE_SECCOMP ... is refused when NODE_ENV=production` | The image bakes `NODE_ENV=production`. Add `-e NODE_ENV=development`. |
| Exit 1, `JUDGE_SHARED_SECRET is required in production` | Same baked `NODE_ENV`, no secret passed. |
| `401` from `/submit` | Secret mismatch, or the header spelled `Authorization`. |
| Requests succeed with no token at all | `AUTH_STRICT` left at its `NODE_ENV=development` default of false. |
| Every case `RE`, `/health` green | Cannot happen since the boot probe landed. If you see it, the probe was bypassed. |
| A memory hog is graded `WA`, never `MLE` | Emulation ignores `RLIMIT_AS`. Not a bug in the judge. |
| `cc: internal compiler error` during `docker build` | Flaky QEMU. Retry. |

## Cleaning up

```bash
docker rm -f wmoj-judge-local
```

Delete any stale `wmoj-judge` image built before the `--platform` pin existed. An arm64-native image
looks identical by name, cannot compile `policy.kafel`, and sends you back through this whole
diagnosis. Check with `docker image inspect <tag> --format '{{.Architecture}}'`; it must say `amd64`.
