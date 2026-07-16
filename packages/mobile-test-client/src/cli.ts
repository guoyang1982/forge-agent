#!/usr/bin/env node
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connectDaemon } from "@forge/daemon-client";
import type {
  CreateChannelResult,
  MobileCreatePairingResult,
} from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";
import {
  MobileRelayTestClient,
  type MobileTestClientState,
} from "./client.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let client: MobileRelayTestClient;
  let adapterId = args.adapterId;
  if (args.state && !args.offer && !args.relayOrigin) {
    const state = JSON.parse(readFileSync(args.state, "utf8")) as MobileTestClientState;
    client = await MobileRelayTestClient.resume(state);
  } else {
    let offer: unknown;
    if (args.offer) {
      offer = JSON.parse(readFileSync(args.offer, "utf8"));
    } else {
      if (!args.socket) {
        throw new Error("pairing requires --offer or --socket");
      }
      const daemon = await connectDaemon(args.socket);
      try {
        if (!adapterId) {
          if (!args.relayOrigin || !args.enrollmentToken || !args.cwd) {
            throw new Error(
              "creating a test channel requires --relay-origin, --enrollment-token, and --cwd",
            );
          }
          const created = (await daemon.request(DAEMON_METHODS.CREATE_CHANNEL, {
            draft: {
              kind: "mobile",
              name: "Forge Mobile E2E",
              cwd: args.cwd,
              enabled: true,
              config: {
                relayOrigin: args.relayOrigin,
                enrollmentToken: args.enrollmentToken,
              },
            },
            skipConfirm: true,
          })) as CreateChannelResult;
          adapterId = created.channel.id;
          console.log(JSON.stringify({ step: "channel.create", adapterId }));
        }
        const result = (await daemon.request(DAEMON_METHODS.MOBILE_CREATE_PAIRING, {
          adapterId,
          deviceName: args.deviceName ?? "Mobile E2E Test Client",
          skipConfirm: true,
        })) as MobileCreatePairingResult;
        offer = result.offer;
      } finally {
        daemon.close();
      }
    }
    client = await MobileRelayTestClient.pair(offer);
    if (args.state) saveState(args.state, client.state);
  }

  try {
    const sessions = await client.call("session.list", { limit: 20 });
    console.log(JSON.stringify({ step: "session.list", result: sessions }));
    const firstSession = firstSessionId(sessions);
    if (firstSession) {
      const history = await client.call("session.messages", {
        sessionId: firstSession,
        limit: 20,
      });
      console.log(JSON.stringify({ step: "session.messages", result: history }));
    }
    if (args.cwd && args.message) {
      let runningSessionId = "";
      let releaseSession!: () => void;
      const sessionReady = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      const run = client.startRun(
        { cwd: args.cwd, message: args.message },
        (frame) => {
          console.log(JSON.stringify({ step: "run.event", event: frame.event }));
          const event = frame.event as { sessionId?: unknown };
          if (!runningSessionId && typeof event?.sessionId === "string") {
            runningSessionId = event.sessionId;
            releaseSession();
          }
        },
      );
      if (args.cancel) {
        await Promise.race([
          sessionReady,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("run did not publish a sessionId")), 15_000),
          ),
        ]);
        const cancelled = await client.call("run.cancel", { sessionId: runningSessionId });
        console.log(JSON.stringify({ step: "run.cancel", result: cancelled }));
      }
      try {
        const result = await run.result;
        console.log(JSON.stringify({ step: "run.result", result }));
      } catch (error) {
        if (!args.cancel) throw error;
        console.log(
          JSON.stringify({
            step: "run.result",
            cancelled: true,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (args.revokeAfter) {
      if (!args.socket || !adapterId) {
        throw new Error("--revoke-after requires --socket and --adapter-id");
      }
      const daemon = await connectDaemon(args.socket);
      try {
        const result = await daemon.request(DAEMON_METHODS.MOBILE_REVOKE_DEVICE, {
          adapterId,
          deviceId: client.state.deviceId,
        });
        console.log(JSON.stringify({ step: "device.revoke", result }));
      } finally {
        daemon.close();
      }
    }
    console.log("Forge Mobile end-to-end smoke passed");
  } finally {
    client.close();
  }
}

interface Args {
  socket?: string;
  adapterId?: string;
  offer?: string;
  state?: string;
  deviceName?: string;
  cwd?: string;
  message?: string;
  cancel: boolean;
  relayOrigin?: string;
  enrollmentToken?: string;
  revokeAfter: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cancel: false, revokeAfter: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--cancel") args.cancel = true;
    else if (flag === "--revoke-after") args.revokeAfter = true;
    else {
      const value = argv[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--socket") args.socket = value;
      else if (flag === "--adapter-id") args.adapterId = value;
      else if (flag === "--offer") args.offer = value;
      else if (flag === "--state") args.state = value;
      else if (flag === "--device-name") args.deviceName = value;
      else if (flag === "--cwd") args.cwd = value;
      else if (flag === "--message") args.message = value;
      else if (flag === "--relay-origin") args.relayOrigin = value;
      else if (flag === "--enrollment-token") args.enrollmentToken = value;
      else throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function firstSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return undefined;
  const first = sessions[0] as { id?: unknown } | undefined;
  return typeof first?.id === "string" ? first.id : undefined;
}

function saveState(path: string, state: MobileTestClientState): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
