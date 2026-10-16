import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorizeMcpServer, listAuthorizedMcpServers, resourceMetadataUrl } from "./mcp-oauth.js";

describe("mcp oauth", () => {
  it("reads the protected-resource metadata url", () => {
    const url = resourceMetadataUrl(
      "Bearer resource_metadata=https://klingai.com/.well-known/oauth-protected-resource/mcp",
      new URL("https://klingai.com/mcp"),
    );
    expect(url).toBe("https://klingai.com/.well-known/oauth-protected-resource/mcp");
  });

  it("stores the token outside the returned result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-auth-"));
    const accessToken = "test-access-token";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://klingai.com/mcp" && (!init?.method || init.method === "GET")) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              "Bearer resource_metadata=https://klingai.com/.well-known/oauth-protected-resource/mcp",
          },
        });
      }
      if (url.endsWith("/oauth-protected-resource/mcp")) {
        return Response.json({
          resource: "https://klingai.com/mcp",
          authorization_servers: ["https://klingai.com/auth"],
          scopes_supported: ["generation.read"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://klingai.com/auth",
          authorization_endpoint: "https://klingai.com/auth/authorize",
          token_endpoint: "https://klingai.com/auth/token",
          registration_endpoint: "https://klingai.com/auth/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/register")) {
        return Response.json({ client_id: "forge-client" });
      }
      if (url.endsWith("/token")) {
        return Response.json({ access_token: accessToken, refresh_token: "test-refresh", expires_in: 3600 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await authorizeMcpServer({
      dataDir: dir,
      name: "kling",
      url: "https://klingai.com/mcp",
      fetchImpl,
      openUrl: async (authorizeUrl) => {
        const url = new URL(authorizeUrl);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_verifier")).toBeNull();
        const redirect = new URL(url.searchParams.get("redirect_uri") || "");
        redirect.searchParams.set("code", "auth-code");
        redirect.searchParams.set("state", url.searchParams.get("state") || "");
        await fetch(redirect);
      },
    });

    expect(result).toEqual({ name: "kling" });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(listAuthorizedMcpServers(dir)).toEqual(["kling"]);
    // Windows does not expose POSIX owner/group permission bits.
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "mcp-auth.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("accepts an authorization server on another https host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-auth-"));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://mcp.feishu.cn/mcp" && (!init?.method || init.method === "GET")) {
        return new Response("", { status: 405 });
      }
      if (url.endsWith("/oauth-protected-resource/mcp")) {
        return Response.json({
          resource: "https://mcp.feishu.cn/mcp",
          authorization_servers: ["https://accounts.feishu.cn/mcp"],
          scopes_supported: ["offline_access"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://accounts.feishu.cn/mcp",
          authorization_endpoint: "https://accounts.feishu.cn/oauth/v2/mcp/authorize",
          token_endpoint: "https://accounts.feishu.cn/oauth/v3/token",
          registration_endpoint: "https://open.feishu.cn/open-apis/app/v1/dcr",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url.endsWith("/dcr")) return Response.json({ client_id: "feishu-client" });
      if (url.endsWith("/token")) {
        return Response.json({ access_token: "feishu-access", expires_in: 3600 });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const result = await authorizeMcpServer({
      dataDir: dir,
      name: "feishu",
      url: "https://mcp.feishu.cn/mcp",
      fetchImpl,
      openUrl: async (authorizeUrl) => {
        const url = new URL(authorizeUrl);
        expect(url.hostname).toBe("accounts.feishu.cn");
        const redirect = new URL(url.searchParams.get("redirect_uri") || "");
        redirect.searchParams.set("code", "auth-code");
        redirect.searchParams.set("state", url.searchParams.get("state") || "");
        await fetch(redirect);
      },
    });
    expect(result).toEqual({ name: "feishu" });
    expect(JSON.stringify(result)).not.toContain("feishu-access");
  });

  it("stops when the vendor does not offer dynamic registration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-auth-"));
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://mcp.slack.com/mcp") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource"' },
        });
      }
      if (url.includes("oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.slack.com/mcp",
          authorization_servers: ["https://mcp.slack.com"],
        });
      }
      if (url.includes("oauth-authorization-server")) {
        return Response.json({
          issuer: "https://mcp.slack.com",
          authorization_endpoint: "https://slack.com/oauth/v2_user/authorize",
          token_endpoint: "https://slack.com/api/oauth.v2.user.access",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    await expect(authorizeMcpServer({
      dataDir: dir,
      name: "slack",
      url: "https://mcp.slack.com/mcp",
      fetchImpl,
      openUrl: () => undefined,
    })).rejects.toThrow(/预先登记/);
  });
});
