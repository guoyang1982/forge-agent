import type { Interface } from "node:readline";
import type { AgentEvent } from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";
import { connectDaemon } from "@forge/bus";
import { loadConfig } from "@forge/config";

const handledIds = new Set<string>();

export async function handleSoftwarePermissionEvent(
  socketPath: string,
  event: Extract<AgentEvent, { type: "permission_request" }>,
  rl?: Interface,
): Promise<void> {
  if (event.kind !== "software" || handledIds.has(event.id)) return;
  handledIds.add(event.id);

  const approved = rl
    ? await askSoftwareConfirm(rl, event.summary)
    : await askSoftwareConfirmOnce(event.summary);

  const cfg = loadConfig();
  const client = await connectDaemon(socketPath || cfg.daemon.socketPath);
  try {
    await client.request(DAEMON_METHODS.PERMISSION_RESPONSE, {
      id: event.id,
      approved,
    });
  } finally {
    client.close();
  }
}

export async function handleNetworkPermissionEvent(
  socketPath: string,
  event: Extract<AgentEvent, { type: "permission_request" }>,
  rl?: Interface,
): Promise<void> {
  if (event.kind !== "network" || handledIds.has(event.id)) return;
  handledIds.add(event.id);

  const approved = rl
    ? await askNetworkConfirm(rl, event.summary)
    : await askNetworkConfirmOnce(event.summary);

  const cfg = loadConfig();
  const client = await connectDaemon(socketPath || cfg.daemon.socketPath);
  try {
    await client.request(DAEMON_METHODS.PERMISSION_RESPONSE, {
      id: event.id,
      approved,
    });
  } finally {
    client.close();
  }
}

export async function handleRuntimePermissionEvent(
  socketPath: string,
  event: Extract<AgentEvent, { type: "permission_request" }>,
  rl?: Interface,
): Promise<void> {
  if (
    event.kind !== "acp" &&
    event.kind !== "codex" &&
    event.kind !== "claude-code"
  ) {
    return;
  }
  if (handledIds.has(event.id)) return;
  handledIds.add(event.id);

  const options = event.options ?? [];
  const optionId = rl
    ? await askRuntimePermissionChoice(rl, event.summary, event.kind, options)
    : await askRuntimePermissionChoiceOnce(event.summary, event.kind, options);
  if (!optionId) return;

  const cfg = loadConfig();
  const client = await connectDaemon(socketPath || cfg.daemon.socketPath);
  try {
    await client.request(DAEMON_METHODS.PERMISSION_RESPONSE, {
      id: event.id,
      optionId,
    });
  } finally {
    client.close();
  }
}

function askSoftwareConfirm(rl: Interface, summary: string): Promise<boolean> {
  const wasPaused = (rl as Interface & { paused?: boolean }).paused;
  if (wasPaused) rl.resume();
  return new Promise((resolve) => {
    rl.question(`\n\x1b[33m软件管理\x1b[0m ${summary} [y/N] `, (answer) => {
      if (wasPaused) rl.pause();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function askSoftwareConfirmOnce(summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`\n\x1b[33m软件管理\x1b[0m ${summary} [y/N] `);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
    });
  });
}

function askNetworkConfirm(rl: Interface, summary: string): Promise<boolean> {
  const wasPaused = (rl as Interface & { paused?: boolean }).paused;
  if (wasPaused) rl.resume();
  return new Promise((resolve) => {
    rl.question(`\n\x1b[33m网络权限\x1b[0m ${summary} [y/N] `, (answer) => {
      if (wasPaused) rl.pause();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function askNetworkConfirmOnce(summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(`\n\x1b[33m网络权限\x1b[0m ${summary} [y/N] `);
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
    });
  });
}

async function askRuntimePermissionChoice(
  rl: Interface,
  summary: string,
  kind: string,
  options: Array<{ optionId: string; name: string; kind?: string }>,
): Promise<string | null> {
  const label =
    kind === "codex" ? "Codex" : kind === "claude-code" ? "Claude Code" : "ACP";
  const wasPaused = (rl as Interface & { paused?: boolean }).paused;
  if (wasPaused) rl.resume();
  process.stdout.write(`\n\x1b[33m${label} 工具授权\x1b[0m ${summary}\n`);
  options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option.name}\n`);
  });
  return new Promise((resolve) => {
    rl.question("选择 [1-N，回车取消]: ", (answer) => {
      if (wasPaused) rl.pause();
      const trimmed = answer.trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      const index = Number.parseInt(trimmed, 10) - 1;
      resolve(options[index]?.optionId ?? null);
    });
  });
}

async function askRuntimePermissionChoiceOnce(
  summary: string,
  kind: string,
  options: Array<{ optionId: string; name: string; kind?: string }>,
): Promise<string | null> {
  const label =
    kind === "codex" ? "Codex" : kind === "claude-code" ? "Claude Code" : "ACP";
  process.stdout.write(`\n\x1b[33m${label} 工具授权\x1b[0m ${summary}\n`);
  options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option.name}\n`);
  });
  process.stdout.write("选择 [1-N，回车取消]: ");
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      const trimmed = String(chunk).trim();
      if (!trimmed) {
        resolve(null);
        return;
      }
      const index = Number.parseInt(trimmed, 10) - 1;
      resolve(options[index]?.optionId ?? null);
    });
  });
}

export function wrapRunEventHandler(
  base: (event: AgentEvent) => void,
  options: { socketPath: string; rl?: Interface },
): (event: AgentEvent) => void {
  return (event) => {
    if (event.type === "permission_request" && event.kind === "network") {
      void handleNetworkPermissionEvent(
        options.socketPath,
        event,
        options.rl,
      ).catch((e) => {
        console.error(
          `\x1b[31m权限确认失败:\x1b[0m ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
    if (event.type === "permission_request" && event.kind === "software") {
      void handleSoftwarePermissionEvent(
        options.socketPath,
        event,
        options.rl,
      ).catch((e) => {
        console.error(
          `\x1b[31m软件管理确认失败:\x1b[0m ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }
    if (
      event.type === "permission_request" &&
      (event.kind === "acp" ||
        event.kind === "codex" ||
        event.kind === "claude-code")
    ) {
      void handleRuntimePermissionEvent(options.socketPath, event, options.rl).catch(
        (e) => {
          console.error(
            `\x1b[31mRuntime 权限确认失败:\x1b[0m ${e instanceof Error ? e.message : String(e)}`,
          );
        },
      );
    }
    base(event);
  };
}
