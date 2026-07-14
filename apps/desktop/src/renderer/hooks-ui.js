/** Hooks settings visual editor + in-app guide (loaded before app.js). */
(function () {
  const HOOK_EVENTS = [
    {
      id: "SessionStart",
      label: "SessionStart",
      when: "每轮对话开始时（可按 startup / resume / clear / compact 过滤）",
      matcher: "startup | resume | clear | compact",
    },
    {
      id: "UserPromptSubmit",
      label: "UserPromptSubmit",
      when: "用户消息提交给模型之前",
      matcher: "（通常留空 = 全部匹配）",
    },
    {
      id: "PreToolUse",
      label: "PreToolUse",
      when: "工具调用执行之前，可拦截",
      matcher: "工具名，如 write_patch | read_file",
    },
    {
      id: "PostToolUse",
      label: "PostToolUse",
      when: "工具执行完成之后",
      matcher: "工具名",
    },
    {
      id: "Stop",
      label: "Stop",
      when: "本轮 Agent 结束前",
      matcher: "（通常留空）",
    },
    {
      id: "PreCompact",
      label: "PreCompact",
      when: "执行 /compact 压缩历史之前",
      matcher: "（通常留空）",
    },
    {
      id: "SessionEnd",
      label: "SessionEnd",
      when: "Forge daemon 关闭时",
      matcher: "（通常留空）",
    },
  ];

  const HANDLER_TYPES = [
    { id: "command", label: "Shell 命令" },
    { id: "inject-text", label: "注入文本" },
    { id: "inject-skill", label: "注入 Skill" },
  ];

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function emptySettings() {
    return { hooks: {} };
  }

  function normalizeSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    return {
      disableAllHooks: s.disableAllHooks === true,
      hooks: s.hooks && typeof s.hooks === "object" ? s.hooks : {},
    };
  }

  function handlerFieldsHtml(entry) {
    const type = entry?.type || "command";
    const command = entry?.command || "";
    const text = entry?.text || "";
    const skillId = entry?.skillId || "";
    return `
      <div class="hooks-entry-fields">
        <div class="field">
          <label>类型</label>
          <select class="hooks-entry-type">
            ${HANDLER_TYPES.map(
              (t) =>
                `<option value="${t.id}"${type === t.id ? " selected" : ""}>${escapeHtml(t.label)}</option>`,
            ).join("")}
          </select>
        </div>
        <div class="field hooks-field-command" ${type !== "command" ? 'style="display:none"' : ""}>
          <label>command</label>
          <input type="text" class="hooks-entry-command" value="${escapeHtml(command)}" placeholder=".forge/hooks/my-hook.sh" />
        </div>
        <div class="field hooks-field-text" ${type !== "inject-text" ? 'style="display:none"' : ""}>
          <label>text</label>
          <textarea class="hooks-entry-text" rows="3" placeholder="注入到 prompt 的文本规则">${escapeHtml(text)}</textarea>
        </div>
        <div class="field hooks-field-skill" ${type !== "inject-skill" ? 'style="display:none"' : ""}>
          <label>skillId</label>
          <input type="text" class="hooks-entry-skill" value="${escapeHtml(skillId)}" placeholder="skill-id" />
        </div>
      </div>`;
  }

  function entryHtml(entry) {
    return `
      <article class="hooks-entry-card">
        <header class="hooks-entry-head">
          <span>处理程序</span>
          <button type="button" class="icon-btn subtle hooks-remove-entry" title="删除">✕</button>
        </header>
        ${handlerFieldsHtml(entry)}
      </article>`;
  }

  function groupHtml(group) {
    const matcher = group?.matcher || "";
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    const entries =
      hooks.length > 0
        ? hooks.map((h) => entryHtml(h)).join("")
        : entryHtml({ type: "inject-text" });
    return `
      <article class="hooks-group-card">
        <header class="hooks-group-head">
          <div class="field hooks-group-matcher-field">
            <label>matcher</label>
            <input type="text" class="hooks-group-matcher" value="${escapeHtml(matcher)}" placeholder="留空 = 匹配全部" />
          </div>
          <button type="button" class="btn secondary btn-sm hooks-remove-group">删除组</button>
        </header>
        <div class="hooks-entries">${entries}</div>
        <button type="button" class="btn secondary btn-sm hooks-add-entry">+ 添加处理程序</button>
      </article>`;
  }

  function eventSectionHtml(eventDef, groups) {
    const list = Array.isArray(groups) ? groups : [];
    const body =
      list.length > 0
        ? list.map((g) => groupHtml(g)).join("")
        : groupHtml({ hooks: [{ type: "inject-text", text: "" }] });
    return `
      <details class="hooks-event-section" open>
        <summary>
          <strong>${escapeHtml(eventDef.label)}</strong>
          <span class="hooks-event-when">${escapeHtml(eventDef.when)}</span>
        </summary>
        <p class="hooks-event-matcher tiny">matcher 示例：${escapeHtml(eventDef.matcher)}</p>
        <div class="hooks-groups" data-event="${escapeHtml(eventDef.id)}">${body}</div>
        <button type="button" class="btn secondary btn-sm hooks-add-group" data-event="${escapeHtml(eventDef.id)}">+ 添加匹配组</button>
      </details>`;
  }

  function renderGuideHtml() {
    return `
      <div class="hooks-guide">
        <h3>Forge Hooks 说明</h3>
        <p>Hooks 在 Agent 生命周期的固定节点执行，用于注入规则、运行脚本或拦截操作。配置保存在 <code>settings.json</code> 的 <code>hooks</code> 字段，<strong>不是</strong> <code>config.json</code>。</p>

        <h4>配置层级（按执行顺序合并）</h4>
        <ol class="hooks-guide-list">
          <li><strong>用户</strong>：<code>~/.forge-agent/settings.json</code>（可在「设置 → Hooks」编辑）</li>
          <li><strong>项目</strong>：<code>&lt;项目&gt;/.forge/settings.json</code>（本页「项目」标签）</li>
          <li><strong>项目本地</strong>：<code>.forge/settings.local.json</code>（不提交 Git）</li>
          <li><strong>插件</strong>：<code>&lt;插件&gt;/hooks/hooks.json</code>（只读，随插件安装）</li>
        </ol>
        <p class="tiny">兼容读取 <code>~/.claude/settings.json</code> 与 <code>.claude/settings.json</code>，便于迁移 Claude Code 配置。</p>

        <h4>处理程序类型</h4>
        <ul class="hooks-guide-list">
          <li><strong>command</strong>：执行 shell；stdin 收到 JSON 事件；stdout 可返回 <code>additionalContext</code> 或 <code>permissionDecision: deny</code>；退出码 <code>2</code> 表示阻止。</li>
          <li><strong>inject-text</strong>：直接把文本注入本轮 prompt（Forge 扩展）。</li>
          <li><strong>inject-skill</strong>：注入指定 Skill 全文（Forge 扩展）。</li>
        </ul>

        <h4>SessionStart 与斜杠命令</h4>
        <ul class="hooks-guide-list">
          <li><code>/clear</code> 后下一条消息 → <code>source: clear</code></li>
          <li><code>/compact</code> 后下一条消息 → <code>source: compact</code></li>
          <li>新会话首条 → <code>startup</code>；有历史 → <code>resume</code></li>
        </ul>

        <h4>示例（项目 .forge/settings.json）</h4>
        <pre class="hooks-guide-pre">${escapeHtml(`{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [{ "type": "inject-text", "text": "Read AGENTS.md before editing." }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [{ "type": "command", "command": ".forge/hooks/validate-shell.sh" }]
      }
    ]
  }
}`)}</pre>
        <p class="tiny">完整文档见仓库 <code>docs/hooks-guide.md</code>。</p>
      </div>`;
  }

  function renderEditorHtml(settings, meta) {
    const s = normalizeSettings(settings);
    const pathLine = meta?.path
      ? `<p class="hooks-path tiny">文件：<code>${escapeHtml(meta.path)}</code>${meta.exists ? "" : "（将新建）"}</p>`
      : "";
    const eventsHtml = HOOK_EVENTS.map((ev) =>
      eventSectionHtml(ev, s.hooks[ev.id]),
    ).join("");
    return `
      <div class="hooks-editor" data-hooks-scope="${escapeHtml(meta?.scope || "")}">
        ${pathLine}
        <label class="toggle hooks-disable-all">
          <input type="checkbox" class="hooks-disable-input" ${s.disableAllHooks ? "checked" : ""} />
          <span>disableAllHooks（禁用本文件内全部 hooks）</span>
        </label>
        <div class="hooks-events">${eventsHtml}</div>
        <details class="settings-advanced-json hooks-advanced-json">
          <summary>高级：直接编辑 JSON</summary>
          <textarea class="hooks-json-input" rows="14">${escapeHtml(JSON.stringify(s, null, 2))}</textarea>
          <button type="button" class="btn secondary btn-sm hooks-load-json">从 JSON 加载到表单</button>
        </details>
        <div class="hooks-editor-actions">
          <button type="button" class="btn primary hooks-save-btn">保存 Hooks 配置</button>
        </div>
      </div>`;
  }

  function syncEntryTypeFields(entryCard) {
    const type = entryCard.querySelector(".hooks-entry-type")?.value || "command";
    entryCard.querySelector(".hooks-field-command").style.display =
      type === "command" ? "" : "none";
    entryCard.querySelector(".hooks-field-text").style.display =
      type === "inject-text" ? "" : "none";
    entryCard.querySelector(".hooks-field-skill").style.display =
      type === "inject-skill" ? "" : "none";
  }

  function bindEditor(root) {
    if (!root) return;
    root.querySelectorAll(".hooks-entry-card").forEach((card) => {
      const typeSel = card.querySelector(".hooks-entry-type");
      typeSel?.addEventListener("change", () => syncEntryTypeFields(card));
      card.querySelector(".hooks-remove-entry")?.addEventListener("click", () => {
        const parent = card.parentElement;
        card.remove();
        if (parent && !parent.querySelector(".hooks-entry-card")) {
          parent.insertAdjacentHTML("beforeend", entryHtml({ type: "inject-text" }));
          bindEditor(parent.closest(".hooks-editor") || root);
        }
      });
    });

    root.querySelectorAll(".hooks-remove-group").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.closest(".hooks-group-card")?.remove();
      });
    });

    root.querySelectorAll(".hooks-add-entry").forEach((btn) => {
      btn.addEventListener("click", () => {
        const container = btn.previousElementSibling;
        if (container) {
          container.insertAdjacentHTML("beforeend", entryHtml({ type: "inject-text" }));
          bindEditor(root);
        }
      });
    });

    root.querySelectorAll(".hooks-add-group").forEach((btn) => {
      btn.addEventListener("click", () => {
        const eventId = btn.getAttribute("data-event");
        const groupsEl = root.querySelector(`.hooks-groups[data-event="${eventId}"]`);
        if (groupsEl) {
          groupsEl.insertAdjacentHTML("beforeend", groupHtml({ hooks: [{ type: "inject-text" }] }));
          bindEditor(root);
        }
      });
    });

    root.querySelector(".hooks-load-json")?.addEventListener("click", () => {
      try {
        const parsed = JSON.parse(root.querySelector(".hooks-json-input")?.value || "{}");
        const scope = root.dataset.hooksScope;
        const editorHost = root.parentElement;
        const meta = { scope, path: root.querySelector(".hooks-path code")?.textContent };
        root.outerHTML = renderEditorHtml(parsed, meta);
        bindEditor(editorHost.querySelector(".hooks-editor"));
      } catch (e) {
        alert(`JSON 无效: ${e}`);
      }
    });
  }

  function collectEntry(card) {
    const type = card.querySelector(".hooks-entry-type")?.value || "command";
    const entry = { type };
    if (type === "command") {
      const cmd = card.querySelector(".hooks-entry-command")?.value?.trim();
      if (cmd) entry.command = cmd;
    } else if (type === "inject-text") {
      const text = card.querySelector(".hooks-entry-text")?.value?.trim();
      if (text) entry.text = text;
    } else if (type === "inject-skill") {
      const skillId = card.querySelector(".hooks-entry-skill")?.value?.trim();
      if (skillId) entry.skillId = skillId;
    }
    return entry;
  }

  function collectSettings(root) {
    if (!root) return emptySettings();
    const disableAllHooks = Boolean(
      root.querySelector(".hooks-disable-input")?.checked,
    );
    const hooks = {};
    root.querySelectorAll(".hooks-groups").forEach((groupsEl) => {
      const eventId = groupsEl.getAttribute("data-event");
      if (!eventId) return;
      const groups = [];
      groupsEl.querySelectorAll(".hooks-group-card").forEach((groupCard) => {
        const matcher = groupCard.querySelector(".hooks-group-matcher")?.value?.trim();
        const entries = [];
        groupCard.querySelectorAll(".hooks-entry-card").forEach((entryCard) => {
          const entry = collectEntry(entryCard);
          if (
            entry.command ||
            entry.text ||
            entry.skillId ||
            entry.type !== "command"
          ) {
            entries.push(entry);
          }
        });
        if (entries.length) {
          const group = { hooks: entries };
          if (matcher) group.matcher = matcher;
          groups.push(group);
        }
      });
      if (groups.length) hooks[eventId] = groups;
    });
    const out = { hooks };
    if (disableAllHooks) out.disableAllHooks = true;
    return out;
  }

  function renderDiscoveredTable(rows) {
    if (!rows?.length) {
      return `<div class="hooks-discovered-empty">当前未发现任何 Hook。在「项目」或「设置 → Hooks」中添加配置后刷新。</div>`;
    }
    const body = rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.sourceId)}</td>
          <td>${escapeHtml(r.event)}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${escapeHtml(r.matcher || "—")}</td>
        </tr>`,
      )
      .join("");
    return `
      <div class="hooks-discovered-wrap">
        <p class="tiny">合并自用户 / 项目 / 插件等来源，只读列表。</p>
        <table class="hooks-discovered-table">
          <thead><tr><th>来源</th><th>标识</th><th>事件</th><th>类型</th><th>matcher</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  window.ForgeHooksUI = {
    HOOK_EVENTS,
    renderGuideHtml,
    renderEditorHtml,
    renderDiscoveredTable,
    bindEditor,
    collectSettings,
    normalizeSettings,
    emptySettings,
  };
})();
