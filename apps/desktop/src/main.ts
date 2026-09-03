import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type WebContents,
} from "electron";
import { killDaemonInDataDir } from "@forge/platform";
import {
  resolveDevelopmentNodeExecutable,
  shouldReplaceConnectedDaemon,
  waitForDaemonDisconnect,
} from "./daemon-lifecycle.js";
import { connectDaemon } from "@forge/bus";
import {
  DAEMON_METHODS,
  FORGE_DAEMON_BUILD,
  type AgentEvent,
  type ForgeConfig,
  type RunAttachment,
} from "@forge/protocol";
import { loadConfig, saveConfig, saveModelSelection } from "@forge/config";
import { WorkspaceGuard, gitBranchInfo, gitSwitchBranch } from "@forge/workspace";
import {
  attachmentPickerExtensions,
  attachmentTextFromExtract,
  extractDocumentText,
  IMAGE_EXTENSIONS,
} from "@forge/document-extract";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import {
  getHooksSettingsPayload,
  listDiscoveredHooksPayload,
  saveHooksSettingsPayload,
} from "./hooks-ipc.js";
import { disposeAllTerminals, registerTerminalIpc } from "./terminal-ipc.js";
import type { HooksSettingsFile, HooksSettingsScope } from "@forge/hooks";
import {
  gitDiffArgs,
  parseUnifiedDiffByFile,
  resolveRealWorkspaceFile,
  resolveWorkspaceImageFile,
} from "./workspace-ipc-utils.js";
import { startBrowserHost, type BrowserHostHandle } from "./browser/browser-host.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAEMON_PING_INTERVAL_MS = 100;
// Windows cold starts (defender scan / first run) can be slower; avoid false timeout.
const DAEMON_PING_MAX_ATTEMPTS = process.platform === "win32" ? 200 : 80;

app.setName("Forge");

const PICKER_EXTENSIONS = attachmentPickerExtensions();
let browserHost: BrowserHostHandle | null = null;

function mimeFromExtension(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/octet-stream";
  }
}

async function readAttachmentFromPath(filePath: string): Promise<RunAttachment | null> {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  const name = basename(filePath);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const mimeType = mimeFromExtension(ext);
  const buf = readFileSync(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      kind: "image",
      name,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
    };
  }
  const extracted = await extractDocumentText(name, buf);
  return {
    kind: "file",
    name,
    mimeType,
    text: attachmentTextFromExtract(name, extracted),
  };
}

async function readAttachmentFromBytes(
  name: string,
  base64: string,
): Promise<RunAttachment | null> {
  const safeName = basename(String(name || "file"));
  const ext = safeName.includes(".") ? safeName.split(".").pop()!.toLowerCase() : "";
  const mimeType = mimeFromExtension(ext);
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!buf.length) return null;
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      kind: "image",
      name: safeName,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
    };
  }
  const extracted = await extractDocumentText(safeName, buf);
  return {
    kind: "file",
    name: safeName,
    mimeType,
    text: attachmentTextFromExtract(safeName, extracted),
  };
}

const WORKSPACE_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "target",
]);

let ipcHandlersRegistered = false;
let mainWindow: BrowserWindow | null = null;
/** False during main-frame navigation until did-finish-load */
let rendererReady = false;
const recentAgentEventKeys = new Map<string, number>();

function agentEventDedupeKey(ev: AgentEvent): string {
  return JSON.stringify(ev);
}

function canSendToWebContents(wc: WebContents | null | undefined): wc is WebContents {
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return false;
  try {
    void wc.mainFrame;
    return true;
  } catch {
    return false;
  }
}

function safeSendAgentEvent(
  wc: WebContents | null | undefined,
  ev: AgentEvent,
): void {
  if (!rendererReady || !canSendToWebContents(wc)) return;
  const now = Date.now();
  const key = agentEventDedupeKey(ev);
  const last = recentAgentEventKeys.get(key) ?? 0;
  if (now - last < 250) return;
  recentAgentEventKeys.set(key, now);
  if (recentAgentEventKeys.size > 500) {
    for (const [k, t] of recentAgentEventKeys) {
      if (now - t > 1000) recentAgentEventKeys.delete(k);
    }
  }
  try {
    wc.send("forge:event", ev);
  } catch {
    /* frame disposed mid-flight (reload, crash, window closed) */
  }
}

function sendAgentEvent(ev: AgentEvent): void {
  // Browser tabs render untrusted web pages. Agent events must only be sent to
  // Forge's own renderer, even when a managed browser tab is focused.
  safeSendAgentEvent(mainWindow?.webContents, ev);
}

function bindWebContentsLifecycle(wc: WebContents): void {
  wc.on("did-start-navigation", (_event, _url, isMainFrame, isSameDocument) => {
    if (isMainFrame && !isSameDocument) {
      rendererReady = false;
      const cfg = loadConfig();
      void requestDaemonMethod(cfg, DAEMON_METHODS.CANCEL_RUN, {}).catch(() => {});
    }
  });
  wc.on("did-finish-load", () => {
    rendererReady = true;
  });
  wc.once("destroyed", () => {
    rendererReady = false;
  });
}

