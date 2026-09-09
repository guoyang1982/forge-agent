import { app, BrowserWindow } from "electron";
import { COMPANY_WINDOW_OPTIONS, resolveCompanyAssetPaths } from "./host.js";

function createWindow(): BrowserWindow {
  const assets = resolveCompanyAssetPaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const win = new BrowserWindow({
    width: COMPANY_WINDOW_OPTIONS.width,
    height: COMPANY_WINDOW_OPTIONS.height,
    minWidth: COMPANY_WINDOW_OPTIONS.minWidth,
    minHeight: COMPANY_WINDOW_OPTIONS.minHeight,
    title: COMPANY_WINDOW_OPTIONS.title,
    backgroundColor: COMPANY_WINDOW_OPTIONS.backgroundColor,
    webPreferences: {
      ...COMPANY_WINDOW_OPTIONS.webPreferences,
      preload: assets.preload,
    },
  });
  void win.loadFile(assets.html);
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
