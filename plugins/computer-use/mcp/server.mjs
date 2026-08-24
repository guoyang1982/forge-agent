#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pendingServerRequests = new Map();
const appSnapshots = new Map();
let nextServerRequestId = 1;
let nextSnapshotId = 1;

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
    description: "Get the target application's front-window state, accessibility element snapshot, and optional PNG capture. Element indices are valid for the returned snapshot. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Exact application name returned by list_apps." },
        include_screenshot: { type: "boolean", description: "Return a PNG of the front app window. Defaults to true." },
        include_accessibility: { type: "boolean", description: "Return a flattened accessibility tree with element indices. Defaults to true." },
        max_elements: { type: "integer", minimum: 1, maximum: 800, description: "Maximum accessibility elements to return. Defaults to 100. After a timeout, retry at most once with a lower value." },
        accessibility_format: { type: "string", enum: ["compact", "structured", "both"], description: "Accessibility response format. compact (default) avoids duplicating every element in the MCP response." },
        time_budget_ms: { type: "integer", minimum: 1000, maximum: 20000, description: "Accessibility traversal budget. Defaults to 18000ms and returns a partial snapshot before the MCP timeout." },
      },
      required: ["app"],
    },
  },
  {
    name: "click",
    description: "Click an accessibility element from the latest snapshot, or an absolute screen coordinate. Prefer element_index and take a fresh get_app_state first. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        x: { type: "number", description: "Absolute screen X coordinate." },
        y: { type: "number", description: "Absolute screen Y coordinate." },
        element_index: { type: "integer", minimum: 0, description: "Element index from the latest get_app_state snapshot. Preferred over coordinates." },
        snapshot_id: { type: "string", description: "Optional snapshot id returned by get_app_state. Rejects stale element references." },
      },
      required: ["app"],
    },
  },
  {
    name: "drag",
    description: "Drag between screen coordinates, or from an accessibility element's center. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        element_index: { type: "integer", minimum: 0 },
        snapshot_id: { type: "string" },
        from_x: { type: "number" }, from_y: { type: "number" },
        to_x: { type: "number" }, to_y: { type: "number" },
      },
      required: ["app", "to_x", "to_y"],
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
    name: "type_text",
    description: "Type text into the focused control of a target macOS application. Alias of type for Codex-compatible workflows. Requires user approval.",
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
        key: { type: "string", description: "A supported named key (enter/tab/escape/delete/space/arrows/home/end/pageup/pagedown) or one literal character such as n for Command+N." },
        modifiers: { type: "array", items: { type: "string", enum: ["command", "control", "option", "shift"] } },
      },
      required: ["app", "key"],
    },
  },
  {
    name: "set_value",
    description: "Set the value of an editable accessibility element from the latest app snapshot. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        element_index: { type: "integer", minimum: 0 },
        snapshot_id: { type: "string" },
        value: { type: "string" },
      },
      required: ["app", "element_index", "value"],
    },
  },
  {
    name: "select_text",
    description: "Select matching text or place the cursor before/after it in an editable accessibility element. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        element_index: { type: "integer", minimum: 0 },
        snapshot_id: { type: "string" },
        text: { type: "string" },
        prefix: { type: "string" },
        suffix: { type: "string" },
        selection_type: { type: "string", enum: ["text", "cursor_before", "cursor_after"] },
      },
      required: ["app", "element_index", "text"],
    },
  },
  {
    name: "perform_secondary_action",
    description: "Perform a named accessibility action exposed by an element, such as AXShowMenu, AXIncrement, or AXDecrement. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        element_index: { type: "integer", minimum: 0 },
        snapshot_id: { type: "string" },
        action: { type: "string" },
      },
      required: ["app", "element_index", "action"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the focused target application up, down, left, or right, optionally focusing an accessibility element first. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 20, description: "Number of scroll steps. Defaults to 3." },
        element_index: { type: "integer", minimum: 0, description: "Optional element to focus before scrolling." },
        snapshot_id: { type: "string" },
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
  const maxElements = Math.max(1, Math.min(800, Number(argv[1] || 100)));
  const timeBudgetMs = Math.max(1000, Math.min(20000, Number(argv[2] || 18000)));
  const includeAccessibility = String(argv[3] || "true") !== "false";
  const deadline = Date.now() + timeBudgetMs;
  const se = Application("System Events");
  const apps = se.applicationProcesses.whose({ backgroundOnly: false })();
  const app = apps.find((item) => {
    try { return String(item.name()).toLowerCase() === query; } catch (_) { return false; }
  });
  if (!app) throw new Error("Application is not running: " + argv[0]);
  app.frontmost = true;
  delay(0.15);
  const safe = (read, fallback) => { try { return read(); } catch (_) { return fallback; } };
  const stringValue = (value) => {
    if (value === null || value === undefined) return "";
    if (["string", "number", "boolean"].includes(typeof value)) return String(value);
    return "";
  };
  const windows = app.windows().map((win, index) => {
    let position = [0, 0], size = [0, 0], title = "";
    try { position = win.position(); } catch (_) {}
    try { size = win.size(); } catch (_) {}
    try { title = win.name(); } catch (_) {}
    return { index, title: String(title || ""), x: Number(position[0] || 0), y: Number(position[1] || 0), width: Number(size[0] || 0), height: Number(size[1] || 0) };
  });
  const elements = [];
  let truncated = false;
  let truncatedReason = "";
  let visited = 0;
  const interactiveRoles = {
    AXButton: true, AXCheckBox: true, AXComboBox: true, AXLink: true,
    AXMenu: true, AXMenuBar: true, AXMenuItem: true, AXPopUpButton: true,
    AXRadioButton: true, AXSearchField: true, AXSlider: true, AXStepper: true,
    AXTabGroup: true, AXTextArea: true, AXTextField: true,
  };
  const structuralRoles = {
    AXCell: true, AXDialog: true, AXImage: true, AXOutline: true, AXRow: true,
    AXScrollArea: true, AXSheet: true, AXTable: true, AXToolbar: true, AXWindow: true,
  };
  function stop(reason) {
    truncated = true;
    if (!truncatedReason) truncatedReason = reason;
    return true;
  }
  function visit(element, path, depth) {
    if (Date.now() >= deadline) return stop("time_budget");
    if (elements.length >= maxElements) return stop("max_elements");
    if (++visited > 1200) return stop("visit_limit");
    const role = stringValue(safe(() => element.role(), ""));
    const title = stringValue(safe(() => element.name(), ""));
    const focused = interactiveRoles[role] ? Boolean(safe(() => element.focused(), false)) : false;
    const shouldInclude = depth === 0 || interactiveRoles[role] || structuralRoles[role] || role === "AXStaticText" || Boolean(title) || focused;
    if (shouldInclude) {
      const expensive = interactiveRoles[role] || structuralRoles[role] || focused;
      const position = expensive ? safe(() => element.position(), [0, 0]) : [0, 0];
      const size = expensive ? safe(() => element.size(), [0, 0]) : [0, 0];
      const actions = interactiveRoles[role]
        ? safe(() => element.actions().map((action) => String(action.name() || "")).filter(Boolean), [])
        : [];
      const description = title ? "" : stringValue(safe(() => element.description(), ""));
      elements.push({
        element_index: elements.length,
        path,
        depth,
        role,
        subrole: structuralRoles[role] ? stringValue(safe(() => element.subrole(), "")) : "",
        title,
        description,
        help: "",
        value: interactiveRoles[role] ? stringValue(safe(() => element.value(), "")) : "",
        enabled: interactiveRoles[role] ? Boolean(safe(() => element.enabled(), true)) : true,
        focused,
        x: Number(position[0] || 0), y: Number(position[1] || 0),
        width: Number(size[0] || 0), height: Number(size[1] || 0),
        actions,
      });
    }
    if (Date.now() >= deadline) return stop("time_budget");
    if (depth >= 14) return;
    const children = safe(() => element.uiElements(), []);
    for (let index = 0; index < children.length; index++) {
      if (visit(children[index], { root: path.root, window_index: path.window_index, indices: path.indices.concat(index) }, depth + 1)) break;
      if (truncated) break;
    }
    return truncated;
  }
  const frontWindow = safe(() => app.windows()[0], null);
  if (includeAccessibility && frontWindow) {
    visit(frontWindow, { root: "window", window_index: 0, indices: [] }, 0);
  }
  const frontWindowRole = frontWindow ? stringValue(safe(() => frontWindow.role(), "")) : "";
  const frontWindowSubrole = frontWindow ? stringValue(safe(() => frontWindow.subrole(), "")) : "";
  return JSON.stringify({ app: app.name(), pid: app.unixId(), active: Boolean(app.frontmost()), windows, elements, truncated, truncatedReason, visited, frontWindowRole, frontWindowSubrole });
}`;

const ELEMENT_OPERATION_JXA = String.raw`function run(argv) {
  const query = String(argv[0] || "").toLowerCase();
  const path = JSON.parse(String(argv[1] || "[]"));
  const operation = String(argv[2] || "frame");
  const payload = argv.length > 3 ? JSON.parse(String(argv[3] || "null")) : null;
  const se = Application("System Events");
  const app = se.applicationProcesses.whose({ backgroundOnly: false })().find((item) => {
    try { return String(item.name()).toLowerCase() === query; } catch (_) { return false; }
  });
  if (!app) throw new Error("Application is not running: " + argv[0]);
  let element = app;
  let indices = path;
  if (!Array.isArray(path) && path && path.root === "window") {
    const windows = app.windows();
    const windowIndex = Number(path.window_index || 0);
    if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex >= windows.length) throw new Error("Accessibility window is stale; call get_app_state again");
    element = windows[windowIndex];
    indices = Array.isArray(path.indices) ? path.indices : [];
  }
  for (const index of indices) {
    const children = element.uiElements();
    if (!Number.isInteger(index) || index < 0 || index >= children.length) throw new Error("Accessibility element is stale; call get_app_state again");
    element = children[index];
  }
  const position = (() => { try { return element.position(); } catch (_) { return [0, 0]; } })();
  const size = (() => { try { return element.size(); } catch (_) { return [0, 0]; } })();
  const frame = { x: Number(position[0] || 0), y: Number(position[1] || 0), width: Number(size[0] || 0), height: Number(size[1] || 0) };
  if (operation === "frame") return JSON.stringify(frame);
  app.frontmost = true;
  delay(0.08);
  if (operation === "set_value") {
    element.value = String(payload && payload.value !== undefined ? payload.value : "");
    return JSON.stringify({ ok: true, frame });
  }
  if (operation === "select_text") {
    const attributes = element.attributes();
    const selectedRange = attributes.find((attribute) => {
      try { return String(attribute.name()) === "AXSelectedTextRange"; } catch (_) { return false; }
    });
    if (!selectedRange) throw new Error("Element does not expose AXSelectedTextRange");
    selectedRange.value = [Number(payload.start), Number(payload.length)];
    return JSON.stringify({ ok: true, frame, start: Number(payload.start), length: Number(payload.length) });
  }
  if (operation === "action") {
    const requested = String(payload && payload.action || "");
    const normalize = (value) => String(value || "").replace(/^AX/i, "").replace(/[ _-]/g, "").toLowerCase();
    const action = element.actions().find((candidate) => {
      try { return normalize(candidate.name()) === normalize(requested); } catch (_) { return false; }
    });
    if (!action) throw new Error("Accessibility action is not exposed by this element: " + requested);
    action.perform();
    return JSON.stringify({ ok: true, action: requested, frame });
  }
  throw new Error("Unsupported accessibility operation: " + operation);
}`;

const DRAG_JXA = String.raw`ObjC.import("CoreGraphics");
function run(argv) {
  const appName = String(argv[0] || "");
  const fromX = Number(argv[1]), fromY = Number(argv[2]), toX = Number(argv[3]), toY = Number(argv[4]);
  const se = Application("System Events");
  const app = se.applicationProcesses.whose({ backgroundOnly: false })().find((item) => {
    try { return String(item.name()).toLowerCase() === appName.toLowerCase(); } catch (_) { return false; }
  });
  if (!app) throw new Error("Application is not running: " + appName);
  app.frontmost = true;
  delay(0.08);
  function post(type, x, y) {
    const event = $.CGEventCreateMouseEvent(null, type, { x, y }, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, event);
  }
  post($.kCGEventMouseMoved, fromX, fromY);
  delay(0.08);
  post($.kCGEventLeftMouseDown, fromX, fromY);
  try {
    for (let step = 1; step <= 20; step++) {
      const ratio = step / 20;
      post($.kCGEventLeftMouseDragged, fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio);
      delay(0.015);
    }
  } finally {
    post($.kCGEventLeftMouseUp, toX, toY);
  }
  return JSON.stringify({ ok: true });
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
  set savedClipboard to the clipboard as record
  try
    set the clipboard to inputText
    tell application "System Events"
      set frontmost of first application process whose name is appName to true
      delay 0.15
      if shouldClear then
        keystroke "a" using command down
        delay 0.05
      end if
      keystroke "v" using command down
      delay 0.2
    end tell
  on error errorMessage number errorNumber
    try
      set the clipboard to savedClipboard
    end try
    error errorMessage number errorNumber
  end try
  set the clipboard to savedClipboard
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
      throw new Error("macOS Accessibility permission is missing. In System Settings → Privacy & Security → Accessibility, enable the currently running Forge app. Source builds use apps/desktop/.forge-electron/Forge.app; an older Electron or Forge entry does not authorize this host. Then restart Forge and retry.");
    }
    throw error;
  }
}