function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  registerTerminalIpc();

  ipcMain.handle("forge:get-config", async () => loadConfig());

  ipcMain.handle(
    "forge:get-hooks-settings",
    async (
      _event,
      payload: { scope: HooksSettingsScope; cwd?: string },
    ) => getHooksSettingsPayload({
      scope: payload.scope,
      cwd: payload.cwd,
      distDir: __dirname,
    }),
  );

  ipcMain.handle(
    "forge:save-hooks-settings",
    async (
      _event,
      payload: {
        scope: HooksSettingsScope;
        cwd?: string;
        settings: HooksSettingsFile;
      },
    ) => saveHooksSettingsPayload({
      scope: payload.scope,
      cwd: payload.cwd,
      settings: payload.settings,
      distDir: __dirname,
    }),
  );

  ipcMain.handle(
    "forge:list-discovered-hooks",
    async (_event, cwd: string) =>
      listDiscoveredHooksPayload({ cwd, distDir: __dirname }),
  );

  ipcMain.handle("forge:get-default-cwd", async () => app.getPath("documents"));

  ipcMain.handle(
    "forge:get-git-branches",
    async (_event, payload: { cwd: string }) => {
      const cwd = resolve(payload.cwd);
      if (!existsSync(cwd)) {
        throw new Error(`目录不存在: ${payload.cwd}`);
      }
      return gitBranchInfo(await WorkspaceGuard.ensure(cwd));
    },
  );

  ipcMain.handle(
    "forge:switch-git-branch",
    async (_event, payload: { cwd: string; branch: string }) => {
      const cwd = resolve(payload.cwd);
      if (!existsSync(cwd)) {
        throw new Error(`目录不存在: ${payload.cwd}`);
      }
      return gitSwitchBranch(await WorkspaceGuard.ensure(cwd), payload.branch);
    },
  );

  ipcMain.handle(
    "forge:save-config",
    async (
      _event,
      patch: Partial<ForgeConfig> & { replaceProfiles?: boolean },
    ) => {
      const { replaceProfiles, ...rest } = patch;
      return saveConfig(rest, { replaceProfiles });
    },
  );

  ipcMain.handle("forge:save-config-json", async (_event, fullConfig: ForgeConfig) =>
    saveConfig(fullConfig),
  );

  ipcMain.handle(
    "forge:switch-profile",
    async (_event, profileId: string, modelId?: string) =>
      saveModelSelection(profileId, modelId),
  );

  ipcMain.handle("forge:list-codex-models", async (_event, payload?: { cwd?: string }) => {
    const cwd = payload?.cwd || process.cwd();
    const cfg = loadConfig({ cwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_CODEX_MODELS, { cwd });
  });

  ipcMain.handle("forge:list-cursor-models", async (_event, payload?: { cwd?: string }) => {
    const cwd = payload?.cwd || process.cwd();
    const cfg = loadConfig({ cwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_CURSOR_MODELS, { cwd });
  });

  ipcMain.handle("forge:probe-cursor-runtime", async (_event, payload?: { cwd?: string }) => {
    const cwd = payload?.cwd || process.cwd();
    const cfg = loadConfig({ cwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.PROBE_CURSOR_RUNTIME, { cwd });
  });

  ipcMain.handle("forge:list-runtimes", async (_event, payload?: { cwd?: string }) => {
    const cwd = payload?.cwd || process.cwd();
    const cfg = loadConfig({ cwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_RUNTIMES, { cwd });
  });

  ipcMain.handle(
    "forge:close-acp-session",
    async (_event, payload: { provider?: string; sessionId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.CLOSE_ACP_SESSION, payload);
    },
  );

  ipcMain.handle(
    "forge:release-acp-forge-session",
    async (_event, payload: { sessionId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.RELEASE_ACP_FORGE_SESSION, payload);
    },
  );

  ipcMain.handle("forge:list-warm-acp-sessions", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_WARM_ACP_SESSIONS);
  });

  ipcMain.handle(
    "forge:prewarm-acp-session",
    async (
      _event,
      payload?: {
        provider?: string;
        cwd?: string;
        model?: string;
        mode?: string;
        sandboxMode?: string;
      },
    ) => {
      const cwd = payload?.cwd || process.cwd();
      const cfg = loadConfig({ cwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.PREWARM_ACP_SESSION, {
        provider: payload?.provider ?? "cursor",
        cwd,
        model: payload?.model,
        mode: payload?.mode,
        sandboxMode: payload?.sandboxMode,
      });
    },
  );

  ipcMain.handle(
    "forge:workspace-turn-diffs",
    async (_event, payload: { cwd: string; baseSha?: string }) => {
      const cwd = resolve(payload.cwd);
      const baseSha = String(payload.baseSha || "").trim();
      const args = gitDiffArgs(baseSha);
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn("git", args, { cwd, windowsHide: true });
        let out = "";
        let err = "";
        proc.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        proc.stderr.on("data", (chunk: Buffer) => {
          err += chunk.toString("utf8");
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code !== 0 && !out.trim()) {
            reject(new Error(err.trim() || `git ${args.join(" ")} failed (${code})`));
            return;
          }
          resolve(out);
        });
      });
      return { ok: true, files: parseUnifiedDiffByFile(stdout) };
    },
  );

  ipcMain.handle(
    "forge:read-workspace-file",
    async (_event, payload: { cwd: string; path: string }) => {
      const cwd = resolve(payload.cwd);
      const target = resolveRealWorkspaceFile(cwd, payload.path);
      if (!existsSync(target)) {
        throw new Error(`文件不存在: ${payload.path}`);
      }
      return { path: payload.path, content: readFileSync(target, "utf-8") };
    },
  );

  ipcMain.handle(
    "forge:read-workspace-image",
    async (_event, payload: { cwd: string; path: string }) => {
      const cwd = resolve(payload.cwd);
      const { target, extension } = resolveWorkspaceImageFile(
        cwd,
        payload.path,
        IMAGE_EXTENSIONS,
      );
      const mimeType = mimeFromExtension(extension);
      const buf = readFileSync(target);
      return {
        path: payload.path,
        mimeType,
        dataUrl: `data:${mimeType};base64,${buf.toString("base64")}`,
      };
    },
  );

  ipcMain.handle(
    "forge:list-workspace-dir",
    async (_event, payload: { cwd: string; path?: string }) => {
      const cwd = resolve(payload.cwd);
      const relPath = (payload.path ?? ".").replace(/\\/g, "/");
      const target = resolve(cwd, relPath === "." ? "" : relPath);
      const rel = relative(cwd, target);
      if (rel.startsWith("..") || rel === "..") {
        throw new Error("非法目录路径");
      }
      if (!existsSync(target)) {
        throw new Error(`目录不存在: ${relPath}`);
      }
      const entries = await readdir(target, { withFileTypes: true });
      const items: Array<{ name: string; path: string; type: "file" | "dir" }> = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        const childRel =
          relPath === "." || relPath === ""
            ? e.name
            : `${relPath}/${e.name}`.replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (WORKSPACE_IGNORE_DIRS.has(e.name)) continue;
          items.push({ name: e.name, path: childRel, type: "dir" });
        } else if (e.isFile()) {
          items.push({ name: e.name, path: childRel, type: "file" });
        }
      }
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        rootName: basename(cwd),
        path: relPath === "" ? "." : relPath,
        items,
      };
    },
  );

  ipcMain.handle("forge:pick-directory", async (event) => {
    const win =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
      null;
    const opts = {
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    "forge:list-sessions",
    async (_event, payload?: { limit?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_SESSIONS, {
        limit: payload?.limit ?? 80,
      });
    },
  );

  ipcMain.handle(
    "forge:get-session-messages",
    async (
      _event,
      payload: { sessionId: string; limit?: number; eventLimit?: number },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.GET_SESSION_MESSAGES, payload);
    },
  );

  ipcMain.handle("forge:list-skills", async (_event, cwd?: string) => {
    const resolvedCwd = cwd ?? process.cwd();
    const cfg = loadConfig({ cwd: resolvedCwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_SKILLS, { cwd: resolvedCwd });
  });

  ipcMain.handle("forge:list-talent-roster", async (_event, payload?: { cwd?: string }) => {
    const resolvedCwd = payload?.cwd ?? process.cwd();
    const cfg = loadConfig({ cwd: resolvedCwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_LIST_ROSTER, {
      cwd: resolvedCwd,
    });
  });

  ipcMain.handle(
    "forge:list-talent-templates",
    async (_event, payload?: { category?: string; query?: string; cwd?: string }) => {
      const resolvedCwd = payload?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_LIST_TEMPLATES, {
        category: payload?.category,
        query: payload?.query,
        cwd: resolvedCwd,
      });
    },
  );

  ipcMain.handle(
    "forge:hire-talent",
    async (
      _event,
      payload: { templateId: string; displayName?: string; mention?: string; cwd?: string },
    ) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      const result = await requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_HIRE, {
        ...payload,
        cwd: resolvedCwd,
      });
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle(
    "forge:fire-talent",
    async (_event, payload: { instanceIdOrMention: string; cwd?: string }) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      const result = await requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_FIRE, {
        instanceIdOrMention: payload.instanceIdOrMention,
        cwd: resolvedCwd,
      });
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle(
    "forge:sync-talents",
    async (_event, payload?: { categories?: string[]; sourceDir?: string }) => {
      const cfg = loadConfig({ cwd: process.cwd() });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_SYNC_TEMPLATES, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:rename-talent",
    async (
      _event,
      payload: {
        instanceIdOrMention: string;
        displayName?: string;
        mention?: string;
        cwd?: string;
      },
    ) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      const result = await requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_RENAME, {
        ...payload,
        cwd: resolvedCwd,
      });
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle(
    "forge:update-talent-bindings",
    async (
      _event,
      payload: {
        instanceIdOrMention: string;
        skills?: string[];
        tools?: string[];
        enabled?: boolean;
        strictSkills?: boolean;
        cwd?: string;
      },
    ) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      const result = await requestDaemonMethod(
        cfg,
        DAEMON_METHODS.TALENTS_UPDATE_BINDINGS,
        { ...payload, cwd: resolvedCwd },
      );
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle(
    "forge:get-talent-template",
    async (_event, payload: { templateId: string }) => {
      const cfg = loadConfig({ cwd: process.cwd() });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_GET_TEMPLATE, payload);
    },
  );

  ipcMain.handle(
    "forge:create-custom-talent",
    async (_event, payload: { talent: Record<string, unknown> }) => {
      const cfg = loadConfig({ cwd: process.cwd() });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_CREATE_CUSTOM, payload);
    },
  );

  ipcMain.handle(
    "forge:update-custom-talent",
    async (_event, payload: { templateId: string; patch: Record<string, unknown> }) => {
      const cfg = loadConfig({ cwd: process.cwd() });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_UPDATE_CUSTOM, payload);
    },
  );

  ipcMain.handle(
    "forge:delete-custom-talent",
    async (_event, payload: { templateId: string }) => {
      const cfg = loadConfig({ cwd: process.cwd() });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_DELETE_CUSTOM, payload);
    },
  );

  ipcMain.handle("forge:list-talent-teams", async (_event, payload?: { cwd?: string }) => {
    const resolvedCwd = payload?.cwd ?? process.cwd();
    const cfg = loadConfig({ cwd: resolvedCwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_LIST_TEAMS, { cwd: resolvedCwd });
  });

  ipcMain.handle(
    "forge:list-talent-agent-runs",
    async (_event, payload?: { cwd?: string; talentInstanceId?: string; limit?: number }) => {
      const resolvedCwd = payload?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_LIST_AGENT_RUNS, {
        ...payload,
        cwd: resolvedCwd,
      });
    },
  );

  ipcMain.handle(
    "forge:list-talent-agent-memory",
    async (_event, payload: { cwd?: string; talentInstanceId: string; limit?: number }) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_LIST_AGENT_MEMORY, {
        ...payload,
        cwd: resolvedCwd,
      });
    },
  );

  ipcMain.handle(
    "forge:create-talent-team",
    async (_event, payload: Record<string, unknown> & { cwd?: string }) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_CREATE_TEAM, {
        ...payload,
        cwd: resolvedCwd,
      });
    },
  );

  ipcMain.handle(
    "forge:delete-talent-team",
    async (_event, payload: { idOrMention: string; cwd?: string }) => {
      const resolvedCwd = payload.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.TALENTS_DELETE_TEAM, {
        ...payload,
        cwd: resolvedCwd,
      });
    },
  );

  ipcMain.handle("forge:open-external", async (_event, url: string) => {
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error("仅支持 http(s) 链接");
    }
    await shell.openExternal(target);
    return { ok: true };
  });

  // Session maintenance for the embedded browser panel (renderer/browser-panel.js).
  // Must match the <webview> partition attribute set there.
  ipcMain.handle(
    "forge:browser-clear-data",
    async (_event, payload: { kind: "cookies" | "cache" }) => {
      const ses = session.fromPartition("persist:forge-panel-browser");
      if (payload?.kind === "cache") {
        await ses.clearCache();
      } else if (payload?.kind === "cookies") {
        await ses.clearStorageData({ storages: ["cookies"] });
      } else {
        throw new Error(`未知的清理类型: ${String(payload?.kind ?? "")}`);
      }
      return { ok: true };
    },
  );

  ipcMain.handle("forge:reveal-path", async (_event, path: string) => {
    const target = resolve(String(path ?? "").trim());
    if (!target || !existsSync(target)) {
      throw new Error(`路径不存在: ${path ?? ""}`);
    }
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle("forge:read-skill-file", async (_event, payload: { path: string }) => {
    const target = resolve(String(payload?.path ?? ""));
    if (!target || !existsSync(target)) {
      throw new Error(`Skill 文件不存在: ${payload?.path ?? ""}`);
    }
    if (!statSync(target).isFile()) {
      throw new Error(`不是有效文件: ${payload?.path ?? ""}`);
    }
    return { path: payload.path, content: readFileSync(target, "utf-8") };
  });

  ipcMain.handle(
    "forge:list-skill-dir",
    async (_event, payload: { skillPath: string; path?: string }) => {
      const skillFile = resolve(String(payload?.skillPath ?? ""));
      const root = dirname(skillFile);
      if (!existsSync(root)) {
        throw new Error(`Skill 目录不存在: ${root}`);
      }
      const relPath = (payload.path ?? ".").replace(/\\/g, "/");
      const target = resolve(root, relPath === "." ? "" : relPath);
      const rel = relative(root, target);
      if (rel.startsWith("..") || rel === "..") {
        throw new Error("非法 Skill 目录路径");
      }
      if (!existsSync(target)) {
        throw new Error(`目录不存在: ${relPath}`);
      }
      const entries = await readdir(target, { withFileTypes: true });
      const items: Array<{ name: string; path: string; type: "file" | "dir" }> = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        const childRel =
          relPath === "." || relPath === ""
            ? e.name
            : `${relPath}/${e.name}`.replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (WORKSPACE_IGNORE_DIRS.has(e.name)) continue;
          items.push({ name: e.name, path: childRel, type: "dir" });
        } else if (e.isFile()) {
          items.push({ name: e.name, path: childRel, type: "file" });
        }
      }
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        rootName: basename(root),
        path: relPath === "" ? "." : relPath,
        items,
      };
    },
  );

  ipcMain.handle(
    "forge:list-plugin-dir",
    async (_event, payload: { pluginRoot: string; path?: string }) => {
      const root = resolve(String(payload?.pluginRoot ?? ""));
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new Error(`插件目录不存在: ${payload?.pluginRoot ?? ""}`);
      }
      const relPath = (payload.path ?? ".").replace(/\\/g, "/");
      const target = resolve(root, relPath === "." ? "" : relPath);
      const rel = relative(root, target);
      if (rel.startsWith("..") || rel === "..") {
        throw new Error("非法插件目录路径");
      }
      if (!existsSync(target)) {
        throw new Error(`目录不存在: ${relPath}`);
      }
      const entries = await readdir(target, { withFileTypes: true });
      const items: Array<{ name: string; path: string; type: "file" | "dir" }> = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        const childRel =
          relPath === "." || relPath === ""
            ? e.name
            : `${relPath}/${e.name}`.replace(/\\/g, "/");
        if (e.isDirectory()) {
          if (WORKSPACE_IGNORE_DIRS.has(e.name)) continue;
          items.push({ name: e.name, path: childRel, type: "dir" });
        } else if (e.isFile()) {
          items.push({ name: e.name, path: childRel, type: "file" });
        }
      }
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        rootName: basename(root),
        path: relPath === "" ? "." : relPath,
        items,
      };
    },
  );

  ipcMain.handle(
    "forge:compact-session",
    async (_event, payload: { sessionId: string; keepLast?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.COMPACT_SESSION, payload);
    },
  );

  ipcMain.handle("forge:list-plugins", async (_event, cwd?: string) => {
    const resolvedCwd = cwd ?? process.cwd();
    const cfg = loadConfig({ cwd: resolvedCwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_PLUGINS, { cwd: resolvedCwd });
  });

  ipcMain.handle(
    "forge:search-skills-marketplace",
    async (_event, payload?: { query?: string; mode?: string; limit?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.SEARCH_SKILLS_MARKETPLACE, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:search-plugins-marketplace",
    async (_event, payload?: { query?: string; mode?: string; limit?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.SEARCH_PLUGINS_MARKETPLACE, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:search-catalog",
    async (_event, payload?: { query?: string; kind?: "skill" | "plugin" }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.SEARCH_CATALOG, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:set-skill-enabled",
    async (
      _event,
      payload: { skillId: string; enabled: boolean; cwd?: string; project?: boolean },
    ) => {
      const cfg = loadConfig({ cwd: payload.cwd });
      await requestDaemonMethod(cfg, DAEMON_METHODS.SET_SKILL_ENABLED, payload);
      return requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
    },
  );

  ipcMain.handle(
    "forge:set-plugin-enabled",
    async (
      _event,
      payload: { pluginId: string; enabled: boolean; cwd?: string; project?: boolean },
    ) => {
      const cfg = loadConfig({ cwd: payload.cwd });
      await requestDaemonMethod(cfg, DAEMON_METHODS.SET_PLUGIN_ENABLED, payload);
      return requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
    },
  );

  ipcMain.handle(
    "forge:import-skill",
    async (
      _event,
      payload: { source?: string; catalogId?: string; force?: boolean },
    ) => {
      const cfg = loadConfig();
      const result = await requestDaemonMethod(cfg, DAEMON_METHODS.IMPORT_SKILL, payload);
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle(
    "forge:import-plugin",
    async (
      _event,
      payload: { source?: string; catalogId?: string; force?: boolean },
    ) => {
      const cfg = loadConfig();
      const result = await requestDaemonMethod(cfg, DAEMON_METHODS.IMPORT_PLUGIN, payload);
      await requestDaemonMethod(cfg, DAEMON_METHODS.RELOAD_RUNTIME, {});
      return result;
    },
  );

  ipcMain.handle("forge:hub-list", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_LIST, {});
  });

  ipcMain.handle("forge:hub-install", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_INSTALL, payload);
  });

  // Peek a local directory to guess whether it's a skill or plugin package, and
  // suggest an id (basename). Used by the "import local dir" flow so the renderer
  // doesn't need prompt() (unsupported in Electron).
  ipcMain.handle("forge:detect-extension", async (_event, dir: unknown) => {
    if (typeof dir !== "string" || !dir) return null;
    const has = (rel: string) => existsSync(join(dir, rel));
    const isPlugin =
      has("plugin.json") ||
      has(".cursor-plugin") ||
      has(".claude-plugin") ||
      has(".codex-plugin") ||
      has(".mcp.json") ||
      has("commands");
    const kind: "skill" | "plugin" = isPlugin ? "plugin" : "skill";
    return { kind, id: basename(dir) };
  });

  ipcMain.handle("forge:hub-deploy", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_DEPLOY, payload);
  });

  ipcMain.handle("forge:hub-undeploy", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_UNDEPLOY, payload);
  });

  ipcMain.handle("forge:hub-remove", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_REMOVE, payload);
  });

  ipcMain.handle("forge:hub-sync", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_SYNC, payload ?? {});
  });

  ipcMain.handle("forge:hub-discover", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_DISCOVER, payload ?? {});
  });

  ipcMain.handle("forge:hub-import", async (_event, payload: unknown) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.HUB_IMPORT, payload);
  });

  ipcMain.handle("forge:list-mcp", async (_event, cwd?: string) => {
    const resolvedCwd = cwd ?? process.cwd();
    const cfg = loadConfig({ cwd: resolvedCwd });
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_MCP, { cwd: resolvedCwd });
  });

  ipcMain.handle(
    "forge:list-automations",
    async (_event, payload?: { cwd?: string }) => {
      const resolvedCwd = payload?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_AUTOMATIONS, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:get-automation",
    async (_event, payload: { id: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.GET_AUTOMATION, payload);
    },
  );

  ipcMain.handle(
    "forge:create-automation",
    async (
      _event,
      payload: {
        draft: import("@forge/protocol").AutomationDraft;
        skipConfirm?: boolean;
      },
    ) => {
      const resolvedCwd = payload?.draft?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.CREATE_AUTOMATION, payload);
    },
  );

  ipcMain.handle(
    "forge:update-automation",
    async (
      _event,
      payload: {
        id: string;
        patch: Partial<import("@forge/protocol").AutomationDraft> & {
          enabled?: boolean;
        };
      },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.UPDATE_AUTOMATION, payload);
    },
  );

  ipcMain.handle(
    "forge:delete-automation",
    async (_event, payload: { id: string; skipConfirm?: boolean }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.DELETE_AUTOMATION, payload);
    },
  );

  ipcMain.handle(
    "forge:run-automation",
    async (
      _event,
      payload: {
        id: string;
        trigger?: import("@forge/protocol").AutomationRunTrigger;
        skipConfirm?: boolean;
      },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethodWithEvents(
        cfg,
        DAEMON_METHODS.RUN_AUTOMATION,
        payload,
      );
    },
  );

  ipcMain.handle(
    "forge:list-automation-runs",
    async (_event, payload: { automationId: string; limit?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_AUTOMATION_RUNS, payload);
    },
  );

  ipcMain.handle(
    "forge:parse-automation-draft",
    async (_event, payload: { message: string; cwd?: string }) => {
      const resolvedCwd = payload?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.PARSE_AUTOMATION_DRAFT, payload);
    },
  );

  ipcMain.handle("forge:list-automation-templates", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_AUTOMATION_TEMPLATES);
  });

  ipcMain.handle(
    "forge:list-channels",
    async (_event, payload?: { cwd?: string }) => {
      const resolvedCwd = payload?.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_CHANNELS, payload ?? {});
    },
  );

  ipcMain.handle("forge:get-channel", async (_event, payload: { id: string }) => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.GET_CHANNEL, payload);
  });

  ipcMain.handle(
    "forge:create-channel",
    async (
      _event,
      payload: {
        draft: {
          kind: string;
          name: string;
          description?: string;
          cwd?: string;
          enabled?: boolean;
          config?: Record<string, unknown>;
        };
        skipConfirm?: boolean;
      },
    ) => {
      const resolvedCwd = payload.draft.cwd ?? process.cwd();
      const cfg = loadConfig({ cwd: resolvedCwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.CREATE_CHANNEL, payload);
    },
  );

  ipcMain.handle(
    "forge:update-channel",
    async (
      _event,
      payload: {
        id: string;
        patch: {
          name?: string;
          description?: string;
          cwd?: string;
          enabled?: boolean;
          config?: Record<string, unknown>;
        };
      },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.UPDATE_CHANNEL, payload);
    },
  );

  ipcMain.handle(
    "forge:delete-channel",
    async (_event, payload: { id: string; skipConfirm?: boolean }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.DELETE_CHANNEL, payload);
    },
  );

  ipcMain.handle("forge:list-channel-kinds", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.LIST_CHANNEL_KINDS);
  });

  ipcMain.handle("forge:get-channel-gateway-status", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.GET_CHANNEL_GATEWAY_STATUS);
  });

  ipcMain.handle(
    "forge:start-channel-gateway",
    async (_event, payload?: { skipConfirm?: boolean }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.START_CHANNEL_GATEWAY, payload ?? {});
    },
  );

  ipcMain.handle("forge:stop-channel-gateway", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.STOP_CHANNEL_GATEWAY);
  });

  ipcMain.handle(
    "forge:mobile-create-pairing",
    async (
      _event,
      payload: { adapterId: string; deviceName?: string; skipConfirm?: boolean },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.MOBILE_CREATE_PAIRING, payload);
    },
  );

  ipcMain.handle(
    "forge:mobile-list-devices",
    async (_event, payload: { adapterId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.MOBILE_LIST_DEVICES, payload);
    },
  );

  ipcMain.handle(
    "forge:mobile-revoke-device",
    async (_event, payload: { adapterId: string; deviceId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.MOBILE_REVOKE_DEVICE, payload);
    },
  );

  ipcMain.handle(
    "forge:mobile-update-device-projects",
    async (
      _event,
      payload: { adapterId: string; deviceId: string; allowedProjects: string[] },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.MOBILE_UPDATE_DEVICE_PROJECTS, payload);
    },
  );

  ipcMain.handle(
    "forge:channel-start-login",
    async (_event, payload: { adapterId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.CHANNEL_START_LOGIN, payload);
    },
  );

  ipcMain.handle(
    "forge:channel-poll-login",
    async (_event, payload: { adapterId: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.CHANNEL_POLL_LOGIN, payload);
    },
  );

  ipcMain.handle("forge:pick-attachments", async (event) => {
    const win =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getFocusedWindow() ??
      mainWindow;
    const opts = {
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
      filters: [
        {
          name: "图片、Office、代码与文本",
          extensions: PICKER_EXTENSIONS,
        },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths.length) {
      return { items: [] as RunAttachment[] };
    }
    const items: RunAttachment[] = [];
    for (const p of result.filePaths) {
      try {
        const att = await readAttachmentFromPath(p);
        if (att) items.push(att);
      } catch (error) {
        console.warn("[forge] skip attachment", p, error);
      }
    }
    return { items };
  });

  ipcMain.handle("forge:read-attachment-paths", async (_event, paths: string[]) => {
    const items: RunAttachment[] = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      try {
        const att = await readAttachmentFromPath(String(p));
        if (att) items.push(att);
      } catch (error) {
        console.warn("[forge] skip attachment", p, error);
      }
    }
    return { items };
  });

  ipcMain.handle(
    "forge:extract-attachment-bytes",
    async (_event, payload: { name?: string; base64?: string }) => {
      const name = String(payload?.name ?? "file");
      const base64 = String(payload?.base64 ?? "");
      if (!base64) return { attachment: null as RunAttachment | null };
      const attachment = await readAttachmentFromBytes(name, base64);
      return { attachment };
    },
  );

  ipcMain.handle(
    "forge:run",
    async (
      _event,
      payload: {
        cwd: string;
        message: string;
        sessionId?: string | null;
        hookSource?: import("@forge/protocol").SessionHookSource;
        runtime?: import("@forge/protocol").RunRequest["runtime"];
        clientRunId?: string;
        autoApply?: boolean;
        files?: string[];
        attachments?: RunAttachment[];
      },
    ) => {
      const cfg = loadConfig({ cwd: payload.cwd });
      return requestDaemonMethodWithEvents(cfg, DAEMON_METHODS.RUN, {
        cwd: payload.cwd,
        message: payload.message,
        sessionId: payload.sessionId ?? null,
        hookSource: payload.hookSource,
        runtime: payload.runtime,
        clientRunId: payload.clientRunId,
        autoApply: Boolean(payload.autoApply),
        files: payload.files,
        attachments: payload.attachments,
      });
    },
  );

  ipcMain.handle(
    "forge:apply-patch",
    async (
      _event,
      payload: { cwd: string; path: string; unifiedDiff: string },
    ) => {
      const cfg = loadConfig({ cwd: payload.cwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.APPLY_PATCH, payload);
    },
  );

  ipcMain.handle(
    "forge:search-sessions",
    async (_event, payload: { query: string; limit?: number }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.SEARCH_SESSIONS, payload);
    },
  );

  ipcMain.handle(
    "forge:save-text-file",
    async (_event, payload: { defaultName: string; content: string }) => {
      const win = mainWindow ?? undefined;
      const res = win
        ? await dialog.showSaveDialog(win, {
            defaultPath: payload.defaultName,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          })
        : await dialog.showSaveDialog({
            defaultPath: payload.defaultName,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      await writeFile(res.filePath, payload.content, "utf-8");
      return { ok: true, path: res.filePath };
    },
  );

  ipcMain.handle(
    "forge:restore-checkpoint",
    async (
      _event,
      payload: {
        cwd: string;
        sha: string;
        sessionId?: string;
        turnIndex?: number;
        truncateConversation?: boolean;
      },
    ) => {
      const cfg = loadConfig({ cwd: payload.cwd });
      return requestDaemonMethod(cfg, DAEMON_METHODS.RESTORE_CHECKPOINT, payload);
    },
  );

  ipcMain.handle("forge:daemon-status", async () => {
    const cfg = loadConfig();
    return requestDaemonMethod(cfg, DAEMON_METHODS.STATUS);
  });

  ipcMain.handle(
    "forge:cancel-run",
    async (_event, payload?: { sessionId?: string }) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.CANCEL_RUN, payload ?? {});
    },
  );

  ipcMain.handle(
    "forge:respond-permission",
    async (
      _event,
      payload: { id: string; approved?: boolean; remember?: boolean; optionId?: string },
    ) => {
      const cfg = loadConfig();
      return requestDaemonMethod(cfg, DAEMON_METHODS.PERMISSION_RESPONSE, payload);
    },
  );
}

