import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const renderSource = source.match(/function renderPersonaActiveBanner\b[\s\S]*?\n}\n/)[0];

function node(text = "", classes = []) {
  const tokens = new Set(classes);
  return { textContent: text, dataset: {}, classList: {
    contains: (value) => tokens.has(value),
    add: (...values) => values.forEach((value) => tokens.add(value)),
  } };
}

function fixture() {
  let root = { children: [] };
  const state = {};
  const render = new Function("state", "getTimelineMount", "pushEvent",
    "updateRunActivityPersonaChip", "getActiveEventSessionId", "updateTimelineEventEntry",
    `${renderSource}; return renderPersonaActiveBanner;`)(
      state, () => root, (text, cls) => {
        const line = node(text, [cls]);
        root.children.push(line);
        return line;
      }, () => {}, () => "session", () => {},
    );
  return { render, state, get root() { return root; }, switchSession() { root = { children: [] }; } };
}

const event = { loaded: true, label: "苏衡 · 高级开发工程师", promptChars: 3134 };

describe("persona status banner", () => {
  it("renders repeated delivery of the same status only once within a turn", () => {
    const f = fixture();
    f.render(event);
    f.render(event);
    expect(f.root.children).toHaveLength(1);
    expect(f.root.children[0].classList.contains("persona-ok")).toBe(true);
  });

  it("reuses a restored status row without relying on a live-only marker", () => {
    const f = fixture();
    f.root.children.push(node("人设状态：已使用 · 成功生效 · 苏衡 · 高级开发工程师（3134 字）", ["persona-ok"]));
    f.render(event);
    expect(f.root.children).toHaveLength(1);
  });

  it("preserves the same status in another turn and another session", () => {
    const f = fixture();
    f.render(event);
    f.root.children.push(node("next prompt", ["user-prompt"]));
    f.render(event);
    expect(f.root.children).toHaveLength(3);
    f.switchSession();
    f.render(event);
    expect(f.root.children).toHaveLength(1);
  });

  it("does not suppress a changed outcome or a different employee", () => {
    const f = fixture();
    f.render({ ...event, loaded: false, reason: "missing" });
    f.render(event);
    f.render({ ...event, label: "另一位员工" });
    expect(f.root.children).toHaveLength(3);
  });
});
