import { describe, expect, it } from "vitest";
import type { MessageItem } from "../screens/session-sanitize.js";
import {
  applyAttachmentPreviews,
  normalizeSessionPreviews,
  prunePreviewStore,
  stripMissingLocalUris,
  type PreviewStoreShape,
} from "./attachment-preview-policy.js";

describe("attachment preview cache merge", () => {
  it("fills localUri onto matching history placeholders", () => {
    const merged = applyAttachmentPreviews(
      [
        {
          key: "m:1",
          role: "user",
          text: "请查看附件",
          attachments: [{ kind: "image", name: "a.jpg" }],
        },
      ],
      [{ kind: "image", name: "a.jpg", localUri: "file:///tmp/a.jpg" }],
    );
    expect(merged[0]?.attachments?.[0]?.localUri).toBe("file:///tmp/a.jpg");
  });

  it("leaves unmatched placeholders alone", () => {
    const merged = applyAttachmentPreviews(
      [
        {
          key: "m:1",
          role: "user",
          text: "hi",
          attachments: [{ kind: "file", name: "note.txt" }],
        },
      ],
      [{ kind: "image", name: "a.jpg", localUri: "file:///tmp/a.jpg" }],
    );
    expect(merged[0]?.attachments?.[0]?.localUri).toBeUndefined();
  });

  it("matches by basename when history and local names differ by path", () => {
    const merged = applyAttachmentPreviews(
      [
        {
          key: "m:1",
          role: "user",
          text: "请查看附件",
          attachments: [{ kind: "image", name: "/tmp/upload/a.jpg" }],
        },
      ],
      [{ kind: "image", name: "a.jpg", localUri: "file:///tmp/a.jpg" }],
    );
    expect(merged[0]?.attachments?.[0]?.localUri).toBe("file:///tmp/a.jpg");
  });
});

describe("attachment preview cache retention", () => {
  it("prefers newest duplicates and drops expired entries", () => {
    const now = 1_000_000;
    const next = normalizeSessionPreviews(
      [{ kind: "image", name: "a.jpg", localUri: "file:///old.jpg", updatedAt: now - 1_000 }],
      [
        { kind: "image", name: "a.jpg", localUri: "file:///new.jpg", updatedAt: now - 100 },
        { kind: "file", name: "note.txt", localUri: "file:///note.txt", updatedAt: now - 20 * 24 * 60 * 60 * 1000 },
      ],
      now,
    );
    expect(next.length).toBe(1);
    expect(next[0]?.localUri).toBe("file:///new.jpg");
  });

  it("keeps most recent sessions in store prune", () => {
    const store: PreviewStoreShape = {
      bySession: Object.fromEntries(
        Array.from({ length: 45 }, (_, idx) => [`s${idx}`, [{ kind: "image", name: `${idx}.jpg`, updatedAt: idx }]]),
      ),
      updatedAtBySession: Object.fromEntries(Array.from({ length: 45 }, (_, idx) => [`s${idx}`, idx])),
    };
    const pruned = prunePreviewStore(store);
    expect(Object.keys(pruned.bySession).length).toBe(40);
    expect(pruned.bySession.s44).toBeTruthy();
    expect(pruned.bySession.s0).toBeUndefined();
  });

  it("drops previews whose local files are gone", () => {
    const kept = stripMissingLocalUris(
      [
        { kind: "image", name: "alive.jpg", localUri: "file:///alive.jpg" },
        { kind: "image", name: "gone.jpg", localUri: "file:///gone.jpg" },
        { kind: "file", name: "no-uri.txt" },
      ],
      (uri) => uri.endsWith("alive.jpg"),
    );
    expect(kept).toEqual([{ kind: "image", name: "alive.jpg", localUri: "file:///alive.jpg" }]);
  });

  it("treats exists() exceptions as missing", () => {
    const kept = stripMissingLocalUris(
      [{ kind: "image", name: "x.jpg", localUri: "file:///x.jpg" }],
      () => {
        throw new Error("fs boom");
      },
    );
    expect(kept).toEqual([]);
  });
});
