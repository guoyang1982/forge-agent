import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const extract = (name) => source.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n}\\n`))?.[0] || "";
function fixture() {
  const element = () => ({ dataset: {}, classList: { add() {}, contains(name) { return name === "user-prompt" && this.prompt; } } });
  const container = () => ({ children: [], appendChild(line) { this.children.push(line); } });
  const records = [];
  const push = new Function("document", "state", "getActiveEventSessionId", "getEventDetailStore",
    "serializeEventDetail", "maybeScrollTimeline", "recordTimelineEvent",
    `${extract("findRepeatedSetupEvent")}\n${extract("pushEventIn")}\n${extract("renderStructuredEventLine")}\nreturn Object.assign(pushEventIn, { restore: renderStructuredEventLine });`)(
    { createElement: element }, { eventSeq: 0, detailById: new Map() }, () => "session",
    () => new Map(), JSON.stringify, () => {}, (...args) => records.push(args),
  );
  return { push, container, element, records };
}
describe("setup event replay deduplication", () => {
  it("does not repaint duplicate setup rows already present in historical cache", () => {
    const { push, container } = fixture();
    const root = container();
    const entry = { id: "one", text: "Skill 目录 87 个（未预加载，模型按需读取）", className: "status" };
    push.restore(entry, root, "session");
    push.restore({ ...entry, id: "two" }, root, "session");
    expect(root.children).toHaveLength(1);
  });
  it("records repeated Skill catalogue notices once", () => {
    const { push, container, records } = fixture();
    const root = container();
    push(root, "Skill 目录 87 个（未预加载，模型按需读取）", "status");
    push(root, "Skill 目录 87 个（未预加载，模型按需读取）", "status");
    expect(root.children).toHaveLength(1);
    expect(records).toHaveLength(1);
  });
  it("deduplicates model understanding by detail, not just its common heading", () => {
    const { push, container } = fixture();
    const root = container();
    const detail = { title: "模型理解", content: "目标：生成内容" };
    push(root, "模型理解", "skill-hit", detail);
    push(root, "模型理解", "skill-hit", { ...detail });
    expect(root.children).toHaveLength(1);
    push(root, "模型理解", "skill-hit", { ...detail, content: "目标：审核内容" });
    expect(root.children).toHaveLength(2);
  });
  it("keeps notices separate across turns and agent/session containers", () => {
    const { push, container, element } = fixture();
    const root = container();
    const text = "Skill 目录 87 个（未预加载，模型按需读取）";
    push(root, text, "status");
    const prompt = element();
    prompt.classList.prompt = true;
    root.appendChild(prompt);
    push(root, text, "status");
    expect(root.children).toHaveLength(3);
    const other = container();
    push(other, text, "status");
    expect(other.children).toHaveLength(1);
  });
  it("does not hide repeated ordinary execution messages", () => {
    const { push, container } = fixture();
    const root = container();
    push(root, "正在执行", "status");
    push(root, "正在执行", "status");
    expect(root.children).toHaveLength(2);
  });
});
