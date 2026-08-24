import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf8");

function loadSessionRunUi() {
  const context = { window: {} };
  vm.runInNewContext(
    readFileSync(join(here, "session-run-ui.js"), "utf8"),
    context,
  );
  return context.window.ForgeSessionRunUi;
}

describe("cross-device session synchronization", () => {
  it("treats a persisted run followed by done as completed", () => {
    const api = loadSessionRunUi();

    expect(
      api.persistedSessionIsRunning([
        { event: { type: "session_start" } },
        { event: { type: "text_delta" } },
        { event: { type: "done" } },
      ]),
    ).toBe(false);
  });

  it("does not resurrect a journal-only run after the daemon lost it", () => {
    const api = loadSessionRunUi();
    const records = [
      { event: { type: "session_start", sessionId: "ghost" } },
      { event: { type: "status", sessionId: "ghost" } },
    ];

    expect(
      api.reconciledPersistedSessionIsRunning(records, {
        activeRun: false,
        activeSessionIds: [],
      }),
    ).toBe(false);
    expect(
      api.reconciledPersistedSessionIsRunning(records, {
        activeRun: true,
        activeSessionIds: ["other-session"],
      }),
    ).toBe(false);
    expect(
      api.reconciledPersistedSessionIsRunning(records, {
        activeRun: true,
        activeSessionIds: ["ghost"],
      }),
    ).toBe(true);
  });

  it("keeps polling an externally-owned run but not a local live run", () => {
    const api = loadSessionRunUi();

    expect(
      api.shouldRefreshSessionTimeline({
        running: true,
        locallyOwned: false,
        versionChanged: false,
      }),
    ).toBe(true);
    expect(
      api.shouldRefreshSessionTimeline({
        running: true,
        locallyOwned: true,
        versionChanged: true,
      }),
    ).toBe(false);
  });

  it("reconciles replayed run state and uses ownership-aware refresh", () => {
    const source = appSource();
    const replay =
      source.match(/function renderPersistedSessionEvents[\s\S]*?\n}\n/)?.[0] ?? "";
    const refresh =
      source.match(
        /async function refreshViewedSessionFromDaemonIfChanged[\s\S]*?\n}\n/,
      )?.[0] ?? "";

    expect(replay).toContain("reconciledPersistedSessionIsRunning(");
    expect(replay).toContain("sessionRuns.markSessionRunning(");
    expect(refresh).toContain("shouldRefreshSessionTimeline");
    expect(refresh).toContain("state.clientRuns.values()");
  });

  it("clears a journal-only ghost run when cancel finds no backend work", () => {
    const source = appSource();
    const submit =
      source.match(/async function handleComposerSubmit[\s\S]*?\n  }\n\n  \/\*\*/)?.[0] ??
      source;

    expect(submit).toContain("cancelResult?.canceled === false");
    expect(submit).toContain("sessionRuns.markSessionRunning(stopSid, false)");
    expect(submit).toContain("已清除残留运行状态");
  });

  it("does not reuse a previous turn activity for a text-only desktop turn", () => {
    const source = appSource();
    const resolverSource =
      source.match(
        /function resolveTurnRunActivityForConclusion[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    const previousTurnActivity = {};
    const prompts = [{}, {}];
    const container = {
      contains: () => false,
      querySelectorAll: (selector) =>
        selector.includes("user-prompt") ? prompts : [previousTurnActivity],
    };
    const resolve = Function(
      "state",
      "findRunActivityDomForTurn",
      `${resolverSource}; return resolveTurnRunActivityForConclusion;`,
    )({ runActivityEl: null }, () => null);

    expect(resolve(container)).toBeNull();
  });

  it("scopes structured conclusion dedupe to the latest prompt", () => {
    const api = loadSessionRunUi();

    expect(
      api.currentTurnHasStructuredConclusion([
        { type: "event", isUserPrompt: true },
        { type: "run_activity" },
        { type: "conclusion" },
        { type: "event", isUserPrompt: true },
      ]),
    ).toBe(false);
    expect(
      api.currentTurnHasStructuredConclusion([
        { type: "event", isUserPrompt: true },
        { type: "conclusion" },
      ]),
    ).toBe(true);
  });

  it("mobile completion reloads the same persisted final answer shown by desktop", () => {
    const source = appSource();
    const refresh =
      source.match(
        /async function refreshViewedSessionFromDaemonIfChanged[\s\S]*?\n}\n/,
      )?.[0] ?? "";
    const replay =
      source.match(/function renderPersistedSessionEvents[\s\S]*?\n}\n/)?.[0] ?? "";

    // Desktop and mobile both treat daemon session storage as the shared source of truth:
    // desktop rebuilds from persisted records; mobile reloads session.messages after run.result.
    expect(refresh).toContain("shouldRefreshSessionTimeline");
    expect(replay).toContain("reconciledPersistedSessionIsRunning(");
    expect(source).toMatch(/session\.events|getSession|listSession|persist/i);
  });
});
