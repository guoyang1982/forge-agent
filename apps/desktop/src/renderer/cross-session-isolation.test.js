import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("cross-session isolation", () => {
  it("activates the offscreen root before replaying another session's cache", () => {
    const source = appSource();
    const fn = source.match(/withOffscreenRoot: \(sessionId, fn\) => \{[\s\S]*?\n    \},/)?.[0] ?? "";
    expect(fn).toBeTruthy();
    // Replaying the cache resolves mounts via getTimelineMount(): the virtual
    // root must already be active, or dispatch/reflection cards paint onto the
    // visible timeline of whichever session the user is viewing.
    const setIdx = fn.indexOf("state.offscreenTimelineEl = virtual");
    const replayIdx = fn.indexOf("renderTimelineFromState(sessionId, virtual)");
    expect(setIdx).toBeGreaterThan(-1);
    expect(replayIdx).toBeGreaterThan(setIdx);
  });

  it("swaps per-session run artifacts around offscreen event handling", () => {
    const source = appSource();
    const fn = source.match(/withOffscreenRoot: \(sessionId, fn\) => \{[\s\S]*?\n    \},/)?.[0] ?? "";
    // Offscreen events write into state.runPatches (generated images, edits);
    // without loading that session's own map and restoring the viewer's map
    // afterwards, files leak into the viewed session's 文件已修改.
    expect(fn).toContain("loadSessionRunArtifacts(sessionId)");
    expect(fn).toContain("state.runPatches = prevPatches");
    expect(fn).toContain("state.runFinalText = prevFinalText");
    expect(fn).toContain("state.runConclusionRendered = prevConclusionRendered");
  });

  it("refuses to paint another session's cards onto the live timeline", () => {
    const source = appSource();
    const dispatch = source.match(/function renderDispatchTimelineCard[\s\S]*?\n}\n/)?.[0] ?? "";
    const reflection = source.match(/function renderReflectionCard[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(dispatch).toContain("timelineCardSessionMismatch(dispatchState.sessionId)");
    expect(reflection).toContain("timelineCardSessionMismatch(reflectionState.sessionId)");

    const guard = source.match(/function timelineCardSessionMismatch[\s\S]*?\n}\n/)?.[0] ?? "";
    const factory = new Function(
      "state",
      "sessionRuns",
      `${guard}\nreturn { timelineCardSessionMismatch };`,
    );
    const mismatch = (state, sessionRuns, cardSid) =>
      factory(state, sessionRuns).timelineCardSessionMismatch(cardSid);

    const viewingB = { offscreenTimelineEl: null, viewingTimelineSessionId: "B" };
    expect(mismatch(viewingB, null, "A")).toBe(true);
    expect(mismatch(viewingB, null, "B")).toBe(false);
    // Offscreen virtual roots host exactly one session — never blocked.
    expect(
      mismatch({ offscreenTimelineEl: {}, viewingTimelineSessionId: "B" }, null, "A"),
    ).toBe(false);
    // Unknown viewer or anonymous card keeps the legacy behaviour.
    expect(mismatch({ offscreenTimelineEl: null, viewingTimelineSessionId: "" }, null, "A")).toBe(false);
    expect(mismatch(viewingB, null, "_anonymous")).toBe(false);
  });

  it("pins async run-patch writes to their session after awaits", () => {
    const source = appSource();
    // reconcile resolves after awaits — every write must carry the session.
    const reconcile = source.match(
      /async function reconcileRunPatchesFromWorkspace[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(reconcile).toContain("isRunPatchSessionLoaded(sessionId)");
    expect(reconcile).toContain("sessionId: sessionId || undefined");

    // Edit polls capture the session at schedule time, not per tick.
    const turnPoll = source.match(/function scheduleWorkspaceTurnDiffPoll[\s\S]*?\n}\n/)?.[0] ?? "";
    const chipPoll = source.match(/function scheduleCodexChipDiffPoll[\s\S]*?\n}\n/)?.[0] ?? "";
    for (const poll of [turnPoll, chipPoll]) {
      const sidIdx = poll.indexOf("const sid = state.eventRouteSessionId");
      const tickIdx = poll.indexOf("const tick = async");
      expect(sidIdx).toBeGreaterThan(-1);
      expect(tickIdx).toBeGreaterThan(sidIdx);
      expect(poll).toContain("isRunPatchSessionLoaded(sid)");
    }
  });

  it("routes detached recordRunModifiedFile writes into the session's own map", () => {
    const source = appSource();
    const loadedFn = source.match(/function isRunPatchSessionLoaded[\s\S]*?\n}\n/)?.[0] ?? "";
    const ensureFn = source.match(/function ensureSavedRunPatchMap[\s\S]*?\n}\n/)?.[0] ?? "";
    const recordFn = source.match(/function recordRunModifiedFile[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(loadedFn).toBeTruthy();
    expect(ensureFn).toBeTruthy();

    const state = {
      eventRouteSessionId: null,
      liveRunSessionId: null,
      viewingTimelineSessionId: "B",
      runPatches: new Map(),
      runPatchesBySession: new Map(),
    };
    let savedSid = null;
    let uiTouched = 0;
    const factory = new Function(
      "state",
      "normalizeWorkspaceRelPath",
      "getActiveProject",
      "accumulateRuntimeFileStats",
      "isImageFilePath",
      "saveRunPatchesForSession",
      "syncFileEditLiveLabel",
      "updateRunFilesChangedBar",
      "updateRunActivitySummary",
      `${loadedFn}\n${ensureFn}\n${recordFn}\nreturn { recordRunModifiedFile };`,
    );
    const { recordRunModifiedFile } = factory(
      state,
      (cwd, p) => String(p || ""),
      () => ({ cwd: "/proj" }),
      () => ({ contributions: {}, adds: 0, dels: 0 }),
      (p) => /\.(png|jpe?g)$/i.test(p),
      (sid) => { savedSid = sid; },
      () => { uiTouched += 1; },
      () => { uiTouched += 1; },
      () => { uiTouched += 1; },
    );

    // Session A finished offscreen; user is viewing B → detached write.
    recordRunModifiedFile("shot.png", { sessionId: "A" });
    expect(state.runPatches.size).toBe(0);
    expect(state.runPatchesBySession.get("A")?.has("shot.png")).toBe(true);
    expect(state.runPatchesBySession.get("A")?.get("shot.png")?.meta).toBe("已生成图片");
    expect(savedSid).toBe(null);
    expect(uiTouched).toBe(0);

    // Same write while A is the loaded session → normal global-map path.
    state.viewingTimelineSessionId = "A";
    recordRunModifiedFile("code.js", { sessionId: "A" });
    expect(state.runPatches.has("code.js")).toBe(true);
    expect(savedSid).toBe("A");
    expect(uiTouched).toBeGreaterThan(0);
  });

  it("records talent-fold thinking under the subagent child and dedupes by id", () => {
    const source = appSource();
    const deepFn = source.match(/function findThinkingEntryDeep[\s\S]*?\n}\n/)?.[0] ?? "";
    const recordFn = source.match(/function recordThinkingEntry[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(deepFn).toBeTruthy();
    expect(recordFn).toBeTruthy();

    const runEntry = { type: "run_activity", children: [] };
    const subagent = { type: "subagent", talent: { mention: "chengyan" }, children: [] };
    runEntry.children.push(subagent);
    const state = { suppressTimelineRecording: false };
    const factory = new Function(
      "state",
      "getNormalTimelineState",
      "findTimelineRunActivityEntry",
      "normalizeTalentMention",
      "findTimelineSubagentChild",
      "touchTimelineState",
      `${deepFn}\n${recordFn}\nreturn { recordThinkingEntry };`,
    );
    const { recordThinkingEntry } = factory(
      state,
      () => ({ sessionId: "s1", entries: [runEntry] }),
      () => runEntry,
      (m) => String(m || "").toLowerCase(),
      (entry, holder) => (holder?.isTalentFold ? subagent : null),
      () => {},
    );

    const holder = { isTalentFold: true };
    recordThinkingEntry("s1", "7", { mention: "chengyan" }, "程砚 · 思考中（可展开）", "", holder);
    recordThinkingEntry("s1", "7", { mention: "chengyan" }, "", "分析依赖风险…", holder);

    // One entry, nested in the subagent child — not duplicated at the top level.
    expect(subagent.children).toHaveLength(1);
    expect(subagent.children[0].content).toBe("分析依赖风险…");
    expect(runEntry.children.filter((child) => child.type === "thinking")).toHaveLength(0);

    // Top-level (coordinator) thinking still lands on the run activity itself.
    recordThinkingEntry("s1", "8", null, "思考中（可展开）", "汇总中", null);
    expect(runEntry.children.filter((child) => child.type === "thinking")).toHaveLength(1);
  });

  it("snapshots nested talent folds so cache sync cannot drop 程砚/老周", () => {
    const source = appSource();
    const snapChild =
      source.match(/function snapshotDomTimelineChild[\s\S]*?\n}\n/)?.[0] ?? "";
    const snapBody =
      source.match(/function snapshotRunActivityBodyChildren[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(snapChild).toContain("subagent-talent-activity");
    expect(snapChild).toContain('type: "subagent"');
    // Nested body must be walked — otherwise only Nina's outer shell survives.
    expect(snapChild).toContain("snapshotRunActivityBodyChildren");
    expect(snapBody).toBeTruthy();

    const sync =
      source.match(/function syncStructuredTimelineFromDom[\s\S]*?\n}\n/)?.[0] ?? "";
    // Blind overwrite of a richer structured tree with a flat DOM snapshot
    // must not discard subagent shells.
    expect(sync).toMatch(/subagent|mergeRunActivityChildren|preserveSubagent/);
  });

  it("finalizes stuck talent folds and avoids ghost multi-hour 已处理 labels", () => {
    const source = appSource();
    expect(source).toContain("function finalizeOrphanSubagentFolds");
    const finalize =
      source.match(/function finalizeRunActivity[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(finalize).toContain("finalizeOrphanSubagentFolds");

    const restore =
      source.match(/async function restoreSessionTimeline[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(restore).toContain("finalizeOrphanSubagentFolds");
    expect(restore).toContain("omitDuration: true");

    const summary =
      source.match(/function updateRunActivitySummary[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(summary).toContain("omitDuration");
  });
});

describe("session restore performance", () => {
  it("loads the full latest-turn journal instead of a recent-tail event window", () => {
    const source = appSource();
    const restore =
      source.match(/async function restoreSessionTimeline[\s\S]*?\n}\n/)?.[0] ?? "";
    // Must not pass a small eventLimit — that used listRecentEvents and clipped
    // team sessions after Nina's thinking stream filled the window.
    expect(restore).toContain("getSessionMessages(sessionId, 2000)");
    expect(restore).not.toMatch(/getSessionMessages\(sessionId,\s*2000,\s*1500\)/);
    expect(restore).toContain("finalizeOrphanSubagentFolds");
    expect(restore).toContain("omitDuration: true");
    // Daemon restore must not skip journal replay just because an incomplete
    // (no-conclusion) memory cache looks rich.
    expect(restore).toContain("cacheHasConclusion");
    expect(restore).toContain("running || cacheHasConclusion");

    const replay =
      source.match(/function renderPersistedSessionEvents[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(replay).toContain("options.truncated");
    expect(replay).toContain("clearStructuredTimelineForRestore");

    const preload = readFileSync(join(here, "../preload.ts"), "utf-8");
    expect(preload).toContain("getSessionMessages:");
    // Defaulting eventLimit to 1500 silently drops `done` on long runs.
    expect(preload).not.toMatch(/eventLimit\s*=\s*1500/);
    expect(preload).toContain("typeof eventLimit === \"number\"");
  });

  it("rebuilds prior turns from messages before replaying the latest-turn journal", () => {
    const source = appSource();
    const restore =
      source.match(/async function restoreSessionTimeline[\s\S]*?\n}\n/)?.[0] ?? "";
    // Latest-turn-only events must not leave older turns as bare 开始执行 rows.
    expect(restore).toContain("messagesBeforeLatestTurns");
    expect(restore).toContain("countPersistedSessionStarts");
    expect(restore).toContain("expectedPrompts > journalStarts");
    const priorIdx = restore.indexOf(
      "renderRestoredSession(sessionId, priorMessages, checkpoints, dispatchPlans)",
    );
    const journalAfterPrior = restore.indexOf(
      "renderPersistedSessionEvents(",
      priorIdx,
    );
    expect(priorIdx).toBeGreaterThan(-1);
    expect(journalAfterPrior).toBeGreaterThan(priorIdx);

    const ensure =
      source.match(/function ensureRestoredPromptFromPreview[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(ensure).toContain("isLatestSuffix");
    expect(source).toContain("function messagesBeforeLatestTurns");
    expect(source).toContain("function countPersistedSessionStarts");
  });

  it("slices messagesBeforeLatestTurns to every turn before the journal window", () => {
    const source = appSource();
    const group =
      source.match(/function groupRestoredTurns[\s\S]*?\n}\n/)?.[0] ?? "";
    const dedupe =
      source.match(/function turnsWithDedupedPrompts[\s\S]*?\n}\n/)?.[0] ?? "";
    const before =
      source.match(/function messagesBeforeLatestTurns[\s\S]*?\n}\n/)?.[0] ?? "";
    const { messagesBeforeLatestTurns } = new Function(
      `
        function plainUserContent(content) {
          if (typeof content === "string") return content;
          return "";
        }
        function formatUserPromptForDisplay(text) {
          return String(text || "").trim();
        }
        function isTeamDispatchFollowupMessage() { return false; }
        ${group}
        ${dedupe}
        ${before}
        return { messagesBeforeLatestTurns };
      `,
    )();
    const messages = [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" },
      { role: "user", content: "再分析下" },
      { role: "assistant", content: "最新答" },
    ];
    const prior = messagesBeforeLatestTurns(messages, 1);
    expect(prior.map((m) => m.content)).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
    ]);
    expect(messagesBeforeLatestTurns(messages, 2).map((m) => m.content)).toEqual([
      "第一问",
      "第一答",
    ]);
    expect(messagesBeforeLatestTurns(messages, 3)).toEqual([]);
  });
});
