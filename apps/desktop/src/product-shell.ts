import { BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { COMPANY_WINDOW_OPTIONS, resolveCompanyAssetPaths } from "@forge/company-desktop";
import { parseForgeDeepLink } from "@forge/forge-links";
import { DAEMON_COMPANY_METHODS } from "@forge/protocol";
import { routeForgeDeepLink } from "./product-shell-menu.js";

let companyWindow: BrowserWindow | null = null;

export type ProductShellDeps = {
  getWorkbenchWindow: () => BrowserWindow | null;
  createWorkbenchWindow: () => BrowserWindow;
  isPackaged: boolean;
  resourcesPath: string;
  requestDaemonMethod: (method: string, params?: unknown) => Promise<unknown>;
};

export function assertCompanyInvokeMethod(method: unknown): string {
  if (
    typeof method !== "string" ||
    !Object.values(DAEMON_COMPANY_METHODS).includes(method as never)
  ) {
    throw new Error(`blocked method: ${String(method)}`);
  }
  return method;
}

export function installProductShell(deps: ProductShellDeps): void {
  const openCompanyWindow = (url?: string) => {
    const workItemId = companyWorkItemIdFromLink(url);
    const reveal = (win: BrowserWindow) => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (workItemId) {
        win.webContents.send("company:open-work", { workItemId });
      }
    };

    if (companyWindow && !companyWindow.isDestroyed()) {
      reveal(companyWindow);
      return;
    }

    const assets = resolveCompanyAssetPaths({
      packaged: deps.isPackaged,
      resourcesPath: deps.resourcesPath,
    });
    if (!existsSync(assets.html) || !existsSync(assets.preload)) {
      console.error("[forge-desktop] Company assets missing", assets);
      return;
    }

    const win = new BrowserWindow({
      width: COMPANY_WINDOW_OPTIONS.width,
      height: COMPANY_WINDOW_OPTIONS.height,
      minWidth: COMPANY_WINDOW_OPTIONS.minWidth,
      minHeight: COMPANY_WINDOW_OPTIONS.minHeight,
      title: COMPANY_WINDOW_OPTIONS.title,
      backgroundColor: COMPANY_WINDOW_OPTIONS.backgroundColor,
      webPreferences: {
        contextIsolation: COMPANY_WINDOW_OPTIONS.webPreferences.contextIsolation,
        nodeIntegration: COMPANY_WINDOW_OPTIONS.webPreferences.nodeIntegration,
        sandbox: COMPANY_WINDOW_OPTIONS.webPreferences.sandbox,
        preload: assets.preload,
      },
    });
    win.on("closed", () => {
      if (companyWindow === win) companyWindow = null;
    });
    const query = workItemId ? { work: workItemId } : undefined;
    void win.loadFile(assets.html, query ? { query } : {}).then(() => {
      if (workItemId) win.webContents.send("company:open-work", { workItemId });
    });
    companyWindow = win;
  };

  const focusWorkbench = (payload?: {
    runId?: string;
    sessionId?: string;
    workItemId?: string;
    cwd?: string;
  }) => {
    const win = deps.getWorkbenchWindow() ?? deps.createWorkbenchWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (payload?.runId || payload?.sessionId || payload?.workItemId || payload?.cwd) {
      win.webContents.send("forge:open-run", payload);
    }
  };

  ipcMain.removeHandler("company:open-workbench");
  ipcMain.removeHandler("company:get-app-info");
  ipcMain.removeHandler("company:invoke");
  ipcMain.removeHandler("forge:open-company");
  ipcMain.handle("company:open-workbench", (_event, url?: unknown, extras?: unknown) => {
    if (typeof url === "string" && url.length > 0) {
      if (routeForgeDeepLink(url) !== "workbench") {
        throw new Error("invalid deep link");
      }
    }
    focusWorkbench({
      ...readOpenWorkbenchExtras(extras),
      ...workbenchTargetFromLink(typeof url === "string" ? url : undefined),
    });
    return { ok: true };
  });
  ipcMain.handle("forge:open-company", (_event, url?: unknown) => {
    if (typeof url !== "string" || routeForgeDeepLink(url) !== "company") {
      throw new Error("invalid deep link");
    }
    openCompanyWindow(url);
    return { ok: true };
  });
  ipcMain.handle("company:get-app-info", () => ({
    name: "Forge Company",
    product: "company",
  }));
  ipcMain.handle("company:invoke", (_event, method, params) => {
    const allowed = assertCompanyInvokeMethod(method);
    return deps.requestDaemonMethod(allowed, params);
  });

  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "窗口",
      submenu: [
        {
          label: "工作台",
          accelerator: "CmdOrCtrl+1",
          click: () => focusWorkbench(),
        },
        {
          label: "公司",
          accelerator: "CmdOrCtrl+2",
          click: () => openCompanyWindow(),
        },
        { type: "separator" },
        { role: "minimize" },
        ...(isMac ? [{ role: "front" as const }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function companyWorkItemIdFromLink(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const link = parseForgeDeepLink(url);
    return link.app === "company" && link.kind === "work" ? link.id : undefined;
  } catch {
    return undefined;
  }
}

function workbenchTargetFromLink(url?: string): { runId?: string; sessionId?: string } {
  if (!url) return {};
  try {
    const link = parseForgeDeepLink(url);
    if (link.app !== "workbench") return {};
    return link.kind === "session" ? { sessionId: link.id } : { runId: link.id };
  } catch {
    return {};
  }
}

function readOpenWorkbenchExtras(extras: unknown): {
  workItemId?: string;
  sessionId?: string;
  cwd?: string;
} {
  if (!extras || typeof extras !== "object") return {};
  const rec = extras as { workItemId?: unknown; sessionId?: unknown; cwd?: unknown };
  const workItemId = typeof rec.workItemId === "string" ? rec.workItemId.trim() : "";
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId.trim() : "";
  const cwd = typeof rec.cwd === "string" ? rec.cwd.trim() : "";
  return {
    ...(workItemId ? { workItemId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}
