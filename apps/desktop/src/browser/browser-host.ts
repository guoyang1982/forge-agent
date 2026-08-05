import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { BrowserWindow } from "electron";
import {
  browserHostSocketPath,
  browserHostTokenPath,
  type BrowserHostRequest,
  type BrowserHostResponse,
} from "@forge/browser-core";
import type {
  BrowserElementActionInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserTypeInput,
} from "@forge/protocol";

const REQUEST_LIMIT_BYTES = 256 * 1024;
const SNAPSHOT_SCRIPT = String.raw`(() => {
  const attribute = "data-forge-browser-ref";
  let nextRef = Number(document.documentElement.getAttribute("data-forge-browser-next-ref") || "1");
  const selector = "a[href],button,input,textarea,select,[role],[contenteditable='true'],[tabindex]";
  const elements = [];
  for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 1000)) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
    let ref = element.getAttribute(attribute);
    if (!ref) {
      ref = "e" + nextRef++;
      element.setAttribute(attribute, ref);
    }
    const tag = element.tagName.toLowerCase();
    const explicitRole = element.getAttribute("role");
    const role = explicitRole || (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox" : tag === "input" ? ((element.getAttribute("type") || "text") === "checkbox" ? "checkbox" : "textbox") : undefined);
    const rawName = element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("title") || element.innerText || element.textContent || "";
    const value = "value" in element ? String(element.value || "") : undefined;
    elements.push({
      ref,
      role,
      name: rawName.trim().replace(/\\s+/g, " ").slice(0, 300) || undefined,
      value: value ? value.slice(0, 1000) : undefined,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true") || undefined,
    });
    if (elements.length >= 500) break;
  }
  document.documentElement.setAttribute("data-forge-browser-next-ref", String(nextRef));
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || "").slice(0, 50000),
    elements,
  };
})()`;

function validateWebUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Forge Browser only supports HTTP(S) URLs: ${raw}`);
  }
  return parsed.href;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class ForgeBrowserController {
  private readonly windows = new Map<string, BrowserWindow>();
  private nextTabId = 1;

  listTabs(): BrowserTab[] {
    return [...this.windows].map(([id, win]) => this.tab(id, win));
  }

  async open(input: BrowserOpenInput): Promise<BrowserTab> {
    const id = `iab-${this.nextTabId++}`;
    const win = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 640,
      minHeight: 480,
      show: true,
      title: "Forge Browser",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:forge-browser",
      },
    });
    this.windows.set(id, win);
    win.on("closed", () => this.windows.delete(id));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      try {
        validateWebUrl(url);
      } catch {
        event.preventDefault();
      }
    });

    try {
      if (input.url) await win.loadURL(validateWebUrl(input.url));
      else await win.loadURL("about:blank");
      win.focus();
      return this.tab(id, win);
    } catch (error) {
      win.destroy();
      throw error;
    }
  }

  async navigate(input: BrowserNavigateInput): Promise<BrowserTab> {
    const win = this.requireWindow(input.tabId);
    await win.loadURL(validateWebUrl(input.url));
    win.show();
    win.focus();
    return this.tab(input.tabId, win);
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    const win = this.requireWindow(tabId);
    const result = await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true) as Omit<BrowserSnapshot, "tabId" | "backendId">;
    return { tabId, backendId: "iab", ...result };
  }

  async click(input: BrowserElementActionInput): Promise<void> {
    const win = this.requireWindow(input.tabId);
    const ref = JSON.stringify(input.ref);
    const clicked = await win.webContents.executeJavaScript(String.raw`(() => {
      const element = document.querySelector("[data-forge-browser-ref=" + CSS.escape(${ref}) + "]");
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    })()`, true);
    if (!clicked) throw new Error(`Browser element not found: ${input.ref}. Take a new snapshot and retry.`);
  }

  async type(input: BrowserTypeInput): Promise<void> {
    const win = this.requireWindow(input.tabId);
    const ref = JSON.stringify(input.ref);
    const clear = input.clear !== false;
    const focused = await win.webContents.executeJavaScript(String.raw`(() => {
      const element = document.querySelector("[data-forge-browser-ref=" + CSS.escape(${ref}) + "]");
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      if (${JSON.stringify(clear)}) {
        if ("value" in element) element.value = "";
        else if (element.isContentEditable) element.textContent = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return true;
    })()`, true);
    if (!focused) throw new Error(`Browser element not found: ${input.ref}. Take a new snapshot and retry.`);
    await win.webContents.insertText(input.text);
  }

  async screenshot(tabId: string): Promise<BrowserScreenshot> {
    const win = this.requireWindow(tabId);
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    return {
      tabId,
      backendId: "iab",
      mime: "image/png",
      data: image.toPNG().toString("base64"),
      width: size.width,
      height: size.height,
    };
  }

  close(tabId: string): void {
    this.requireWindow(tabId).close();
  }

  dispose(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }

  private requireWindow(tabId: string): BrowserWindow {
    const win = this.windows.get(tabId);
    if (!win || win.isDestroyed()) throw new Error(`Forge Browser tab not found: ${tabId}`);
    return win;
  }

  private tab(id: string, win: BrowserWindow): BrowserTab {
    return {
      id,
      backendId: "iab",
      title: win.webContents.getTitle() || "Forge Browser",
      url: win.webContents.getURL() || "about:blank",
      active: win.isFocused(),
    };
  }
}

export interface BrowserHostHandle {
  dispose(): Promise<void>;
}

export async function startBrowserHost(dataDir: string): Promise<BrowserHostHandle> {
  const socketPath = browserHostSocketPath(dataDir);
  const tokenPath = browserHostTokenPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  if (process.platform !== "win32" && existsSync(socketPath)) await unlink(socketPath);

  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  const controller = new ForgeBrowserController();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleSocket(socket, token, controller);
  });
  await listen(server, socketPath);
  if (process.platform !== "win32") await chmod(socketPath, 0o600);

  return {
    async dispose() {
      controller.dispose();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await unlink(tokenPath).catch(() => undefined);
      if (process.platform !== "win32") await unlink(socketPath).catch(() => undefined);
    },
  };
}

function handleSocket(socket: Socket, token: string, controller: ForgeBrowserController): void {
  socket.setEncoding("utf8");
  let body = "";
  socket.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body) > REQUEST_LIMIT_BYTES) {
      socket.destroy(new Error("Browser host request exceeded the size limit"));
      return;
    }
    const newline = body.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    void respond(socket, token, controller, body.slice(0, newline));
  });
}

async function respond(socket: Socket, token: string, controller: ForgeBrowserController, raw: string): Promise<void> {
  let id = "unknown";
  try {
    const request = JSON.parse(raw) as BrowserHostRequest;
    id = request.id;
    if (!request.id || !request.method || !safeEqual(request.token ?? "", token)) {
      throw new Error("Unauthorized Forge Browser request");
    }
    const params = (request.params ?? {}) as Record<string, unknown>;
    let result: unknown;
    switch (request.method) {
      case "listTabs": result = controller.listTabs(); break;
      case "open": result = await controller.open(params as BrowserOpenInput); break;
      case "navigate": result = await controller.navigate(params as unknown as BrowserNavigateInput); break;
      case "snapshot": result = await controller.snapshot(String(params.tabId)); break;
      case "click": result = await controller.click(params as unknown as BrowserElementActionInput); break;
      case "type": result = await controller.type(params as unknown as BrowserTypeInput); break;
      case "screenshot": result = await controller.screenshot(String(params.tabId)); break;
      case "close": result = controller.close(String(params.tabId)); break;
      default: throw new Error(`Unknown Forge Browser method: ${request.method}`);
    }
    writeResponse(socket, { id, result });
  } catch (error) {
    writeResponse(socket, { id, error: error instanceof Error ? error.message : String(error) });
  }
}

function writeResponse(socket: Socket, response: BrowserHostResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