async function askApproval(message, subtitle, permissionScope = "apps.control") {
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
      _meta: { subtitle, riskLevel: "high", persist: ["session"], permissionScope },
    },
  });
  const response = await decision;
  if (response?.action !== "accept") throw new Error("User declined Computer Use access");
}

async function listApps() {
  const apps = JSON.parse(await osascript("JavaScript", LIST_APPS_JXA));
  return [...new Map(apps.map((app) => [app.pid, app])).values()];
}

function accessibilityText(elements, truncated, truncatedReason) {
  const lines = elements.map((element) => {
    const indent = "  ".repeat(Math.min(8, element.depth));
    const label = element.title || element.description || element.help || "";
    const details = [
      label ? JSON.stringify(label) : "",
      element.value && element.value !== label ? `value=${JSON.stringify(element.value)}` : "",
      element.focused ? "focused" : "",
      element.enabled ? "" : "disabled",
      element.width > 0 && element.height > 0
        ? `frame=(${element.x},${element.y},${element.width},${element.height})`
        : "",
      element.actions.length ? `actions=[${element.actions.join(",")}]` : "",
    ].filter(Boolean);
    return `${indent}[${element.element_index}] ${element.role || "AXElement"}${details.length ? ` ${details.join(" ")}` : ""}`;
  });
  if (truncated) {
    const reason = truncatedReason || "unknown";
    lines.push(`… partial accessibility snapshot (reason=${reason}); do not retry with a larger max_elements`);
  }
  return lines.join("\n");
}

