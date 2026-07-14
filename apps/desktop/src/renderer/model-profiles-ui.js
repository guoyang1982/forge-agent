/** Visual editor for config.profiles (loaded before app.js). */
(function () {
  const PROVIDER_PRESETS = {
    openai: {
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
    },
    deepseek: {
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
    },
    dashscope: {
      label: "阿里云 DashScope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen3.7-plus",
    },
    anthropic: {
      label: "Anthropic (兼容)",
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-20250514",
    },
    custom: {
      label: "自定义",
      baseUrl: "",
      defaultModel: "",
    },
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function providerOptions(selected) {
    const keys = Object.keys(PROVIDER_PRESETS);
    return keys
      .map((id) => {
        const label = PROVIDER_PRESETS[id].label;
        const sel = id === selected ? " selected" : "";
        return `<option value="${escapeHtml(id)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join("");
  }

  function profileCardHtml(id, profile, isActive) {
    const p = profile ?? {};
    const enabled = p.enabled !== false;
    const provider = p.provider || "custom";
    const activeClass = isActive ? " model-profile-card--active" : "";
    const disabledClass = enabled ? "" : " model-profile-card--disabled";
    return `
      <article class="model-profile-card${activeClass}${disabledClass}" data-profile-id="${escapeHtml(id)}">
        <header class="model-profile-card-head">
          <div class="model-profile-card-title">
            <input type="text" class="profile-id-input" value="${escapeHtml(id)}" placeholder="配置档 ID" title="配置档唯一标识" />
            ${isActive ? '<span class="model-profile-badge">当前</span>' : ""}
          </div>
          <div class="model-profile-card-tools">
            <label class="toggle toggle-compact" title="停用后不可选用">
              <input type="checkbox" class="profile-enabled-input" ${enabled ? "checked" : ""} />
              <span>启用</span>
            </label>
            <button type="button" class="icon-btn subtle profile-delete-btn" title="删除此配置档">✕</button>
          </div>
        </header>
        <div class="field-grid">
          <div class="field">
            <label>提供商</label>
            <select class="profile-provider-input">${providerOptions(provider)}</select>
          </div>
          <div class="field">
            <label>模型 ID</label>
            <input type="text" class="profile-name-input" value="${escapeHtml(p.name || "")}" placeholder="例如 qwen3.7-plus" />
          </div>
        </div>
        <div class="field">
          <label>API Base URL</label>
          <input type="text" class="profile-baseurl-input" value="${escapeHtml(p.baseUrl || "")}" placeholder="https://..." />
        </div>
        <div class="field">
          <label>API Key</label>
          <input type="password" class="profile-apikey-input" value="${escapeHtml(p.apiKey || "")}" placeholder="sk-..." autocomplete="off" />
        </div>
        <label class="toggle">
          <input type="checkbox" class="profile-vision-input" ${p.vision ? "checked" : ""} />
          <span>支持视觉（图片附件）</span>
        </label>
      </article>`;
  }

  function applyProviderPreset(card, providerId) {
    const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
    const baseEl = card.querySelector(".profile-baseurl-input");
    const nameEl = card.querySelector(".profile-name-input");
    if (baseEl && preset.baseUrl && !baseEl.value.trim()) {
      baseEl.value = preset.baseUrl;
    }
    if (nameEl && preset.defaultModel && !nameEl.value.trim()) {
      nameEl.value = preset.defaultModel;
    }
  }

  function bindCardEvents(card, listEl, getActiveId) {
    const providerSel = card.querySelector(".profile-provider-input");
    providerSel?.addEventListener("change", () => {
      const pid = providerSel.value;
      applyProviderPreset(card, pid);
      if (pid !== "custom") {
        const baseEl = card.querySelector(".profile-baseurl-input");
        const nameEl = card.querySelector(".profile-name-input");
        const preset = PROVIDER_PRESETS[pid];
        if (baseEl && preset?.baseUrl) baseEl.value = preset.baseUrl;
        if (nameEl && preset?.defaultModel) nameEl.value = preset.defaultModel;
      }
    });

    card.querySelector(".profile-enabled-input")?.addEventListener("change", (e) => {
      card.classList.toggle("model-profile-card--disabled", !e.target.checked);
    });

    card.querySelector(".profile-delete-btn")?.addEventListener("click", () => {
      const id = card.dataset.profileId || "";
      const remaining = listEl.querySelectorAll(".model-profile-card").length;
      if (remaining <= 1) {
        window.alert("至少保留一个模型配置档。");
        return;
      }
      const msg = id ? `确定删除配置档「${id}」？` : "确定删除此配置档？";
      if (!window.confirm(msg)) return;
      card.remove();
      refreshActiveBadges(listEl, getActiveId());
    });
  }

  function refreshActiveBadges(listEl, activeId) {
    listEl.querySelectorAll(".model-profile-card").forEach((card) => {
      const idInput = card.querySelector(".profile-id-input");
      const id = (idInput?.value || card.dataset.profileId || "").trim();
      const isActive = id === activeId;
      card.classList.toggle("model-profile-card--active", isActive);
      let badge = card.querySelector(".model-profile-badge");
      if (isActive && !badge) {
        const title = card.querySelector(".model-profile-card-title");
        if (title) {
          badge = document.createElement("span");
          badge.className = "model-profile-badge";
          badge.textContent = "当前";
          title.appendChild(badge);
        }
      } else if (!isActive && badge) {
        badge.remove();
      }
    });
  }

  function renderModelProfilesList(listEl, cfg) {
    if (!listEl) return;
    const profiles = cfg?.profiles ?? {};
    const keys = Object.keys(profiles);
    const activeId = cfg?.activeProfile ?? keys[0] ?? "";
    if (keys.length === 0) {
      const defaultId = "default";
      listEl.innerHTML = profileCardHtml(
        defaultId,
        {
          provider: "deepseek",
          baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
          name: PROVIDER_PRESETS.deepseek.defaultModel,
          apiKey: cfg?.model?.apiKey ?? "",
          enabled: true,
        },
        true,
      );
    } else {
      listEl.innerHTML = keys
        .map((id) => profileCardHtml(id, profiles[id], id === activeId))
        .join("");
    }
    const getActiveId = () => activeId;
    listEl.querySelectorAll(".model-profile-card").forEach((card) => {
      bindCardEvents(card, listEl, getActiveId);
    });
  }

  function collectProfilesFromList(listEl, previousCfg) {
    const cards = [...listEl.querySelectorAll(".model-profile-card")];
    const profiles = {};
    const ids = [];
    const renameMap = {};
    for (const card of cards) {
      const id = (card.querySelector(".profile-id-input")?.value || "").trim();
      const origId = (card.dataset.profileId || "").trim();
      if (origId && origId !== id) renameMap[origId] = id;
      if (!id) throw new Error("配置档 ID 不能为空");
      if (ids.includes(id)) throw new Error(`重复的配置档 ID：${id}`);
      ids.push(id);
      const provider = card.querySelector(".profile-provider-input")?.value || "custom";
      const enabled = Boolean(card.querySelector(".profile-enabled-input")?.checked);
      const name = (card.querySelector(".profile-name-input")?.value || "").trim();
      const baseUrl = (card.querySelector(".profile-baseurl-input")?.value || "").trim();
      const apiKey = card.querySelector(".profile-apikey-input")?.value || "";
      const vision = Boolean(card.querySelector(".profile-vision-input")?.checked);
      if (!name) throw new Error(`「${id}」：请填写模型 ID`);
      if (!baseUrl) throw new Error(`「${id}」：请填写 API Base URL`);
      const prev = previousCfg?.profiles?.[card.dataset.profileId || id];
      profiles[id] = {
        ...(prev && typeof prev === "object" ? prev : {}),
        provider: provider === "custom" ? undefined : provider,
        baseUrl,
        apiKey,
        name,
      };
      if (!enabled) profiles[id].enabled = false;
      else delete profiles[id].enabled;
      if (vision) profiles[id].vision = true;
      else delete profiles[id].vision;
    }
    let activeProfile = previousCfg?.activeProfile ?? ids[0];
    if (activeProfile && renameMap[activeProfile]) {
      activeProfile = renameMap[activeProfile];
    }
    if (!profiles[activeProfile]) {
      activeProfile = ids[0];
    }
    const activeProf = profiles[activeProfile];
    if (!activeProf || activeProf.enabled === false) {
      activeProfile = ids.find((id) => profiles[id]?.enabled !== false) ?? ids[0];
    }
    return { profiles, activeProfile };
  }

  function addEmptyProfileCard(listEl, cfg) {
    const n = listEl.querySelectorAll(".model-profile-card").length + 1;
    let id = `profile-${n}`;
    while (listEl.querySelector(`[data-profile-id="${id}"]`)) {
      id = `profile-${n++}`;
    }
    const wrap = document.createElement("div");
    wrap.innerHTML = profileCardHtml(
      id,
      {
        provider: "dashscope",
        baseUrl: PROVIDER_PRESETS.dashscope.baseUrl,
        name: PROVIDER_PRESETS.dashscope.defaultModel,
        apiKey: "",
        enabled: true,
      },
      false,
    );
    const card = wrap.firstElementChild;
    listEl.appendChild(card);
    bindCardEvents(card, listEl, () => cfg?.activeProfile);
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  window.ForgeModelProfilesUI = {
    renderModelProfilesList,
    collectProfilesFromList,
    addEmptyProfileCard,
    refreshActiveBadges,
  };
})();
