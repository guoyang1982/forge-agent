import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("structured timeline state", () => {
  it("uses JSON entries as the only timeline cache", () => {
    const source = appSource();
    expect(source).not.toContain("timelineBySession");
    expect(source).toContain("entries: []");
    expect(source).toContain("function renderTimelineFromState(");
    expect(source).toContain("function structuredTimelineCacheUsable(");
    expect(source).toContain("suppressTimelineRecording");
    expect(source).toContain('type: "run_activity"');
    expect(source).toContain('type: "plan_card"');
    expect(source).toContain('type: "dispatch_card"');
    expect(source).toContain('type: "conclusion"');
  });

  it("records timeline mutations without DOM closest() on the hot path", () => {
    const source = appSource();
    const should = source.match(
      /function shouldRecordTimelineEvent[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(should).not.toContain("closest(");
    expect(source).toContain("recordTimelineEvent(container, line");
  });

  it("restores sessions from structured state only in session-run-ui", () => {
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    const restore = ui.match(
      /function restoreTimelineSnapshot[\s\S]*?\n    \}/,
    )?.[0] ?? "";
    expect(restore).toContain("structuredTimelineCacheUsable");
    expect(restore).toContain("renderTimelineFromState");
    expect(restore).not.toContain("timeline.innerHTML");
    expect(ui).not.toContain("captureTimelineSnapshot");
  });

  it("inserts plan cards after the user prompt in structured timeline entries", () => {
    const source = appSource();
    expect(source).toContain("function findTurnScopedCardIndex(entries, cardType)");
    expect(source).toContain("function placePlanCardOnMount(card, mount)");
    const fn = source.match(/function findTurnScopedCardIndex[\s\S]*?\n}\n/)?.[0] ?? "";
    const { findTurnScopedCardIndex } = new Function(`${fn}\nreturn { findTurnScopedCardIndex };`)();
    const entries = [
      { type: "event", isUserPrompt: true },
      { type: "run_activity" },
      { type: "conclusion" },
    ];
    expect(findTurnScopedCardIndex(entries, "plan_card")).toBe(1);
  });

  it("reduces reflection events into a per-session state machine", () => {
    const source = appSource();
    const getState = source.match(/function getReflectionState[\s\S]*?\n}\n/)?.[0] ?? "";
    const reduce = source.match(/function reduceReflectionEvent[\s\S]*?\n}\n/)?.[0] ?? "";
    const factory = new Function(
      "state",
      "getActiveEventSessionId",
      `${getState}\n${reduce}\nreturn { reduceReflectionEvent };`,
    );
    const state = { reflectionBySession: new Map() };
    const { reduceReflectionEvent } = factory(state, () => "s1");

    const start = reduceReflectionEvent({ type: "reflection_start", sessionId: "s1", round: 1 });
    expect(start.status).toBe("reviewing");
    expect(start.round).toBe(1);
    expect(start.issues).toEqual([]);

    const revise = reduceReflectionEvent({
      type: "reflection_verdict",
      sessionId: "s1",
      round: 1,
      verdict: "revise",
      reworking: true,
      issues: [
        { dimension: "completeness", severity: "blocker", detail: "漏点", suggestedAction: "补上" },
      ],
    });
    expect(revise.status).toBe("revise");
    expect(revise.issues).toHaveLength(1);
    expect(revise.delivered).toBeFalsy();

    // verdict=revise but gate not met (reworking=false) -> released, not 需返工
    const minorOnly = reduceReflectionEvent({
      type: "reflection_verdict",
      sessionId: "s1",
      round: 1,
      verdict: "revise",
      reworking: false,
      issues: [
        { dimension: "grounding", severity: "minor", detail: "无证据", suggestedAction: "补证据" },
      ],
    });
    expect(minorOnly.status).toBe("pass");
    expect(minorOnly.issues).toHaveLength(1);

    const pass = reduceReflectionEvent({
      type: "reflection_verdict",
      sessionId: "s1",
      round: 2,
      verdict: "pass",
      reworking: false,
      issues: [],
    });
    expect(pass.status).toBe("pass");
    expect(pass.issues).toEqual([]);
    // same session object is mutated in place, not duplicated
    expect(state.reflectionBySession.size).toBe(1);
  });

  it("renders a reflection issue row with dimension label and severity", () => {
    const source = appSource();
    const labels = source.match(/const REFLECTION_DIMENSION_LABELS = \{[\s\S]*?\};/)?.[0] ?? "";
    const fn = source.match(/function renderReflectionIssueRow[\s\S]*?\n}\n/)?.[0] ?? "";
    const factory = new Function(
      "escapeHtml",
      "truncateToolSummary",
      `${labels}\n${fn}\nreturn { renderReflectionIssueRow };`,
    );
    const { renderReflectionIssueRow } = factory(
      (s) => String(s),
      (s) => String(s),
    );
    const html = renderReflectionIssueRow({
      dimension: "grounding",
      severity: "blocker",
      detail: "断言无证据",
      suggestedAction: "去核对来源",
    });
    expect(html).toContain("接地性");
    expect(html).toContain("阻断");
    expect(html).toContain("is-error");
    expect(html).toContain("断言无证据");
    expect(html).toContain("去核对来源");
  });

  it("classifies subagent failure only from explicit daemon prefixes", () => {
    const source = appSource();
    const fn = source.match(/function isSubagentFailureSummary[\s\S]*?\n}\n/)?.[0] ?? "";
    const { isSubagentFailureSummary } = new Function(`${fn}\nreturn { isSubagentFailureSummary };`)();
    expect(isSubagentFailureSummary("Game Audio Engineer: 失败 — timeout")).toBe(true);
    expect(isSubagentFailureSummary("子代理失败: boom")).toBe(true);
    expect(
      isSubagentFailureSummary(
        "Game Audio Engineer: 已补上事件式 Web Audio，包含失败兜底与 Combo 音效",
      ),
    ).toBe(false);
  });
});
