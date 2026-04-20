import express from "express";
import cors from "cors";
import { config } from "./config";
import { logger, httpLogger } from "./util/logger";
import { startupSweep } from "./util/workdir";
import { installShutdownHandlers, enterRequest, exitRequest } from "./util/shutdown";
import { authMiddleware } from "./middleware/auth";
import { createRateLimiter } from "./middleware/rateLimit";
import { requestCaps } from "./middleware/requestCaps";
import { submitRouter } from "./routes/submit";
import { generateTestsRouter } from "./routes/generateTests";
import { healthRouter, probeToolchainAtBoot } from "./routes/health";
import { startCompileCache, stopCompileCache } from "./cache/compileCache";

async function main(): Promise<void> {
  const app = express();
  app.use(httpLogger);
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use((_req, res, next) => { enterRequest(); let done=false; const end=()=>{if(!done){done=true;exitRequest();}}; res.on("finish", end); res.on("close", end); next(); });
  app.use("/health", healthRouter);
  const gated = [authMiddleware, createRateLimiter(), requestCaps];
  app.use("/submit", ...gated, submitRouter);
  app.use("/generate-tests", ...gated, generateTestsRouter);
  await startupSweep();
  await probeToolchainAtBoot();
  startCompileCache();
  const server = app.listen(config.PORT, "0.0.0.0", () =>
    logger.info({ port: config.PORT }, "judge listening"));
  installShutdownHandlers(server);
  process.on("beforeExit", stopCompileCache);
}

main().catch((err) => { logger.error({ err }, "fatal: boot failed"); process.exit(1); });
