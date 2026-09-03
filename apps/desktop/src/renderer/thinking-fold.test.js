import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

function extractHelpers() {
  const source = appSource();
  const snap = source.match(/function snapshotDomTimelineChild[\s\S]*?\n}\n/)?.[0] ?? "";
  const flat = source.match(/function isFlattenedThinkingEvent[\s\S]*?\n}\n/)?.[0] ?? "";
  const fromFlat = source.match(/function thinkingEntryFromFlattenedEvent[\s\S]*?\n}\n/)?.[0] ?? "";
  const heal = source.match(/function healFlattenedThinkingChildren[\s\S]*?\n}\n/)?.[0] ?? "";
  expect(snap).toBeTruthy();
  expect(flat).toBeTruthy();
  expect(fromFlat).toBeTruthy();
  expect(heal).toBeTruthy();
  const factory = new Function(
    "domLineTextContent",
    "timelineEntryId",
    `${flat}\n${fromFlat}\n${heal}\n${snap}\nreturn { snapshotDomTimelineChild, thinkingEntryFromFlattenedEvent, healFlattenedThinkingChildren };`,
  );
  return factory((node) => String(node?.textContent || "").trim(), () => "id-1");
}

describe("thinking fold snapshot and restore", () => {
  it("snapshots details.event.thinking before the generic event branch", () => {
    const snap =
      appSource().match(/function snapshotDomTimelineChild[\s\S]*?\n}\n/)?.[0] ?? "";
    const thinkingIdx = snap.indexOf('contains("thinking")');
    const eventIdx = snap.indexOf('contains("event")');
    expect(thinkingIdx).toBeGreaterThan(-1);
    expect(eventIdx).toBeGreaterThan(-1);
    expect(thinkingIdx).toBeLessThan(eventIdx);
  });

  it("keeps thinking as a collapsed fold instead of flattening summary+body", () => {
    const { snapshotDomTimelineChild } = extractHelpers();
    const node = {
      tagName: "DETAILS",
      classList: {
        contains: (name) => name === "event" || name === "thinking",
        [Symbol.iterator]: function* () {
          yield "event";
          yield "thinking";
        },
      },
      dataset: { thinkingId: "t1", talentMention: "", userPinned: "" },
      open: false,
      querySelector: (sel) => {
        if (sel === "summary") return { textContent: "思考中（可展开）" };
        if (sel === ".event-pre") return { textContent: "按 ship-team 规范设计小游戏。" };
        return null;
      },
    };
    expect(snapshotDomTimelineChild(node, "s1")).toMatchObject({
      type: "thinking",
      id: "t1",
      summary: "思考中（可展开）",
      content: "按 ship-team 规范设计小游戏。",
      open: false,
    });
  });

  it("rebuilds a fold from already-flattened restore cache rows", () => {
    const { thinkingEntryFromFlattenedEvent, healFlattenedThinkingChildren } =
      extractHelpers();
    const flattened = {
      type: "event",
      id: "old",
      className: "thinking",
      text: "思考中（可展开）按 ship-team 规范设计小游戏。先找 talent-teams.json。",
    };
    const healedThinking = thinkingEntryFromFlattenedEvent(flattened);
    expect(healedThinking).toMatchObject({
      type: "thinking",
      open: false,
      content: "按 ship-team 规范设计小游戏。先找 talent-teams.json。",
    });
    expect(healedThinking.summary).toMatch(/^思考完成 · \d+ 字$/);
    const healed = healFlattenedThinkingChildren([
      flattened,
      { type: "event", className: "status", text: "◇ 团队负责人汇总中…" },
    ]);
    expect(healed[0].type).toBe("thinking");
    expect(healed[1].type).toBe("event");
  });
});
