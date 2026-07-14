/**
 * `@path` file mention + `@talent` roster completion for the composer.
 * Reuses the slash-palette look; file index is walked lazily via listDir.
 */
(function initForgeFileMention(global) {
  const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "build",
    "out",
    "venv",
    "__pycache__",
    "target",
    "coverage",
  ]);
  const MAX_FILES = 2000;
  const MAX_DEPTH = 6;
  const MAX_RESULTS = 20;
  const MAX_TALENTS = 15;
  const CACHE_TTL_MS = 60000;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function talentAvatarHtml(t) {
    const avatar = t?.avatar || "";
    if (/^data:image\/svg\+xml[;,]/i.test(avatar)) {
      return `<img class="slash-palette-icon talent-avatar talent-avatar-xs" src="${escapeHtml(avatar)}" alt="" aria-hidden="true" />`;
    }
    return `<span class="slash-palette-icon slash-palette-icon-skill" aria-hidden="true">${escapeHtml(t?.emoji || "🧑")}</span>`;
  }

  function looksLikePathQuery(query) {
    const q = String(query || "");
    return q.includes("/") || q.includes("\\") || q.includes(".");
  }

  function init(options) {
    const input = options.input;
    const paletteEl = options.paletteEl;
    if (!input || !paletteEl) return null;

    const state = {
      open: false,
      flatItems: [],
      talents: [],
      fileItems: [],
      selectedIndex: 0,
      token: null,
      index: null,
      indexing: false,
    };

    function close() {
      state.open = false;
      paletteEl.classList.add("hidden");
    }

    function openPalette() {
      state.open = true;
      paletteEl.classList.remove("hidden");
    }

    /** The whitespace-delimited token containing the caret, if it starts with `@`. */
    function findMentionToken(value, caret) {
      let start = caret;
      while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
      const token = value.slice(start, caret);
      if (!token.startsWith("@") || token.length > 200) return null;
      return { start, end: caret, query: token.slice(1) };
    }

    async function ensureIndex() {
      const cwd = options.getCwd?.() || "";
      if (
        state.indexing ||
        (state.index &&
          state.index.cwd === cwd &&
          Date.now() - state.index.at < CACHE_TTL_MS)
      ) {
        return;
      }
      state.indexing = true;
      try {
        const files = [];
        const queue = [{ path: ".", depth: 0 }];
        while (queue.length && files.length < MAX_FILES) {
          const { path, depth } = queue.shift();
          let data = null;
          try {
            data = await options.listDir(path);
          } catch {
            continue;
          }
          for (const item of data?.items ?? []) {
            const base = String(item.name || "");
            if (item.type === "dir") {
              if (SKIP_DIRS.has(base) || base.startsWith(".")) continue;
              if (depth + 1 <= MAX_DEPTH) queue.push({ path: item.path, depth: depth + 1 });
            } else if (item.type === "file") {
              files.push(item.path);
              if (files.length >= MAX_FILES) break;
            }
          }
        }
        state.index = { cwd, files, at: Date.now() };
      } finally {
        state.indexing = false;
      }
    }

    /** Basename-prefix matches first, then path substring matches. */
    function filterFiles(query) {
      const files = state.index?.files ?? [];
      const q = String(query || "").toLowerCase();
      if (!q) return files.slice(0, MAX_RESULTS);
      const starts = [];
      const includes = [];
      for (const f of files) {
        const lower = f.toLowerCase();
        const base = lower.slice(lower.lastIndexOf("/") + 1);
        if (base.startsWith(q)) starts.push(f);
        else if (lower.includes(q)) includes.push(f);
        if (starts.length >= MAX_RESULTS) break;
      }
      return [...starts, ...includes].slice(0, MAX_RESULTS);
    }

    function filterTalents(query) {
      const roster = options.listTalents?.() ?? [];
      const q = String(query || "").toLowerCase();
      const enabled = roster.filter((t) => t.enabled !== false);
      const matches = !q
        ? enabled
        : enabled.filter((t) => {
            const hay = `${t.mention} ${t.displayName} ${t.role || ""}`.toLowerCase();
            return hay.includes(q);
          });
      return matches.slice(0, MAX_TALENTS);
    }

    function rebuildFlatItems() {
      const pathLike = looksLikePathQuery(state.token?.query);
      const query = state.token?.query || "";
      state.talents = filterTalents(query);
      state.fileItems = query || pathLike ? filterFiles(query) : [];
      const flat = [];
      for (const talent of state.talents) {
        flat.push({ kind: "talent", talent });
      }
      for (const file of state.fileItems) {
        flat.push({ kind: "file", file });
      }
      state.flatItems = flat;
      if (state.selectedIndex >= flat.length) state.selectedIndex = 0;
    }

    function render() {
      if (!state.flatItems.length) {
        const emptyMsg = state.indexing
          ? "正在索引工作区文件…"
          : looksLikePathQuery(state.token?.query)
            ? "没有匹配的文件或人才"
            : "没有匹配的人才（输入路径片段可 @ 文件）";
        paletteEl.innerHTML = `<div class="slash-palette-empty">${emptyMsg}</div>`;
        return;
      }

      let globalIdx = 0;
      const sections = [];

      if (state.talents.length) {
        const rows = state.talents
          .map((t) => {
            const idx = globalIdx++;
            const selected = idx === state.selectedIndex;
            return `<button type="button" class="slash-palette-item mention-item mention-talent${selected ? " is-selected" : ""}" data-idx="${idx}" role="option" aria-selected="${selected}">
            ${talentAvatarHtml(t)}
            <span class="slash-palette-label">@${escapeHtml(t.mention)}</span>
            <span class="mention-dir">${escapeHtml(t.displayName)}${t.role ? ` · ${escapeHtml(t.role)}` : ""}</span>
          </button>`;
          })
          .join("");
        sections.push(`<div class="slash-palette-section">
        <div class="slash-palette-section-title">人才</div>
        <div class="slash-palette-items">${rows}</div>
      </div>`);
      }

      if (state.fileItems.length) {
        const rows = state.fileItems
          .map((f) => {
            const idx = globalIdx++;
            const slash = f.lastIndexOf("/");
            const dir = slash >= 0 ? f.slice(0, slash + 1) : "";
            const base = slash >= 0 ? f.slice(slash + 1) : f;
            const selected = idx === state.selectedIndex;
            return `<button type="button" class="slash-palette-item mention-item${selected ? " is-selected" : ""}" data-idx="${idx}" role="option" aria-selected="${selected}">
            <span class="slash-palette-label">${escapeHtml(base)}</span>
            ${dir ? `<span class="mention-dir">${escapeHtml(dir)}</span>` : ""}
          </button>`;
          })
          .join("");
        sections.push(`<div class="slash-palette-section">
        <div class="slash-palette-section-title">文件</div>
        <div class="slash-palette-items">${rows}</div>
      </div>`);
      }

      paletteEl.innerHTML = `<div class="slash-palette-body">${sections.join("")}</div>`;
      paletteEl.querySelectorAll(".mention-item").forEach((btn) => {
        btn.addEventListener("mouseenter", () => {
          state.selectedIndex = Number(btn.dataset.idx);
          render();
        });
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectItem(Number(btn.dataset.idx));
        });
      });
      paletteEl.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
    }

    function selectItem(index) {
      const item = state.flatItems[index];
      const token = state.token;
      if (!item || !token) return;
      const value = input.value;
      let inserted;
      if (item.kind === "talent") {
        inserted = `@${item.talent.mention} `;
      } else {
        inserted = `@${item.file} `;
      }
      input.value = value.slice(0, token.start) + inserted + value.slice(token.end);
      const caret = token.start + inserted.length;
      close();
      input.focus();
      input.setSelectionRange(caret, caret);
    }

    function syncFromInput() {
      if (options.isDisabled?.()) {
        close();
        return;
      }
      const token = findMentionToken(
        input.value,
        input.selectionStart ?? input.value.length,
      );
      if (!token) {
        close();
        return;
      }
      state.token = token;
      openPalette();
      rebuildFlatItems();
      render();
      if (token.query || looksLikePathQuery(token.query)) {
        void ensureIndex().then(() => {
          if (!state.open || !state.token) return;
          rebuildFlatItems();
          render();
        });
      }
    }

    input.addEventListener("input", syncFromInput);

    input.addEventListener("keydown", (e) => {
      if (!state.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!state.flatItems.length) return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        state.selectedIndex =
          (state.selectedIndex + delta + state.flatItems.length) %
          state.flatItems.length;
        render();
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        if (!state.flatItems.length) {
          close();
          return;
        }
        e.preventDefault();
        selectItem(state.selectedIndex);
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (!state.open) return;
      if (paletteEl.contains(e.target) || input.contains(e.target)) return;
      close();
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement === input) return;
        if (paletteEl.contains(document.activeElement)) return;
        close();
      }, 120);
    });

    return {
      close,
      isOpen: () => state.open,
      invalidate: () => {
        state.index = null;
      },
    };
  }

  global.ForgeFileMention = { init };
})(typeof window !== "undefined" ? window : globalThis);
