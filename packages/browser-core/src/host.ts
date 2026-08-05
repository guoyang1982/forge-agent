import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export const BROWSER_HOST_TOKEN_FILE = "browser-host.token";
export const BROWSER_HOST_SOCKET_FILE = "browser-host.sock";

export function browserHostTokenPath(dataDir: string): string {
  return join(resolve(dataDir), BROWSER_HOST_TOKEN_FILE);
}

export function browserHostSocketPath(dataDir: string): string {
  const absoluteDataDir = resolve(dataDir);
  if (process.platform === "win32") {
    const suffix = createHash("sha256").update(absoluteDataDir).digest("hex").slice(0, 20);
    return `\\\\.\\pipe\\forge-browser-${suffix}`;
  }
  return join(absoluteDataDir, BROWSER_HOST_SOCKET_FILE);
}

export interface BrowserHostRequest {
  id: string;
  token: string;
  method: string;
  params?: unknown;
}

export interface BrowserHostResponse {
  id: string;
  result?: unknown;
  error?: string;
}
