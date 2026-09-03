import { mkdir } from "node:fs/promises";

import { defaultConfigPath, loadConfig } from "./config.js";
import { PiCompletionRunner } from "./pi-runner.js";
import { createBridgeServer } from "./server.js";

function configPathFromArguments(arguments_: string[]): string {
  const index = arguments_.indexOf("--config");
  if (index < 0) {
    return process.env.PI_LEO_CONFIG || defaultConfigPath();
  }
  const value = arguments_[index + 1];
  if (!value) {
    throw new Error("--config requires a path");
  }
  return value;
}

async function main(): Promise<void> {
  process.title = "pi-leo-bridge";
  const configPath = configPathFromArguments(process.argv.slice(2));
  const config = await loadConfig(configPath);
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });

  console.info(`${new Date().toISOString()} initializing ${config.provider}/${config.modelId}`);
  const runner = await PiCompletionRunner.create(config);
  const bridge = createBridgeServer(config, runner);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    bridge.server.once("error", onError);
    bridge.server.listen(config.port, config.host, () => {
      bridge.server.off("error", onError);
      resolve();
    });
  });

  console.info(
    `${new Date().toISOString()} listening=http://${config.host}:${config.port} model=${runner.provider}/${runner.modelId} profiles=${runner.profiles.map((profile) => `${profile.publicModelId}:${profile.thinkingLevel}`).join(",")} tools=disabled`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`${new Date().toISOString()} shutdown=${signal} active=${bridge.activeRequests()}`);
    bridge.server.close(() => process.exit(0));
    setTimeout(() => {
      bridge.server.closeAllConnections();
      process.exit(0);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-api-key>")
    .replace(/\/auth\/[A-Za-z0-9_-]{20,}\//g, "/auth/<redacted>/")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  console.error(`${new Date().toISOString()} fatal=${name}:${message}`);
  process.exitCode = 1;
});
