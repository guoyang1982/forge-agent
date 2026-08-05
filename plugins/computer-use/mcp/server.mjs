#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingServerRequests = new Map();
let nextServerRequestId = 1;

const tools = [
  {
    name: "list_apps",
    description: "List visible macOS applications that Forge Computer Use can target.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_app",
    description: "Open or activate a named macOS application. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", description: "Application name, for example Safari or Notes." } },
      required: ["app"],
    },
  },
  {
    name: "get_app_state",
    description: "Get the target application's front-window title and screen bounds, and return a PNG capture of that app window. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Exact application name returned by list_apps." },
        include_screenshot: { type: "boolean", description: "Return a PNG of the front app window. Defaults to true." },
      },
      required: ["app"],
    },
  },
  {
    name: "click",
    description: "Click a screen coordinate in a target macOS application. Take a fresh get_app_state first. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        x: { type: "number", description: "Absolute screen X coordinate." },
        y: { type: "number", description: "Absolute screen Y coordinate." },
      },
      required: ["app", "x", "y"],
    },
  },
  {
    name: "type",
    description: "Type text into the focused control of a target macOS application. Optionally replaces the current value. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", description: "Select all before typing. Defaults to false." },
      },
      required: ["app", "text"],
    },
  },
  {
    name: "press_key",
    description: "Press a supported key in a target macOS application, with optional modifiers. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        key: { type: "string", enum: ["enter", "tab", "escape", "delete", "space", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"] },
        modifiers: { type: "array", items: { type: "string", enum: ["command", "control", "option", "shift"] } },
      },
      required: ["app", "key"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the focused target application vertically using repeated arrow or page keys. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "integer", minimum: 1, maximum: 20, description: "Number of scroll steps. Defaults to 3." },
      },
      required: ["app", "direction"],
    },
  },
];

const LIST_APPS_JXA = String.raw`function run() {
  const se = Application("System Events");
  const apps = se.applicationProcesses.whose({ backgroundOnly: false })();
  return JSON.stringify(apps.map((app) => {
    try { return { name: app.name(), pid: app.unixId(), active: Boolean(app.frontmost()) }; }
    catch (_) { return null; }
  }).filter(Boolean));
}`;

const APP_STATE_JXA = String.raw`function run(argv) {
  const query = String(argv[0] || "").toLowerCase();
  const se = Application("System Events");
  const apps = se.applicationProcesses.whose({ backgroundOnly: false })();
  const app = apps.find((item) => {
    try { return String(item.name()).toLowerCase() === query; } catch (_) { return false; }
  });
  if (!app) throw new Error("Application is not running: " + argv[0]);
  app.frontmost = true;
  delay(0.15);
  const windows = app.windows().map((win, index) => {
    let position = [0, 0], size = [0, 0], title = "";
    try { position = win.position(); } catch (_) {}
    try { size = win.size(); } catch (_) {}
    try { title = win.name(); } catch (_) {}
    return { index, title: String(title || ""), x: Number(position[0] || 0), y: Number(position[1] || 0), width: Number(size[0] || 0), height: Number(size[1] || 0) };
  });
  return JSON.stringify({ app: app.name(), pid: app.unixId(), active: Boolean(app.frontmost()), windows });
}`;

const CLICK_APPLESCRIPT = String.raw`on run argv
  set appName to item 1 of argv
  set clickX to item 2 of argv as integer
  set clickY to item 3 of argv as integer
  tell application "System Events"
    set frontmost of first application process whose name is appName to true
    delay 0.15
    click at {clickX, clickY}
  end tell
end run`;

const TYPE_APPLESCRIPT = String.raw`on run argv
  set appName to item 1 of argv
  set inputText to item 2 of argv
  set shouldClear to item 3 of argv is "true"
  tell application "System Events"
    set frontmost of first application process whose name is appName to true
    delay 0.15
    if shouldClear then keystroke "a" using command down
    keystroke inputText
  end tell
end run`;

const KEY_CODES = {
  enter: 36, tab: 48, escape: 53, delete: 51, space: 49,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};
const MODIFIERS = {
  command: "command down", control: "control down", option: "option down", shift: "shift down",
};

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textContent(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function requiredString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

async function osascript(language, source, args = []) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", language, "-e", source, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const detail = `${error?.stderr || ""} ${error?.message || error}`;
    if (detail.includes("-25211") || detail.includes("辅助访问")) {
      throw new Error("macOS Accessibility permission is missing. In System Settings → Privacy & Security → Accessibility, enable Forge (and the launching terminal during development), then retry.");
    }
    throw error;
  }
}

async function askApproval(message, subtitle) {
  const id = `forge-computer-use-${nextServerRequestId++}`;
  const decision = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingServerRequests.delete(id);
      reject(new Error("Computer Use approval timed out"));
    }, 180_000);
    pendingServerRequests.set(id, { resolve, reject, timer });
  });
  write({
    jsonrpc: "2.0",
    id,
    method: "elicitation/create",
    params: {
      message,
      requestedSchema: { type: "object", properties: {} },
      _meta: { subtitle, riskLevel: "high", persist: ["session"] },
    },
  });
  const response = await decision;
  if (response?.action !== "accept") throw new Error("User declined Computer Use access");
}

