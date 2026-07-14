import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("copy buttons in the timeline", () => {
  it("decorates markdown code blocks and the conclusion with copy actions", () => {
    const source = appSource();
    expect(source).toContain("decorateMarkdownCodeBlocks(host)");
    expect(source).toContain('data-copy-action="code"');
    expect(source).toContain('data-copy-action="conclusion"');
    expect(source).toContain("navigator.clipboard.writeText");
    // Clicks must be delegated — direct listeners die on innerHTML repaints.
    expect(source).toContain('closest("[data-copy-action]")');
  });

  it("renders generated workspace images in conclusions", () => {
    const source = appSource();
    const preload = readFileSync(join(here, "../preload.ts"), "utf-8");
    const main = readFileSync(join(here, "../main.ts"), "utf-8");
    const css = readFileSync(join(here, "styles.css"), "utf-8");

    expect(preload).toContain("readWorkspaceImage");
    expect(main).toContain("forge:read-workspace-image");
    expect(source).toContain("function extractImagePathsFromText");
    expect(source).toContain("function mergeConclusionImageFiles");
    expect(source).toContain("function buildRunGeneratedImagesHtml");
    expect(source).toContain("function hydrateGeneratedImages");
    expect(source).toContain("recordGeneratedImagePathsFromText(result)");
    expect(source).toContain("recordGeneratedImagePathsFromText(text)");
    expect(source).toContain("hydrateMarkdownLocalImages(host)");
    expect(css).toContain(".generated-images-list");
    expect(css).toContain(".image-file-preview");
  });
});

