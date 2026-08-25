import { describe, expect, it } from "vitest";
import {
  initialMobileWorkbenchState,
  mobileWorkbenchReducer,
  type MobileWorkbenchState,
} from "./mobile-workbench-state.js";

describe("Mobile workbench state", () => {
  it("deduplicates replayed events by subscription and sequence", () => {
    const once = mobileWorkbenchReducer(initialMobileWorkbenchState, {
      type: "run.event",
      subscriptionId: "sub-12345678",
      seq: 4,
      event: { kind: "text", delta: "A" },
    });
    const twice = mobileWorkbenchReducer(once, {
      type: "run.event",
      subscriptionId: "sub-12345678",
      seq: 4,
      event: { kind: "text", delta: "A" },
    });

    expect(twice.liveText).toBe("A");
    expect(twice.liveEvents).toHaveLength(1);
  });

  it("does not duplicate liveText when a full message is replayed as a delta", () => {
    const streamed = mobileWorkbenchReducer(initialMobileWorkbenchState, {
      type: "run.event",
      subscriptionId: "sub-abcdef12",
      seq: 1,
      event: { kind: "text", delta: "我会先查看项目结构。" },
    });
    const replayed = mobileWorkbenchReducer(streamed, {
      type: "run.event",
      subscriptionId: "sub-abcdef12",
      seq: 2,
      event: { kind: "text", delta: "我会先查看项目结构。" },
    });
    expect(replayed.liveText).toBe("我会先查看项目结构。");
  });

  it("replaces live turn data with persisted history after completion", () => {
    const messages = [{ key: "0:assistant", role: "assistant" as const, text: "Persisted answer" }];
    const runningState: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      runningSessionId: "session-12345678",
      liveText: "Transient answer",
      liveEvents: [{ kind: "text", delta: "Transient answer" }],
    };

    const next = mobileWorkbenchReducer(runningState, {
      type: "session.persisted",
      sessionId: "session-12345678",
      messages,
    });

    expect(next.runningSessionId).toBeNull();
    expect(next.liveText).toBe("");
    expect(next.messagesBySession["session-12345678"]).toEqual(messages);
  });

  it("clears the global running session as soon as done arrives", () => {
    const runningState: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      activeSessionId: "session-12345678",
      runningSessionId: "session-12345678",
      liveText: "Completed answer",
    };

    const next = mobileWorkbenchReducer(runningState, {
      type: "run.event",
      subscriptionId: "sub-terminal-01",
      seq: 12,
      event: {
        kind: "done",
        sessionId: "session-12345678",
        finalText: "Completed answer",
      },
    });

    expect(next.runningSessionId).toBeNull();
  });

  it("replaces completed live data when persisted history arrives after done", () => {
    const sessionId = "session-12345678";
    const runningState: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      activeSessionId: sessionId,
      runningSessionId: sessionId,
      liveText: "Transient answer",
      liveEvents: [{ kind: "text", delta: "Transient answer" }],
    };
    const completedState = mobileWorkbenchReducer(runningState, {
      type: "run.event",
      subscriptionId: "sub-terminal-02",
      seq: 13,
      event: { kind: "done", sessionId, finalText: "Persisted answer" },
    });
    const messages = [{ key: "0:assistant", role: "assistant" as const, text: "Persisted answer" }];

    const next = mobileWorkbenchReducer(completedState, {
      type: "session.persisted",
      sessionId,
      messages,
    });

    expect(next.liveText).toBe("");
    expect(next.liveEvents).toEqual([]);
    expect(next.messagesBySession[sessionId]).toEqual(messages);
  });

  it("remembers the selected host and preserves it after deselection", () => {
    const populated: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      workspaceId: "/repo-a",
      messagesBySession: {
        "session-a": [{ key: "0:user", role: "user", text: "private host data" }],
      },
      unreadSessionIds: ["session-a"],
      liveText: "running",
    };

    const first = mobileWorkbenchReducer(populated, { type: "host.selected", hostId: "host-a" });
    expect(first).toMatchObject({ selectedHostId: "host-a", lastHostId: "host-a" });

    const second = mobileWorkbenchReducer(first, { type: "host.selected", hostId: "host-b" });
    expect(second).toMatchObject({ selectedHostId: "host-b", lastHostId: "host-b" });
    expect(second.messagesBySession).toEqual({});
    expect(second.unreadSessionIds).toEqual([]);
    expect(second.liveText).toBe("");

    const deselected = mobileWorkbenchReducer(second, { type: "host.selected", hostId: null });
    expect(deselected).toMatchObject({ selectedHostId: null, lastHostId: "host-b" });
    expect(deselected.messagesBySession).toEqual({});
    expect(deselected.workspaceId).toBeNull();
  });

  it("forgets a removed remembered host while preserving other remembered hosts", () => {
    const remembered: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      selectedHostId: "host-a",
      lastHostId: "host-a",
      workspaceId: "/repo-a",
      liveText: "host-a data",
    };

    const forgottenRemembered = mobileWorkbenchReducer(remembered, {
      type: "host.forgotten",
      hostId: "host-a",
    });
    expect(forgottenRemembered).toMatchObject({
      selectedHostId: null,
      lastHostId: null,
      workspaceId: null,
      liveText: "",
    });

    const otherSelected: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      selectedHostId: "host-b",
      lastHostId: "host-b",
      workspaceId: "/repo-b",
    };
    const forgottenOther = mobileWorkbenchReducer(otherSelected, {
      type: "host.forgotten",
      hostId: "host-a",
    });
    expect(forgottenOther).toEqual(otherSelected);
  });

  it("supports the four shell tabs", () => {
    expect(initialMobileWorkbenchState.activeTab).toBe("workbench");
    const tabs = ["workbench", "workspaces", "sessions", "settings"] as const;
    const visited = tabs.map((tab) =>
      mobileWorkbenchReducer(initialMobileWorkbenchState, { type: "tab.selected", tab }).activeTab
    );
    expect(visited).toEqual(tabs);
  });

  it("marks sessions for history refresh after reconnecting", () => {
    const state: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      runningSessionId: "session-running",
      activeSessionId: "session-active",
    };

    expect(mobileWorkbenchReducer(state, { type: "connection.reconnected" })).toMatchObject({
      needsHistoryRefresh: true,
      historyRefreshSessionIds: ["session-active", "session-running"],
    });
  });

  it("reconnect replay does not duplicate text or tool events", () => {
    const liveFrames = [
      { subscriptionId: "sub-1", seq: 1, event: { kind: "text" as const, delta: "Hello" } },
      {
        subscriptionId: "sub-1",
        seq: 2,
        event: { kind: "tool" as const, callId: "t1", name: "bash", status: "running" as const },
      },
      {
        subscriptionId: "sub-1",
        seq: 3,
        event: {
          kind: "tool" as const,
          callId: "t1",
          name: "bash",
          status: "done" as const,
          output: "ok",
        },
      },
    ];

    const reduceFrames = (frames: typeof liveFrames) =>
      frames.reduce(
        (state, frame) =>
          mobileWorkbenchReducer(state, {
            type: "run.event",
            subscriptionId: frame.subscriptionId,
            seq: frame.seq,
            event: frame.event,
          }),
        initialMobileWorkbenchState,
      );

    const replayed = reduceFrames([...liveFrames, ...liveFrames]);
    expect(replayed.liveEvents).toHaveLength(liveFrames.length);
    expect(replayed.liveText).toBe("Hello");
  });

  it("host-scoped state never leaks workspace or session caches after host switch", () => {
    const hostAState: MobileWorkbenchState = {
      ...initialMobileWorkbenchState,
      selectedHostId: "host-a",
      lastHostId: "host-a",
      workspaceId: "/repo-a",
      activeSessionId: "session-a",
      runningSessionId: "session-a",
      unreadSessionIds: ["session-a"],
      messagesBySession: {
        "session-a": [{ key: "0:user", role: "user", text: "host-a only" }],
      },
      liveText: "secret",
      liveEvents: [{ kind: "text", delta: "secret" }],
    };

    const next = mobileWorkbenchReducer(hostAState, { type: "host.selected", hostId: "host-b" });
    expect(next.selectedHostId).toBe("host-b");
    expect(next.workspaceId).toBeNull();
    expect(next.activeSessionId).toBeNull();
    expect(next.runningSessionId).toBeNull();
    expect(next.unreadSessionIds).toEqual([]);
    expect(next.messagesBySession).toEqual({});
    expect(next.liveText).toBe("");
    expect(next.liveEvents).toEqual([]);
  });
});
