import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("timeline refresh scroll position", () => {
  it("preserves manual scroll position when a viewed session refreshes", () => {
    const source = appSource();

    expect(source).toContain("restoreScrollAfterSessionRefresh");
    expect(source).toContain("previousScrollTop");
    expect(source).not.toContain(
      '$("timeline").scrollTop = $("timeline").scrollHeight;',
    );
  });

  it("preserves run-activity body scroll across innerHTML repaints", () => {
    const source = appSource();

    expect(source).toContain("captureTimelineUiState");
    expect(source).toContain("restoreTimelineUiState");
    // Each fold's body scroll is captured/restored by fold index, not a single
    // snapshot applied to whichever body happens to be found after the repaint.
    expect(source).toContain("activityScrolls.push({");
    expect(source).toContain("activities[snap.idx]");
  });

  it("does not auto-scroll outer timeline while reading inside run-activity", () => {
    const source = appSource();
    const schedule = source.match(
      /function scheduleRunViewScroll[\s\S]*?\n}\n/,
    )?.[0] ?? "";

    expect(schedule).toContain("state.activityFollowBottom");
    expect(source).toContain("runActivityBodyShouldAutoScroll");
    expect(source).toContain("pauseRunActivityAutoScroll");
    expect(source).toContain(
      "if (!follow) state.timelineFollowBottom = false",
    );
  });

  it("does not re-enable inner follow-bottom while thinking blocks are pinned open", () => {
    const source = appSource();
    const bindScroll = source.match(
      /function bindRunActivityScroll[\s\S]*?\n}\n\nfunction runActivityRefsValid/,
    )?.[0] ?? "";

    expect(bindScroll).toContain("runActivityBodyHasPinnedDetails(body)");
    expect(bindScroll).toContain("pauseRunActivityAutoScroll()");
  });

  it("preserves expanded thinking blocks across innerHTML repaints", () => {
    const source = appSource();

    expect(source).toContain("restoreOpenDetails");
    expect(source).toContain('details.event.thinking[data-user-pinned="1"]');
    expect(source).toContain("runActivityHasExpandedContent");
    expect(source).toContain("thinkingId");
    expect(source).toContain("dataset.thinkingId");
  });

  it("does not force run activity into view after the user scrolls upward", () => {
    const source = appSource();
    const startStepGroup = source.match(
      /function startStepGroup[\s\S]*?\n}\n\nfunction ensureStreamTextNode/,
    )?.[0] ?? "";

    expect(source).toContain("maybeScrollRunActivityIntoView");
    expect(source).toContain("applyFollow(false)");
    // Following the bottom may only move the view down — scrollIntoView(nearest)
    // used to step UP from the bottom when the fold's top was off-screen.
    const intoView = source.match(
      /function maybeScrollRunActivityIntoView[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(intoView).toContain("scrollElToBottom");
    expect(intoView).not.toContain(".scrollIntoView(");
    // The restore snapshot must be taken AFTER the daemon round-trip, or stale
    // scroll positions overwrite whatever the user did during the await.
    const restoreFn = source.match(
      /async function restoreSessionTimeline[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    const awaitIdx = restoreFn.indexOf("await requireBridge().getSessionMessages");
    const captureIdx = restoreFn.indexOf("captureTimelineUiState(timeline)");
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeGreaterThan(awaitIdx);
    expect(startStepGroup).not.toContain(
      'state.runActivityEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });',
    );
  });

  it("ignores programmatic scrolls when deciding follow-bottom", () => {
    const source = appSource();

    expect(source).toContain("bindFollowBottomScroll");
    expect(source).toContain("markProgrammaticScroll");
    expect(source).toContain("isRecentProgrammaticScroll");
    // Re-enabling follow requires recent user scroll intent.
    expect(source).toContain("hasUserIntent");
  });

  it("rebinding markers must not survive innerHTML serialization", () => {
    const source = appSource();

    // data-* bound markers would be serialized into snapshots and block
    // rebinding after a restore, leaving the body without a scroll listener
    // (which made the view snap back to the bottom while reading).
    expect(source).not.toContain("dataset.runActivityBound");
    expect(source).not.toContain("dataset.runActivityPinBound");
    expect(source).not.toContain("dataset.activityToggleBound");
    expect(source).not.toContain("dataset.scrollFollowBound");
    expect(source).toContain("followScrollBoundEls");
    expect(source).toContain("runActivityPinBoundEls");
    expect(source).toContain("runActivityToggleBoundEls");
  });
});
