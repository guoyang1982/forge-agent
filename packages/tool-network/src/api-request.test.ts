import { describe, expect, it } from "vitest";
import { apiRequest } from "./api-request.js";

describe("apiRequest", () => {
  it("rejects unsupported methods", async () => {
    const result = await apiRequest({
      method: "TRACE",
      url: "https://example.com",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported method/);
  });

  it("returns JSON body from mock fetch", async () => {
    const result = await apiRequest({
      method: "GET",
      url: "https://api.example.com/v1/ping",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(result.ok).toBe(true);
    expect(result.body).toContain("ok");
    expect(result.status).toBe(200);
  });

  it("rejects binary responses with hint", async () => {
    const result = await apiRequest({
      method: "GET",
      url: "https://example.com/file.bin",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.binary).toBe(true);
    expect(result.hint).toMatch(/download_file/);
  });

  it("blocks private hosts", async () => {
    const result = await apiRequest({
      method: "GET",
      url: "http://127.0.0.1/admin",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Blocked host/);
  });
});