function snapshotElement(appName, elementIndex, snapshotId) {
  const snapshot = appSnapshots.get(appName.toLowerCase());
  if (!snapshot) throw new Error("No accessibility snapshot is available; call get_app_state first");
  if (snapshotId && snapshot.id !== snapshotId) {
    throw new Error(`Accessibility snapshot is stale (expected ${snapshot.id}, received ${snapshotId}); call get_app_state again`);
  }
  if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex >= snapshot.elements.length) {
    throw new Error(`Invalid element_index: ${elementIndex}; call get_app_state again`);
  }
  return { snapshot, element: snapshot.elements[elementIndex] };
}

async function elementFrame(appName, elementIndex, snapshotId) {
  const { snapshot, element } = snapshotElement(appName, elementIndex, snapshotId);
  const frame = JSON.parse(await osascript("JavaScript", ELEMENT_OPERATION_JXA, [
    appName,
    JSON.stringify(element.path),
    "frame",
    "null",
  ]));
  if (!(frame.width > 0 && frame.height > 0)) throw new Error(`Element ${elementIndex} has no clickable frame`);
  return { snapshot, element, frame };
}

async function elementOperation(appName, elementIndex, snapshotId, operation, payload) {
  const { snapshot, element } = snapshotElement(appName, elementIndex, snapshotId);
  const result = JSON.parse(await osascript("JavaScript", ELEMENT_OPERATION_JXA, [
    appName,
    JSON.stringify(element.path),
    operation,
    JSON.stringify(payload ?? null),
  ]));
  return { snapshot, element, result };
}

