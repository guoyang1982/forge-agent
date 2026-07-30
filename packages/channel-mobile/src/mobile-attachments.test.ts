import { describe, expect, it } from "vitest";
import { normalizeMobileAttachments } from "./mobile-attachments.js";

describe("normalizeMobileAttachments", () => {
  it("accepts image dataUrls", async () => {
    const tiny = Buffer.from("iVBORw0KGgo=", "base64");
    const dataUrl = `data:image/png;base64,${tiny.toString("base64")}`;
    const out = await normalizeMobileAttachments([
      { kind: "image", name: "a.png", mimeType: "image/png", dataUrl },
    ]);
    expect(out).toEqual([
      { kind: "image", name: "a.png", mimeType: "image/png", dataUrl },
    ]);
  });

  it("accepts file text payloads", async () => {
    const out = await normalizeMobileAttachments([
      { kind: "file", name: "note.md", mimeType: "text/markdown", text: "# hi" },
    ]);
    expect(out[0]).toMatchObject({ kind: "file", name: "note.md", text: "# hi" });
  });

  it("extracts text from rawBase64 plain files", async () => {
    const rawBase64 = Buffer.from("hello from phone", "utf8").toString("base64");
    const out = await normalizeMobileAttachments([
      { kind: "file", name: "hello.txt", mimeType: "text/plain", rawBase64 },
    ]);
    expect(out[0]?.kind).toBe("file");
    expect(out[0]?.text).toContain("hello from phone");
  });

  it("rejects more than five attachments", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      kind: "file" as const,
      name: `f${i}.txt`,
      mimeType: "text/plain",
      text: "x",
    }));
    await expect(normalizeMobileAttachments(items)).rejects.toThrow(/最多附带/);
  });
});
