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
  const selector = "a[href],button,input,textarea,select,img,[role],[contenteditable='true'],[tabindex]";
  const elements = [];
  for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 1000)) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
    const tag = element.tagName.toLowerCase();
    if (tag === "img" && (rect.width < 80 || rect.height < 80)) continue;
    let ref = element.getAttribute(attribute);
    if (!ref) {
      ref = "e" + nextRef++;
      element.setAttribute(attribute, ref);
    }
    const explicitRole = element.getAttribute("role");
    const editable = element.isContentEditable;
    const role = explicitRole || (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" || editable ? "textbox" : tag === "input" ? ((element.getAttribute("type") || "text") === "checkbox" ? "checkbox" : "textbox") : tag === "img" ? "img" : undefined);
    const rawName = element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("data-placeholder") || element.getAttribute("alt") || element.getAttribute("title") || element.innerText || element.textContent || "";
    const value = "value" in element ? String(element.value || "") : undefined;
    const href = tag === "a" ? String(element.href || "") : "";
    elements.push({
      ref,
      role,
      name: rawName.trim().replace(/\\s+/g, " ").slice(0, 300) || undefined,
      value: value ? value.slice(0, 1000) : undefined,
      href: /^https?:\/\//i.test(href) ? href : undefined,
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

async function clickAccessibleText(win: BrowserWindow, text: string): Promise<boolean> {
  const debugger_ = win.webContents.debugger;
  const attachedHere = !debugger_.isAttached();
  if (attachedHere) debugger_.attach("1.3");
  try {
    const tree = await debugger_.sendCommand("Accessibility.getFullAXTree") as {
      nodes?: Array<{ role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number }>;
    };
    const named = (tree.nodes ?? []).filter((node) => (node.name?.value ?? "").replace(/\s+/g, " ").trim() === text && node.backendDOMNodeId);
    const node = named.find((item) => item.role?.value === "button") ?? named[0];
    if (!node?.backendDOMNodeId) return false;
    const quads = await debugger_.sendCommand("DOM.getContentQuads", { backendNodeId: node.backendDOMNodeId }) as {
      quads?: number[][];
    };
    const quad = quads.quads?.[0];
    if (!quad || quad.length < 8) return false;
    const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
    const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return true;
  } catch {
    return false;
  } finally {
    if (attachedHere && debugger_.isAttached()) debugger_.detach();
  }
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

  async clickText(tabId: string, text: string): Promise<void> {
    if (!/^[\u4e00-\u9fa5A-Za-z0-9]{1,12}$/.test(text)) {
      throw new Error("Browser click text is not allowed");
    }
    const win = this.requireWindow(tabId);
    const wanted = JSON.stringify(text);
    const target = await win.webContents.executeJavaScript(String.raw`(() => {
      const wanted = ${wanted};
      const seen = new Set();
      const candidates = [];
      const collect = (root) => {
        if (!root || seen.has(root) || !root.querySelectorAll) return;
        seen.add(root);
        for (const element of root.querySelectorAll("button,a,[role='button'],div,span")) candidates.push(element);
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) collect(element.shadowRoot);
        }
        for (const frame of root.querySelectorAll("iframe")) {
          try { collect(frame.contentDocument); } catch (error) {}
        }
      };
      collect(document);
      const matches = candidates.filter((element) => {
        const label = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
        if (label !== wanted) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      matches.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
      });
      let element = matches[0];
      if (!element) return null;
      let current = element;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (style.cursor === "pointer" || current.tagName === "BUTTON" || current.getAttribute("role") === "button") {
          element = current;
          break;
        }
        const root = current.getRootNode();
        current = current.parentElement || (root && root.host) || null;
      }
      const style = getComputedStyle(element);
      if (element.getAttribute("aria-disabled") === "true" || style.pointerEvents === "none") return { disabled: true };
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      element.click();
      return {
        disabled: false,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`, true) as { disabled: boolean; x: number; y: number } | null;
    if (!target) {
      const clicked = await clickAccessibleText(win, text);
      if (!clicked) throw new Error(`Browser element not found: ${text}. Take a new snapshot and retry.`);
      return;
    }
    if (target.disabled) throw new Error(`Browser element is disabled: ${text}`);
    win.show();
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
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
      case "clickText": result = await controller.clickText(String(params.tabId), String(params.text ?? "")); break;
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
