# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for wmoj-judge.
#
# Stages:
#   1. nsjail-builder : clone and build nsjail from source (not in
#                       Debian apt repos), and build the wmoj-jailrun
#                       resource reporter that wraps it.
#   2. builder        : install dev deps and compile TypeScript -> dist.
#   3. runtime        : install toolchain + runtime deps, copy dist,
#                       create the unprivileged UID pool, lock down
#                       /app perms.
#
# Base image: node:20-trixie-slim (Debian 13). Trixie ships g++ 14.2,
# which has complete -std=c++23 support — required for the cpp23
# language target. Bullseye (g++ 10) and bookworm (g++ 12) only cover
# a partial set of C++23 features, so they are insufficient here.
#
# EVERY stage pins --platform=linux/amd64, and that pin is load-bearing.
# `policy.kafel` is written against Kafel's **amd64** syscall table (its
# own first line says so). Built natively on an arm64 host — an Apple
# Silicon laptop — the policy does not compile, and nsjail dies on every
# single spawn with:
#
#   [W] preparePolicy():121 Could not compile policy: 51:12: Undefined identifier `umount'
#   [F] main():360 Couldn't prepare sandboxing policy
#
# nsjail then exits 255 and EVERY test case of EVERY submission is graded
# `RE` on a clean HTTP 200 while /health still returns {"status":"ok"} —
# a judge that looks healthy and fails every student. The Render target
# is amd64, so pinning also keeps a developer's local image identical to
# production. On arm64 hosts this builds under emulation and is slow;
# that is the correct trade against silently wrong verdicts.

# ---------------------------------------------------------------------
# Stage 1: build nsjail and the wmoj-jailrun reporter from source
# ---------------------------------------------------------------------
FROM --platform=linux/amd64 debian:trixie-slim AS nsjail-builder

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

# wmoj-jailrun: the judge's resource-accounting wrapper around nsjail.
#
# WHY IT EXISTS. nsjail 3.3 collects no rusage at all — both wait4()
# calls in its subproc.cc pass NULL — and emits no runtime log line
# containing a CPU time, a wall time or a maxrss. src/sandbox/nsjail.ts
# used to scrape six regexes out of that log for exactly those numbers,
# so `cpuMs` and `memKb` were 0 on every run, which silently disabled
# the authoritative TLE gate and both RSS-based MLE rules with no error
# anywhere. This program supplies those numbers from the kernel instead.
#
# It runs OUTSIDE the jail (Node -> wmoj-jailrun -> nsjail -> program),
# so it is never subject to policy.kafel and needs no seccomp allowance,
# and wait4()'s rusage covers nsjail plus every descendant nsjail reaped
# — which is the submission. It writes one line to the fd named by
# argv[1], marked FD_CLOEXEC before the fork so the jailed program never
# inherits it and cannot forge or truncate the report, and it exits with
# the same status nsjail did so nothing downstream changes shape.
#
# The report format is a contract with src/sandbox/nsjail.ts's
# REPORT_RE. Change one, change the other.
COPY <<'WMOJ_JAILRUN_C' /src/wmoj-jailrun.c
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Write the whole buffer, retrying short writes and EINTR. Diagnostics
   must never be the reason a run fails, so failures are swallowed. */
static void emit(int fd, const char *buf, size_t len) {
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, buf + off, len - off);
        if (n < 0) {
            if (errno == EINTR) continue;
            return;
        }
        off += (size_t)n;
    }
}

