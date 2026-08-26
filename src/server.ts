import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { config } from "./config";
import { logger, httpLogger } from "./util/logger";
import { startupSweep } from "./util/workdir";
import { installShutdownHandlers, enterRequest, exitRequest } from "./util/shutdown";
import { authMiddleware } from "./middleware/auth";
import { createRateLimiter } from "./middleware/rateLimit";
import { requestCaps, JSON_BODY_LIMIT } from "./middleware/requestCaps";
import { submitRouter } from "./routes/submit";
import { generateTestsRouter } from "./routes/generateTests";
import { healthRouter, probeToolchainAtBoot } from "./routes/health";
import { startCompileCache } from "./cache/compileCache";
import { sandboxSelfCheck } from "./sandbox/nsjail";

/**
 * Bump the in-flight counter `shutdown()` drains against.
 *
 * Mounted as the LAST gate, so it counts only requests that actually
 * reached a judging route: `/health` (which Render polls every few
 * seconds) and unmatched paths must not hold a deploy open, and a
 * request rejected by the rate limiter, auth or the size caps has no
 * work to drain.
 *
 * Being keyed on the response lifecycle bounds the counter from one
 * side only: `res` emits `'close'` when the *client* disconnects, so
 * the count drops to zero while the route is still compiling and
 * running cases against a workdir `shutdown()` may then delete
 * underneath it. Closing that gap needs the routes to bracket their own
 * judging work with the same `enterRequest()`/`exitRequest()` pair,
 * which they may safely do on top of this: the drain waits for the
 * counter to reach zero, so double-counting simply makes it wait for
 * the later of the two to finish.
 */
function countInFlight(_req: Request, res: Response, next: NextFunction): void {
  enterRequest();
  let done = false;
  const end = (): void => {
    if (done) return;
    done = true;
    exitRequest();
  };
  res.on("finish", end);
  res.on("close", end);
  next();
}

async function main(): Promise<void> {
  const app = express();
  app.use(httpLogger);
  app.use(cors());
  app.use("/health", healthRouter);

  // Gate order is load-bearing, and the body parser now sits inside
  // this chain instead of in front of the whole app:
  //
  //   1. rate limiter FIRST, ahead of auth, so a flood of *failed*
  //      auth attempts is throttled too. Behind auth it only ever
  //      throttled callers who already held the shared secret.
  //   2. auth, so nothing below burns memory on an anonymous request.
  //   3. express.json LAST of the three, because body-parser buffers
  //      the raw body, Buffer.concats it, decodes it to a JS string and
  //      then parses it — several times the body size in peak RSS, on a
  //      512 MB box. Mounted globally (as it was) that ran for every
  //      request on every path, including unrouted ones, so an
  //      unauthenticated POST of a few hundred MB to any URL could
  //      OOM-kill the container before auth ever ran. `inflate`
  //      defaults on, so a small gzip body could force the full limit
  //      of inflation first. `/health` is a GET and needs no parser.
  //   4. requestCaps, which needs `req.body` parsed to measure it.
  //
  // JSON_BODY_LIMIT and the caps live in the same module so the parser
  // limit can never again drift *below* the largest payload the caps
  // accept — see the comment on JSON_BODY_LIMIT for what that costs.
  //
  // One limiter and one parser instance are shared by both mounts, so
  // the documented "60/min across both gated routes" budget is one
  // budget, not two.
  const gated = [
    createRateLimiter(),
    authMiddleware,
    express.json({ limit: JSON_BODY_LIMIT }),
    requestCaps,
    countInFlight,
  ];
  app.use("/submit", ...gated, submitRouter);
  app.use("/generate-tests", ...gated, generateTestsRouter);

  await startupSweep();
  await probeToolchainAtBoot();

  // Refuse to boot unless the sandbox both RUNS and MEASURES.
  //
  // `probeToolchainAtBoot` only checks that python3/pypy3/g++ exist. It cannot
  // catch either of the two failures that actually shipped here:
  //
  //   * nsjail starting and bailing — an unreadable or uncompilable
  //     `policy.kafel` makes it exit 255 with an empty child stderr, and every
  //     test case of every submission comes back `RE` on a clean HTTP 200 while
  //     /health reports "ok". Reproduced in a container on this repo.
  //   * the sandbox running but reporting nothing — `cpuMs`/`memKb` were `0` on
  //     every run for the entire life of the nsjail 3.3 pin, because the code
  //     scraped them from a log format nsjail does not emit. That silently
  //     disabled the authoritative CPU-time TLE gate and both RSS-based MLE
  //     rules. Confirmed in production data: 3,457 stored cases, zero non-zero
  //     cpuMs, and 94 real timeouts recorded as `WA`.
  //
  // `sandboxSelfCheck` runs a CPU-bound probe against a 50 ms limit and fails
  // if the ladder does not return `TO` or if `cpuMs` comes back 0. Exiting here
  // is the point: a judge that cannot measure must not accept submissions,
  // because every verdict it produces would be wrong and nothing downstream
  // would notice.
  const selfCheck = await sandboxSelfCheck();
  if (!selfCheck.ok) {
    logger.fatal({ error: selfCheck.error }, "sandbox self-check failed; refusing to start");
    process.exit(1);
  }
  logger.info({ ...selfCheck.value }, "sandbox self-check passed");

  startCompileCache();
  // AUTH_STRICT goes in the boot line because it is the only switch
  // that decides whether the shared secret is checked at all, and it
  // fails open. Without it a judge running wide open is
  // indistinguishable at boot from a correctly configured one — the
  // sole other signal is one warn per request, on an instance nobody
  // tails.
  const server = app.listen(config.PORT, "0.0.0.0", () => {
    logger.info(
      {
        port: config.PORT,
        authStrict: config.AUTH_STRICT,
        nodeEnv: config.NODE_ENV,
        version: config.VERSION,
      },
      "judge listening",
    );
  });
  // A listen failure (EADDRINUSE, or EACCES on a privileged PORT under
  // UID 1000) is emitted asynchronously, after main() has already
  // resolved — so without this listener it escapes `main().catch` below
  // and dies as an uncaught exception with a raw V8 stack instead of
  // the structured fatal line every other boot failure produces.
  server.on("error", (err) => {
    logger.error({ err, port: config.PORT }, "fatal: listen failed");
    process.exit(1);
  });
  installShutdownHandlers(server);
}

main().catch((err) => { logger.error({ err }, "fatal: boot failed"); process.exit(1); });
