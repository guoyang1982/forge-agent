import { BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { COMPANY_WINDOW_OPTIONS, resolveCompanyAssetPaths } from "@forge/company-desktop";
import { routeForgeDeepLink } from "./product-shell-menu.js";

let companyWindow: BrowserWindow | null = null;

export type ProductShellDeps = {
  getWorkbenchWindow: () => BrowserWindow | null;
  createWorkbenchWindow: () => BrowserWindow;
  isPackaged: boolean;
  resourcesPath: string;
};

export function installProductShell(deps: ProductShellDeps): void {
  const focusWorkbench = () => {
    const win = deps.getWorkbenchWindow() ?? deps.createWorkbenchWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const openCompanyWindow = () => {
    if (companyWindow && !companyWindow.isDestroyed()) {
      if (companyWindow.isMinimized()) companyWindow.restore();
      companyWindow.show();
      companyWindow.focus();
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
    void win.loadFile(assets.html);
    companyWindow = win;
  };

  ipcMain.removeHandler("company:open-workbench");
  ipcMain.removeHandler("company:get-app-info");
  ipcMain.handle("company:open-workbench", (_event, url?: unknown) => {
    if (typeof url === "string" && url.length > 0) {
      if (routeForgeDeepLink(url) !== "workbench") {
        throw new Error("invalid deep link");
      }
    }
    focusWorkbench();
    return { ok: true };
  });
  ipcMain.handle("company:get-app-info", () => ({
    name: "Forge Company",
    product: "company",
  }));

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
