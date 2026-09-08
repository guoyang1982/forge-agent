import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { connectDaemon } from "@forge/bus";
import { DAEMON_METHODS, type SessionHookSource } from "@forge/protocol";
import { getDataDir, loadConfig } from "@forge/config";
import { formatSessionsList, SessionManager } from "@forge/session-manager";
import { printWelcome, printHelp } from "./welcome.js";
import { printUnknownSlash } from "./commands-hint.js";
import {
  createCommandRegistry,
  registerBuiltinCommands,
} from "./commands/index.js";
import {
  applyPendingPatches,
  createEventPrinter,
  executeRun,
  printRunError,
} from "./runner.js";
import { printNextSteps } from "./next-steps.js";
import { ensureDaemon } from "./daemon-util.js";
import { askPatchConfirm } from "./patch-confirm.js";
import { wrapRunEventHandler } from "./network-confirm.js";

const PROMPT = "\x1b[32mforge\x1b[0m \x1b[2m›\x1b[0m ";

export interface ReplOptions {
  cwd: string;
  yes?: boolean;
  version: string;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  let cwd = await ensureWorkspaceDir(resolve(opts.cwd));
  const cfg = loadConfig({ cwd });
  const autoApplyPatches = Boolean(opts.yes ?? cfg.ui?.autoApplyPatches);
  await ensureDaemon(cfg.daemon.socketPath);

  let sessionId: string | null = null;
  let pendingHookSource: SessionHookSource | undefined;
  let busy = false;
  let lastChangedPaths: string[] = [];
  let activeClient: Awaited<ReturnType<typeof connectDaemon>> | null = null;
  let cancelRequested = false;
  const commandRegistry = createCommandRegistry();
  registerBuiltinCommands(commandRegistry);

  const printBanner = () => {
    printWelcome({
      version: opts.version,
      cwd,
      config: loadConfig({ cwd }),
      sessionId,
    });
  };

