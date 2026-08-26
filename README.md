# wmoj-judge

The grading service for [WMOJ](https://github.com/WMOJ/wmoj-app) — an open-source competitive
programming judge by the White Oaks Secondary School CS Club. It compiles and runs submitted code in
a sandbox and returns verdicts. Supports Python 3, PyPy 3, and C++14/17/20/23.

## Requirements

- **Docker** — the recommended path; the image bundles every compiler, runtime, and the sandbox
- Or, to run from source: a **Linux host** with Node.js 20+, `python3`, `pypy3`, `g++` 14+, and
  `nsjail` installed

The sandbox is Linux-only, so on macOS or Windows use Docker.

## Run with Docker

```bash
git clone https://github.com/WMOJ/wmoj-judge.git
cd wmoj-judge

docker build --platform=linux/amd64 -t wmoj-judge .

export JUDGE_SHARED_SECRET="$(openssl rand -hex 32)"
docker run --rm --platform=linux/amd64 -p 4001:4001 \
  -e JUDGE_SHARED_SECRET="$JUDGE_SHARED_SECRET" \
  -e AUTH_STRICT=true \
  wmoj-judge
```

> **The image must be `linux/amd64`.** `policy.kafel`, the seccomp policy, is written against the
> **amd64** syscall table. Build it for arm64 — the default on an Apple Silicon Mac — and the
> policy fails to compile with `Undefined identifier 'umount'`, nsjail exits 255 before it ever
> starts your program, and **every submission is graded `RE`** while `/health` still reports `ok`.
> Nothing in the logs points at the architecture. On Apple Silicon the amd64 image runs under
> emulation, which is several times slower, so calibrate time limits on a real amd64 host.

Check it:

```bash
curl http://localhost:4001/health
# → {"status":"ok","version":"0.2.0+2026-08-15T12:00:00.000Z"}
```

`version` is the deployed git commit when the host provides one (Render sets `RENDER_GIT_COMMIT`),
otherwise the package version plus the process start time — poll it to tell a new build from the
old one.

Keep that secret — `wmoj-app` needs the same value in its `JUDGE_SHARED_SECRET`.

## Run from source

For hacking on the judge itself, on Linux:

```bash
npm install
export JUDGE_SHARED_SECRET="$(openssl rand -hex 32)"

# Both of these default to paths that only exist inside the Docker image.
export SECCOMP_POLICY="$PWD/policy.kafel"
export NSJAIL_BIN="$(command -v nsjail)"

npm run dev
```

Those two exports are not optional. `SECCOMP_POLICY` defaults to `/app/policy.kafel` and
`NSJAIL_BIN` to `/usr/local/bin/nsjail` — both correct in the image, neither present in a source
checkout. Get either wrong and nsjail refuses to start the jailed process, so **every submission
comes back `RE`** with a passing `/health`. The policy is amd64-only, so this path needs an amd64
Linux host for the same reason the image does.

Note that `.env.local` is not auto-loaded — export the variables or use
`node --env-file=.env.local dist/server.js`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Hot-reloading dev server on :4001 |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the build |

## Configuration

In the Docker image only the first two normally need setting; everything else has a sensible
default. Running from source additionally needs the last two.

| Variable | Default | Notes |
|---|---|---|
| `JUDGE_SHARED_SECRET` | — | Must match `wmoj-app`. Required in production. |
| `AUTH_STRICT` | `true` in production, else `false` | Follows `NODE_ENV`, so production is closed unless you explicitly open it. Outside production the secret is `""`, which strict mode would reject every request against. |
| `PORT` | `4001` | |
| `HOST_MEMORY_CEILING_MB` | `384` | Most memory the host can really back, leaving room for the judge itself. Every submission's limit is clamped to this and the clamped value comes back as `effectiveMemoryLimitMb`. Raise it on a bigger box. |
| `GLOBAL_SUBMIT_CONCURRENCY` | derived | How many `/submit` requests run at once. Derived from `HOST_MEMORY_CEILING_MB`, capped at the visible core count. |
| `SECCOMP_POLICY` | `/app/policy.kafel` | Path to the kafel policy. Correct in the image; must be set when running from source. |
| `NSJAIL_BIN` | `/usr/local/bin/nsjail` | Same — correct in the image, must be set when running from source. |

Every variable is validated at boot. An unparseable value — `AUTH_STRICT=on`,
`HOST_MEMORY_CEILING_MB=1e6` — makes the judge refuse to start rather than silently run with a
different number. A typo in a security switch or a memory cap should be loud, not a green
`/health` with everything quietly broken.

## Contributing

Contributions are genuinely welcome — this project is built and maintained by high school students,
and outside help makes it better. Language support, performance work, better error messages, and
docs are all useful, and small PRs are perfectly good ones.

Fork it, branch off `main`, and make sure `npm run build` is clean before pushing. Because this
service runs untrusted code, changes to the sandbox, the seccomp policy, or the Dockerfile need a
clear explanation in the PR of what changes and why.

Not sure where to start, or stuck on setup? Open an issue — questions are welcome too.

## License

[MIT](LICENSE) — fork it, ship it, no strings.
