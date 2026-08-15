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

docker build -t wmoj-judge .

export JUDGE_SHARED_SECRET="$(openssl rand -hex 32)"
docker run --rm -p 4001:4001 \
  -e JUDGE_SHARED_SECRET="$JUDGE_SHARED_SECRET" \
  -e AUTH_STRICT=true \
  wmoj-judge
```

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
npm run dev
```

Note that `.env.local` is not auto-loaded — export the variables or use
`node --env-file=.env.local dist/server.js`.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Hot-reloading dev server on :4001 |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the build |

## Configuration

Only two variables normally need setting; everything else has a sensible default.

| Variable | Default | Notes |
|---|---|---|
| `JUDGE_SHARED_SECRET` | — | Must match `wmoj-app`. Required in production. |
| `AUTH_STRICT` | `false` | Set `true` in production to reject bad tokens. |
| `PORT` | `4001` | |
| `HOST_MEMORY_CEILING_MB` | `512` | Most memory the host can really back. Every submission's limit is clamped to this. Raise it on a bigger box. |

## Contributing

Contributions are genuinely welcome — this project is built and maintained by high school students,
and outside help makes it better. Language support, performance work, better error messages, and
docs are all useful, and small PRs are perfectly good ones.

Fork it, branch off `main`, and make sure `npm run build` is clean before pushing. Because this
service runs untrusted code, changes to the sandbox, the seccomp policy, or the Dockerfile need a
clear explanation in the PR of what changes and why.

Not sure where to start, or stuck on setup? Open an issue — questions are welcome too.
