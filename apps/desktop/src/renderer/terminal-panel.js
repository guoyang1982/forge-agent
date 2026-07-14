// Embedded terminal panel. Classic script (loaded before app.js); wires a
// toggle button to a floating right-side panel that hosts xterm.js terminals
// backed by the main-process PTY (see terminal-ipc.ts). Each tab is one shell
// rooted at the active project's working directory.
(function initTerminalPanel() {
  const FONT_FAMILY =
    'Menlo, "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace';

  /** @type {Map<string, { term: any, fit: any, backendId: string|null, body: HTMLElement, tab: HTMLElement, dispose: Set<Function>, exited: boolean }>} */
  const tabs = new Map();
  let activeTabId = null;
  let seq = 0;
  let globalSubsBound = false;

  const bridge = () => window.forgeDesktop;

  function activeCwd() {
    try {
      return window.getActiveProject?.()?.cwd || "";
    } catch {
      return "";
    }
  }

  function els() {
    return {
      panel: document.getElementById("terminalPanel"),
      tabBar: document.getElementById("terminalTabs"),
      bodies: document.getElementById("terminalBodies"),
      newBtn: document.getElementById("terminalNewBtn"),
    };
  }

  function backendToTab(backendId) {
    for (const [tabId, t] of tabs) {
      if (t.backendId === backendId) return { tabId, t };
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
      if (hit) hit.t.term.write(payload.data ?? "");
    });
    b.onTerminalExit?.((payload) => {
      const hit = backendToTab(payload?.id);
      if (!hit) return;
      hit.t.exited = true;
      hit.t.term.write(
        `\r\n\x1b[2m[进程已退出，code ${payload?.exitCode ?? 0}]\x1b[0m\r\n`,
      );
    });
  }

  function setActiveTab(tabId) {
    activeTabId = tabId;
    for (const [id, t] of tabs) {
      const on = id === tabId;
      t.body.classList.toggle("hidden", !on);
      t.tab.classList.toggle("active", on);
      if (on) {
        // Defer so layout is settled before fit/focus.
        requestAnimationFrame(() => {
          fitTab(t);
          t.term.focus();
        });
      }
    }
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

  function closeTab(tabId) {
    const t = tabs.get(tabId);
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
    t.body.remove();
    t.tab.remove();
    tabs.delete(tabId);
    if (activeTabId === tabId) {
      const next = tabs.keys().next().value || null;
      if (next) setActiveTab(next);
      else activeTabId = null;
    }
  }

  function showUnavailable(message) {
    const { bodies } = els();
    if (!bodies) return;
    bodies.innerHTML = "";
    const note = document.createElement("div");
    note.className = "terminal-unavailable";
    note.textContent = message;
    bodies.appendChild(note);
  }

  async function newTab() {
    const b = bridge();
    const TermLib = globalThis.ForgeTerminal;
    if (!TermLib || !TermLib.Terminal) {
      showUnavailable("终端组件未加载（请先 pnpm install 并重新构建桌面端）。");
      return;
    }
    if (!b || typeof b.terminalCreate !== "function") {
      showUnavailable("终端通信桥未就绪。");
      return;
    }
    bindGlobalSubs();

    const { bodies, tabBar } = els();
    const tabId = `tab-${++seq}`;

    const body = document.createElement("div");
    body.className = "terminal-body";
    bodies.appendChild(body);

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "terminal-tab";
    const label = document.createElement("span");
    label.className = "terminal-tab-label";
    label.textContent = `终端 ${seq}`;
    const x = document.createElement("span");
    x.className = "terminal-tab-close";
    x.textContent = "✕";
    x.title = "关闭此终端";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tabId);
    });
    tab.append(label, x);
    tab.addEventListener("click", () => setActiveTab(tabId));
    tabBar.appendChild(tab);

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

    const entry = {
      term,
      fit,
      backendId: null,
      body,
      tab,
      dispose: new Set(),
      exited: false,
    };
    tabs.set(tabId, entry);
    setActiveTab(tabId);

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
      } catch (err) {
        term.write(`\r\n[forge] 无法创建终端: ${err?.message || err}\r\n`);
      }
    });
  }

  // Called by app.js when the right region switches to terminal mode. Panel
  // visibility / width / collapse is owned by app.js (shared with the code
  // panel); here we only ensure a live shell exists and is sized.
  function ensureStarted() {
    if (tabs.size === 0) {
      newTab();
    } else {
      setActiveTab(activeTabId || tabs.keys().next().value);
    }
  }

  function refit() {
    if (!activeTabId) return;
    const t = tabs.get(activeTabId);
    if (t) fitTab(t);
  }

  function wire() {
    const { newBtn, bodies } = els();
    newBtn?.addEventListener("click", newTab);
    // Refit whenever the container changes size — covers the shared right-panel
    // drag-resize and window resizes without app.js needing to call us.
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