async function getAppState(appName, options = {}) {
  const willScreenshot = options.include_screenshot !== false;
  await askApproval(
    `允许 Forge 读取${willScreenshot ? "并截图" : ""}“${appName}”吗？`,
    willScreenshot
      ? "Computer Use 将读取目标应用窗口；不会截取整个桌面。"
      : "Computer Use 将读取目标应用的窗口与辅助功能信息。",
  );
  const includeAccessibility = options.include_accessibility !== false;
  const maxElements = Math.min(800, Math.max(1, Number.isInteger(options.max_elements) ? options.max_elements : 100));
  const timeBudgetMs = Math.min(20_000, Math.max(1_000, Number.isInteger(options.time_budget_ms) ? options.time_budget_ms : 18_000));
  const accessibilityFormat = ["compact", "structured", "both"].includes(options.accessibility_format)
    ? options.accessibility_format
    : "compact";
  const state = JSON.parse(await osascript("JavaScript", APP_STATE_JXA, [
    appName,
    String(maxElements),
    String(timeBudgetMs),
    String(includeAccessibility),
  ]));
  const snapshotId = `ax-${Date.now().toString(36)}-${nextSnapshotId++}`;
  const snapshotElements = includeAccessibility ? state.elements : [];
  const snapshot = { id: snapshotId, elements: snapshotElements };
  appSnapshots.set(appName.toLowerCase(), snapshot);
  appSnapshots.set(String(state.app).toLowerCase(), snapshot);
  const publicElements = snapshotElements.map(({ path: _path, ...element }) => element);
  const frontTitle = state.windows?.[0]?.title || "";
  const isDialog = state.frontWindowRole === "AXDialog" || state.frontWindowSubrole === "AXDialog";
  const isFileDialog = /^(open|save|打开|存储|另存为)/i.test(frontTitle.trim());
  const accessibility = includeAccessibility
    ? {
        element_count: publicElements.length,
        visited_count: state.visited,
        ...(accessibilityFormat === "structured"
          ? {}
          : { text: accessibilityText(publicElements, state.truncated, state.truncatedReason) }),
        ...(accessibilityFormat === "compact" ? {} : { elements: publicElements }),
        truncated: state.truncated,
        truncated_reason: state.truncatedReason || null,
      }
    : null;
  const result = {
    app: state.app,
    pid: state.pid,
    active: state.active,
    windows: state.windows,
    snapshot_id: snapshotId,
    accessibility,
    front_window: {
      title: frontTitle,
      role: state.frontWindowRole || null,
      subrole: state.frontWindowSubrole || null,
      context: isFileDialog ? "file-dialog" : isDialog ? "dialog" : "application-window",
    },
    ...(state.truncated
      ? { guidance: "A safe partial snapshot was returned. Continue from visible elements or retry once with a lower max_elements; never increase it after truncation or timeout." }
      : isFileDialog
        ? { guidance: "The front window appears to be a file dialog. Do not keep searching this snapshot for the application's main editor." }
        : {}),
    screenshotScope: "front-window",
  };
  if (!willScreenshot) return textContent(result);
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
  const normalized = [...new Set(modifiers)].map((modifier) => MODIFIERS[modifier]).filter(Boolean);
  const using = normalized.length ? ` using {${normalized.join(", ")}}` : "";
  if (code !== undefined) {
    const source = `on run argv\nset appName to item 1 of argv\ntell application "System Events"\nset frontmost of first application process whose name is appName to true\ndelay 0.1\nkey code ${code}${using}\nend tell\nend run`;
    await osascript("AppleScript", source, [appName]);
    return;
  }
  if ([...key].length !== 1) throw new Error(`Unsupported key: ${key}`);
  const source = `on run argv\nset appName to item 1 of argv\nset keyText to item 2 of argv\ntell application "System Events"\nset frontmost of first application process whose name is appName to true\ndelay 0.1\nkeystroke keyText${using}\nend tell\nend run`;
  await osascript("AppleScript", source, [appName, key]);
}