async function listApps() {
  const apps = JSON.parse(await osascript("JavaScript", LIST_APPS_JXA));
  return [...new Map(apps.map((app) => [app.pid, app])).values()];
}

async function getAppState(appName, includeScreenshot) {
  await askApproval(`允许 Forge 读取并截图“${appName}”吗？`, "Computer Use 将读取目标应用窗口；不会截取整个桌面。 ");
  const state = JSON.parse(await osascript("JavaScript", APP_STATE_JXA, [appName]));
  const result = { ...state, screenshotScope: "front-window" };
  if (!includeScreenshot) return textContent(result);
  const front = state.windows?.find((window) => window.width > 0 && window.height > 0);
  if (!front) return textContent({ ...result, screenshotError: "The application has no capturable front window." });

  const dir = await mkdtemp(join(tmpdir(), "forge-computer-use-"));
  const path = join(dir, "app.png");
  try {
    await execFileAsync("/usr/sbin/screencapture", ["-x", `-R${front.x},${front.y},${front.width},${front.height}`, path]);
    const image = await readFile(path);
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
        { type: "image", mimeType: "image/png", data: image.toString("base64") },
      ],
    };
  } catch (error) {
    return textContent({ ...result, screenshotError: `Screen Recording permission may be missing: ${error.message}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pressKey(appName, key, modifiers = []) {
  const code = KEY_CODES[key];
  if (code === undefined) throw new Error(`Unsupported key: ${key}`);
  const normalized = [...new Set(modifiers)].map((modifier) => MODIFIERS[modifier]).filter(Boolean);
  const using = normalized.length ? ` using {${normalized.join(", ")}}` : "";
  const source = `on run argv\nset appName to item 1 of argv\ntell application "System Events"\nset frontmost of first application process whose name is appName to true\ndelay 0.1\nkey code ${code}${using}\nend tell\nend run`;
  await osascript("AppleScript", source, [appName]);
}

async function callTool(name, args) {
  if (process.platform !== "darwin") throw new Error("Forge Computer Use currently supports macOS only");
  switch (name) {
    case "list_apps":
      return textContent({ apps: await listApps() });
    case "open_app": {
      const app = requiredString(args, "app");
      await askApproval(`允许 Forge 打开“${app}”吗？`, "Computer Use 将启动或激活应用。");
      await execFileAsync("/usr/bin/open", ["-a", app]);
      return textContent({ ok: true, app });
    }
    case "get_app_state":
      return getAppState(requiredString(args, "app"), args.include_screenshot !== false);
    case "click": {
      const app = requiredString(args, "app");
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be finite screen coordinates");
      await askApproval(`允许 Forge 在“${app}”中点击 (${Math.round(x)}, ${Math.round(y)}) 吗？`, "Computer Use 即将执行鼠标操作。");
      await osascript("AppleScript", CLICK_APPLESCRIPT, [app, String(Math.round(x)), String(Math.round(y))]);
      return textContent({ ok: true, app, x: Math.round(x), y: Math.round(y) });
    }
    case "type": {
      const app = requiredString(args, "app");
      const text = typeof args.text === "string" ? args.text : "";
      await askApproval(`允许 Forge 在“${app}”中输入文本吗？`, `Computer Use 将输入 ${text.length} 个字符；内容不会显示在授权卡中。`);
      await osascript("AppleScript", TYPE_APPLESCRIPT, [app, text, String(args.clear === true)]);
      return textContent({ ok: true, app, characters: text.length, cleared: args.clear === true });
    }
    case "press_key": {
      const app = requiredString(args, "app");
      const key = requiredString(args, "key").toLowerCase();
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.filter((value) => typeof value === "string") : [];
      await askApproval(`允许 Forge 在“${app}”中按下 ${[...modifiers, key].join("+")} 吗？`, "Computer Use 即将执行键盘操作。");
      await pressKey(app, key, modifiers);
      return textContent({ ok: true, app, key, modifiers });
    }
    case "scroll": {
      const app = requiredString(args, "app");
      const direction = requiredString(args, "direction").toLowerCase();
      if (direction !== "up" && direction !== "down") throw new Error("direction must be up or down");
      const amount = Math.min(20, Math.max(1, Number.isInteger(args.amount) ? args.amount : 3));
      await askApproval(`允许 Forge 在“${app}”中向${direction === "up" ? "上" : "下"}滚动吗？`, `Computer Use 将执行 ${amount} 个滚动步骤。`);
      for (let i = 0; i < amount; i++) await pressKey(app, direction, []);
      return textContent({ ok: true, app, direction, amount });
    }
    default:
      throw new Error(`Unknown Computer Use tool: ${name}`);
  }
}

async function handleRequest(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "forge-computer-use", version: "1.0.0" } };
  }
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return; }

  if (message.id !== undefined && !message.method && pendingServerRequests.has(String(message.id))) {
    const pending = pendingServerRequests.get(String(message.id));
    pendingServerRequests.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "Permission request failed"));
    else pending.resolve(message.result);
    return;
  }
  if (!message.method || message.id === undefined) return;
  void handleRequest(message).then(
    (result) => write({ jsonrpc: "2.0", id: message.id, result }),
    (error) => write({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32000, message: error.message ?? String(error) } }),
  );
});
