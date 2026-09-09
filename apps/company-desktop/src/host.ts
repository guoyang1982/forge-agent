import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPANY_WINDOW_OPTIONS = {
  width: 1440,
  height: 920,
  minWidth: 1180,
  minHeight: 720,
  title: "Forge Company",
  backgroundColor: "#0a1513",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  },
} as const;

export function companyPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveCompanyAssetPaths(opts?: {
  packaged?: boolean;
  resourcesPath?: string;
}): { html: string; preload: string } {
  const root =
    opts?.packaged && opts.resourcesPath
      ? join(opts.resourcesPath, "company-desktop")
      : companyPackageRoot();
  return {
    html: join(root, "src", "renderer", "index.html"),
    preload: join(root, "dist", "preload.cjs"),
  };
}
