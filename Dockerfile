# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for wmoj-judge.
#
# Stages:
#   1. nsjail-builder : clone and build nsjail from source (not in
#                       Debian apt repos).
#   2. builder        : install dev deps and compile TypeScript -> dist.
#   3. runtime        : install toolchain + runtime deps, copy dist,
#                       create the unprivileged UID pool, lock down
#                       /app perms.
#
# Base image: node:20-trixie-slim (Debian 13). Trixie ships g++ 14.2,
# which has complete -std=c++23 support — required for the cpp23
# language target. Bullseye (g++ 10) and bookworm (g++ 12) only cover
# a partial set of C++23 features, so they are insufficient here.

# ---------------------------------------------------------------------
# Stage 1: build nsjail from source
# ---------------------------------------------------------------------
FROM debian:trixie-slim AS nsjail-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        build-essential \
        pkg-config \
        protobuf-compiler \
        libprotobuf-dev \
        libnl-route-3-dev \
        libcap-dev \
        bison \
        flex \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth=1 --branch 3.3 https://github.com/google/nsjail.git \
    && cd nsjail \
    && make

# ---------------------------------------------------------------------
# Stage 2: compile TypeScript
# ---------------------------------------------------------------------
FROM node:20-trixie AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY languages.json policy.kafel ./
RUN npm run build

# ---------------------------------------------------------------------
# Stage 3: runtime image
# ---------------------------------------------------------------------
FROM node:20-trixie-slim AS runtime

# Compilers and language runtimes for the 6-entry language matrix:
#   python3      -> /usr/bin/python3                (debian apt)
#   pypy3        -> /usr/bin/pypy3                  (debian apt)
#   cpp14/17/20/23 -> /usr/bin/g++                  (debian apt, gcc 14)
#
# Shared libs for nsjail at runtime: libprotobuf32t64 (trixie renamed
# from libprotobuf32 during the 64-bit time_t transition), libnl-3-200,
# libnl-route-3-200, libcap2.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        pypy3 \
        g++ \
        libprotobuf32t64 \
        libnl-3-200 \
        libnl-route-3-200 \
        libcap2 \
    && rm -rf /var/lib/apt/lists/*

# nsjail binary from stage 1
COPY --from=nsjail-builder /src/nsjail/nsjail /usr/local/bin/nsjail
RUN chmod 0755 /usr/local/bin/nsjail

# Unprivileged UID pool — matches src/sandbox/uidPool.ts (BASE_UID=1000,
# pool size 16). Use --system so the accounts aren't interactive and
# --no-create-home so nothing ends up on disk.
RUN for i in $(seq 1000 1015); do \
        useradd --system --no-create-home --shell /usr/sbin/nologin \
                --uid "$i" "judge-$i"; \
    done

WORKDIR /app

# Install production Node deps only.
COPY package*.json ./
RUN npm ci --omit=dev

# Bring in the compiled TS and the static assets consumed at runtime.
COPY --from=builder /app/dist ./dist
COPY languages.json policy.kafel ./

# Run Node as the judge-1000 unprivileged user. This is REQUIRED on
# Render-style unprivileged containers because nsjail's initNsFromChild
# issues prctl(PR_SET_SECUREBITS, ...) which needs CAP_SETPCAP (which
# Render does not grant). nsjail has an early-return guard that skips
# that whole block when orig_euid != 0:
#
#   if (!clone_newuser && orig_euid != 0) return true;
#
# so by running as UID 1000 we bypass the failing prctl entirely. The
# sandboxed child simply inherits Node's UID (no setuid happens), which
# still gives us an unprivileged, capability-less, no-new-privs process
# with the full seccomp allow-list and rlimits.
RUN chown -R 1000:1000 /app \
    && chmod -R 750 /app

USER 1000

ENV NODE_ENV=production \
    NSJAIL_BIN=/usr/local/bin/nsjail \
    SECCOMP_POLICY=/app/policy.kafel

EXPOSE 4001

CMD ["node", "dist/server.js"]
