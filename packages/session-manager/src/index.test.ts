import { describe, expect, it } from "vitest";
import { formatSessionsList } from "./index.js";

describe("formatSessionsList", () => {
  it("marks the active session and includes previews", () => {
    const out = formatSessionsList(
      [
        {
          id: "abcdef123456",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 3,
          lastPreview: "latest user request",
        },
      ],
      "abcdef123456",
    );

    expect(out).toContain("* abcdef12");
    expect(out).toContain("3 msgs");
    expect(out).toContain("latest user request");
  });
});