static void emit_error(int fd, const char *what, int err) {
    char line[256];
    int n = snprintf(line, sizeof line,
                     "WMOJ-JAILRUN v1 error=%s errno=%d\n", what, err);
    if (n > 0 && (size_t)n < sizeof line) emit(fd, line, (size_t)n);
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: wmoj-jailrun <report-fd> <program> [args...]\n");
        return 125;
    }

    char *end = NULL;
    long fdl = strtol(argv[1], &end, 10);
    if (end == argv[1] || *end != '\0' || fdl < 0 || fdl > 1024) {
        fprintf(stderr, "wmoj-jailrun: bad report fd '%s'\n", argv[1]);
        return 125;
    }
    int rfd = (int)fdl;

    /* Keep the report pipe out of the sandbox. FD_CLOEXEC survives the
       fork and closes at the child's exec, so nsjail and the jailed
       program never see the fd their own verdict is measured on. This
       process does not exec, so it keeps the fd. */
    if (fcntl(rfd, F_SETFD, FD_CLOEXEC) < 0) {
        emit_error(rfd, "report_fd", errno);
        return 125;
    }

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    pid_t pid = fork();
    if (pid < 0) {
        emit_error(rfd, "fork", errno);
        return 126;
    }
    if (pid == 0) {
        execvp(argv[2], &argv[2]);
        emit_error(rfd, "exec", errno);
        _exit(127);
    }

    int status = 0;
    struct rusage ru;
    memset(&ru, 0, sizeof ru);
    while (wait4(pid, &status, 0, &ru) < 0) {
        if (errno == EINTR) continue;
        emit_error(rfd, "wait4", errno);
        return 126;
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);

    unsigned long long cpu_us =
        (unsigned long long)ru.ru_utime.tv_sec * 1000000ULL +
        (unsigned long long)ru.ru_utime.tv_usec +
        (unsigned long long)ru.ru_stime.tv_sec * 1000000ULL +
        (unsigned long long)ru.ru_stime.tv_usec;

    long long wall_ns = (long long)(t1.tv_sec - t0.tv_sec) * 1000000000LL +
                        (long long)(t1.tv_nsec - t0.tv_nsec);
    if (wall_ns < 0) wall_ns = 0;

    /* ru_maxrss is in KB on Linux and is the peak over nsjail and every
       descendant it reaped, so it includes nsjail's own few MB. It can
       only ever over-report, never hide a real MLE. */
    long long maxrss_kb = (long long)ru.ru_maxrss;
    if (maxrss_kb < 0) maxrss_kb = 0;

    int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    int term_sig = WIFSIGNALED(status) ? WTERMSIG(status) : 0;

    char line[256];
    int n = snprintf(line, sizeof line,
                     "WMOJ-JAILRUN v1 exit=%d signal=%d cpu_us=%llu "
                     "maxrss_kb=%lld wall_us=%llu\n",
                     exit_code, term_sig, cpu_us, maxrss_kb,
                     (unsigned long long)(wall_ns / 1000));
    if (n > 0 && (size_t)n < sizeof line) emit(rfd, line, (size_t)n);

    /* Mirror nsjail's own exit shape so callers see exactly what they
       saw before this wrapper existed: nsjail's code, or 128 + signal. */
    if (WIFSIGNALED(status)) return 128 + term_sig;
    return exit_code < 0 ? 125 : exit_code;
}
WMOJ_JAILRUN_C

# Statically linked: the runtime stage is a different (slimmer) image, and
# a reporter that fails to load is a judge that grades nothing.
RUN gcc -O2 -Wall -Wextra -static -o /usr/local/bin/wmoj-jailrun /src/wmoj-jailrun.c

# ---------------------------------------------------------------------
# Stage 2: compile TypeScript
# ---------------------------------------------------------------------
FROM --platform=linux/amd64 node:20-trixie AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY languages.json policy.kafel ./
RUN npm run build

# ---------------------------------------------------------------------
# Stage 3: runtime image
# ---------------------------------------------------------------------
FROM --platform=linux/amd64 node:20-trixie-slim AS runtime

# Compilers and language runtimes for the 6-entry language matrix:
#   python3      -> /usr/bin/python3                (debian apt)
#   pypy3        -> /usr/bin/pypy3                  (debian apt)
#   cpp14/17/20/23 -> /usr/bin/g++                  (debian apt, gcc 14)
#
# Shared libs for nsjail at runtime: libprotobuf32t64 (trixie renamed
# from libprotobuf32 during the 64-bit time_t transition), libnl-3-200,
# libnl-route-3-200, libcap2.
#
# tini is the container's init — see ENTRYPOINT below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        pypy3 \
        g++ \
        tini \
        libprotobuf32t64 \
        libnl-3-200 \
        libnl-route-3-200 \
        libcap2 \
    && rm -rf /var/lib/apt/lists/*

# nsjail and its resource-accounting wrapper from stage 1. They are one
# unit: src/sandbox/nsjail.ts locates wmoj-jailrun in NSJAIL_BIN's own
# directory, so these two must stay side by side.
COPY --from=nsjail-builder /src/nsjail/nsjail /usr/local/bin/nsjail
COPY --from=nsjail-builder /usr/local/bin/wmoj-jailrun /usr/local/bin/wmoj-jailrun
RUN chmod 0755 /usr/local/bin/nsjail /usr/local/bin/wmoj-jailrun

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

# tini as PID 1, because Node is not an init and libuv only waitpid()s
# handles it created itself. There is no PID namespace in the jail, so a
# submission's orphaned descendants are reparented to PID 1; with Node
# there they become PERMANENT zombies, and the kernel counts a zombie
# against RLIMIT_NPROC for its real UID until it is reaped. Every
# submission, every g++ and Node itself share UID 1000, so one program
# that forks a few hundred children and exits 0 (scoring AC) can leave
# the per-UID budget exhausted for every OTHER student until redeploy.
# tini reaps them. Render does not allow `docker run --init`, so the
# init has to live in the image. tini forwards SIGTERM to node, so the
# graceful-drain path in src/util/shutdown.ts is unaffected.
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "dist/server.js"]