describe("prompt history recall", () => {
  it("ArrowUp recalls past prompts only from an empty composer", () => {
    const source = appSource();
    expect(source).toContain("handlePromptHistoryKey(e)");
    const handler = source.match(
      /function handlePromptHistoryKey[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(handler).toContain('input.value.trim() !== ""');
    expect(handler).toContain("promptHistory.draft");
  });

  it("records sent messages with consecutive-dedup and a cap", () => {
    const source = appSource();
    expect(source).toContain("pushPromptHistory(message)");
    const push = source.match(/function pushPromptHistory[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(push).toContain("items.length > 50");
  });
});

describe("performance and quick-win batch", () => {
  it("touches structured timeline state instead of serializing innerHTML", () => {
    const source = appSource();
    expect(source).not.toContain("timelineBySession");
    expect(source).toContain("function syncTimelineCacheForSession(sessionId)");
    const sync = source.match(/function syncTimelineCacheForSession[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(sync).toContain("touchTimelineState(sessionId)");
    expect(source).not.toContain("timelineCacheSyncPending");
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    expect(ui).not.toContain("timeline.innerHTML = html");
    expect(ui).toContain("renderTimelineFromState");
  });

  it("syncs restored DOM toggles to the session currently shown in the timeline", () => {
    const source = appSource();
    const fn =
      source.match(/function syncViewedTimelineCacheAfterToggle[\s\S]*?\n}\n/)?.[0] ??
      "";
    expect(fn).toContain("state.viewingTimelineSessionId");
    expect(fn).not.toContain("getViewingSessionId");
  });

  it("double-Esc stops the running session without fighting the palettes", () => {
    const source = appSource();
    const esc = source.match(/if \(e\.key === "Escape" && !e\.isComposing\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
    expect(esc).toContain("escStopArmedAt");
    expect(esc).toContain("composerPaletteOpen()");
    expect(esc).toContain("再按一次 Esc");
  });

  it("reverseUnifiedDiff swaps direction for patch undo", () => {
    const source = appSource();
    const pick = (name) =>
      source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? "";
    const { reverseUnifiedDiff } = new Function(
      `${pick("reverseUnifiedDiff")}\nreturn { reverseUnifiedDiff };`,
    )();
    const fwd = ["--- a/x", "+++ b/x", "@@ -2,3 +2,4 @@ ctx", " keep", "-old", "+new"].join("\n");
    expect(reverseUnifiedDiff(fwd)).toBe(
      ["+++ a/x", "--- b/x", "@@ -2,4 +2,3 @@ ctx", " keep", "+old", "-new"].join("\n"),
    );
    expect(source).toContain("撤销此补丁");
    expect(source).toContain("markPatchAppliedInUi(detail.patch.path, false)");
  });

  it("prompt history persists across restarts", () => {
    const source = appSource();
    expect(source).toContain('"forge.promptHistory"');
    expect(source).toContain("loadPromptHistory()");
    expect(source).toContain("localStorage.setItem(PROMPT_HISTORY_LS_KEY");
  });

  it("marks sessions finished off-screen as unread until opened", () => {
    const source = appSource();
    expect(source).toContain("unreadDoneSessions: new Set()");
    expect(source).toContain("state.unreadDoneSessions.add(finishedSid)");
    expect(source).toContain("session-unread-dot");
    expect(source).toContain("unreadDoneSessions.delete(sessionId)");
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    expect(ui).toContain("unreadDoneSessions?.delete(newSessionId)");
  });
});

describe("sub-agent delegation", () => {
  it("renders subagent_start/end as timeline cards", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "subagent_start"');
    expect(source).toContain('ev.type === "subagent_end"');
    expect(source).toContain("🤖 子代理");
    expect(source).toContain("子代理结果");
  });
});

describe("command confirmation", () => {
  it("renders a command permission card with allow-once / always options", () => {
    const source = appSource();
    const html = readFileSync(join(here, "index.html"), "utf-8");
    const css = readFileSync(join(here, "styles.css"), "utf-8");
    expect(source).toContain('ev.kind === "command"');
    expect(source).toContain("data-permission-always");
    expect(source).toContain("本会话总是允许");
    expect(source).toContain('composerCard?.classList.add("permission-active")');
    expect(source).not.toContain("等待命令执行确认:");
    const composerIdx = html.indexOf('id="composerCard"');
    const permissionIdx = html.indexOf('id="networkPermissionHost"');
    const inputIdx = html.indexOf('id="messageInput"');
    expect(composerIdx).toBeGreaterThan(-1);
    expect(permissionIdx).toBeGreaterThan(composerIdx);
    expect(permissionIdx).toBeLessThan(inputIdx);
    expect(css).toContain(".composer-card.permission-active #messageInput");
    expect(css).toContain(".composer-card.permission-active .composer-footer");
    // remember flag flows through to the daemon.
    const respond = source.match(/async function respondNetworkPermission[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(respond).toContain("respondPermission({ id, approved, remember })");
    // The settings toggle persists ui.confirmCommands.
    expect(source).toContain("confirmCommands: $(\"settingsConfirmCommandsCheck\")?.checked");
  });
});

describe("settings page layout", () => {
  it("renders settings as a full-page sidebar view instead of a modal card", () => {
    const html = readFileSync(join(here, "index.html"), "utf-8");
    const settings = html.match(/<div id="settingsModal"[\s\S]*?<div id="projectModal"/)?.[0] ?? "";
    expect(settings).toContain("settings-shell");
    expect(settings).toContain("settings-sidebar");
    expect(settings).toContain("settings-content");
    expect(settings).toContain("settings-section-card");
    expect(settings).not.toContain("modal-card");
    expect(settings).not.toContain("modal-mask");
  });

  it("offers a persisted app theme setting", () => {
    const html = readFileSync(join(here, "index.html"), "utf-8");
    const source = appSource();
    expect(html).toContain('id="themeSelect"');
    expect(html).toContain('<option value="system">跟随系统</option>');
    expect(html).toContain('<option value="dark">深色</option>');
    expect(html).toContain('<option value="light">浅色</option>');
    expect(source).toContain('applyTheme(cfg?.ui?.theme ?? "system")');
    expect(source).toContain('theme: $("themeSelect")?.value || "system"');
  });
});

describe("in-session find and compact nudge", () => {
  it("Cmd+F find highlights via the Highlight API without mutating the DOM", () => {
    const source = appSource();
    expect(source).toContain("createTreeWalker(tl, NodeFilter.SHOW_TEXT)");
    expect(source).toContain('CSS.highlights.set("forge-find"');
    expect(source).toContain('CSS.highlights.set("forge-find-active"');
    // Matches inside collapsed folds must be revealed when navigated to.
    const reveal = source.match(/function revealFindMatch[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(reveal).toContain("d.open = true");
    expect(reveal).toContain("state.timelineFollowBottom = false");
  });

  it("nudges once at 90% context and the meter click runs /compact", () => {
    const source = appSource();
    expect(source).toContain("compactNudgedSessions");
    expect(source).toContain("pct >= 90");
    const bind = source.match(/function bindContextMeterCompact[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(bind).toContain('tryHandleSlashCommand("/compact")');
    expect(bind).toContain("runningSessions.has");
  });
});

describe("prompt rendering and session titles", () => {
  it("dedupes the prompt line only within the current turn", () => {
    const source = appSource();
    const fn = source.match(/function timelineHasPromptText[\s\S]*?\n}\n/)?.[0] ?? "";
    // A prompt followed by a conclusion belongs to a finished turn — repeated
    // short replies (可以/继续) must each render their own 开始执行 line.
    expect(fn).toContain('classList?.contains("run-conclusion")');
    expect(fn).toContain("prompts[prompts.length - 1]");
    expect(fn).not.toContain(".some(");
  });

  it("session titles are first-write-wins, never renamed by later turns", () => {
    const source = appSource();
    const fn = source.match(/function upsertSessionInWorkspace[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(fn).toContain('lastPreview: prev?.lastPreview || preview || ""');
  });
});

describe("session export and search", () => {
  it("exports sessions as readable markdown via the save dialog", () => {
    const source = appSource();
    const md = source.match(/function buildSessionMarkdown[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(md).toContain("## 🧑 用户");
    expect(md).toContain("## 🤖 助手");
    expect(md).toContain("toolCallSummary");
    expect(source).toContain("saveTextFile");
    expect(source).toContain('action === "export"');
  });

  it("debounced cross-session search opens hits in their own project", () => {
    const source = appSource();
    expect(source).toContain("searchSessions({ query: q, limit: 20 })");
    expect(source).toContain("setTimeout(() => void runSessionSearch(), 250)");
    const open = source.match(/function openSearchedSession[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(open).toContain("sessionCwdMatches");
    expect(open).toContain("switchSessionView");
  });
});

describe("checkpoint rewind", () => {
  it("attaches a delegated rewind button to the turn's user prompt", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "checkpoint"');
    expect(source).toContain("attachCheckpointToPrompt(ev.sha, ev.turnIndex)");
    expect(source).toContain('closest("[data-checkpoint-sha]")');
    const restore = source.match(
      /async function handleCheckpointRestore[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    // Never rewind under a running session, and always confirm via the dialog.
    expect(restore).toContain("runningSessions.has");
    expect(restore).toContain("showRewindDialog");
    expect(restore).toContain("restoreCheckpoint");
  });

  it("offers code/code+chat rewind and truncates the conversation server-side", () => {
    const source = appSource();
    // The button carries the turn ordinal so truncation knows where to cut.
    expect(source).toContain("data-checkpoint-turn");
    const handler = source.match(/async function handleCheckpointRestore[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(handler).toContain('choice === "code+chat"');
    expect(handler).toContain("truncateConversation: truncate");
    // After a truncating rewind the timeline is rebuilt from the daemon.
    expect(handler).toContain("restoreSessionTimeline(viewingSid");
    expect(handler).toContain("externalSessionVersionSeen.delete(viewingSid)");
    const dialog = source.match(/function showRewindDialog[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(dialog).toContain("文件 + 撤回对话");
    expect(dialog).toContain("canTruncate");
  });

  it("clears stale caches after truncation so the old conclusion is not resurrected", () => {
    const source = appSource();
    const handler = source.match(/async function handleCheckpointRestore[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(handler).toContain("forgetSessionRunCaches(viewingSid)");
    const forget = source.match(/function forgetSessionRunCaches[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(forget).toContain("runConclusionBySession.delete");
    expect(forget).toContain("runFinalTextBySession.delete");
    expect(forget).toContain("normalTimelineBySession.delete");
    // An emptied session shows the new-chat state, not a blank/stale pane.
    const restore = source.match(/async function restoreSessionTimeline[\s\S]*?showChatEmpty\(false\)/)?.[0] ?? "";
    expect(restore).toContain("if (!messages.length)");
    expect(restore).toContain("showChatEmpty(true)");
  });

  it("restored sessions rebuild rewind buttons from persisted checkpoints", () => {
    const source = appSource();
    // Daemon returns checkpoints keyed by user-turn ordinal; restore decorates
    // each turn's prompt line so old sessions get the button too.
    expect(source).toContain("renderRestoredSession(sessionId, messages, checkpoints = [], dispatchPlans = [])");
    expect(source).toContain("checkpointByTurn");
    expect(source).toContain("decoratePromptWithCheckpoint(promptLine, sha, userTurnOrdinal)");
    expect(source).toContain("Array.isArray(res?.checkpoints) ? res.checkpoints : []");
  });
});

describe("task plan card", () => {
  it("renders intent_plan events before execution details", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "intent_plan"');
    expect(source).toContain("模型理解");
    expect(source).toContain("renderIntentPlanCard(ev)");
  });

  it("renders plan_update events as a card instead of tool lines", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "plan_update"');
    expect(source).toContain("renderPlanCard(ev.items || [], state.planCardTitle");
    expect(source).toContain('ev.type === "dispatch_plan"');
    expect(source).toContain("dispatchTimelineBySession: new Map()");
    expect(source).toContain("reduceDispatchTimelineEvent(ev)");
    expect(source).toContain("renderDispatchTimelineCard(dispatchState)");
    expect(source).toContain("applyDispatchTimelineEvent(ev)");
    expect(source).toContain("normalTimelineBySession: new Map()");
    expect(source).toContain("recordTimelineEvent(");
    expect(source).toContain("renderTimelineFromState(");
    expect(source).toContain("structuredTimelineCacheUsable(");
    expect(source).toContain("dispatchPlansByTurnIndex");
    expect(source).toContain("applyRestoredDispatchPlan");
    expect(source).toContain("res?.dispatchPlans");
    // update_plan must not produce ✓/⏺ tool lines, live or restored.
    expect(source).toContain('if (ev.name === "update_plan" || ev.name === "spawn_agent") return;');
    expect(source).toContain('if (name === "update_plan") {');
    // The card must not be hoisted into the activity fold.
    expect(source).toContain('node.classList?.contains("plan-card")');
    expect(source).toContain("shouldHoistNodeIntoRunActivity");
    const card = source.match(/function renderPlanCard[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(card).toContain("任务清单");
    expect(card).toContain("is-active");
    expect(card).toContain("escapeHtml(i.text)");
  });

  it("renders reflection gate events as a card", () => {
    const source = appSource();
    expect(source).toContain("reflectionBySession: new Map()");
    expect(source).toContain('ev.type === "reflection_start" || ev.type === "reflection_verdict"');
    expect(source).toContain("applyReflectionEvent(ev)");
    expect(source).toContain("reduceReflectionEvent(ev)");
    // persisted across session switch via a structured placeholder entry
    expect(source).toContain("recordReflectionCardEntry(");
    expect(source).toContain('entry.type === "reflection_card"');
    // run conclusion closes the rework loop on the card
    expect(source).toContain("markReflectionDelivered(ev.sessionId)");
    const card = source.match(/function renderReflectionCard[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(card).toContain("反思校验");
    expect(card).toContain("reflection-status");
    expect(card).toContain("已退回返工");
    expect(card).toContain("已返工并交付");
  });
});

describe("context usage meter", () => {
  it("stores daemon context_usage events per session and renders a badge", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "context_usage"');
    expect(source).toContain("contextUsageBySession");
    const meter = source.match(/function renderContextMeter[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(meter).toContain("上下文");
    expect(meter).toContain("pct >= 80");
    // Session switches must refresh the badge too.
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    expect(ui).toContain("renderContextMeter?.()");
  });
});

describe("restored team dispatch sessions", () => {
  it("does not render internal coordinator payload as a user prompt", () => {
    const source = appSource();
    expect(source).toContain("isTeamDispatchFollowupMessage");
    expect(source).toContain("parseTeamDispatchSections");
    expect(source).toContain("renderRestoredTeamDispatchTurn");
    expect(source).toContain('name === "spawn_agent"');
    expect(source).toContain("structuredTimelineShouldReload");
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    expect(ui).toContain("structuredTimelineCacheUsable");
    expect(ui).toContain("renderTimelineFromState");
  });
});

describe("restored step narratives", () => {
  it("survive the conclusion render and use markdown", () => {
    const source = appSource();
    // Live stream copies inside the fold are stripped when the root conclusion renders.
    expect(source).toContain(".run-activity-body .assistant-block.narrative-buffer");
    expect(source).toContain(".run-activity-body .run-conclusion-live");
    expect(source).toContain("pruneRunActivityConclusionCopies");
    expect(source).toContain("pruneStructuredRunActivityConclusionCopies");
    const prune = source.match(/function pruneRunActivityConclusionCopies[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(prune).toContain(".codex-commentary");
    expect(source).not.toContain(
      'querySelectorAll(".run-activity-body .assistant-block")',
    );
    const restored = source.match(
      /function appendRestoredAssistantText[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(restored).toContain("step-narrative");
    expect(restored).toContain("beginStepToolGroup");
    expect(restored).toContain("recordStepNarrativeEntry");
    expect(restored).not.toContain("assistant（步骤内说明");
  });

  it("folds tool command lines under step-tool-group", () => {
    const source = appSource();
    expect(source).toContain("step-tool-group");
    expect(source).toContain("getToolEventMount");
    expect(source).toContain("isStructuredToolGroupChild");
    expect(source).toContain("stepToolGroupHasCodexActivity");
    const create =
      source.match(/function createStepToolGroupElement[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(create).toContain("open = false");
    const beginGroup =
      source.match(/function beginStepToolGroup[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(beginGroup).toContain("createStepToolGroupElement(false)");
    const begin = source.match(/function beginToolLine[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(begin).toContain("getToolEventMount");
    const codex = source.match(/function renderCodexActivityChip[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(codex).toContain("getToolEventMount");
    expect(codex).toContain("bumpStepToolGroupCount");
    expect(codex).toContain("stats-updated");
    expect(source).toContain("function codexActivityStatsHtml");
    expect(source).toContain('payload.icon === "file"');
    const commentary = source.match(/function appendCodexCommentaryBlock[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(commentary).toContain("endStepToolGroup");
    expect(commentary).toContain("maybeStartCodexProvisionalFileActivities");
    expect(source).toContain("function extractCodexMentionedFiles");
    expect(source).toContain("scheduleCodexProvisionalFilePoll");
    expect(source).toContain("准备新建");
    expect(source).toContain("record.sawMissing ? 0");
    expect(source).toContain("shouldPreserveStats");
    expect(source).toContain("function removeRunFilesChangedBars");
    const flush = source.match(/function flushStreamText[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(flush).toContain("maybeStartCodexProvisionalFileActivities");
    const css = readFileSync(join(here, "styles.css"), "utf-8");
    expect(css).toContain(".codex-activity-add");
    expect(css).toContain(".codex-activity-del");
    expect(css).toContain("@keyframes codexStatsBump");
  });

  it("dedupes near-duplicate step narratives when tools interrupt streaming", () => {
    const source = appSource();
    expect(source).toContain("isNearDuplicateNarrative");
    const collapse =
      source.match(/function collapseRepeatedCodexText[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(collapse).toContain("isNearDuplicateNarrative");
    expect(collapse).toContain("collapseLeadingReplayCodexText");
    expect(source).toContain("function collapseLeadingReplayCodexText");
    const skip =
      source.match(/function shouldSkipCodexCommentary[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(skip).toContain("isNearDuplicateNarrative");
    const seed =
      source.match(/function seedCodexCommentarySeenFromDom[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(seed).toContain(".run-activity-stream .step-narrative-text");
    const restored =
      source.match(/function appendRestoredAssistantText[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(restored).toContain("collapseRepeatedCodexText");
    expect(restored).toContain("shouldSkipCodexCommentary");
  });

  it("persists intermediate text_delta segments inside 已处理 before tools run", () => {
    const source = appSource();
    const finish = source.match(/function finishStreamTextSegment[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(finish).toContain("appendRestoredAssistantText");
    expect(finish).toContain("dataset?.rawText");
    expect(source).toContain("collapseRepeatedCodexText");
    expect(source).toContain("shouldSkipCodexCommentary");
    const conclusion = source.match(/function renderRunConclusion[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(conclusion).toContain("hadToolSteps");
    expect(conclusion).toContain("dedupeConclusionAgainstStepNarratives");
    expect(conclusion).toContain("turnHasConclusionAfter");
    expect(conclusion).not.toContain('querySelector(":scope > .run-conclusion.done")');
    expect(conclusion).toContain("placeRunConclusionOnMount");
    expect(conclusion).toContain("removeRunFilesChangedBars");
    expect(conclusion).toContain("recordConclusionEntry");
    expect(conclusion).toContain("syncTimelineCacheForSession");
  });

  it("uses standardized runtime activity events and does not persist duplicate live final text", () => {
    const source = appSource();
    expect(source).toContain('ev.type === "runtime_activity"');
    expect(source).toContain("handleRuntimeActivityEvent(ev)");
    const runtimeHandler =
      source.match(/function handleRuntimeActivityEvent[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(runtimeHandler).toContain("beginToolLine");
    expect(runtimeHandler).toContain("completeToolLine");
    expect(runtimeHandler).toContain("handleCodexActivityEvent");

    const conclusion = source.match(/function renderRunConclusion[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(conclusion).toContain("skipPersist");
    expect(conclusion).toContain("isDuplicateConclusionCopy(streamedText, finalCandidate)");
    const finish = source.match(/function finishStreamTextSegment[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(finish).toContain("state.runConclusionRendered");
    expect(finish).toContain("options.skipPersist");
    const dedupe = source.match(/function collectStepNarrativeTexts[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(dedupe).toContain("codex-commentary-text");
    const strip = source.match(/function stripLeadingStepNarratives[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(strip).toContain("isNearDuplicateLeadSentence");
    expect(strip).toContain("isLikelyProcessNarrativeSentence");
    expect(source).toContain("stripLeadingProcessNarrativeSentences");
    expect(source).toContain("recordRunModifiedFile");
  });

  it("keeps the active run timer ticking while work is running", () => {
    const source = appSource();
    expect(source).toContain("runActivityTimer");
    expect(source).toContain("startRunActivityTimer");
    expect(source).toContain("stopRunActivityTimer");
    const summary = source.match(/function updateRunActivitySummary[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(summary).toContain("`${elapsed}s`");
  });

  it("allows one conclusion block per turn in a multi-turn session", () => {
    const source = appSource();
    const record = source.match(/function recordConclusionEntry[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(record).toContain('type === "run_activity"');
    expect(record).not.toContain("last?.type === \"conclusion\"");
    const turnCheck = source.match(/function turnHasConclusionAfter[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(turnCheck).toContain("run-conclusion");
    expect(turnCheck).toContain("user-prompt");
  });
});

describe("session restore timeline", () => {
  it("rejects conclusion-only structured caches and prefers richer restore", () => {
    const source = appSource();
    const usable =
      source.match(/function structuredTimelineCacheUsable[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(usable).toContain("hasRunActivity");
    expect(usable).toContain("!hasUserTurn && !hasRunActivity");
    expect(usable).toContain("hasActivityChildren");
    expect(usable).toContain("leadingPromptOk");
    expect(usable).toContain("turnOrderOk");
    expect(source).toContain("structuredTimelineTurnOrderValid");
    expect(source).toContain("structuredTimelineRunActivityHasSubstantiveChildren");
    expect(source).toContain("clearStructuredTimelineForRestore");
    expect(source).toContain("ensureRestoredPromptFromPreview");
    expect(source).toContain("renderRestoredTurnConclusion");
    expect(source).toContain("findTurnPromptDomAnchor");
    expect(source).toContain("structuredTimelineHasRunActivity");
    expect(source).toContain("syncStructuredTimelineFromDom");
    expect(source).toContain('type: "step_narrative"');
    expect(source).toContain("structuredTimelineTurnOrderValid");
    expect(source).toContain("structuredTimelineMatchesMessages");
    expect(source).toContain("mergeRunActivitySnapshot");
    expect(source).toContain("snapshotRunActivitiesFromCache");
  });

  it("inserts later-turn prompts before their own 已处理/结论 blocks", () => {
    const source = appSource();
    const turnInsert =
      source.match(/function findTurnPromptCacheInsertIndex[\s\S]*?\n}\n/)?.[0] ?? "";
    const leading =
      source.match(/function findLeadingTurnPromptInsertIndex[\s\S]*?\n}\n/)?.[0] ?? "";
    const { findTurnPromptCacheInsertIndex, findLeadingTurnPromptInsertIndex } = new Function(
      `${turnInsert}\n${leading}\nreturn { findTurnPromptCacheInsertIndex, findLeadingTurnPromptInsertIndex };`,
    )();
    const turnOneComplete = [
      { type: "event", isUserPrompt: true },
      { type: "run_activity" },
      { type: "conclusion" },
    ];
    expect(findTurnPromptCacheInsertIndex(turnOneComplete, 1)).toBe(3);
    expect(findLeadingTurnPromptInsertIndex(turnOneComplete)).toBe(3);
    expect(
      findLeadingTurnPromptInsertIndex([
        { type: "run_activity", id: "a1" },
        { type: "conclusion", id: "c1" },
      ]),
    ).toBe(0);
  });

  it("rejects multi-turn caches whose prompts and conclusions are out of order", () => {
    const source = appSource();
    const isCard = source.match(/function isTimelineCardEntry[\s\S]*?\n}\n/)?.[0] ?? "";
    const valid =
      source.match(/function structuredTimelineTurnOrderValid[\s\S]*?\n}\n/)?.[0] ?? "";
    const { structuredTimelineTurnOrderValid } = new Function(
      `${isCard}\n${valid}\nreturn { structuredTimelineTurnOrderValid };`,
    )();
    const ok = [
      { type: "event", isUserPrompt: true },
      { type: "run_activity" },
      { type: "conclusion" },
      { type: "event", isUserPrompt: true },
      { type: "run_activity" },
      { type: "conclusion" },
    ];
    const missingSecondPrompt = [
      { type: "event", isUserPrompt: true },
      { type: "run_activity" },
      { type: "conclusion" },
      { type: "run_activity" },
      { type: "conclusion" },
    ];
    expect(structuredTimelineTurnOrderValid(ok)).toBe(true);
    expect(structuredTimelineTurnOrderValid(missingSecondPrompt)).toBe(false);
  });

  it("rejects partial multi-turn caches when daemon messages have more completed turns", () => {
    const source = appSource();
    expect(source).toContain("turnsWithDedupedPrompts(messages)");
    expect(source).toContain("sanitizeStructuredTimelineCache(sessionId)");
    expect(source).toContain("sessionUsesExternalRuntime(sessionId, messages)");
    expect(source).toContain("mergeRunActivitySnapshot(sessionId, activitySnapshot)");
    expect(source).toContain("turnIndex");
    expect(source).toContain("realignRunActivitiesToTurns");
    expect(source).toContain("findRunActivityDomForTurn(mount, turnIndex)");
    expect(source).toContain("dedupeDomUserPrompts($(\"timeline\"), collectExpectedRestorePrompts(messages, sessionId))");
    expect(source).toContain("structuredTimelineMatchesMessages");
    expect(source).toContain("countExpectedRestoreCompletedTurns");
    expect(source).toContain("countExpectedRestoreActivityTurns");
    const restore =
      source.match(/async function restoreSessionTimeline[\s\S]*?pushEvent\(`恢复会话失败/)?.[0] ?? "";
    expect(restore).toContain("structuredTimelineMatchesMessages(sessionId, messages)");
    expect(restore).toContain("snapshotRunActivitiesFromCache(sessionId)");
    expect(restore).toContain("mergeRunActivitySnapshot(sessionId, activitySnapshot)");
    const begin =
      source.match(/function beginRestoredRunActivity[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(begin).toContain("activeRunEntry = null");
    expect(begin).toContain('ensureRunActivity({ force: true })');
    const append =
      source.match(/function appendRestoredAssistantText[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(append).toContain('ensureRunActivity({ force: true })');
    const conclusion =
      source.match(/function renderRestoredTurnConclusion[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(conclusion).toContain("hadActivity = false");
    expect(conclusion).toContain("user-prompt:last-of-type");
  });

  it("treats 执行完成-only run_activity shells as empty when deciding cache usability", () => {
    const source = appSource();
    const isChild =
      source.match(/function isSubstantiveRunActivityChild[\s\S]*?\n}\n/)?.[0] ?? "";
    const substantive =
      source.match(/function structuredTimelineRunActivityHasSubstantiveChildren[\s\S]*?\n}\n/)?.[0] ??
      "";
    const { isSubstantiveRunActivityChild } = new Function(
      `${isChild}\nreturn { isSubstantiveRunActivityChild };`,
    )();
    expect(isSubstantiveRunActivityChild({ type: "event", className: "done" })).toBe(false);
    expect(isSubstantiveRunActivityChild({ type: "step_narrative", text: "plan" })).toBe(true);
    const state = {
      normalTimelineBySession: new Map([
        [
          "s1",
          {
            entries: [
              {
                type: "run_activity",
                children: [{ type: "event", className: "done", text: "执行完成" }],
              },
              { type: "conclusion", text: "answer" },
            ],
          },
        ],
      ]),
    };
    const getNormalTimelineState = (sessionId) => state.normalTimelineBySession.get(sessionId);
    const ensureTimelineEntries = (timelineState) => timelineState.entries;
    const api = new Function(
      "getNormalTimelineState",
      "ensureTimelineEntries",
      `${isChild}\n${substantive}\nreturn { structuredTimelineRunActivityHasSubstantiveChildren };`,
    )(getNormalTimelineState, ensureTimelineEntries);
    expect(api.structuredTimelineRunActivityHasSubstantiveChildren("s1")).toBe(false);
  });
});

describe("retry on failed runs", () => {
  it("failed runs render a delegated retry button with the original message", () => {
    const source = appSource();
    expect(source).toContain("data-retry-message");
    expect(source).toContain('closest("[data-retry-message]")');
    const retry = source.match(
      /function retryComposerMessage[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    // Never auto-click the stop-mode button — that would cancel the active run.
    expect(retry).toContain("isComposerStopMode");
  });
});

describe("right code panel outside close", () => {
  it("closes the code detail panel on outside pointerdown, keeping chrome and open triggers", () => {
    const source = appSource();
    expect(source).toContain("function bindRightPanelOutsideClose()");
    expect(source).toContain("bindRightPanelOutsideClose()");
    const bind =
      source.match(/function bindRightPanelOutsideClose[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(bind).toContain('state.rightMode !== "code"');
    expect(bind).toContain("isRightCodePanelChrome");
    expect(bind).toContain("isRightCodePanelOpenTrigger");
    expect(bind).toContain("openRight(false)");
    expect(bind).toContain("pointerdown");
    const chrome =
      source.match(/function isRightCodePanelChrome[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(chrome).toContain("#rightPanel");
    expect(chrome).toContain("#toggleRightBtn");
    const triggers =
      source.match(/function isRightCodePanelOpenTrigger[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(triggers).toContain(".plugin-card[data-plugin-id]");
    expect(triggers).toContain(".skill-card[data-skill-id]");
  });
});

describe("timeline prompt and source-link handling", () => {
  it("dedupes start prompts even when one side is truncated", () => {
    const source = appSource();
    const fn = source.match(/function timelineHasPromptText[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(fn).toContain("normalizeUserPromptLabel");
    expect(fn).toContain("startsWith");
    expect(fn).toContain("text.length >= 24");
  });

  it("renders a prompt immediately for follow-up turns in existing sessions", () => {
    const source = appSource();
    const exec = source.match(/async function executeAgentRun[\s\S]*?\n  }\n/)?.[0] ?? "";
    expect(exec).toContain("if (routeSid)");
    expect(exec).toContain("renderUserPromptOnce(preview)");
    expect(exec).toContain("sessionRuns.withEventRoute(routeSid");
  });

  it("opens local source anchors in right panel detail", () => {
    const source = appSource();
    expect(source).toContain("openWorkspaceSourceLinkFromTimeline");
    expect(source).toContain("findWorkspaceFileByBasename");
    expect(source).toContain("未在当前项目找到文件");
    const click = source.match(/function bindTimelineClickDelegation[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(click).toContain('e.target.closest("a")');
    expect(click).toContain("openWorkspaceSourceLinkFromTimeline");
  });
});

describe("automation intent gating", () => {
  it("only auto-creates automation on explicit create intent", () => {
    const source = appSource();
    expect(source).toContain("hasExplicitAutomationCreateIntent");
    const gate = source.match(/function hasExplicitAutomationCreateIntent[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(gate).toContain("looksLikeScheduledAutomationRequest");
    expect(gate).toContain("不想|不要|先别");
    expect(gate).toContain("创建|新建|设置|设定");
    expect(source).toContain("hasExplicitAutomationCreateIntent");
    expect(source).toContain("window.confirm(");
    expect(source).toContain("未明确要创建任务");
    expect(source).toContain("已确认创建自动化");
    expect(source).toContain("已按普通对话执行（未创建自动化）");
    expect(source).toContain("明确的定时创建意图");
  });
});

describe("flat run-activity streaming", () => {
  it("streams process output flat while running, then folds long runs on conclusion", () => {
    const source = appSource();
    expect(source).toContain("run-activity-stream");
    expect(source).toContain("shouldCollapseRunActivityContent");
    expect(source).toContain("foldLiveRunActivityContent");
    expect(source).toContain("unwrapLiveRunActivityContent");
    const ensure =
      source.match(/function ensureRunActivity[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(ensure).toContain("details.open = false");
    expect(ensure).toContain('stream.className = "run-activity-stream"');
    expect(ensure).toContain("state.runActivityBody = stream");
    const finalize =
      source.match(/function finalizeRunActivity[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(finalize).toContain("shouldCollapseRunActivityContent");
    expect(finalize).toContain("foldLiveRunActivityContent");
    expect(finalize).toContain("unwrapLiveRunActivityContent");
    const collapse =
      source.match(/function shouldCollapseRunActivityContent[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(collapse).toContain("units >= 4");
    expect(collapse).toContain("chars >= 800");
    const css = readFileSync(join(here, "styles.css"), "utf-8");
    expect(css).toContain(".run-activity-stream");
  });
});
