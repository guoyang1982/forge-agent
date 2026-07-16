import { describe, expect, it } from "vitest";
import { parseMessages, parseSessions } from "./session-sanitize.js";

describe("Mobile session response sanitization", () => {
  it("keeps only the session fields rendered by the app", () => {
    expect(
      parseSessions({
        sessions: [
          {
            id: "session_01",
            cwd: "/workspace/a",
            updatedAt: "2026-07-16T00:00:00.000Z",
            messageCount: 2,
            lastPreview: "hello",
            secretInternalField: "must-not-pass",
          },
          { id: 123, cwd: "/invalid" },
        ],
      }),
    ).toEqual([
      {
        id: "session_01",
        cwd: "/workspace/a",
        updatedAt: "2026-07-16T00:00:00.000Z",
        messageCount: 2,
        lastPreview: "hello",
      },
    ]);
  });

  it("renders text only and drops unknown roles or non-text parts", () => {
    expect(
      parseMessages({
        messages: [
          { role: "user", content: "hello", hidden: "drop" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "answer" },
              { type: "image_url", image_url: { url: "data:secret" } },
            ],
          },
          { role: "admin", content: "drop" },
        ],
      }),
    ).toEqual([
      { key: "0:user", role: "user", text: "hello" },
      { key: "1:assistant", role: "assistant", text: "answer" },
    ]);
  });
});
