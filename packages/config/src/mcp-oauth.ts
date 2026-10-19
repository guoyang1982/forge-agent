import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "@forge/tool-mcp";
import { requireRemoteMcpUrl } from "./mcp.js";

const AUTH_FILE = "mcp-auth.json";

interface StoredMcpCredential {
  url: string;
  clientId: string;
  refreshToken?: string;
  accessToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  resource: string;
}

interface McpAuthFile {
  servers: Record<string, StoredMcpCredential>;
}

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

export async function authorizeMcpServer(options: {
  dataDir: string;
  name: string;
  url: string;
  openUrl: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ name: string }> {
  const name = requireName(options.name);
  const resource = requireRemoteMcpUrl(options.url);
  const resourceUrl = new URL(resource);
  const fetchImpl = options.fetchImpl ?? fetch;
  const metadataUrl = await discoverMetadataUrl(fetchImpl, resourceUrl);
  const resourceMetadata = await readJson<ResourceMetadata>(fetchImpl, metadataUrl);
  const issuer = httpsOnly(resourceMetadata.authorization_servers?.[0]);
  const authorizationServer = await loadAuthorizationServer(fetchImpl, issuer);
  const listener = await listenForCallback(options.timeoutMs ?? 180_000);
  try {
    const client = await registerClient(fetchImpl, authorizationServer, listener.redirectUri, resourceMetadata);
    const pkce = createPkce();
    const authorizeUrl = new URL(authorizationServer.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.clientId);
    authorizeUrl.searchParams.set("redirect_uri", listener.redirectUri);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", listener.state);
    authorizeUrl.searchParams.set("resource", resourceMetadata.resource || resource);
    const scope = scopesFor(resourceMetadata, authorizationServer);
    if (scope) authorizeUrl.searchParams.set("scope", scope);
    const pending = listener.waitForCode();
    await options.openUrl(authorizeUrl.toString());
    const code = await pending;
    const token = await requestToken(fetchImpl, authorizationServer.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: listener.redirectUri,
      client_id: client.clientId,
      code_verifier: pkce.verifier,
      resource: resourceMetadata.resource || resource,
    });
    storeCredential(options.dataDir, name, {
      url: resource,
      clientId: client.clientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiry(token.expires_in),
      tokenEndpoint: authorizationServer.token_endpoint,
      resource: resourceMetadata.resource || resource,
    });
    return { name };
  } finally {
    listener.close();
  }
}

export function listAuthorizedMcpServers(dataDir: string): string[] {
  const file = readAuthFile(dataDir);
  return Object.entries(file.servers)
    .filter(([, credential]) => credential.accessToken || credential.refreshToken)
    .map(([name]) => name);
}

export async function attachMcpAuthorization(
  dataDir: string,
  servers: McpServerConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<McpServerConfig[]> {
  const next: McpServerConfig[] = [];
  for (const server of servers) {
    if (!server.url) {
      next.push(server);
      continue;
    }
    const accessToken = await currentAccessToken(dataDir, server.name, fetchImpl);
    next.push(accessToken ? { ...server, authorization: accessToken } : server);
  }
  return next;
}

function authorizationServerMetadataUrl(issuer: URL): string {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  return `${issuer.origin}/.well-known/oauth-authorization-server${path}`;
}

async function loadAuthorizationServer(
  fetchImpl: typeof fetch,
  issuer: URL,
): Promise<OAuthMetadata> {
  const candidates = [
    authorizationServerMetadataUrl(issuer),
    `${issuer.origin}${issuer.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  ];
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    const candidateUrl = httpsOnly(candidate);
    if (candidateUrl.hostname !== issuer.hostname) continue;
    try {
      const metadata = await readJson<OAuthMetadata>(fetchImpl, candidate);
      if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
        throw new Error("授权服务元数据不完整");
      }
      if (!metadata.code_challenge_methods_supported?.includes("S256")) {
        throw new Error("授权服务不支持 PKCE");
      }
      httpsOnly(metadata.authorization_endpoint);
      httpsOnly(metadata.token_endpoint);
      if (!metadata.registration_endpoint) {
        throw new Error("这个连接器需要服务商预先登记的应用，当前还不能直接授权");
      }
      httpsOnly(metadata.registration_endpoint);
      return metadata;
    } catch (error) {
      if (error instanceof Error && error.message.includes("预先登记")) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("读取授权信息失败");
}

async function discoverMetadataUrl(fetchImpl: typeof fetch, resourceUrl: URL): Promise<string> {
  try {
    const discovery = await fetchImpl(resourceUrl.toString(), { method: "GET", redirect: "error" });
    const header = discovery.headers.get("www-authenticate");
    if (header?.includes("resource_metadata")) return resourceMetadataUrl(header, resourceUrl);
  } catch {
    /* The MCP endpoint can reject GET and still publish protected-resource metadata. */
  }
  return new URL(
    `/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
    resourceUrl.origin,
  ).toString();
}

function scopesFor(resource: ResourceMetadata, metadata: OAuthMetadata): string {
  const scopes = resource.scopes_supported ?? metadata.scopes_supported ?? [];
  const gmail = scopes.filter((scope) =>
    /\/auth\/gmail\.(readonly|send|compose)$/.test(scope),
  );
  return (gmail.length > 0 ? gmail : scopes).join(" ");
}

export function resourceMetadataUrl(header: string | null, resourceUrl: URL): string {
  const match = header?.match(/resource_metadata="([^"]+)"|resource_metadata=([^\s,]+)/);
  const value = match?.[1] || match?.[2];
  if (!value) throw new Error("这个地址没有返回授权信息");
  return httpsSameSite(value, resourceUrl).toString();
}

