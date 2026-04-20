# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for wmoj-judge.
#
# Stages:
#   1. nsjail-builder : clone and build nsjail from source (not in
#                       Debian bullseye apt repos).
#   2. builder        : install dev deps and compile TypeScript -> dist.
#   3. runtime        : install toolchain + runtime deps, copy dist,
#                       create the unprivileged UID pool, pre-generate
#                       the JVM CDS archive, lock down /app perms.

# ---------------------------------------------------------------------
# Stage 1: build nsjail from source
# ---------------------------------------------------------------------
FROM debian:bullseye-slim AS nsjail-builder

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
FROM node:20-bullseye AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY languages.json policy.kafel ./
RUN npm run build

# ---------------------------------------------------------------------
# Stage 3: runtime image
# ---------------------------------------------------------------------
FROM node:20-bullseye AS runtime

# Compilers and language runtimes for the 5 supported languages plus
# the shared libs nsjail needs at run time (libprotobuf, libnl-3,
# libnl-route-3, libcap).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        pypy3 \
        g++ \
        openjdk-17-jdk-headless \
        openjdk-17-jre-headless \
        libprotobuf23 \
        libnl-3-200 \
        libnl-route-3-200 \
        libcap2 \
        ca-certificates \
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

# Pre-generate the JVM Class Data Sharing archive. Faster Java cold
# starts; tolerate failure (architectures / JVMs without CDS still
# boot, just without the speedup).
RUN java -Xshare:dump -XX:SharedArchiveFile=/app/jvm-cds.jsa \
        > /tmp/cds.log 2>&1 \
    || echo "WARN: JVM CDS dump failed; java will run without -Xshare:on"

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