  printBanner();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: PROMPT,
  });

  rl.prompt();

  rl.on("SIGINT", () => {
    if (busy && activeClient) {
      if (!cancelRequested) {
        cancelRequested = true;
        process.stderr.write(
          "\n\x1b[33m正在取消任务… (再按 Ctrl+C 可退出 REPL)\x1b[0m\n",
        );
        void activeClient
          .request(DAEMON_METHODS.CANCEL_RUN, {})
          .catch(() => {});
      }
      return;
    }
    process.stdout.write("\n");
    rl.close();
  });

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      const handled = await commandRegistry.dispatch(input, {
        rl,
        getCwd: () => cwd,
        setCwd: async (p) => {
          cwd = await ensureWorkspaceDir(resolve(p));
        },
        getSession: () => sessionId,
        clearSession: async () => {
          const outgoingSid = sessionId;
          if (outgoingSid) {
            try {
              await connectAndRequest(
                cfg.daemon.socketPath,
                DAEMON_METHODS.RELEASE_ACP_FORGE_SESSION,
                { sessionId: outgoingSid },
              );
            } catch {
              /* daemon may be offline */
            }
          }
          sessionId = null;
          pendingHookSource = "clear";
          printBanner();
        },
        listSessions: async () => {
          const manager = openSessionManager();
          try {
            console.log("\n" + formatSessionsList(manager.list(12), sessionId) + "\n");
          } finally {
            manager.close();
          }
        },
        resumeSession: async (prefix) => {
          const manager = openSessionManager();
          try {
            const matches = manager.list(50).filter((s) => s.id.startsWith(prefix));
            if (matches.length === 0) {
              console.log(`\x1b[33m未找到 session:\x1b[0m ${prefix}\n`);
              return;
            }
            if (matches.length > 1) {
              console.log("\x1b[33m匹配到多个 session，请输入更长 id:\x1b[0m");
              console.log(formatSessionsList(matches, sessionId) + "\n");
              return;
            }
            sessionId = matches[0].id;
            cwd = await ensureWorkspaceDir(matches[0].cwd);
            console.log(`Resumed ${sessionId}\nWorkspace: ${cwd}\n`);
          } finally {
            manager.close();
          }
        },
        compactSession: async (prefix) => {
          const targetPrefix = prefix ?? sessionId;
          if (!targetPrefix) {
            console.log("\x1b[33m当前没有 session，可用 /sessions 查看历史。\x1b[0m\n");
            return;
          }
          const manager = openSessionManager();
          try {
            const matches = manager.list(50).filter((s) => s.id.startsWith(targetPrefix));
            if (matches.length === 0) {
              console.log(`\x1b[33m未找到 session:\x1b[0m ${targetPrefix}\n`);
              return;
            }
            if (matches.length > 1) {
              console.log("\x1b[33m匹配到多个 session，请输入更长 id:\x1b[0m");
              console.log(formatSessionsList(matches, sessionId) + "\n");
              return;
            }
            const result = (await connectAndRequest(
              cfg.daemon.socketPath,
              DAEMON_METHODS.COMPACT_SESSION,
              { sessionId: matches[0].id },
            )) as {
              mode?: string;
              summarizedMessages: number;
              keptMessages: number;
              summaryPreview?: string;
            };
            console.log(
              `Compacted ${matches[0].id.slice(0, 8)} (${result.mode ?? "local"}): summarized ${result.summarizedMessages}, kept ${result.keptMessages}`,
            );
            if (result.summaryPreview) console.log(`Summary: ${result.summaryPreview}`);
            if (!(result as { blocked?: boolean }).blocked) {
              pendingHookSource = "compact";
            }
            console.log("");
          } finally {
            manager.close();
          }
        },
        onExit: () => {
          rl.close();
        },
        lastChanged: () => lastChangedPaths,
        requestDaemon: async (method, params, onEvent) => {
          const client = await connectDaemon(cfg.daemon.socketPath);
          try {
            return await client.request(method, params, onEvent);
          } finally {
            client.close();
          }
        },
        printHelp,
        printUnknownSlash,
      });
      if (handled) rl.prompt();
      return;
    }

    if (busy) {
      console.log("\x1b[33m请等待当前任务完成…\x1b[0m");
      rl.prompt();
      return;
    }

    busy = true;
    rl.pause();
    process.stderr.write(
      "\x1b[2m  执行中…（▼ Thinking = 模型思考，结束后可折叠；◇/◐ = 进度）\x1b[0m\n",
    );

    const pending: Array<{ path: string; unifiedDiff: string }> = [];
    const appliedDuringRun: string[] = [];
    let newSession: string | undefined;
    let streamedText = false;

    try {
      const client = await connectDaemon(cfg.daemon.socketPath);
      activeClient = client;
      cancelRequested = false;
      const printer = createEventPrinter(pending, {
        quietSession: true,
        appliedPaths: appliedDuringRun,
        thinking: cfg.ui?.thinking ?? "collapse",
        progress: cfg.ui?.progress ?? "compact",
      });

      console.log("");
      const result = await executeRun(client, {
        cwd,
        message: input,
        sessionId,
        hookSource: pendingHookSource,
        autoApply: autoApplyPatches,
        onEvent: wrapRunEventHandler(
          (ev) => {
            if (ev.type === "text_delta") streamedText = true;
            const sid = printer(ev);
            if (typeof sid === "string") newSession = sid;
          },
          { socketPath: cfg.daemon.socketPath, rl },
        ),
      });

      if (newSession) sessionId = newSession;
      else if (result.sessionId) sessionId = result.sessionId;

      const appliedFromConfirm = await applyPendingPatches(
        client,
        cwd,
        pending,
        autoApplyPatches,
        (item) => askPatchConfirm(rl, item),
        rl,
      );
      const allChanged = [
        ...appliedDuringRun,
        ...appliedFromConfirm,
      ];
      if (allChanged.length) {
        lastChangedPaths = allChanged;
        printNextSteps(cwd, allChanged);
      }

      // 流式时已通过 text_delta 输出；仅非流式时补打 finalText
      if (result.finalText && !streamedText) {
        console.log("\n" + result.finalText);
      }

      client.close();
      console.log("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("取消") || msg.includes("Aborted")) {
        process.stderr.write("\n\x1b[33m任务已取消\x1b[0m\n");
      } else {
        printRunError(e);
      }
      console.log("");
    }

    pendingHookSource = undefined;
    busy = false;
    activeClient = null;
    cancelRequested = false;
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nBye.");
    process.exit(0);
  });
}

async function connectAndRequest(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const client = await connectDaemon(socketPath);
  try {
    return await client.request(method, params);
  } finally {
    client.close();
  }
}

function openSessionManager(): SessionManager {
  return new SessionManager({
    dataDir: getDataDir(),
  });
}

async function ensureWorkspaceDir(abs: string): Promise<string> {
  if (!existsSync(abs)) {
    await mkdir(abs, { recursive: true });
    console.log(`\nCreated workspace: ${abs}\n`);
  }
  return abs;
}
