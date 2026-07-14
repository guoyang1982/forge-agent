(function registerGitBranchRefresh(root) {
  function createGitBranchRefreshController(options) {
    const refresh = options?.refresh;
    const getActiveKey = options?.getActiveKey;
    const intervalMs = Number(options?.intervalMs ?? 4000);
    const windowObject = options?.windowObject ?? root.window;
    const documentObject = options?.documentObject ?? root.document;
    const setIntervalFn = options?.setIntervalFn ?? root.setInterval;
    const clearIntervalFn = options?.clearIntervalFn ?? root.clearInterval;

    let started = false;
    let timer = null;
    let inFlight = false;

    const hasActiveTarget = () => {
      try {
        return Boolean(getActiveKey?.());
      } catch {
        return false;
      }
    };

    const runRefresh = () => {
      if (!started || inFlight || typeof refresh !== "function" || !hasActiveTarget()) return;
      inFlight = true;
      try {
        const result = refresh();
        if (result && typeof result.then === "function") {
          Promise.resolve(result)
            .catch(() => {})
            .finally(() => {
              inFlight = false;
            });
        } else {
          inFlight = false;
        }
      } catch {
        inFlight = false;
      }
    };

    const onFocus = () => runRefresh();
    const onVisibilityChange = () => {
      if (!documentObject || documentObject.visibilityState === "visible") runRefresh();
    };

    return {
      start() {
        if (started) return;
        started = true;
        if (typeof setIntervalFn === "function" && intervalMs > 0) {
          timer = setIntervalFn(runRefresh, intervalMs);
        }
        windowObject?.addEventListener?.("focus", onFocus);
        documentObject?.addEventListener?.("visibilitychange", onVisibilityChange);
        runRefresh();
      },
      stop() {
        if (!started) return;
        started = false;
        if (timer !== null && typeof clearIntervalFn === "function") {
          clearIntervalFn(timer);
        }
        timer = null;
        windowObject?.removeEventListener?.("focus", onFocus);
        documentObject?.removeEventListener?.("visibilitychange", onVisibilityChange);
      },
      refreshNow() {
        runRefresh();
      },
    };
  }

  root.ForgeGitBranchRefresh = {
    createGitBranchRefreshController,
  };
})(globalThis);
