import { describe, expect, it } from "vitest";
import { compareCodexVersions, pickNewestCodexBinary } from "./codex-runtime.js";

describe("Codex CLI selection", () => {
  it("prefers a newer ChatGPT-bundled CLI over the older PATH install", () => {
    expect(compareCodexVersions("0.162.0-alpha.17.2", "0.144.3")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.162.1", "0.162.0-alpha.17.2")).toBeGreaterThan(0);
    expect(compareCodexVersions("0.162.0", "0.162.0-alpha.17.2")).toBeGreaterThan(0);

    const picked = pickNewestCodexBinary([
      { path: "/usr/local/bin/codex", version: "0.144.3" },
      {
        path: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        version: "0.162.0-alpha.17.2",
      },
      { path: "/missing", version: null },
    ]);
    expect(picked).toBe("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  });
});
