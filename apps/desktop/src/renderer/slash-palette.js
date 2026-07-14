/**
 * Slash command palette for the composer input (triggered by typing `/`).
 */
(function initForgeSlashPalette(global) {
  const MAX_COLLAPSED = 3;

  /** Mirrors apps/cli/src/commands/builtin.ts (REPL slash commands). */
  const BUILTIN_COMMANDS = [
    {
      id: "help",
      label: "help",
      title: "Help",
      description: "显示完整斜杠命令与快捷键说明",
      usage: "/help",
      detail:
        "列出 REPL 可用命令、@文件 引用、补丁确认键（y/n/v）等。桌面端部分命令（如 /compact、/clear）会本地执行，不会发给模型。",
      insert: "/help ",
      aliases: ["h", "?", "commands", "hints"],
      kind: "command",
    },
    {
      id: "clear",
      label: "clear",
      title: "Clear",
      description: "清空当前会话，开始新对话",
      usage: "/clear",
      detail:
        "丢弃当前 session 绑定并清空时间线，不删除历史 session 记录。适合上下文已满或要换话题时使用。",
      action: "new-chat",
      aliases: ["new"],
      kind: "command",
    },
    {
      id: "cwd",
      label: "cwd",
      title: "Cwd",
      description: "查看或切换 Agent 工作区根目录",
      usage: "/cwd [路径]",
      detail:
        "无参数时打印当前 cwd；带路径时切换工作区（目录不存在会尝试创建）。所有 read_file / write_patch 均限制在该目录内。",
      insert: "/cwd ",
      kind: "command",
    },
    {
      id: "session",
      label: "session",
      title: "Session",
      description: "显示当前会话 ID",
      usage: "/session",
      detail: "用于 /resume 或 forge session 时指定 id 前缀。桌面端会话与左侧项目绑定。",
      insert: "/session ",
      aliases: ["id"],
      kind: "command",
    },
    {
      id: "sessions",
      label: "sessions",
      title: "Sessions",
      description: "列出最近会话",
      usage: "/sessions",
      detail: "按更新时间列出历史 session 及预览，便于选择 /resume 恢复。",
      insert: "/sessions ",
      aliases: ["ls"],
      kind: "command",
    },
    {
      id: "resume",
      label: "resume",
      title: "Resume",
      description: "按 id 前缀恢复历史会话",
      usage: "/resume <id前缀>",
      detail:
        "匹配唯一 session 后加载其消息历史并切换到对应工作区。前缀过短匹配多条时需输入更长 id。",
      insert: "/resume ",
      aliases: ["r"],
      kind: "command",
    },
    {
      id: "compact",
      label: "compact",
      title: "Compact",
      description: "压缩会话历史，降低上下文占用",
      usage: "/compact [保留条数]",
      detail:
        "由 daemon 将较早消息合并为一条摘要并写入数据库（不是 memory_save）。默认保留最近 12 条；可写 /compact 8 更激进。压缩后请用一句话重述当前任务。",
      insert: "/compact ",
      aliases: ["压缩"],
      kind: "command",
    },
    {
      id: "plan",
      label: "plan",
      title: "Plan",
      description: "生成只读实现计划",
      usage: "/plan <目标>",
      detail:
        "调用规划工作流，只读分析代码与上下文，不修改文件。适合在动手改代码前先对齐步骤与风险。",
      insert: "/plan ",
      kind: "command",
    },
    {
      id: "review",
      label: "review",
      title: "Review",
      description: "审查当前 git diff",
      usage: "/review",
      detail:
        "基于工作区未提交变更做结构化代码审查，输出问题与建议，默认不写回仓库。",
      insert: "/review ",
      kind: "command",
    },
    {
      id: "run",
      label: "run",
      title: "Run",
      description: "运行项目建议命令",
      usage: "/run",
      detail:
        "根据 AGENTS.md 或最近改动推断的 test/dev 命令，在受控 shell 中执行并回传输出。",
      insert: "/run ",
      aliases: ["exec"],
      kind: "command",
    },
    {
      id: "model",
      label: "model",
      title: "Model",
      description: "查看或切换 LLM 厂商与模型",
      usage: "/model [厂商] [模型名]",
      detail:
        "列出 config 中的 profiles，或切换到指定 provider/model。API Key 来自 ~/.forge-agent/config.json 或环境变量。",
      insert: "/model ",
      aliases: ["m"],
      kind: "command",
    },
    {
      id: "talents",
      label: "talents",
      title: "Talents",
      description: "浏览人才市场模板",
      usage: "/talents [分类]",
      detail: "列出已同步的 agency-agents 模板；带分类可筛选 engineering、product 等。",
      insert: "/talents ",
      aliases: ["talent"],
      kind: "command",
    },
    {
      id: "roster",
      label: "roster",
      title: "Roster",
      description: "查看已租用人才",
      usage: "/roster",
      detail: "列出当前项目（及全局）已 hire 的人才与 @mention。",
      insert: "/roster ",
      kind: "command",
    },
    {
      id: "hire",
      label: "hire",
      title: "Hire",
      description: "租用人才模板",
      usage: "/hire <template-id>",
      detail: "从模板库创建一名可 @ 调用的人才；也可在「人才」页点击租用。",
      insert: "/hire ",
      kind: "command",
    },
    {
      id: "open",
      label: "open",
      title: "Open",
      description: "用系统默认应用打开文件",
      usage: "/open <相对路径>",
      detail: "在工作区内解析路径并用 OS 默认程序打开（如预览图片、用 IDE 打开配置）。",
      insert: "/open ",
      aliases: ["o"],
      kind: "command",
    },
  ];

  const MODES = [
    {
      id: "ask",
      label: "Ask",
      title: "Ask",
      description: "只读问答模式",
      usage: "前缀插入 Ask 提示",
      detail:
        "在消息开头注入约束：仅解释与回答，不调用写文件或 shell。适合查概念、读代码、对比方案。",
      insert: "【Ask 模式】请只回答与解释，不要修改文件或执行命令。\n\n",
      kind: "mode",
    },
    {
      id: "agent",
      label: "Agent",
      title: "Agent",
      description: "默认完整 Agent 模式",
      usage: "（无额外前缀）",
      detail:
        "可使用 read_file、write_patch、run_command、Skill 等全部能力，按项目规则自动改代码与验证。",
      insert: "",
      kind: "mode",
    },
  ];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function matchesQuery(item, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    const hay = [
      item.label,
      item.id,
      item.title,
      item.description,
      item.detail,
      item.usage,
      ...(item.aliases ?? []),
      ...(item.triggers ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      hay.includes(q) ||
      (item.aliases ?? []).some((a) => a.toLowerCase().startsWith(q)) ||
      item.id.toLowerCase().startsWith(q) ||
      item.label.toLowerCase().startsWith(q)
    );
  }

  function flattenSkills(groups) {
    const out = [];
    for (const group of groups ?? []) {
      for (const skill of group.skills ?? []) {
        const triggers = (skill.triggers ?? []).filter(Boolean);
        const shortDesc =
          skill.description || triggers.slice(0, 4).join(" · ") || "（无说明）";
        out.push({
          id: skill.id,
          label: skill.id,
          title: skill.name || skill.id,
          description: shortDesc,
          usage: `/skill ${skill.id}`,
          detail:
            skill.description && triggers.length
              ? `触发词：${triggers.slice(0, 8).join("、")}。选中后会在消息中插入 /skill 引用，由 Agent 加载 SKILL.md 与 bundled 文件。`
              : triggers.length
                ? `触发词：${triggers.join("、")}。匹配任务描述时 Agent 会按需 read_file 加载完整 Skill。`
                : "在消息中显式引用该 Skill，Agent 将读取 SKILL.md 并按其中流程执行。",
          insert: `/skill ${skill.id} `,
          kind: "skill",
          triggers,
        });
      }
    }
    return out;
  }

  function iconForKind(kind) {
    if (kind === "skill") {
      return `<span class="slash-palette-icon slash-palette-icon-skill" aria-hidden="true">✦</span>`;
    }
    if (kind === "mode") {
      return `<span class="slash-palette-icon slash-palette-icon-mode" aria-hidden="true">?</span>`;
    }
    return `<span class="slash-palette-icon slash-palette-icon-cmd" aria-hidden="true">⚡</span>`;
  }

  function init(options) {
    const input = options.input;
    const paletteEl = options.paletteEl;
    if (!input || !paletteEl) return;

    const state = {
      open: false,
      query: "",
      flatItems: [],
      selectedIndex: 0,
      skillsCache: null,
      skillsLoading: false,
      expanded: { skills: false, commands: false, modes: false },
    };

    const previewEl = document.createElement("div");
    previewEl.className = "slash-palette-preview hidden";
    previewEl.setAttribute("aria-live", "polite");
    paletteEl.appendChild(previewEl);

    function close() {
      state.open = false;
      paletteEl.classList.add("hidden");
      previewEl.classList.add("hidden");
    }

    function open() {
      state.open = true;
      paletteEl.classList.remove("hidden");
    }

    function getSlashQuery(value) {
      const trimmed = value.trimStart();
      if (!trimmed.startsWith("/")) return null;
      const token = trimmed.slice(1).split(/\s/)[0] ?? "";
      return token.toLowerCase();
    }

    function shouldShowPalette(value) {
      if (options.isDisabled?.()) return false;
      const trimmed = value.trimStart();
      if (!trimmed.startsWith("/")) return false;
      if (/\s/.test(trimmed.slice(1))) return false;
      return true;
    }

    async function ensureSkills() {
      if (state.skillsCache || state.skillsLoading) return;
      if (typeof options.listSkills !== "function") {
        state.skillsCache = [];
        return;
      }
      state.skillsLoading = true;
      try {
        const res = await options.listSkills();
        state.skillsCache = Array.isArray(res?.groups) ? res.groups : [];
      } catch {
        state.skillsCache = [];
      } finally {
        state.skillsLoading = false;
      }
    }

    function buildFlatItems(query) {
      const skills = flattenSkills(state.skillsCache).filter((s) => matchesQuery(s, query));
      const commands = BUILTIN_COMMANDS.filter((c) => matchesQuery(c, query));
      const modes = MODES.filter((m) => matchesQuery(m, query));
      return { skills, commands, modes };
    }

    function renderSection(title, items, sectionKey, kind) {
      if (!items.length) return "";
      const expanded = state.expanded[sectionKey];
      const visible = expanded ? items : items.slice(0, MAX_COLLAPSED);
      const more = items.length - visible.length;
      const rows = visible
        .map((item) => {
          const globalIdx = state.flatItems.indexOf(item);
          const selected = globalIdx === state.selectedIndex;
          return `<button type="button" class="slash-palette-item${selected ? " is-selected" : ""}" data-idx="${globalIdx}" role="option" aria-selected="${selected}">
            ${iconForKind(kind)}
            <span class="slash-palette-label">${escapeHtml(item.label)}</span>
          </button>`;
        })
        .join("");
      const moreBtn =
        more > 0
          ? `<button type="button" class="slash-palette-more" data-expand="${sectionKey}">再显示 ${more} 项</button>`
          : "";
      return `<div class="slash-palette-section">
        <div class="slash-palette-section-title">${escapeHtml(title)}</div>
        <div class="slash-palette-items">${rows}</div>
        ${moreBtn}
      </div>`;
    }

    function previewKindLabel(kind) {
      if (kind === "skill") return "Skill";
      if (kind === "mode") return "Mode";
      return "Command";
    }

    function updatePreview() {
      const item = state.flatItems[state.selectedIndex];
      if (!item) {
        previewEl.classList.add("hidden");
        return;
      }
      previewEl.classList.remove("hidden");
      const aliases =
        item.aliases?.length ? `别名: ${item.aliases.map((a) => `/${a}`).join(", ")}` : "";
      const triggers =
        item.triggers?.length && item.kind === "skill"
          ? `触发: ${item.triggers.slice(0, 6).join(", ")}`
          : "";
      const meta = [aliases, triggers].filter(Boolean).join(" · ");
      previewEl.innerHTML = `
        <div class="slash-palette-preview-kind">${escapeHtml(previewKindLabel(item.kind))}</div>
        <div class="slash-palette-preview-title">${escapeHtml(item.title)}</div>
        ${item.usage ? `<div class="slash-palette-preview-usage">${escapeHtml(item.usage)}</div>` : ""}
        ${item.description ? `<div class="slash-palette-preview-desc">${escapeHtml(item.description)}</div>` : ""}
        ${item.detail ? `<div class="slash-palette-preview-detail">${escapeHtml(item.detail)}</div>` : ""}
        ${meta ? `<div class="slash-palette-preview-meta">${escapeHtml(meta)}</div>` : ""}`;
    }

    function setSelectedIndex(index, body) {
      if (index < 0 || index >= state.flatItems.length) return;
      state.selectedIndex = index;
      if (body) {
        body.querySelectorAll(".slash-palette-item").forEach((btn) => {
          const idx = Number(btn.dataset.idx);
          btn.classList.toggle("is-selected", idx === index);
          btn.setAttribute("aria-selected", idx === index ? "true" : "false");
        });
      }
      updatePreview();
    }

    function render() {
      const grouped = buildFlatItems(state.query);
      state.flatItems = [...grouped.skills, ...grouped.commands, ...grouped.modes];
      if (state.selectedIndex >= state.flatItems.length) {
        state.selectedIndex = Math.max(0, state.flatItems.length - 1);
      }

      if (!state.flatItems.length) {
        paletteEl.innerHTML = "";
        paletteEl.appendChild(previewEl);
        paletteEl.insertAdjacentHTML(
          "beforeend",
          `<div class="slash-palette-empty">没有匹配的命令</div>`,
        );
        previewEl.classList.add("hidden");
        return;
      }

      const body = document.createElement("div");
      body.className = "slash-palette-body";
      body.innerHTML =
        (state.skillsLoading
          ? `<div class="slash-palette-section"><div class="slash-palette-section-title">Skills</div><div class="slash-palette-loading">加载中…</div></div>`
          : renderSection("Skills", grouped.skills, "skills", "skill")) +
        renderSection("Commands", grouped.commands, "commands", "command") +
        renderSection("Modes", grouped.modes, "modes", "mode");

      paletteEl.innerHTML = "";
      paletteEl.appendChild(body);
      paletteEl.appendChild(previewEl);
      updatePreview();

      body.querySelectorAll(".slash-palette-item").forEach((btn) => {
        btn.addEventListener("mouseenter", () => {
          setSelectedIndex(Number(btn.dataset.idx), body);
        });
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectItem(Number(btn.dataset.idx));
        });
      });
      body.querySelectorAll(".slash-palette-more").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          state.expanded[btn.dataset.expand] = true;
          render();
        });
      });

      const selectedBtn = body.querySelector(".slash-palette-item.is-selected");
      selectedBtn?.scrollIntoView({ block: "nearest" });
    }

    function selectItem(index) {
      const item = state.flatItems[index];
      if (!item) return;
      if (item.action === "new-chat") {
        options.onAction?.("new-chat");
        input.value = "";
        close();
        input.focus();
        return;
      }
      input.value = item.insert ?? "";
      close();
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }

    function syncFromInput() {
      const value = input.value;
      if (!shouldShowPalette(value)) {
        close();
        return;
      }
      const q = getSlashQuery(value);
      state.query = q ?? "";
      open();
      void ensureSkills().then(() => render());
      if (!state.skillsLoading && state.skillsCache) render();
    }

    input.addEventListener("input", syncFromInput);

    input.addEventListener("keydown", (e) => {
      if (!state.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!state.flatItems.length) return;
        const next = (state.selectedIndex + 1) % state.flatItems.length;
        state.selectedIndex = next;
        render();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!state.flatItems.length) return;
        state.selectedIndex =
          (state.selectedIndex - 1 + state.flatItems.length) % state.flatItems.length;
        render();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && state.flatItems.length && shouldShowPalette(input.value)) {
        e.preventDefault();
        selectItem(state.selectedIndex);
      }
      if (e.key === "Tab" && state.flatItems.length) {
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

    return { close, invalidateSkillsCache: () => { state.skillsCache = null; } };
  }

  global.ForgeSlashPalette = { init };
})(typeof window !== "undefined" ? window : globalThis);
