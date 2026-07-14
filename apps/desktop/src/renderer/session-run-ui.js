/** Multi-session run routing for desktop sidebar + timeline (loaded before app.js). */
(function () {
  function createSessionRunApi(getState, helpers) {
    const {
      $,
      getActiveProject,
      showChatEmpty,
      clearTimeline,
      pushEventIn,
      saveProjects,
      renderProjects,
      renderComposerGitBranchSelect,
      renderComposerQueue,
      renderContextMeter,
      sessionCwdMatches,
    } = helpers;

    function getViewingSessionId() {
      return getActiveProject()?.sessionId || "";
    }

    function isViewingSession(sessionId) {
      return Boolean(sessionId) && getViewingSessionId() === sessionId;
    }

    function shouldRouteEventToView(sessionId) {
      if (!sessionId) return false;
      return isViewingSession(sessionId);
    }

    function markSessionRunning(sessionId, running) {
      const state = getState();
      if (!sessionId) return;
      if (running) state.runningSessions.add(sessionId);
      else state.runningSessions.delete(sessionId);
      syncComposerRunChrome();
      renderProjects();
    }

    /** Pending submit on empty「新对话」view only (not other sessions in the project). */
    function isNewChatDraftRunning() {
      if (getViewingSessionId()) return false;
      const project = getActiveProject();
      if (!project) return false;
      return getState().pendingNewSessionByProject.has(project.id);
    }

    /** Session id for cancelRun — only the session currently being viewed. */
    function getComposerStopSessionId() {
      const state = getState();
      const viewingSid = getViewingSessionId();
      if (viewingSid && state.runningSessions.has(viewingSid)) return viewingSid;
      return null;
    }

    function isComposerStopMode() {
      const state = getState();
      const viewingSid = getViewingSessionId();
      const viewingRunning =
        Boolean(viewingSid) && state.runningSessions.has(viewingSid);
      return viewingRunning || isNewChatDraftRunning();
    }

    function syncComposerRunChrome() {
      const state = getState();
      const viewingSid = getViewingSessionId();
      const viewingRunning =
        Boolean(viewingSid) && state.runningSessions.has(viewingSid);
      const viewingStopping =
        Boolean(viewingSid) && Boolean(state.stopRequestedBySession.get(viewingSid));
      const composerStop = isComposerStopMode();
      const anyRunning = state.runningSessions.size > 0;
      state.running = viewingRunning;

      const el = $("runState");
      if (el) {
        el.textContent = anyRunning
          ? `${state.runningSessions.size} 个运行中`
          : "空闲";
        el.className = `pill ${anyRunning ? "running" : "idle"}`;
      }
      const btn = $("runBtn");
      if (btn) {
        btn.classList.toggle("is-running", composerStop);
        btn.classList.toggle("is-stopping", composerStop && viewingStopping);
        const stopLabel = viewingRunning
          ? viewingStopping
            ? "正在停止当前会话"
            : "停止当前会话"
          : "停止提交中的新对话";
        btn.title = composerStop ? stopLabel : "开始执行";
        btn.setAttribute("aria-label", composerStop ? stopLabel : "开始执行");
      }
      const input = $("messageInput");
      if (input) {
        // Typing stays enabled during a run: Enter queues for the next turn.
        input.readOnly = false;
        input.classList.remove("is-disabled");
        input.placeholder = viewingRunning
          ? "执行中 — 回车排队，本轮完成后自动发送"
          : "尽管问…";
      }
      $("composer")?.classList.toggle("composer-running", composerStop);
      renderComposerGitBranchSelect?.();
      renderComposerQueue?.();
      renderContextMeter?.();
    }

    function finishRestoreSessionView(sessionId, switchGen) {
      const state = getState();
      helpers.flushTimelineCacheSync?.();
      if (!helpers.isViewSwitchCurrent?.(switchGen)) return;
      if (sessionId !== state.viewingTimelineSessionId) return;
      helpers.repairTimelineDomStructure?.($("timeline"));
      helpers.rebindTimelineAfterRestore?.($("timeline"));
      helpers.loadSessionRunArtifacts?.(sessionId);
      helpers.reconcileSessionConclusion?.(sessionId);
      if (sessionId && isSessionRunning(sessionId)) {
        helpers.ensureLiveRunSession?.(sessionId);
        helpers.reattachLiveRunDomRefs?.();
      }
    }

    function restoreTimelineSnapshot(sessionId, switchGen) {
      const state = getState();
      helpers.flushTimelineCacheSync?.();
      if (!helpers.isViewSwitchCurrent?.(switchGen)) return false;
      const running = isSessionRunning(sessionId);
      if (!helpers.structuredTimelineCacheUsable?.(sessionId, running)) return false;
      const timeline = $("timeline");
      const sameSession = sessionId === state.viewingTimelineSessionId;
      const ui = sameSession ? helpers.captureTimelineUiState?.(timeline) : null;
      helpers.loadSessionRunArtifacts?.(sessionId);
      if (!helpers.renderTimelineFromState?.(sessionId, timeline)) return false;
      showChatEmpty(false);
      helpers.reconcileSessionConclusion?.(sessionId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          finishRestoreSessionView(sessionId, switchGen);
          if (ui) helpers.restoreTimelineUiState?.(ui, timeline);
        });
      });
      return true;
    }

    function getEventSessionId(ev) {
      if (ev.type === "session_start" || ev.type === "done") return ev.sessionId;
      return ev.sessionId || null;
    }

    function withEventRoute(sessionId, fn) {
      const state = getState();
      const prev = state.eventRouteSessionId;
      state.eventRouteSessionId = sessionId || null;
      try {
        return fn();
      } finally {
        state.eventRouteSessionId = prev;
      }
    }

    function runOffscreen(sessionId, fn) {
      helpers.withOffscreenRoot(sessionId, fn);
    }

    function appendOffscreenEvent(sessionId, text, cls, detail) {
      runOffscreen(sessionId, () => helpers.pushEvent(text, cls, detail));
    }

    function appendOffscreenDone(sessionId, finalText) {
      runOffscreen(sessionId, () =>
        helpers.finalizeRunConclusionOnMount(finalText, sessionId),
      );
    }

    function newClientRunId() {
      return `cr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    function registerClientRun(project, preview) {
      const state = getState();
      const clientRunId = newClientRunId();
      state.clientRuns.set(clientRunId, {
        projectId: project.id,
        cwd: project.cwd,
        sessionId: project.sessionId || null,
        preview,
      });
      if (!project.sessionId) {
        state.pendingNewSessionByProject.add(project.id);
      }
      syncComposerRunChrome();
      renderProjects();
      return clientRunId;
    }

    function clearClientRun(clientRunId) {
      const state = getState();
      const meta = state.clientRuns.get(clientRunId);
      if (meta) state.pendingNewSessionByProject.delete(meta.projectId);
      state.clientRuns.delete(clientRunId);
    }

    function onSessionStart(ev) {
      const state = getState();

      const meta = ev.clientRunId
        ? state.clientRuns.get(ev.clientRunId)
        : null;
      if (meta) {
        meta.sessionId = ev.sessionId;
        state.pendingNewSessionByProject.delete(meta.projectId);
        const project = state.projects.find((p) => p.id === meta.projectId);
        if (project && project.id === state.activeProjectId) {
          const viewing = getViewingSessionId();
          const sameProject =
            helpers.sessionBelongsToActiveProject?.(ev.sessionId) !== false;
          if (sameProject && (!viewing || viewing === ev.sessionId)) {
            project.sessionId = ev.sessionId;
            saveProjects();
          }
        }
      } else if (ev.cwd) {
        const project = getActiveProject();
        const viewing = getViewingSessionId();
        if (
          project &&
          project.id === state.activeProjectId &&
          sessionCwdMatches(project.cwd, ev.cwd) &&
          helpers.sessionBelongsToActiveProject?.(ev.sessionId) !== false &&
          (!viewing || viewing === ev.sessionId)
        ) {
          project.sessionId = ev.sessionId;
          state.viewingTimelineSessionId = ev.sessionId;
          saveProjects();
        }
      }

      markSessionRunning(ev.sessionId, true);

      helpers.upsertSessionInWorkspace({
        sessionId: ev.sessionId,
        cwd: ev.cwd,
        preview: ev.preview,
      });
    }

    function onSessionDone(ev) {
      markSessionRunning(ev.sessionId, false);
      if (!shouldRouteEventToView(ev.sessionId)) {
        appendOffscreenDone(ev.sessionId, ev.finalText);
        return false;
      }
      return true;
    }

    function switchSessionView(project, newSessionId, prevSessionId, options = {}) {
      const st = getState();
      st.unreadDoneSessions?.delete(newSessionId);
      const outgoingSessionId =
        options.outgoingSessionId || st.viewingTimelineSessionId || "";
      const switchGen = ++st.viewSwitchGeneration;

      if (outgoingSessionId && outgoingSessionId !== newSessionId) {
        helpers.captureOutgoingTimeline?.(outgoingSessionId);
      }

      st.viewingTimelineSessionId = newSessionId || null;
      project.sessionId = newSessionId;
      saveProjects();
      helpers.detachLiveRunSession();
      clearTimeline();

      const finish = () => {
        syncComposerRunChrome();
        return true;
      };

      if (!newSessionId) {
        showChatEmpty(true);
        syncComposerRunChrome();
        return Promise.resolve(false);
      }

      if (restoreTimelineSnapshot(newSessionId, switchGen)) {
        return Promise.resolve(finish());
      }

      return helpers
        .restoreSessionTimeline(newSessionId, switchGen, { scrollToBottom: true })
        .then(() => {
          if (!helpers.isViewSwitchCurrent?.(switchGen)) return false;
          if (newSessionId !== st.viewingTimelineSessionId) return false;
          finishRestoreSessionView(newSessionId, switchGen);
          return finish();
        });
    }

    function isSessionRunning(sessionId) {
      return getState().runningSessions.has(sessionId);
    }

    return {
      getViewingSessionId,
      getComposerStopSessionId,
      isComposerStopMode,
      isNewChatDraftRunning,
      isViewingSession,
      shouldRouteEventToView,
      markSessionRunning,
      syncComposerRunChrome,
      restoreTimelineSnapshot,
      getEventSessionId,
      withEventRoute,
      appendOffscreenEvent,
      appendOffscreenDone,
      registerClientRun,
      clearClientRun,
      onSessionStart,
      onSessionDone,
      switchSessionView,
      isSessionRunning,
      appendOffscreenAgentEvent: (sessionId, ev, handler) => {
        runOffscreen(sessionId, () => handler(ev));
      },
      runOffscreen,
      captureOutgoingTimeline: (sessionId) =>
        helpers.captureOutgoingTimeline?.(sessionId),
    };
  }

  window.ForgeSessionRunUi = { createSessionRunApi };
})();
