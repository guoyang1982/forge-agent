import { describe, expect, it } from "vitest";
import {
  hostMatchesAllowlist,
  isBlockedHostname,
  validateHttpUrl,
} from "./host-policy.js";

describe("host-policy", () => {
  it("blocks localhost and private IPs", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.0.0.5")).toBe(true);
    expect(isBlockedHostname("192.168.1.1")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(validateHttpUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateHttpUrl("https://example.com").ok).toBe(true);
  });

  it("matches allowedHosts suffix rules", () => {
    expect(hostMatchesAllowlist("api.example.com", ["example.com"])).toBe(true);
    expect(hostMatchesAllowlist("evil.com", ["example.com"])).toBe(false);
    expect(hostMatchesAllowlist("example.com", [])).toBe(true);
  });
});
