import { connectDaemon } from "@forge/bus";
import { supportsDaemonV2 } from "@forge/daemon-client";
import { DAEMON_METHODS } from "@forge/protocol";
import { spawn } from "node:child_process";
import { join } from "node:path";

export async function ensureDaemon(socketPath: string): Promise<void> {
  try {
    const client = await connectDaemon(socketPath);
    await client.request(DAEMON_METHODS.PING);
    client.close();
  } catch {
    console.log("Starting daemon…");
    const daemonJs = new URL("../../daemon/dist/main.js", import.meta.url);
    const child = spawn(process.execPath, [daemonJs.pathname], {
      detached: true,
      stdio: "ignore",
      cwd: join(daemonJs.pathname, "..", ".."),
    });
    child.unref();
    await sleep(1200);
  }
}

export async function daemonSupportsV2(socketPath: string): Promise<boolean> {
  try {
    const client = await connectDaemon(socketPath);
    try {
      return await supportsDaemonV2(client);
    } finally {
      client.close();
    }
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
