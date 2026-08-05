import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import {
  browserHostSocketPath,
  browserHostTokenPath,
  type BrowserBackend,
  type BrowserHostRequest,
  type BrowserHostResponse,
} from "@forge/browser-core";
import type {
  BrowserBackendCapabilities,
  BrowserElementActionInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserTypeInput,
} from "@forge/protocol";

const RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export class DesktopBrowserBackend implements BrowserBackend {
  readonly id = "iab";
  readonly label = "Forge Browser";
  readonly capabilities: BrowserBackendCapabilities = {
    existingTabs: true,
    persistentSession: true,
    domSnapshot: true,
    screenshot: true,
    downloads: false,
  };

  private readonly socketPath: string;
  private readonly tokenPath: string;

  constructor(dataDir: string) {
    this.socketPath = browserHostSocketPath(dataDir);
    this.tokenPath = browserHostTokenPath(dataDir);
  }

  isConnected(): boolean {
    if (!existsSync(this.tokenPath)) return false;
    return process.platform === "win32" || existsSync(this.socketPath);
  }

  listTabs(): Promise<BrowserTab[]> {
    return this.request("listTabs", {});
  }

  open(input: BrowserOpenInput): Promise<BrowserTab> {
    return this.request("open", input);
  }

  navigate(input: BrowserNavigateInput): Promise<BrowserTab> {
    return this.request("navigate", input);
  }

  snapshot(tabId: string): Promise<BrowserSnapshot> {
    return this.request("snapshot", { tabId });
  }

  click(input: BrowserElementActionInput): Promise<void> {
    return this.request("click", input);
  }

  type(input: BrowserTypeInput): Promise<void> {
    return this.request("type", input);
  }

  screenshot(tabId: string): Promise<BrowserScreenshot> {
    return this.request("screenshot", { tabId });
  }

  close(tabId: string): Promise<void> {
    return this.request("close", { tabId });
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let token: string;
      try {
        token = readFileSync(this.tokenPath, "utf8").trim();
      } catch (error) {
        reject(new Error(`Forge Browser host is unavailable: ${String(error)}`));
        return;
      }

      const request: BrowserHostRequest = {
        id: randomUUID(),
        token,
        method,
        params,
      };
      const socket = createConnection(this.socketPath);
      let settled = false;
      let response = "";
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => finish(new Error(`Forge Browser request timed out: ${method}`)),
        REQUEST_TIMEOUT_MS,
      );

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        response += chunk;
        if (Buffer.byteLength(response) > RESPONSE_LIMIT_BYTES) {
          finish(new Error("Forge Browser response exceeded the size limit"));
          return;
        }
        const newline = response.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(response.slice(0, newline)) as BrowserHostResponse;
          if (parsed.id !== request.id) throw new Error("Mismatched Browser response id");
          if (parsed.error) throw new Error(parsed.error);
          finish(undefined, parsed.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        if (!settled) finish(new Error("Forge Browser host closed the connection without a response"));
      });
    });
  }
}