function createWindow(): BrowserWindow {
  mainWindow = null;
  const appIconPath = join(__dirname, "..", "src", "renderer", "assets", "forge-icon.png");
  if (process.platform === "darwin") {
    app.dock?.setIcon(appIconPath);
  }
  const win = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 480,
    minHeight: 520,
    title: "Forge 桌面端",
    icon: appIconPath,
    backgroundColor: "#121212",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      // sandbox:true breaks preload/ipc on some Electron builds when loading file:// UI
      sandbox: false,
      nodeIntegration: false,
      // Needed by the embedded browser panel (<webview> in the right region).
      webviewTag: true,
    },
  });
  const htmlPath = join(__dirname, "..", "src", "renderer", "index.html");
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  bindWebContentsLifecycle(win.webContents);
  void win.loadFile(htmlPath);
  mainWindow = win;
  return win;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDaemonLaunch(): {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  if (app.isPackaged) {
    const bundleRoot = join(process.resourcesPath, "daemon");
    const daemonPath = join(bundleRoot, "dist", "main.js");
    if (!existsSync(daemonPath)) {
      throw new Error(`Forge daemon entry missing: ${daemonPath}`);
    }
    return {
      executable: process.execPath,
      args: [daemonPath],
      cwd: bundleRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const daemonJs = new URL("../../daemon/dist/main.js", import.meta.url);
  const daemonPath = fileURLToPath(daemonJs);
  return {
    executable: resolveDevelopmentNodeExecutable(process.env),
    args: [daemonPath],
    cwd: dirname(dirname(daemonPath)),
    env: { ...process.env },
  };
}

async function spawnDaemonProcess(): Promise<void> {
  const { executable, args, cwd, env } = resolveDaemonLaunch();
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
      cwd,
      env,
    });
    child.once("error", (error) => {
      rejectSpawn(
        new Error(
          `[forge-desktop] failed to spawn daemon: ${String(error)} (exec=${executable}, cwd=${cwd})`,
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

async function waitForDaemonReady(cfg: ForgeConfig): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < DAEMON_PING_MAX_ATTEMPTS; i++) {
    try {
      const client = await connectDaemon(cfg.daemon.socketPath);
      await client.request(DAEMON_METHODS.PING);
      client.close();
      return;
    } catch (error) {
      lastError = error;
      await sleep(DAEMON_PING_INTERVAL_MS);
    }
  }
  throw new Error(
    `Forge daemon 未在 ${(DAEMON_PING_MAX_ATTEMPTS * DAEMON_PING_INTERVAL_MS) / 1000}s 内就绪: ${String(lastError)}`,
  );
}

async function pingDaemon(
  cfg: ForgeConfig,
): Promise<{ ok?: boolean; build?: string }> {
  const client = await connectDaemon(cfg.daemon.socketPath);
  try {
    return (await client.request(DAEMON_METHODS.PING)) as {
      ok?: boolean;
      build?: string;
    };
  } finally {
    client.close();
  }
}

// A restart can only ever produce the on-disk daemon build. If that build
// still differs from ours, the binary on disk is simply newer/older than this
// running app — restarting again would loop forever. So restart at most once
// per distinct observed build, then accept what's there.
let buildMismatchRestartedFor: string | null = null;
let developmentDaemonSynchronized = false;
let daemonEnsureInFlight: Promise<void> | null = null;

async function ensureDaemon(cfg: ForgeConfig): Promise<void> {
  if (daemonEnsureInFlight) return daemonEnsureInFlight;
  daemonEnsureInFlight = ensureDaemonOnce(cfg);
  try {
    await daemonEnsureInFlight;
  } finally {
    daemonEnsureInFlight = null;
  }
}

async function ensureDaemonOnce(cfg: ForgeConfig): Promise<void> {
  try {
    const pong = await pingDaemon(cfg);
    const observed = pong.build ?? "?";
    const replace = shouldReplaceConnectedDaemon({
      isPackaged: app.isPackaged,
      developmentDaemonSynchronized,
      observedBuild: observed,
      expectedBuild: FORGE_DAEMON_BUILD,
    });
    if (!replace) {
      buildMismatchRestartedFor = null;
      return;
    }
    if (!app.isPackaged && !developmentDaemonSynchronized) {
      console.log(
        "[forge-desktop] development startup: replacing the shared daemon with this checkout",
      );
      await restartDaemon(cfg);
      developmentDaemonSynchronized = true;
      buildMismatchRestartedFor = null;
      return;
    }
    if (buildMismatchRestartedFor === observed) {
      console.log(
        `[forge-desktop] daemon build ${observed} != ${FORGE_DAEMON_BUILD} after restart — accepting on-disk daemon (restart the app to sync)`,
      );
      return;
    }
    console.log(
      `[forge-desktop] daemon build ${observed} != ${FORGE_DAEMON_BUILD}, restarting once…`,
    );
    await restartDaemon(cfg);
    // Re-observe: if the fresh daemon still mismatches, remember it so the next
    // ensureDaemon call won't restart again.
    try {
      const after = await pingDaemon(cfg);
      buildMismatchRestartedFor =
        after.build && after.build !== FORGE_DAEMON_BUILD ? after.build : null;
    } catch {
      /* will be re-evaluated on the next ensureDaemon */
    }
    return;
  } catch {
    await spawnDaemonProcess();
    await waitForDaemonReady(cfg);
    if (!app.isPackaged) developmentDaemonSynchronized = true;
  }
}

async function restartDaemon(cfg: ForgeConfig): Promise<void> {
  killDaemonInDataDir(cfg.daemon.dataDir, cfg.daemon.socketPath);
  await waitForDaemonDisconnect(() => pingDaemon(cfg), sleep);
  await spawnDaemonProcess();
  await waitForDaemonReady(cfg);
  resetDaemonEventSubscriber();
  void ensureDaemonEventSubscriber(cfg);
}

function isUnknownMethodError(error: unknown, method: string): boolean {
  return String(error).includes(`Unknown method: ${method}`);
}

type ForgeDaemonClient = Awaited<ReturnType<typeof connectDaemon>>;

let daemonEventClient: ForgeDaemonClient | null = null;
let daemonEventSubscribeInFlight: Promise<void> | null = null;

async function ensureDaemonEventSubscriber(cfg?: ForgeConfig): Promise<void> {
  if (daemonEventClient) return;
  if (daemonEventSubscribeInFlight) return daemonEventSubscribeInFlight;
  const config = cfg ?? loadConfig();
  daemonEventSubscribeInFlight = (async () => {
    try {
      await ensureDaemon(config);
      const client = await connectDaemon(config.daemon.socketPath);
      daemonEventClient = client;
      client.onEvent((ev) => sendAgentEvent(ev));
      client.onClose(() => {
        daemonEventClient = null;
        setTimeout(() => {
          void ensureDaemonEventSubscriber(config);
        }, 800);
      });
      await client.request(DAEMON_METHODS.PING);
    } catch (error) {
      console.warn("[forge-desktop] daemon event subscriber:", error);
      setTimeout(() => {
        void ensureDaemonEventSubscriber(config);
      }, 2000);
    } finally {
      daemonEventSubscribeInFlight = null;
    }
  })();
  return daemonEventSubscribeInFlight;
}

function resetDaemonEventSubscriber(): void {
  try {
    daemonEventClient?.close();
  } catch {
    /* ignore */
  }
  daemonEventClient = null;
}

async function requestWithClient<T>(
  client: ForgeDaemonClient,
  method: string,
  params?: unknown,
  onEvent?: (ev: AgentEvent) => void,
): Promise<T> {
  if (onEvent) {
    return (await client.request(method, params, onEvent)) as T;
  }
  return (await client.request(method, params)) as T;
}

/** Restart daemon when an old process does not implement a newly added RPC method. */
async function requestDaemonMethod<T>(
  cfg: ForgeConfig,
  method: string,
  params?: unknown,
): Promise<T> {
  await ensureDaemon(cfg);
  const client = await connectDaemon(cfg.daemon.socketPath);
  try {
    return await requestWithClient<T>(client, method, params);
  } catch (error) {
    if (!isUnknownMethodError(error, method)) {
      throw error;
    }
    client.close();
    await restartDaemon(cfg);
    const retried = await connectDaemon(cfg.daemon.socketPath);
    try {
      return await requestWithClient<T>(retried, method, params);
    } finally {
      retried.close();
    }
  } finally {
    client.close();
  }
}

async function requestDaemonMethodWithEvents<T>(
  cfg: ForgeConfig,
  method: string,
  params: unknown,
): Promise<T> {
  await ensureDaemon(cfg);
  void ensureDaemonEventSubscriber(cfg);
  const client = await connectDaemon(cfg.daemon.socketPath);
  try {
    return await requestWithClient<T>(client, method, params, sendAgentEvent);
  } catch (error) {
    if (!isUnknownMethodError(error, method)) {
      throw error;
    }
    client.close();
    await restartDaemon(cfg);
    const retried = await connectDaemon(cfg.daemon.socketPath);
    try {
      return await requestWithClient<T>(retried, method, params, sendAgentEvent);
    } finally {
      retried.close();
    }
  } finally {
    client.close();
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  try {
    browserHost = await startBrowserHost(loadConfig().daemon.dataDir);
  } catch (error) {
    console.error("[forge-browser] failed to start browser host", error);
  }
  const win = createWindow();
  void ensureDaemonEventSubscriber(loadConfig());

  win.webContents.on("did-finish-load", () => {
    rendererReady = true;
    sendAgentEvent({
      type: "status",
      phase: "model",
      message: "Desktop ready",
      elapsedSec: 0,
    });
  });

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  });
});

// The embedded browser panel uses <webview>. Route window.open / target=_blank
// from those pages back into the same webview instead of spawning windows.
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void contents.loadURL(url);
    return { action: "deny" };
  });
});

app.on("window-all-closed", () => {
  disposeAllTerminals();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  disposeAllTerminals();
  void browserHost?.dispose();
  browserHost = null;
});
