import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { McpServerConfig } from "@forge/tool-mcp";

const MCP_CONFIG_FILE = "mcp.json";
const MAX_MCP_CONFIG_CHARS = 64 * 1024;
const MAX_SERVERS = 32;
const MAX_ARGS = 32;
const MAX_ENV = 16;

export interface UserMcpConfigView {
  path: string;
  text: string;
  exists: boolean;
}

export interface SavedUserMcpConfig {
  path: string;
  names: string[];
}

/**
 * Load MCP servers from ~/.forge-agent/mcp.json only.
 * Local file read/write uses built-in tools (read_file, write_patch, …) by default.
 * Opt in to MCP (e.g. filesystem, database, browser) via mcp.json when needed.
 */
export function loadMcpServers(dataDir: string, _workspaceCwd?: string): McpServerConfig[] {
  const path = mcpConfigPath(dataDir);
  if (!existsSync(path)) {
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    servers?: McpServerConfig[];
  };
  return raw.servers ?? [];
}

export function defaultMcpConfigText(): string {
  return `${JSON.stringify({ servers: [] }, null, 2)}\n`;
}

/** Read the user-owned MCP file for the custom-connector editor. */
export function readUserMcpConfig(dataDir: string): UserMcpConfigView {
  const path = mcpConfigPath(dataDir);
  if (!existsSync(path)) {
    return { path, text: defaultMcpConfigText(), exists: false };
  }
  const text = readFileSync(path, "utf-8");
  if (text.length > MAX_MCP_CONFIG_CHARS) {
    throw new Error("MCP 配置过大");
  }
  return { path, text, exists: true };
}

/**
 * Validate and write only ~/.forge-agent/mcp.json.
 * Accepts Forge `{ servers: [] }` and a `{ mcpServers: { name: config } }` map.
 * Remote URL entries are rejected until that transport exists.
 */
export function saveUserMcpConfig(dataDir: string, text: string): SavedUserMcpConfig {
  const servers = parseUserMcpConfig(text);
  const path = mcpConfigPath(dataDir);
  const canonical = `${JSON.stringify({ servers }, null, 2)}\n`;
  mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, canonical, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return { path, names: servers.map((server) => server.name) };
}

export function parseUserMcpConfig(text: string): McpServerConfig[] {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("MCP 配置不能为空");
  }
  if (text.length > MAX_MCP_CONFIG_CHARS) {
    throw new Error("MCP 配置过大");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("MCP 配置不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP 配置必须是对象");
  }
  const record = parsed as Record<string, unknown>;
  rejectDangerousKeys(record);
  const hasServers = Object.prototype.hasOwnProperty.call(record, "servers");
  const hasMap = Object.prototype.hasOwnProperty.call(record, "mcpServers");
  if (hasServers && hasMap) {
    throw new Error("servers 和 mcpServers 只能保留一种");
  }
  const rawServers = hasMap ? serversFromMap(record.mcpServers) : record.servers;
  if (!Array.isArray(rawServers)) {
    throw new Error("servers 必须是数组");
  }
  if (rawServers.length > MAX_SERVERS) {
    throw new Error("自定义连接器数量超出上限");
  }
  const names = new Set<string>();
  return rawServers.map((entry) => normalizeServer(entry, names));
}

function mcpConfigPath(dataDir: string): string {
  if (!dataDir || typeof dataDir !== "string") {
    throw new Error("MCP 配置目录无效");
  }
  const root = resolve(dataDir);
  const path = join(root, MCP_CONFIG_FILE);
  if (dirname(path) !== root) {
    throw new Error("MCP 配置路径无效");
  }
  return path;
}

function serversFromMap(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mcpServers 必须是对象");
  }
  const record = value as Record<string, unknown>;
  rejectDangerousKeys(record);
  return Object.entries(record).map(([name, config]) => {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("MCP 服务配置无效");
    }
    return { name, ...(config as Record<string, unknown>) };
  });
}

function normalizeServer(value: unknown, names: Set<string>): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP 服务配置无效");
  }
  const record = value as Record<string, unknown>;
  rejectDangerousKeys(record);
  for (const key of Object.keys(record)) {
    if (key === "headers" || key === "authorization") {
      throw new Error("请求头和访问令牌不能写入配置");
    }
    if (!["name", "command", "url", "args", "env", "enabled", "cwd"].includes(key)) {
      throw new Error(`不支持的字段 ${key}`);
    }
  }
  const name = requireToken(record.name, "名称");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("连接器名称只能包含字母、数字、点、下划线和短横线");
  }
  if (names.has(name)) throw new Error(`连接器名称重复: ${name}`);
  names.add(name);
  const hasCommand = record.command !== undefined;
  const hasUrl = record.url !== undefined;
  if (hasCommand && hasUrl) throw new Error("command 和 url 只能保留一种");
  if (!hasCommand && !hasUrl) throw new Error("需要 command 或 url");
  const server: McpServerConfig = { name, enabled: record.enabled !== false };
  if (hasUrl) server.url = requireRemoteMcpUrl(record.url);
  if (hasCommand) server.command = requireCommand(record.command);
  if (record.args !== undefined) server.args = requireArgs(record.args);
  if (record.env !== undefined) server.env = requireEnv(record.env);
  if (record.cwd !== undefined) server.cwd = requireCwd(record.cwd);
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new Error("enabled 必须是布尔值");
  }
  return server;
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 64) {
    throw new Error(`${label}无效`);
  }
  if (/[\u0000-\u001f]/.test(value)) throw new Error(`${label}无效`);
  return value;
}

export function requireRemoteMcpUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("url 无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url 无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("远程 MCP 只能使用不带账号的 https 地址");
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    isIpAddress(host)
  ) {
    throw new Error("远程 MCP 不能指向本机或 IP 地址");
  }
  return url.toString();
}

function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function requireCommand(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("command 无效");
  }
  if (/[\u0000-\u001f]/.test(value) || /[;&|`$<>]/.test(value)) {
    throw new Error("command 不能包含 shell 运算符");
  }
  return value;
}

function requireArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error("args 无效");
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 512 || /[\u0000-\u001f]/.test(item)) {
      throw new Error("args 无效");
    }
    return item;
  });
}

function requireEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env 无效");
  }
  const record = value as Record<string, unknown>;
  rejectDangerousKeys(record);
  const entries = Object.entries(record);
  if (entries.length > MAX_ENV) throw new Error("env 数量超出上限");
  const env: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error("环境变量名无效");
    if (typeof item !== "string" || item.length > 4096 || /[\u0000-\u001f]/.test(item)) {
      throw new Error("环境变量值无效");
    }
    env[key] = item;
  }
  return env;
}

function requireCwd(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("cwd 无效");
  }
  if (/[\u0000-\u001f]/.test(value) || !value.startsWith("/")) {
    throw new Error("cwd 必须是绝对路径");
  }
  return value;
}

function rejectDangerousKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("MCP 配置包含不允许的字段");
    }
  }
}
