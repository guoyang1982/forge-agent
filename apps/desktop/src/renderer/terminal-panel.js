// Embedded terminal tabs. Classic script (loaded after tools-panel.js, before
// app.js); each terminal lives in a tab of the unified right-region tools
// panel (tools-panel.js) and hosts an xterm.js instance backed by the
// main-process PTY (see terminal-ipc.ts). Each tab is one shell rooted at the
// active project's working directory.
(function initTerminalPanel() {
  const FONT_FAMILY =
    'Menlo, "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace';

  /** @type {Map<string, { term: any, fit: any, backendId: string|null, dispose: Set<Function>, exited: boolean }>} */
  const tabs = new Map();
  /** Most recently activated terminal entry (for refit). */
  let activeEntry = null;
  let seq = 0;
  let globalSubsBound = false;

  const bridge = () => window.forgeDesktop;
  const tools = () => window.forgeToolsPanel;

  function activeCwd() {
    try {
      return window.getActiveProject?.()?.cwd || "";
    } catch {
      return "";
    }
  }

  function backendToTab(backendId) {
    for (const t of tabs.values()) {
      if (t.backendId === backendId) return t;
    }
    return null;
  }

  function bindGlobalSubs() {
    if (globalSubsBound) return;
    const b = bridge();
    if (!b || typeof b.onTerminalData !== "function") return;
    globalSubsBound = true;
    b.onTerminalData((payload) => {
      const hit = backendToTab(payload?.id);
      if (hit) hit.term.write(payload.data ?? "");
    });
    b.onTerminalExit?.((payload) => {
      const hit = backendToTab(payload?.id);
      if (!hit) return;
      hit.exited = true;
      hit.term.write(
        `\r\n\x1b[2m[进程已退出，code ${payload?.exitCode ?? 0}]\x1b[0m\r\n`,
      );
    });
  }

  function fitTab(t) {
    try {
      t.fit.fit();
      if (t.backendId) {
        bridge()?.terminalResize?.({
          id: t.backendId,
          cols: t.term.cols,
          rows: t.term.rows,
        });
      }
    } catch {
      /* container not visible yet */
    }
  }

  function disposeEntry(id) {
    const t = tabs.get(id);
    if (!t) return;
    for (const off of t.dispose) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    if (t.backendId) bridge()?.terminalKill?.({ id: t.backendId });
    try {
      t.term.dispose();
    } catch {
      /* ignore */
    }
    tabs.delete(id);
    if (activeEntry === t) activeEntry = null;
  }

  async function newTab() {
    const tp = tools();
    if (!tp) return;
    const b = bridge();
    const TermLib = globalThis.ForgeTerminal;

    /** @type {{ term: any, fit: any, backendId: string|null, dispose: Set<Function>, exited: boolean } | null} */
    let entry = null;
    const handle = tp.addTab({
      kind: "terminal",
      label: `终端 ${seq + 1}`,
      onActivate: () => {
        if (!entry) return;
        activeEntry = entry;
        // Defer so layout is settled before fit/focus.
        requestAnimationFrame(() => {
          fitTab(entry);
          entry.term.focus();
        });
      },
      onClose: () => disposeEntry(handle.id),
    });
    if (!handle) return;
    seq += 1;

    const body = document.createElement("div");
    body.className = "terminal-body";
    handle.body.appendChild(body);

    if (!TermLib || !TermLib.Terminal) {
      body.innerHTML = "";
      const note = document.createElement("div");
      note.className = "terminal-unavailable";
      note.textContent = "终端组件未加载（请先 pnpm install 并重新构建桌面端）。";
      body.appendChild(note);
      return;
    }
    if (!b || typeof b.terminalCreate !== "function") {
      const note = document.createElement("div");
      note.className = "terminal-unavailable";
      note.textContent = "终端通信桥未就绪。";
      body.appendChild(note);
      return;
    }
    bindGlobalSubs();

    const term = new TermLib.Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#1b1b1f",
        foreground: "#e6e6ea",
        cursor: "#e6e6ea",
        selectionBackground: "#3a3a44",
      },
    });
    const fit = new TermLib.FitAddon();
    term.loadAddon(fit);
    term.open(body);

    entry = {
      term,
      fit,
      backendId: null,
      dispose: new Set(),
      exited: false,
    };
    tabs.set(handle.id, entry);
    activeEntry = entry;

    // Size before spawning so the PTY starts with correct dimensions.
    requestAnimationFrame(async () => {
      try {
        fit.fit();
      } catch {
        /* not visible */
      }
      try {
        const res = await b.terminalCreate({
          cwd: activeCwd(),
          cols: term.cols,
          rows: term.rows,
        });
        entry.backendId = res.id;
        if (res.backend === "pipe") {
          term.write(
            "\x1b[2m[降级模式：未启用 node-pty，部分交互式程序可能异常]\x1b[0m\r\n",
          );
        }
        const onData = term.onData((data) =>
          b.terminalInput?.({ id: res.id, data }),
        );
        entry.dispose.add(() => onData.dispose());
        term.focus();
      } catch (err) {
        term.write(`\r\n[forge] 无法创建终端: ${err?.message || err}\r\n`);
      }
    });
  }

  // Called by app.js when the user asks for a terminal. Focuses the most
  // recent terminal tab, or creates the first one.
  function ensureStarted() {
    if (tabs.size === 0) {
      newTab();
    } else {
      tools()?.activateKind?.("terminal");
    }
  }

  function refit() {
    if (activeEntry) fitTab(activeEntry);
  }

  function wire() {
    tools()?.registerCreator?.("terminal", newTab);
    // Refit whenever the container changes size — covers the shared right-panel
    // drag-resize and window resizes without app.js needing to call us.
    const bodies = document.getElementById("toolsBodies");
    if (bodies && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => refit());
      ro.observe(bodies);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // app.js drives open/close; these let it spin up + resize the shell.
  window.forgeTerminalPanel = { ensureStarted, refit, newTab };
})();
