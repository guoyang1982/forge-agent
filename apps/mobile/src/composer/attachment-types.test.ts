import { describe, expect, it } from "vitest";
import {
  collectSettledAttachments,
  estimateAttachmentChars,
  isImageFilename,
  isProbablyTextFilename,
  toRpcAttachments,
  type PendingAttachment,
} from "./attachment-types.js";

describe("composer attachment helpers", () => {
  it("detects image and text filenames", () => {
    expect(isImageFilename("a.PNG")).toBe(true);
    expect(isProbablyTextFilename("notes.md")).toBe(true);
    expect(isProbablyTextFilename("report.pdf")).toBe(false);
  });

  it("maps pending attachments to rpc payloads", () => {
    const items: PendingAttachment[] = [
      {
        id: "1",
        kind: "image",
        name: "a.jpg",
        mimeType: "image/jpeg",
        localUri: "file:///tmp/a.jpg",
        dataUrl: "data:image/jpeg;base64,xx",
      },
      {
        id: "2",
        kind: "file",
        name: "a.txt",
        mimeType: "text/plain",
        text: "hello",
      },
    ];
    expect(toRpcAttachments(items)).toEqual([
      {
        kind: "image",
        name: "a.jpg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,xx",
      },
      {
        kind: "file",
        name: "a.txt",
        mimeType: "text/plain",
        text: "hello",
      },
    ]);
    expect(estimateAttachmentChars(items)).toBeGreaterThan(10);
  });

  it("keeps successful items when one encode fails", async () => {
    const { items, errors } = await collectSettledAttachments(
      ["ok.png", "bad.png", "also.txt"],
      async (name) => {
        if (name === "bad.png") throw new Error(`文件过大：${name}`);
        return { name };
      },
    );
    expect(items).toEqual([{ name: "ok.png" }, { name: "also.txt" }]);
    expect(errors).toEqual(["文件过大：bad.png"]);
  });
});
