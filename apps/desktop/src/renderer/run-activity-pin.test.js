import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("run activity manual expansion", () => {
  it("does not collapse a run activity that the user has opened", () => {
    const source = appSource();

    expect(source).toContain('details.dataset.userPinned === "1"');
    expect(source).toContain("runActivityHasExpandedContent");
    expect(source).toContain("if (!runActivityHasExpandedContent(details)) details.open = false");
    // Folds are identified by index — summary text (已处理 Ns) repeats across turns
    // and used to reopen the wrong turn's fold after a repaint.
    const restore = source.match(/function restoreOpenDetails[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(restore).toContain("activities[idx]");
    expect(restore).not.toContain("summary");
  });

  it("does not re-expand a fold the user manually collapsed", () => {
    const source = appSource();

    // Every user toggle must be written back into the timeline cache…
    const syncCalls = source.match(/syncViewedTimelineCacheAfterToggle\(\)/g) ?? [];
    expect(syncCalls.length).toBeGreaterThanOrEqual(4); // 1 def + 3 toggle handlers
    // …and repaints must drop stale `open` attrs the snapshot didn't have.
    expect(source).toContain("closeStaleOpenDetails(timeline, snapshot)");
    const closeStale = source.match(
      /function closeStaleOpenDetails[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(closeStale).toContain("el.open = false");
    expect(closeStale).toContain("wantedIdx");
  });

  it("polling never rebuilds the timeline for a version we already rendered", () => {
    const source = appSource();
    // Local rows carry a local-clock updatedAt that never equals the daemon's —
    // comparing against the merged row rebuilt every 3s, resetting fold state.
    expect(source).toContain("externalSessionVersionSeen");
    const refresh = source.match(
      /async function refreshViewedSessionFromDaemonIfChanged[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(refresh).toContain("state.externalSessionVersionSeen.set(sessionId, ver)");
    expect(refresh).toContain("seen !== ver");
    expect(refresh).toContain("shouldRefreshSessionTimeline");
  });

  it("does not collapse thinking blocks the user has opened", () => {
    const source = appSource();
    const closeOrphans = source.match(
      /function closeOrphanThinkingBlocks[\s\S]*?\n}\n\n\/\*\* Point live run/,
    )?.[0] ?? "";

    expect(closeOrphans).toContain('block.dataset.userPinned === "1"');
    expect(closeOrphans).not.toContain("block.open = false");
    expect(closeOrphans).toContain("Do not force-collapse");
  });
});
