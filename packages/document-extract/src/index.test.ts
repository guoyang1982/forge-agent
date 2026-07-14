import { describe, expect, it } from "vitest";
import {
  BINARY_DOCUMENT_EXTENSIONS,
  extensionOf,
  extractDocumentText,
  isTextLikeFilename,
  PLAIN_TEXT_EXTENSIONS,
} from "./index.js";

describe("extensionOf", () => {
  it("parses extension", () => {
    expect(extensionOf("report.PDF")).toBe("pdf");
    expect(extensionOf("noext")).toBe("");
    expect(extensionOf(".gitignore")).toBe("gitignore");
    expect(extensionOf("src/foo.ts")).toBe("ts");
  });
});

describe("isTextLikeFilename", () => {
  it("recognizes code and config names", () => {
    expect(isTextLikeFilename("app.vue")).toBe(true);
    expect(isTextLikeFilename("Program.cs")).toBe(true);
    expect(isTextLikeFilename("Dockerfile")).toBe(true);
    expect(isTextLikeFilename(".editorconfig")).toBe(true);
    expect(isTextLikeFilename("binary.exe")).toBe(false);
  });
});

describe("extractDocumentText plain text", () => {
  it("reads utf-8 text files", async () => {
    const buf = Buffer.from("# Hello\n\nworld", "utf-8");
    const r = await extractDocumentText("readme.md", buf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("Hello");
  });

  it("reads typescript source", async () => {
    const buf = Buffer.from("export const x = 1;\n", "utf-8");
    const r = await extractDocumentText("index.ts", buf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("export const");
  });

  it("reads vue SFC", async () => {
    const buf = Buffer.from("<template><p>hi</p></template>\n", "utf-8");
    const r = await extractDocumentText("App.vue", buf);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown binary", async () => {
    const buf = Buffer.from([0, 1, 2, 3, 4, 5]);
    const r = await extractDocumentText("data.bin", buf);
    expect(r.ok).toBe(false);
  });
});

describe("extension sets", () => {
  it("covers common office and code types", () => {
    expect(BINARY_DOCUMENT_EXTENSIONS.has("pdf")).toBe(true);
    expect(PLAIN_TEXT_EXTENSIONS.has("ts")).toBe(true);
    expect(PLAIN_TEXT_EXTENSIONS.has("cs")).toBe(true);
    expect(PLAIN_TEXT_EXTENSIONS.has("vue")).toBe(true);
  });
});
