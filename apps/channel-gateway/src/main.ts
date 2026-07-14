#!/usr/bin/env node
import { loadConfig } from "@forge/config";
import { ChannelGateway } from "./gateway.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const gateway = new ChannelGateway({
    dataDir: cfg.daemon.dataDir,
    listenHost: process.env.FORGE_CHANNEL_GATEWAY_HOST ?? "127.0.0.1",
    listenPort: Number(process.env.FORGE_CHANNEL_GATEWAY_PORT ?? "8787"),
  });

  await gateway.start();

  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