function httpsOnly(value: unknown): URL {
  if (typeof value !== "string") throw new Error("授权地址无效");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("授权地址无效");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("授权地址必须是 https");
  }
  return url;
}

function httpsSameSite(value: unknown, resourceUrl: URL): URL {
  const url = httpsOnly(value);
  if (url.hostname !== resourceUrl.hostname) throw new Error("授权元数据必须和 MCP 在同一站点");
  return url;
}

async function readJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  httpsOnly(url);
  const response = await fetchImpl(url, { redirect: "error" });
  if (!response.ok) throw new Error(`读取授权信息失败 (${response.status})`);
  return await response.json() as T;
}

async function registerClient(
  fetchImpl: typeof fetch,
  metadata: OAuthMetadata,
  redirectUri: string,
  resource: ResourceMetadata,
): Promise<{ clientId: string }> {
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Forge",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: (resource.scopes_supported ?? metadata.scopes_supported ?? []).join(" "),
    }),
  });
  const body = await response.json().catch(() => ({})) as { client_id?: string; error?: string };
  if (!response.ok || !body.client_id) {
    const code = body.error && /^[a-z0-9_-]{1,64}$/i.test(body.error) ? body.error : String(response.status);
    throw new Error(`授权服务拒绝了客户端注册 (${code})`);
  }
  return { clientId: body.client_id };
}

async function requestToken(
  fetchImpl: typeof fetch,
  endpoint: string,
  fields: Record<string, string | undefined>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value) body.set(key, value);
  }
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !token.access_token) {
    const code = token.error && /^[a-z0-9_-]{1,64}$/i.test(token.error) ? token.error : String(response.status);
    throw new Error(`授权没有完成 (${code})`);
  }
  return { access_token: token.access_token, refresh_token: token.refresh_token, expires_in: token.expires_in };
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function expiry(expiresIn: number | undefined): number {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 300;
  return Date.now() + seconds * 1000;
}

function listenForCallback(timeoutMs: number): Promise<{
  redirectUri: string;
  state: string;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  const state = randomBytes(24).toString("base64url");
  let settled = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      respond(response, 404, "找不到回调");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      respond(response, 400, "授权校验失败");
      if (!settled) {
        settled = true;
        rejectCode(new Error("授权校验失败"));
      }
      return;
    }
    const code = url.searchParams.get("code") || "";
    if (!code) {
      respond(response, 400, "授权没有返回代码");
      return;
    }
    respond(response, 200, "连接器已授权，可以回到 Forge。");
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectCode(new Error("授权超时"));
      }
      server.close();
    }, timeoutMs);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        state,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timer);
          server.closeAllConnections?.();
          server.close();
          server.unref();
        },
      });
    });
  });
}

function respond(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><meta charset="utf-8"><title>Forge</title><p>${text}</p>`);
}

async function currentAccessToken(
  dataDir: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const credential = readAuthFile(dataDir).servers[name];
  if (!credential?.accessToken) return null;
  if (credential.expiresAt > Date.now() + 60_000) return credential.accessToken;
  if (!credential.refreshToken) return null;
  try {
    const token = await requestToken(fetchImpl, credential.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      resource: credential.resource,
    });
    storeCredential(dataDir, name, {
      ...credential,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || credential.refreshToken,
      expiresAt: expiry(token.expires_in),
    });
    return token.access_token;
  } catch {
    return null;
  }
}

function storeCredential(dataDir: string, name: string, credential: StoredMcpCredential): void {
  const file = readAuthFile(dataDir);
  file.servers[name] = credential;
  const path = authPath(dataDir);
  mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function readAuthFile(dataDir: string): McpAuthFile {
  const path = authPath(dataDir);
  if (!existsSync(path)) return { servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpAuthFile;
    if (!parsed?.servers || typeof parsed.servers !== "object") return { servers: {} };
    return { servers: parsed.servers };
  } catch {
    return { servers: {} };
  }
}

function authPath(dataDir: string): string {
  if (!dataDir) throw new Error("MCP 授权目录无效");
  return join(resolve(dataDir), AUTH_FILE);
}

function requireName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error("连接器名称无效");
  return value;
}
