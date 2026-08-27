# wmoj-judge

The grading service for [WMOJ](https://github.com/WMOJ/wmoj-app), an open-source competitive
programming judge by the White Oaks Secondary School CS Club. It compiles and runs submitted code in
a sandbox and returns verdicts. Supports Python 3, PyPy 3, and C++14/17/20/23.

## Requirements

Docker. The image bundles every compiler, the runtimes, nsjail and the seccomp policy, and it is the
only supported way to run the judge. nsjail is Linux-only, so there is no native macOS or Windows
path.

What matters for setup is your CPU architecture, not your operating system. Docker always runs the
container on a Linux kernel, so an Intel Mac and a Windows machine using WSL2 both behave as amd64
Linux hosts. Check which you are on:

```bash
docker info --format '{{.Architecture}}'
# x86_64 or aarch64
```

`x86_64` means amd64, and everything works normally. `aarch64` means arm64 (an Apple Silicon Mac,
an arm64 Linux server, an arm64 cloud VM) and needs one extra step, described below.

To hack on the judge itself you also want Node.js 20+ locally for `npm run build`.

## Quick start

```bash
git clone https://github.com/WMOJ/wmoj-judge.git
cd wmoj-judge
docker build --platform=linux/amd64 -t wmoj-judge:local .
```

The image must be `linux/amd64`. `policy.kafel` is written against the amd64 syscall table, so an
arm64 build fails to compile it (`Undefined identifier 'umount'`). Every `FROM` in the Dockerfile
pins the platform, so you get amd64 whatever you are on. On Apple Silicon the first build takes tens
of minutes under emulation. If you see `cc: internal compiler error: Segmentation fault` while kafel
is compiling, that is flaky QEMU. Run the build again.

Now start it. **On an amd64 host** (Intel or AMD Linux, Intel Mac, Windows with WSL2):

```bash
docker run --rm --name wmoj-judge-local -p 4001:4001 \
  -e JUDGE_SHARED_SECRET=dev-local-secret \
  -e AUTH_STRICT=true \
  wmoj-judge:local
```

**On an arm64 host** (Apple Silicon Mac, arm64 Linux), you need two more variables (why, below):

```bash
docker run --rm --name wmoj-judge-local -p 4001:4001 --platform=linux/amd64 \
  -e NODE_ENV=development \
  -e UNSAFE_DISABLE_SECCOMP=true \
  -e JUDGE_SHARED_SECRET=dev-local-secret \
  -e AUTH_STRICT=true \
  wmoj-judge:local
```

The judge does not read a `.env` file. There is no dotenv and no `--env-file`, so pass everything
with `-e`. `.env.example` documents every variable.

Boot takes about 20 seconds under emulation, most of it the sandbox self-check. Then:

```bash
curl -s http://localhost:4001/health
# {"status":"ok","version":"0.2.0+2026-08-27T00:22:17.276Z","seccomp":"disabled"}
```

`version` is the deployed git commit when the host provides one (Render sets `RENDER_GIT_COMMIT`),
otherwise the package version plus the process start time. Poll it to tell a new build from an old
one. `seccomp` is `enforced` or `disabled`.

## Grade something

The auth header is `X-Judge-Token`, not `Authorization`.

```bash
curl -s -X POST http://localhost:4001/submit \
  -H 'Content-Type: application/json' \
  -H 'X-Judge-Token: dev-local-secret' \
  -d '{"language":"python3","code":"a,b=map(int,input().split())\nprint(a+b)\n",
       "input":["1 2\n","10 20\n"],"output":["3\n","30\n"],"timeLimit":20000}'
```

```json
{"summary":{"total":2,"passed":2,"failed":0},
 "results":[{"index":0,"verdict":"AC","cpuMs":208,"memKb":31752, ...}, ...],
 "effectiveMemoryLimitMb":256}
```

Change `print(a+b)` to `print(a-b)` and you get `WA` on both cases. A compile error is HTTP 200 with
a top-level `compileError`, not a 4xx.

On an M1 Pro under emulation, python3 and pypy3 run about 210 ms per case and a C++ submission that
includes `bits/stdc++.h` takes about 7 seconds end to end, nearly all of it g++. Be generous with
`timeLimit` locally, and set real time limits on real amd64 hardware.

## Running on arm64

The sandbox cannot install its seccomp filter on any arm64 machine, Apple Silicon or otherwise, and
without the escape hatch the judge refuses to boot.

The amd64 image runs under QEMU user-mode emulation, and QEMU cannot install an amd64 BPF program on
an arm64 kernel. nsjail gets `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER) failed: Invalid argument`,
exits 255, and the boot probe fails with `sandbox launch failed: /bin/true exited 255`. That refusal
is deliberate. It replaced a judge that booted green and graded every submission `RE`.
`--security-opt seccomp=unconfined` and `--privileged` do not help; it is the architecture, not
Docker's own profile.

`UNSAFE_DISABLE_SECCOMP=true` drops `--seccomp_policy` from the nsjail argv and changes nothing else.

**What you lose:** syscall filtering, entirely. A submission can open sockets and reach the network,
and can `ptrace` or `process_vm_readv` any other process sharing UID 1000, including the judge
itself.

**What still applies:** every rlimit (CPU, NPROC, NOFILE, FSIZE, CORE, and AS where the kernel
honours it), all seven namespaces disabled, no-new-privs, the unprivileged capability-less UID 1000,
the four-variable environment allowlist, the per-submission `0700` workdir, and the process-group
kill. TLE still works and resource accounting is unaffected.

Run this mode against code you wrote, on your own machine. Never anywhere other people can reach it,
and never to make a stubborn submission pass. It is guarded: it refuses to boot when
`NODE_ENV=production`, which is why the arm64 command above also passes `NODE_ENV=development` (the
image bakes production). It logs a banner at boot and `/health` reports `"seccomp":"disabled"`.

One more emulation quirk: **QEMU ignores `RLIMIT_AS`, so MLE never fires locally on arm64.** A
program that blows past its memory limit exits normally and gets graded on its output. Verify
anything touching the MLE rules on real amd64 hardware.

If you need true production behaviour, run the image on an amd64 Linux host. Nothing above applies
there.

## Pairing with a local wmoj-app

The Next.js app lives in `wmoj-app/main/`, not the repo root. Add these to `wmoj-app/main/.env.local`:

```
NEXT_PUBLIC_JUDGE_URL=http://localhost:4001
JUDGE_SHARED_SECRET=dev-local-secret
```

`JUDGE_SHARED_SECRET` must be byte-identical on both sides. The judge compares it in constant time
and a length mismatch is rejected outright. `NEXT_PUBLIC_JUDGE_URL` already defaults to
`http://localhost:4001`, so the secret is the part that actually has to match.

Start the app and check that it can see the judge:

```bash
cd wmoj-app/main && npm run dev
curl -s http://localhost:3000/api/status/health
# {"status":"online"}
```

That only proves routing, since `/health` is unauthenticated. To check the secret, POST to the judge
directly: a matching token returns 200, a wrong one returns 401.

Set `AUTH_STRICT=true` on the judge even locally. It defaults to off outside production, and in that
mode a completely missing token is accepted, so a secret mismatch stays hidden until you deploy.

## Scripts

| Command | Does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/`. Also the only typecheck. |
| `npm run dev` | Hot-reloading dev server on :4001. Linux only, and needs `NSJAIL_BIN` and `SECCOMP_POLICY` pointed at real files. |
| `npm run start` | Run the build. |

## Configuration

In Docker, only the first two normally need setting.

| Variable | Default | Notes |
|---|---|---|
| `JUDGE_SHARED_SECRET` | none | Must match `wmoj-app`. Required in production. |
| `AUTH_STRICT` | `true` in production, else `false` | Whether the shared secret is checked at all. In soft mode a missing token is accepted, not just a wrong one. |
| `PORT` | `4001` | |
| `UNSAFE_DISABLE_SECCOMP` | `false` | Run with no syscall filter. Local development only. Refuses to boot when `NODE_ENV=production`. |
| `HOST_MEMORY_CEILING_MB` | `384` | Most memory the host can really back, leaving room for the judge. Every submission's limit is clamped to this, and the clamped value comes back as `effectiveMemoryLimitMb`. Raise it on a bigger box. |
| `GLOBAL_SUBMIT_CONCURRENCY` | derived | Concurrent `/submit` requests. Derived from `HOST_MEMORY_CEILING_MB`, capped at the visible core count. |
| `NSJAIL_BIN` | `/usr/local/bin/nsjail` | Correct in the image. Must be set when running from source. |
| `SECCOMP_POLICY` | `/app/policy.kafel` | Same. |

Every variable is validated at boot. An unparseable value (`AUTH_STRICT=on`,
`HOST_MEMORY_CEILING_MB=1e6`) makes the judge refuse to start rather than silently run with a
different number. A typo in a security switch or a memory cap should be loud, not a green `/health`
with everything quietly broken.

## Contributing

Contributions are genuinely welcome. This project is built and maintained by high school students,
and outside help makes it better. Language support, performance work, better error messages and docs
are all useful, and small PRs are perfectly good ones.

Fork it, branch off `main`, and make sure `npm run build` is clean before pushing. Because this
service runs untrusted code, changes to the sandbox, the seccomp policy or the Dockerfile need a
clear explanation in the PR of what changes and why.

Not sure where to start, or stuck on setup? Open an issue. Questions are welcome too.

## License

[MIT](LICENSE), fork it, ship it, no strings.
