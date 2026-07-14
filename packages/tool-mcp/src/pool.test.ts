import { describe, expect, it } from "vitest";
import { mcpPoolCacheKey } from "./pool.js";

describe("mcpPoolCacheKey", () => {
  it("is stable for same cwd and servers", () => {
    const servers = [
      {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/a"],
      },
    ];
    const a = mcpPoolCacheKey("/tmp/a", servers);
    const b = mcpPoolCacheKey("/tmp/a", servers);
    expect(a).toBe(b);
  });

  it("differs when cwd changes", () => {
    const servers = [{ name: "fs", command: "npx", args: [] }];
    expect(mcpPoolCacheKey("/a", servers)).not.toBe(mcpPoolCacheKey("/b", servers));
  });
});