async function callTool(name, args) {
  if (process.platform !== "darwin") throw new Error("Forge Computer Use currently supports macOS only");
  switch (name) {
    case "list_apps":
      return textContent({ apps: await listApps() });
    case "open_app": {
      const app = requiredString(args, "app");
      await askApproval(`允许 Forge 打开“${app}”吗？`, "Computer Use 将启动或激活应用。", "apps.open");
      await execFileAsync("/usr/bin/open", ["-a", app]);
      return textContent({ ok: true, app });
    }
    case "get_app_state":
      return getAppState(requiredString(args, "app"), args);
    case "click": {
      const app = requiredString(args, "app");
      let x = Number(args.x), y = Number(args.y), elementIndex;
      if (args.element_index !== undefined) {
        elementIndex = Number(args.element_index);
        const { frame } = await elementFrame(app, elementIndex, args.snapshot_id);
        x = frame.x + frame.width / 2;
        y = frame.y + frame.height / 2;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Provide element_index or finite x and y screen coordinates");
      const target = elementIndex === undefined ? `(${Math.round(x)}, ${Math.round(y)})` : `元素 [${elementIndex}]`;
      await askApproval(`允许 Forge 在“${app}”中点击${target}吗？`, "Computer Use 即将执行鼠标操作。");
      await osascript("AppleScript", CLICK_APPLESCRIPT, [app, String(Math.round(x)), String(Math.round(y))]);
      return textContent({ ok: true, app, x: Math.round(x), y: Math.round(y), ...(elementIndex === undefined ? {} : { element_index: elementIndex }) });
    }
    case "drag": {
      const app = requiredString(args, "app");
      let fromX = Number(args.from_x), fromY = Number(args.from_y), elementIndex;
      if (args.element_index !== undefined) {
        elementIndex = Number(args.element_index);
        const { frame } = await elementFrame(app, elementIndex, args.snapshot_id);
        fromX = frame.x + frame.width / 2;
        fromY = frame.y + frame.height / 2;
      }
      const toX = Number(args.to_x), toY = Number(args.to_y);
      if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
        throw new Error("Provide element_index or finite from_x/from_y, plus finite to_x/to_y");
      }
      await askApproval(`允许 Forge 在“${app}”中执行拖拽吗？`, `Computer Use 将从 (${Math.round(fromX)}, ${Math.round(fromY)}) 拖到 (${Math.round(toX)}, ${Math.round(toY)})。`);
      await osascript("JavaScript", DRAG_JXA, [app, String(fromX), String(fromY), String(toX), String(toY)]);
      return textContent({ ok: true, app, from_x: Math.round(fromX), from_y: Math.round(fromY), to_x: Math.round(toX), to_y: Math.round(toY), ...(elementIndex === undefined ? {} : { element_index: elementIndex }) });
    }
    case "type":
    case "type_text": {
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
    case "set_value": {
      const app = requiredString(args, "app");
      const elementIndex = Number(args.element_index);
      const value = typeof args.value === "string" ? args.value : "";
      snapshotElement(app, elementIndex, args.snapshot_id);
      await askApproval(`允许 Forge 修改“${app}”中元素 [${elementIndex}] 的值吗？`, `Computer Use 将写入 ${value.length} 个字符；内容不会显示在授权卡中。`);
      await elementOperation(app, elementIndex, args.snapshot_id, "set_value", { value });
      return textContent({ ok: true, app, element_index: elementIndex, characters: value.length });
    }
    case "select_text": {
      const app = requiredString(args, "app");
      const elementIndex = Number(args.element_index);
      const { element } = snapshotElement(app, elementIndex, args.snapshot_id);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) throw new Error("text is required");
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const suffix = typeof args.suffix === "string" ? args.suffix : "";
      const value = String(element.value || "");
      const matches = [];
      for (let offset = 0; offset <= value.length - text.length; offset++) {
        if (value.slice(offset, offset + text.length) !== text) continue;
        if (prefix && value.slice(Math.max(0, offset - prefix.length), offset) !== prefix) continue;
        if (suffix && value.slice(offset + text.length, offset + text.length + suffix.length) !== suffix) continue;
        matches.push(offset);
      }
      if (!matches.length) throw new Error("Text was not found in the element's latest accessibility value");
      if (matches.length > 1) throw new Error("Text is ambiguous; provide prefix or suffix to identify one occurrence");
      const selectionType = typeof args.selection_type === "string" ? args.selection_type : "text";
      if (!["text", "cursor_before", "cursor_after"].includes(selectionType)) {
        throw new Error("selection_type must be text, cursor_before, or cursor_after");
      }
      const start = selectionType === "cursor_after" ? matches[0] + text.length : matches[0];
      const length = selectionType === "text" ? text.length : 0;
      await askApproval(`允许 Forge 在“${app}”中调整文本选择吗？`, `Computer Use 将操作元素 [${elementIndex}] 的文本光标或选区。`);
      await elementOperation(app, elementIndex, args.snapshot_id, "select_text", { start, length });
      return textContent({ ok: true, app, element_index: elementIndex, selection_type: selectionType, start, length });
    }
    case "perform_secondary_action": {
      const app = requiredString(args, "app");
      const elementIndex = Number(args.element_index);
      const action = requiredString(args, "action");
      const { element } = snapshotElement(app, elementIndex, args.snapshot_id);
      await askApproval(`允许 Forge 在“${app}”中执行 ${action} 吗？`, `Computer Use 将操作元素 [${elementIndex}]；可用动作：${element.actions.join(", ") || "未在快照中列出"}。`);
      await elementOperation(app, elementIndex, args.snapshot_id, "action", { action });
      return textContent({ ok: true, app, element_index: elementIndex, action });
    }
    case "scroll": {
      const app = requiredString(args, "app");
      const direction = requiredString(args, "direction").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) throw new Error("direction must be up, down, left, or right");
      const amount = Math.min(20, Math.max(1, Number.isInteger(args.amount) ? args.amount : 3));
      let focusFrame;
      if (args.element_index !== undefined) {
        const elementIndex = Number(args.element_index);
        const { frame } = await elementFrame(app, elementIndex, args.snapshot_id);
        focusFrame = frame;
      }
      const directionLabel = { up: "上", down: "下", left: "左", right: "右" }[direction];
      await askApproval(`允许 Forge 在“${app}”中向${directionLabel}滚动吗？`, `Computer Use 将执行 ${amount} 个滚动步骤。`);
      if (focusFrame) {
        await osascript("AppleScript", CLICK_APPLESCRIPT, [app, String(Math.round(focusFrame.x + focusFrame.width / 2)), String(Math.round(focusFrame.y + focusFrame.height / 2))]);
      }
      for (let i = 0; i < amount; i++) await pressKey(app, direction, []);
      return textContent({ ok: true, app, direction, amount, ...(args.element_index === undefined ? {} : { element_index: Number(args.element_index) }) });
    }
    default:
      throw new Error(`Unknown Computer Use tool: ${name}`);
  }
}

async function handleRequest(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "forge-computer-use", version: "1.1.4" } };
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
