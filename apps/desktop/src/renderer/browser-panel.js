// Embedded browser tabs. Classic script (loaded after tools-panel.js, before
// app.js); each browser tab lives in the unified right-region tools panel
// (tools-panel.js) and hosts its own toolbar + Electron <webview>. New tabs
// open on a start page listing recently visited pages. History, bookmarks and
// the bookmark-bar preference are shared across tabs via localStorage.
(function initBrowserPanel() {
  const LS_HISTORY_KEY = "forge.browser.history";
  const LS_BOOKMARKS_KEY = "forge.browser.bookmarks";
  const LS_BOOKMARK_BAR_KEY = "forge.browser.showBookmarkBar";
  const HISTORY_MAX = 30;
  const RECENTS_SHOWN = 8;
  // Cookies/localStorage of embedded pages persist across app restarts and
  // stay isolated from the app's own session. Must match the partition used
  // by the forge:browser-clear-data handler in main.ts.
  const PARTITION = "persist:forge-panel-browser";

  /** @type {Set<object>} */
  const instances = new Set();
  /** Instance owning the most recently active browser tab. */
  let activeInstance = null;

  // --- Shared storage helpers ---

  /** @returns {Array<{ url: string, title: string, ts: number }>} */
  function loadHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_HISTORY_KEY) || "[]");
      return Array.isArray(arr)
        ? arr.filter((e) => e && typeof e.url === "string")
        : [];
    } catch {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch {
      /* storage unavailable */
    }
  }

  function addHistory(url) {
    if (!url || url === "about:blank") return;
    const list = loadHistory();
    const prev = list.find((e) => e.url === url);
    saveHistory([
      { url, title: prev?.title || "", ts: Date.now() },
      ...list.filter((e) => e.url !== url),
    ]);
  }

  function setHistoryTitle(url, title) {
    if (!url || !title) return;
    const list = loadHistory();
    const hit = list.find((e) => e.url === url);
    if (!hit || hit.title === title) return;
    hit.title = title;
    saveHistory(list);
  }

  /** @returns {Array<{ url: string, title: string }>} */
  function loadBookmarks() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_BOOKMARKS_KEY) || "[]");
      return Array.isArray(arr)
        ? arr.filter((e) => e && typeof e.url === "string")
        : [];
    } catch {
      return [];
    }
  }

  function saveBookmarks(list) {
    try {
      localStorage.setItem(LS_BOOKMARKS_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable */
    }
  }

  function bookmarkBarVisible() {
    try {
      return localStorage.getItem(LS_BOOKMARK_BAR_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setBookmarkBarVisible(on) {
    try {
      localStorage.setItem(LS_BOOKMARK_BAR_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    refreshBookmarkUI();
  }

  /** Bookmarks/bar are shared: sync the UI of every open browser tab. */
  function refreshBookmarkUI() {
    for (const inst of instances) {
      inst.renderBookmarkBar();
      inst.updateBookmarkBtn();
    }
  }

  // --- Shared URL helpers ---

  /** Turn address-bar text into a loadable URL (or a search URL). */
  function normalizeInput(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^about:/i.test(text)) {
      return text;
    }
    const hostLike =
      /^localhost(:\d+)?([/?#].*)?$/i.test(text) ||
      /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(text) ||
      (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text) && !text.includes(" "));
    if (hostLike) {
      const scheme = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(text)
        ? "http://"
        : "https://";
      return scheme + text;
    }
    return "https://www.baidu.com/s?wd=" + encodeURIComponent(text);
  }

  /** Compact display form of a URL (no scheme, no trailing slash). */
  function urlLabel(url) {
    return String(url || "")
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "");
  }

  function clipText(s, max = 160) {
    const t = String(s ?? "").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  // --- Design mode page scripts ---

  // Injected when design mode turns on: records the original text of every
  // edited text node so we can diff original vs. final when the mode ends.
  const DESIGN_RECORDER_JS = `(() => {
    if (window.__forgeDesignRecorder) return true;
    const orig = new Map();
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== "characterData") continue;
        if (!orig.has(m.target)) orig.set(m.target, m.oldValue ?? "");
      }
    });
    obs.observe(document.documentElement, {
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
    });
    window.__forgeDesignRecorder = {
      collect() {
        const out = [];
        for (const [node, before] of orig) {
          const after = node.textContent ?? "";
          if (before === after) continue;
          const el = node.parentElement;
          let where = "";
          if (el) {
            where = el.tagName.toLowerCase();
            if (el.id) where += "#" + el.id;
            else if (el.classList.length) where += "." + el.classList[0];
          }
          out.push({ before, after, where });
        }
        return out;
      },
      dispose() {
        obs.disconnect();
        delete window.__forgeDesignRecorder;
      },
    };
    return true;
  })()`;

  const DESIGN_COLLECT_JS = `(() => {
    const rec = window.__forgeDesignRecorder;
    const edits = rec ? rec.collect() : [];
    if (rec) rec.dispose();
    document.designMode = "off";
    return edits;
  })()`;

  /** Draft an agent request in the chat composer asking to sync page edits into source. */
  function draftWriteBack(edits, pageUrl) {
    const input = document.getElementById("messageInput");
    if (!input) return;

    const MAX_LISTED = 20;
    const lines = [];
    let n = 0;
    for (const e of edits) {
      const before = clipText(e?.before);
      const after = clipText(e?.after);
      // Empty "before" can't be located in source; whitespace-only diffs are noise.
      if (!before || before === after) continue;
      n += 1;
      if (n > MAX_LISTED) {
        lines.push(`…（还有 ${edits.length - MAX_LISTED} 处修改未列出）`);
        break;
      }
      lines.push(
        `${n}. 「${before}」 改为 「${after}」${e?.where ? `（元素 ${e.where}）` : ""}`,
      );
    }
    if (n === 0) return;

    const text = [
      `我在内嵌浏览器的设计模式里直接修改了页面${pageUrl ? `（${pageUrl}）` : ""}的文案，请在当前项目源码中找到对应位置，把以下修改同步回代码：`,
      ...lines,
      "注意：文案可能在 JSX/模板/HTML 或 i18n 资源文件中，请保持原有格式与缩进；如某条找不到唯一对应位置，请先列出候选再确认。",
    ].join("\n");

    input.value = input.value.trim() ? `${input.value.replace(/\s*$/, "")}\n\n${text}` : text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  // --- Per-tab browser instance ---

  const TOOLBAR_HTML = `
    <header class="browser-panel-head">
      <button class="icon-btn subtle browser-head-btn browser-back-btn" type="button" title="后退" disabled>←</button>
      <button class="icon-btn subtle browser-head-btn browser-forward-btn" type="button" title="前进" disabled>→</button>
      <button class="icon-btn subtle browser-head-btn browser-reload-btn" type="button" title="刷新">⟳</button>
      <button class="icon-btn subtle browser-head-btn browser-bookmark-btn" type="button" title="收藏当前页面">☆</button>
      <input class="browser-url-input" type="text" placeholder="搜索或输入网址" spellcheck="false" autocomplete="off" />
      <button class="icon-btn subtle browser-head-btn browser-design-btn" type="button" title="设计模式：直接编辑页面文案；退出时自动生成「同步到源码」的请求填入聊天框">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <path d="M10.8 2.6l2.6 2.6-7.6 7.6-3.2.6.6-3.2z" />
          <path d="M9.4 4l2.6 2.6" />
        </svg>
      </button>
      <button class="icon-btn subtle browser-head-btn browser-devtools-btn" type="button" title="开发者工具">&gt;_</button>
      <div class="browser-menu-wrap">
        <button class="icon-btn subtle browser-head-btn browser-menu-btn" type="button" title="更多操作" aria-haspopup="menu" aria-expanded="false">…</button>
        <div class="browser-menu hidden" role="menu">
          <button type="button" class="browser-menu-item" data-browser-action="hard-reload" role="menuitem">硬性重新加载</button>
          <button type="button" class="browser-menu-item" data-browser-action="copy-url" role="menuitem">复制当前网址</button>
          <div class="browser-menu-divider"></div>
          <button type="button" class="browser-menu-item browser-menu-toggle" data-browser-action="toggle-bookmark-bar" role="menuitemcheckbox" aria-checked="false">
            <span>显示书签栏</span>
            <span class="browser-menu-switch" aria-hidden="true"></span>
          </button>
          <div class="browser-menu-divider"></div>
          <button type="button" class="browser-menu-item" data-browser-action="clear-history" role="menuitem">清除浏览历史</button>
          <button type="button" class="browser-menu-item" data-browser-action="clear-cookies" role="menuitem">清除 Cookie</button>
          <button type="button" class="browser-menu-item" data-browser-action="clear-cache" role="menuitem">清除缓存</button>
        </div>
      </div>
    </header>
    <div class="browser-bookmark-bar hidden" aria-label="书签栏"></div>
    <div class="browser-body">
      <div class="browser-empty"></div>
    </div>
  `;

  function createBrowserTab() {
    const tools = window.forgeToolsPanel;
    if (!tools) return null;

    /** @type {ReturnType<typeof buildInstance> | null} */
    let inst = null;
    const handle = tools.addTab({
      kind: "browser",
      label: "新标签页",
      onActivate: () => {
        if (!inst) return;
        activeInstance = inst;
        inst.onActivate();
      },
      onClose: () => {
        if (!inst) return;
        instances.delete(inst);
        if (activeInstance === inst) activeInstance = null;
      },
    });
    if (!handle) return null;

    const root = document.createElement("div");
    root.className = "browser-panel";
    root.innerHTML = TOOLBAR_HTML;
    handle.body.appendChild(root);

    inst = buildInstance(root, handle);
    instances.add(inst);
    activeInstance = inst;
    inst.renderStartPage();
    inst.renderBookmarkBar();
    inst.focusUrlInput();
    return inst;
  }

  function buildInstance(root, handle) {
    const q = (sel) => root.querySelector(sel);
    const ui = {
      urlInput: q(".browser-url-input"),
      backBtn: q(".browser-back-btn"),
      forwardBtn: q(".browser-forward-btn"),
      reloadBtn: q(".browser-reload-btn"),
      bookmarkBtn: q(".browser-bookmark-btn"),
      designBtn: q(".browser-design-btn"),
      devtoolsBtn: q(".browser-devtools-btn"),
      menuBtn: q(".browser-menu-btn"),
      menu: q(".browser-menu"),
      bookmarkBar: q(".browser-bookmark-bar"),
      body: q(".browser-body"),
      empty: q(".browser-empty"),
    };

    /** @type {Electron.WebviewTag | null} */
    let webview = null;
    let webviewReady = false;
    /** URL requested before the webview finished initializing. */
    let pendingUrl = "";
    let designModeOn = false;

    function currentUrl() {
      try {
        const url = webview?.getURL() || "";
        return url === "about:blank" ? "" : url;
      } catch {
        return "";
      }
    }

    function updateNavButtons() {
      let canBack = false;
      let canForward = false;
      if (webview && webviewReady) {
        try {
          canBack = webview.canGoBack();
          canForward = webview.canGoForward();
        } catch {
          /* webview not attached yet */
        }
      }
      ui.backBtn.disabled = !canBack;
      ui.forwardBtn.disabled = !canForward;
    }

    function setUrlBar(url) {
      // Don't clobber the user's in-progress edit.
      if (document.activeElement === ui.urlInput) return;
      ui.urlInput.value = url === "about:blank" ? "" : url;
    }

    function updateTabLabel(url, title) {
      const label = title || (url && url !== "about:blank" ? urlLabel(url) : "");
      handle.setLabel(label ? clipText(label, 24) : "新标签页");
    }

    function ensureWebview() {
      if (webview) return webview;
      const wv = document.createElement("webview");
      wv.setAttribute("partition", PARTITION);
      wv.setAttribute("src", "about:blank");
      wv.classList.add("browser-webview");

      wv.addEventListener("dom-ready", () => {
        webviewReady = true;
        if (pendingUrl) {
          const url = pendingUrl;
          pendingUrl = "";
          void wv.loadURL(url).catch(() => {});
        }
      });
      const onNavigated = (url) => {
        addHistory(url);
        setUrlBar(url || "");
        updateNavButtons();
        updateBookmarkBtn();
        updateTabLabel(url, "");
        // Design mode is per-document; a navigation loads a fresh one.
        designModeOn = false;
        ui.designBtn.classList.remove("active");
      };
      wv.addEventListener("did-navigate", (e) => onNavigated(e.url));
      wv.addEventListener("did-navigate-in-page", (e) => onNavigated(e.url));
      wv.addEventListener("did-start-loading", () => {
        ui.reloadBtn.classList.add("loading");
      });
      wv.addEventListener("did-stop-loading", () => {
        ui.reloadBtn.classList.remove("loading");
        updateNavButtons();
      });
      wv.addEventListener("did-fail-load", (e) => {
        // -3 = aborted (e.g. user navigated away mid-load); not a real failure.
        if (e.errorCode === -3 || !e.isMainFrame) return;
        renderStartPage(
          `加载失败（${e.errorDescription || e.errorCode}）：${e.validatedURL || ""}`,
        );
      });
      wv.addEventListener("page-title-updated", (e) => {
        try {
          setHistoryTitle(wv.getURL(), e.title);
        } catch {
          /* webview not attached yet */
        }
        updateTabLabel(currentUrl(), e.title);
        updateNavButtons();
      });

      ui.body.appendChild(wv);
      ui.empty.classList.add("hidden");
      webview = wv;
      return wv;
    }

    /** Show the start page (recents list, optionally an error line) over the webview. */
    function renderStartPage(message) {
      const empty = ui.empty;
      empty.innerHTML = "";
      empty.classList.remove("hidden");

      if (message) {
        const err = document.createElement("p");
        err.className = "browser-start-error";
        err.textContent = message;
        empty.appendChild(err);
      }

      const history = loadHistory();
      if (history.length === 0) {
        if (!message) {
          const lead = document.createElement("p");
          lead.textContent = "输入网址或搜索词开始浏览";
          const hint = document.createElement("p");
          hint.className = "tiny";
          hint.textContent = "例如：localhost:5173、baidu.com";
          empty.append(lead, hint);
        }
        return;
      }

      const head = document.createElement("div");
      head.className = "browser-recents-head";
      const label = document.createElement("span");
      label.textContent = "最近访问";
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "browser-recents-clear";
      clearBtn.textContent = "清除";
      clearBtn.title = "清除浏览历史";
      clearBtn.addEventListener("click", () => {
        saveHistory([]);
        renderStartPage();
      });
      head.append(label, clearBtn);

      const list = document.createElement("div");
      list.className = "browser-recents";
      for (const entry of history.slice(0, RECENTS_SHOWN)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "browser-recent-item";
        const title = document.createElement("span");
        title.className = "browser-recent-title";
        title.textContent = entry.title || urlLabel(entry.url);
        const url = document.createElement("span");
        url.className = "browser-recent-url";
        url.textContent = urlLabel(entry.url);
        item.append(title, url);
        item.title = entry.url;
        item.addEventListener("click", () => navigate(entry.url));
        list.appendChild(item);
      }
      empty.append(head, list);
    }

    function navigate(rawInput) {
      const url = normalizeInput(rawInput);
      if (!url) return;
      const wv = ensureWebview();
      ui.empty.classList.add("hidden");
      if (webviewReady) {
        void wv.loadURL(url).catch(() => {});
      } else {
        pendingUrl = url;
      }
      setUrlBar(url);
      updateTabLabel(url, "");
    }

    // --- Bookmarks ---

    function toggleBookmark() {
      const url = currentUrl();
      if (!url) return;
      const list = loadBookmarks();
      if (list.some((e) => e.url === url)) {
        saveBookmarks(list.filter((e) => e.url !== url));
      } else {
        let title = "";
        try {
          title = webview?.getTitle() || "";
        } catch {
          /* ignore */
        }
        saveBookmarks([...list, { url, title }]);
        // First bookmark: reveal the bar so the action has visible feedback.
        if (list.length === 0 && !bookmarkBarVisible()) {
          setBookmarkBarVisible(true);
        }
      }
      refreshBookmarkUI();
    }

    function updateBookmarkBtn() {
      const url = currentUrl();
      const marked = Boolean(url) && loadBookmarks().some((e) => e.url === url);
      ui.bookmarkBtn.textContent = marked ? "★" : "☆";
      ui.bookmarkBtn.classList.toggle("active", marked);
      ui.bookmarkBtn.title = marked ? "取消收藏" : "收藏当前页面";
    }

    function renderBookmarkBar() {
      const bar = ui.bookmarkBar;
      const show = bookmarkBarVisible();
      bar.classList.toggle("hidden", !show);
      if (!show) return;
      bar.innerHTML = "";
      const bookmarks = loadBookmarks();
      if (bookmarks.length === 0) {
        const hint = document.createElement("span");
        hint.className = "browser-bookmark-empty";
        hint.textContent = "暂无书签 — 点击地址栏左侧 ☆ 收藏当前页面";
        bar.appendChild(hint);
        return;
      }
      for (const bm of bookmarks) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "browser-bookmark-item";
        item.textContent = bm.title || urlLabel(bm.url);
        item.title = `${bm.url}\n右键移除书签`;
        item.addEventListener("click", () => navigate(bm.url));
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          saveBookmarks(loadBookmarks().filter((x) => x.url !== bm.url));
          refreshBookmarkUI();
        });
        bar.appendChild(item);
      }
    }

    // --- "…" overflow menu ---

    function setMenuOpen(open) {
      ui.menu.classList.toggle("hidden", !open);
      ui.menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) return;
      // Refresh per-open state: page-dependent items + bookmark bar switch.
      const hasPage = Boolean(currentUrl());
      for (const action of ["hard-reload", "copy-url"]) {
        const item = ui.menu.querySelector(`[data-browser-action="${action}"]`);
        if (item) item.disabled = !hasPage;
      }
      const toggle = ui.menu.querySelector('[data-browser-action="toggle-bookmark-bar"]');
      if (toggle) {
        const on = bookmarkBarVisible();
        toggle.setAttribute("aria-checked", on ? "true" : "false");
        toggle.classList.toggle("checked", on);
      }
    }

    /** Briefly confirm a menu action by swapping the item label. */
    function flashMenuItem(item, text) {
      const prev = item.textContent;
      item.textContent = text;
      item.disabled = true;
      setTimeout(() => {
        item.textContent = prev;
        item.disabled = false;
        setMenuOpen(false);
      }, 700);
    }

    async function onMenuAction(action, item) {
      switch (action) {
        case "hard-reload":
          try {
            webview?.reloadIgnoringCache();
          } catch {
            /* ignore */
          }
          setMenuOpen(false);
          break;
        case "copy-url": {
          const url = currentUrl();
          if (url) {
            try {
              await navigator.clipboard.writeText(url);
              flashMenuItem(item, "已复制");
              return;
            } catch {
              /* clipboard unavailable */
            }
          }
          setMenuOpen(false);
          break;
        }
        case "toggle-bookmark-bar":
          setBookmarkBarVisible(!bookmarkBarVisible());
          setMenuOpen(true);
          break;
        case "clear-history":
          saveHistory([]);
          // Refresh the start page if it is currently showing recents.
          if (!ui.empty.classList.contains("hidden")) renderStartPage();
          flashMenuItem(item, "已清除");
          break;
        case "clear-cookies":
          try {
            await window.forgeDesktop?.browserClearData?.({ kind: "cookies" });
            flashMenuItem(item, "已清除");
          } catch {
            setMenuOpen(false);
          }
          break;
        case "clear-cache":
          try {
            await window.forgeDesktop?.browserClearData?.({ kind: "cache" });
            flashMenuItem(item, "已清除");
          } catch {
            setMenuOpen(false);
          }
          break;
        default:
          setMenuOpen(false);
      }
    }

    // --- Design mode (edit-in-place + write-back draft) ---

    async function setDesignMode(on) {
      if (!webview || !webviewReady) return;
      designModeOn = on;
      ui.designBtn.classList.toggle("active", on);
      try {
        if (on) {
          await webview.executeJavaScript(
            `document.designMode = "on"; ${DESIGN_RECORDER_JS}`,
          );
        } else {
          const edits = await webview.executeJavaScript(DESIGN_COLLECT_JS);
          if (Array.isArray(edits) && edits.length > 0) {
            draftWriteBack(edits, currentUrl());
          }
        }
      } catch {
        /* page navigated away or script blocked */
      }
    }

    // --- Wiring ---

    ui.urlInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      navigate(ui.urlInput.value);
      ui.urlInput.blur();
    });
    ui.backBtn.addEventListener("click", () => {
      try {
        webview?.goBack();
      } catch {
        /* ignore */
      }
    });
    ui.forwardBtn.addEventListener("click", () => {
      try {
        webview?.goForward();
      } catch {
        /* ignore */
      }
    });
    ui.reloadBtn.addEventListener("click", () => {
      if (!webview || !webviewReady) return;
      try {
        webview.reload();
      } catch {
        /* ignore */
      }
    });
    ui.devtoolsBtn.addEventListener("click", () => {
      if (!webview || !webviewReady) return;
      try {
        if (webview.isDevToolsOpened()) webview.closeDevTools();
        else webview.openDevTools();
      } catch {
        /* ignore */
      }
    });
    ui.designBtn.addEventListener("click", () => setDesignMode(!designModeOn));
    ui.bookmarkBtn.addEventListener("click", toggleBookmark);
    ui.menuBtn.addEventListener("click", () => {
      setMenuOpen(ui.menu.classList.contains("hidden"));
    });
    ui.menu.addEventListener("click", (e) => {
      const item = e.target instanceof Element && e.target.closest("[data-browser-action]");
      if (!item || item.disabled) return;
      void onMenuAction(item.getAttribute("data-browser-action"), item);
    });

    return {
      navigate,
      renderStartPage,
      renderBookmarkBar,
      updateBookmarkBtn,
      focusUrlInput: () => ui.urlInput.focus(),
      onActivate() {
        updateNavButtons();
        updateBookmarkBtn();
        renderBookmarkBar();
        // Recents may have changed since this tab was last visible.
        if (!ui.empty.classList.contains("hidden")) renderStartPage();
      },
      hasMenuOpen: () => !ui.menu.classList.contains("hidden"),
      closeMenu: () => setMenuOpen(false),
      containsNode: (node) => root.contains(node),
    };
  }

  function wire() {
    window.forgeToolsPanel?.registerCreator?.("browser", createBrowserTab);
    // Close any open per-tab "…" menu on clicks outside its own menu area.
    document.addEventListener(
      "pointerdown",
      (e) => {
        const target = e.target instanceof Element ? e.target : null;
        for (const inst of instances) {
          if (!inst.hasMenuOpen()) continue;
          if (target && target.closest(".browser-menu-wrap") && inst.containsNode(target)) {
            continue;
          }
          inst.closeMenu();
        }
      },
      true,
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  // app.js drives open/close. ensureStarted focuses the latest browser tab or
  // opens a new one on the recents start page; navigate is exposed so other
  // features (e.g. preview links) can open pages in the panel.
  window.forgeBrowserPanel = {
    ensureStarted() {
      if (!window.forgeToolsPanel?.activateKind?.("browser")) {
        createBrowserTab();
      }
    },
    navigate(url) {
      // Activating a browser tab (or creating one) updates activeInstance.
      if (!window.forgeToolsPanel?.activateKind?.("browser")) {
        createBrowserTab();
      }
      activeInstance?.navigate(url);
    },
    newTab: createBrowserTab,
  };
})();
