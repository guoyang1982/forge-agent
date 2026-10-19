(function attachForgeDeliveryUi(root) {
  const CLAIM_LABELS = {
    fact: "事实",
    inference: "推断",
    hypothesis: "假设",
    unknown: "未知",
  };

  const GATE_LABELS = {
    research: "调研下一步",
    scope: "确认开发范围",
    technical: "确认实现方案",
    release: "发布检查",
  };

  const OUTCOME_LABELS = {
    approved: "已批准",
    rejected: "已驳回",
    changes_requested: "要修改",
    stopped: "已结束调研",
    pending: "未决策",
    draft: "草稿",
  };

  const STATE_LABELS = {
    draft: "草稿",
    ready: "待派活",
    in_progress: "执行中",
    blocked: "阻塞",
    waiting_input: "等待输入",
    waiting: "等待中",
    submitted: "待验收",
    waiting_approval: "待验收",
    verifying: "核验中",
    accepted: "已验收",
    completed: "已完成",
    rejected: "已驳回",
    cancelled: "已取消",
    failed: "失败",
    pending: "未开始",
    running: "执行中",
    succeeded: "已完成",
  };

  const NEXT_ACTION_LABELS = {
    none: "—",
    takeover: "去工作台接管",
    enter_product_definition: "进入产品定义",
  };

  function formatResearchFailure(reason) {
    const raw = String(reason || "").trim();
    if (!raw) return "";
    if (/RESEARCH_BRANCH_TIMEOUT/i.test(raw) || /timed out/i.test(raw)) {
      return "调研分支超时（模型还在检索时被中断）。已加长时限，请重试。";
    }
    if (/RESEARCH_BRANCH_OUTPUT_INVALID/i.test(raw)) {
      return "调研分支未产出约定 JSON（常见原因：60 秒超时中断）。已加长时限，请重试。";
    }
    if (/no matching grant/i.test(raw)) {
      return "缺少工作区运行授权，请重试（启动时会自动补齐）。";
    }
    if (/BUDGET_EXCEEDED/i.test(raw)) {
      return "公司预算不足，评估中断。请在组织/预算侧充值或调高额度后重试。";
    }
    return raw;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function labelOutcome(value) {
    return OUTCOME_LABELS[value] || value || "未决策";
  }

  function labelState(value) {
    return STATE_LABELS[value] || value || "未开始";
  }

  function labelNextAction(value) {
    if (!value || value === "none") return "—";
    return NEXT_ACTION_LABELS[value] || value;
  }

  function fileParts(path) {
    const normalized = String(path || "").replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const name = parts.pop() || normalized;
    const dir = parts.join("/");
    const ext = (name.includes(".") ? name.split(".").pop() : "FILE").slice(0, 4).toUpperCase();
    return { name, dir, ext };
  }

  function takeoverRequest(step) {
    return {
      kind: "run",
      id: step.runId,
      stepId: step.stepId,
      mode: "takeover",
    };
  }

  function openWorkbenchTakeover(openWorkbench, step) {
    const request = takeoverRequest(step);
    return openWorkbench(`forge://workbench/run/${request.id}`, {
      workItemId: step.workItemId,
      sessionId: step.sessionId,
      cwd: step.cwd,
      stepId: request.stepId,
      mode: request.mode,
    });
  }

  function renderIntakePage(model) {
    if (model?.archived) return `<details class="card delivery-card delivery-details" id="deliveryIntake"><summary>需求背景 · 已归档</summary>${model.existing ? `<p class="report-text">${escapeHtml(model.existing.problem)}</p>` : ""}<p class="hint">项目已归档，报告与产物仍可查看。新需求请新建项目。</p></details>`;
    const open = model?.isNew || model?.keepOpen ? "open" : "";
    return `
      <details class="card delivery-card delivery-details" id="deliveryIntake" ${open}>
        <summary>${model?.isNew ? "登记调研需求" : "需求背景 · 新增调研"}</summary>
        ${model?.existing ? `<p class="report-text">${escapeHtml(model.existing.problem)}</p><p class="muted">期望结果：${escapeHtml(model.existing.expectedOutcome)}</p>` : ""}
        <p class="hint">写清要解决的问题。登记后可在上方「评估想法」直接评估可行性。</p>
        <form id="deliveryIntakeForm" class="form-stack">
          <label>调研问题<textarea name="problem" required rows="2" placeholder="你希望弄清什么？"></textarea></label>
          <div class="intake-fields">
            <label>目标用户<input name="targetUser" required placeholder="谁会用、在什么场景用" /></label>
            <label>期望结果<input name="expectedOutcome" required placeholder="例如：明确是否值得开发" /></label>
          </div>
          <label>约束（选填）<input name="constraints" placeholder="时间、范围或限制" /></label>
          <button type="submit">登记调研需求</button>
        </form>
      </details>`;
  }

  function renderFeasibilityStart(model) {
    if (!model?.runnable) return "";
    const disabled = !model.briefId || model.pending;
    const idea = model.idea;
    const recommend = model.nextAction === "enter_product_definition"
      ? '<p class="hint"><b>建议进入需求设计</b>：调研结论支持继续，可在工作中心确认规格与计划。</p>'
      : "";
    const runState = model.workflow?.runState;
    const failure = formatResearchFailure(model.workflow?.failureReason);
    const hasSynthesis = Boolean(model.workflow?.synthesisRecommendation);
    const progress = hasSynthesis && (model.workflow?.waitingAtGate || runState === "waiting")
      ? `<p class="hint">调研已汇总，正在等待你的决策。请先阅读下方「调研成果」，再在「下一步」决定是否进入需求设计。</p>`
      : runState === "running"
        ? `<p class="hint">调研进行中。工作台会打开对应只读会话；四个分支跑完后才会出现调研成果。</p>`
        : runState === "failed" && failure
          ? `<p class="notice" role="alert">上次评估失败：${escapeHtml(failure)}。可再点下方按钮重试。</p>`
          : "";
    const ideaBlock = idea?.problem
      ? `<section class="current-idea">
          <p class="eyebrow">当前想法</p>
          <p class="report-text">${escapeHtml(idea.problem)}</p>
          ${idea.expectedOutcome ? `<p class="muted">期望结果：${escapeHtml(idea.expectedOutcome)}</p>` : ""}
          <p class="hint">${model.briefId ? "简报已就绪，可直接评估可行性。" : "简报未就绪，请重新登记并填写目标用户。"}</p>
        </section>`
      : '<p class="muted">还没有可评估的想法。先在下方登记调研需求。</p>';
    return `<article class="card delivery-card" id="deliveryFeasibility">
      <div class="card-title"><h2>评估想法</h2></div>
      <p class="hint">让研究员从用户、市场、代码数据、风险四个角度并行调研，汇总后由你决定是否进入需求设计。全程只读。</p>
      ${ideaBlock}
      ${progress}
      ${recommend}
      <div class="gate-actions"><button type="button" data-start-feasibility data-project-id="${escapeHtml(model.projectId || "")}" data-brief-id="${escapeHtml(model.briefId || "")}" ${disabled ? "disabled" : ""}>${model.pending ? "正在启动…" : runState === "failed" ? "重新评估想法可行性" : "评估想法可行性"}</button></div>
      ${model.briefId || !idea?.problem ? "" : '<p class="muted">先登记调研需求并确认调研简报，才能开始评估。</p>'}
    </article>`;
  }

  function buildResultsModel(workItems, projectId) {
    const items = projectId ? (workItems || []).filter((item) => item.projectId === projectId) : [];
    const outputs = items.flatMap((item) => (item.trace?.outputs || []).map((output) => ({
      ...output, workItemId: item.id, workTitle: item.title, workType: item.type,
      workState: item.state,
      run: (item.trace?.runs || []).find((run) => run.runId === output.runId),
      current: !item.trace?.runs?.length || item.trace.runs[item.trace.runs.length - 1].runId === output.runId,
    }))).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const researchItems = items.filter((item) => item.type === "research")
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const latestResearch = researchItems[0];
    const latestResearchId = latestResearch?.id;
    const currentOutputs = outputs.filter((output) => output.workItemId === latestResearchId);
    const historicalOutputs = outputs.filter((output) => output.workItemId !== latestResearchId);
    const reports = currentOutputs.filter((output) => output.current && output.content?.trim());
    const workbenchRun = (latestResearch?.trace?.runs || []).slice(-1)[0] || reports[0]?.run || null;
    return {
      projectId, items, researchItems, outputs, currentOutputs, historicalOutputs, reports,
      workspaceFiles: latestResearch?.trace?.workspaceFiles || [],
      workbenchRun,
      hasResults: currentOutputs.some((output) => output.current &&
        !["running", "waiting", "failed", "cancelled"].includes(output.run?.state) &&
        (output.content?.trim() || output.kind !== "report" && output.mediaType)),
    };
  }

  function renderOutputList(outputs) {
    return (outputs || []).map((output) => `<div class="output-row">
      <div><b>${escapeHtml(output.kind === "report" || output.content !== undefined ? "执行报告" : "交付文件")}</b>
        <small>${escapeHtml(output.workTitle || "")}${output.current === false ? " · 历史版本" : ""} · ${escapeHtml(labelState(output.workState))}</small>
        <small>${escapeHtml(output.createdAt ? new Date(output.createdAt).toLocaleString("zh-CN") : output.mediaType || "")}</small>
      </div>
      <button type="button" class="ghost" data-open-output="${escapeHtml(output.id)}" data-output-work="${escapeHtml(output.workItemId)}">查看内容</button>
    </div>`).join("");
  }

  function renderArtifactsPanel(model) {
    const current = model.currentOutputs || model.outputs || [];
    const historical = model.historicalOutputs || [];
    const ideaTitle = model.researchItems?.[0]?.title || model.researchItems?.[0]?.problem || "";
    const currentBlock = current.length
      ? renderOutputList(current)
      : `<p class="muted">${model.workflow?.synthesisRecommendation
        ? "当前想法走的是「评估想法可行性」工作流：结论在上方「调研成果」，不会生成旧式执行报告。"
        : "当前想法还没有执行报告。工作流评估完成后，结论会出现在上方「调研成果」。"}</p>`;
    const historyBlock = historical.length
      ? `<details class="artifact-history"><summary>同项目其他想法的历史产物（${historical.length}）</summary>
          <p class="hint">与当前想法无关，仅供对照。勿据此决策当前想法。</p>
          ${renderOutputList(historical)}</details>`
      : "";
    return `<article class="card delivery-card" id="deliveryArtifacts">
      <div class="card-title"><div><p class="eyebrow">交付产物</p><h2>${ideaTitle ? "当前想法相关" : "交付产物"}</h2></div><span>${current.length} 份</span></div>
      ${ideaTitle ? `<p class="hint">仅列出「${escapeHtml(ideaTitle)}」相关产物。</p>` : ""}
      ${currentBlock}
      ${historyBlock}
    </article>`;
  }

  function renderDocument(text) {
    const preview = root.ForgeMarkdownPreview;
    if (preview?.renderMarkdown) return preview.renderMarkdown(text);
    return `<div class="md-preview"><p>${escapeHtml(text || "")}</p></div>`;
  }

  function renderClaim(claim) {
    const classification = CLAIM_LABELS[claim.classification] ? claim.classification : "unknown";
    const evidence = (claim.evidenceIds || [])
      .map((id) => {
        const source = (claim.evidence || []).find((entry) => entry.id === id) || { id };
        const label = source.source || source.id;
        const href = /^https?:\/\//i.test(String(source.id || "")) ? String(source.id) : "";
        if (href) {
          return `<a class="claim-evidence" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortEvidenceLabel(label))}</a>`;
        }
        return `<button class="claim-evidence" type="button" data-open-evidence="${escapeHtml(source.id)}" data-source="${escapeHtml(source.source || "")}" data-version="${escapeHtml(source.version || "")}" data-locator="${escapeHtml(source.locator || "")}">${escapeHtml(shortEvidenceLabel(label))}</button>`;
      })
      .join("");
    return `
      <article class="claim claim-${classification}">
        <span class="claim-class">${CLAIM_LABELS[classification]}</span>
        <p>${escapeHtml(claim.text)}</p>
        <div class="claim-meta">${evidence || "<span class=\"muted\">无证据引用</span>"}</div>
      </article>
    `;
  }

  function shortEvidenceLabel(value) {
    const text = String(value || "").trim();
    if (!text) return "证据";
    try {
      if (/^https?:\/\//i.test(text)) {
        const host = new URL(text).hostname.replace(/^www\./, "");
        return host || text.slice(0, 40);
      }
    } catch {
      /* keep plain label */
    }
    return text.length > 48 ? `${text.slice(0, 46)}…` : text;
  }

  const BRANCH_CLAIM_LABELS = {
    "user-research": "用户调研",
    "market-research": "市场调研",
    "code-data-research": "代码与数据",
    "risk-research": "风险研判",
  };

  function claimBranchKey(claim) {
    const id = String(claim?.id || "");
    if (id === "claim-recommendation") return "recommendation";
    const prefix = id.includes(":") ? id.split(":")[0] : "";
    return BRANCH_CLAIM_LABELS[prefix] ? prefix : "other";
  }

  function groupClaimsForReading(claims) {
    const groups = [];
    const order = ["user-research", "market-research", "code-data-research", "risk-research", "other"];
    const buckets = Object.fromEntries(order.map((key) => [key, []]));
    for (const claim of claims || []) {
      const key = claimBranchKey(claim);
      if (key === "recommendation") continue;
      (buckets[key] || buckets.other).push(claim);
    }
    for (const key of order) {
      if (!buckets[key].length) continue;
      groups.push({
        key,
        label: BRANCH_CLAIM_LABELS[key] || "其他依据",
        claims: buckets[key],
      });
    }
    return groups;
  }

  function claimCounts(claims) {
    const counts = { fact: 0, inference: 0, hypothesis: 0, unknown: 0 };
    for (const claim of claims || []) {
      const key = CLAIM_LABELS[claim.classification] ? claim.classification : "unknown";
      counts[key] += 1;
    }
    return counts;
  }

  function researchHighlights(content) {
    const result = { conclusion: "", evidence: "", risks: "", unknowns: "", next: "" };
    const labels = {
      "一句话结论": "conclusion", "核心结论": "conclusion", "结论": "conclusion",
      "依据": "evidence", "证据与来源": "evidence", "关键依据": "evidence",
      "风险": "risks", "主要风险": "risks", "未知项": "unknowns", "待验证问题": "unknowns",
      "下一步建议": "next", "建议动作": "next",
    };
    let current = null;
    let fence = null;
    for (const line of String(content || "").split("\n")) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }
      if (fence) continue;
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (heading) { current = labels[heading[1].trim()] || null; continue; }
      if (current) result[current] += `${line}\n`;
    }
    for (const key of Object.keys(result)) result[key] = result[key].trim();
    return result;
  }

  function renderResearchHighlights(report) {
    const structured = report.researchResult;
    const sections = structured?.schemaVersion === 1 && structured.source?.runId === report.runId && structured.source?.outputRef === report.contentRef
      ? { conclusion: structured.conclusion || "", evidence: structured.evidence.map((entry) => `${entry.claim} — ${entry.source}`).join("\n\n"),
          risks: structured.risks.join("\n\n"), unknowns: structured.unknowns.join("\n\n"), next: structured.nextActions.join("\n\n") }
      : researchHighlights(report.content);
    const labels = { conclusion: "一句话结论", evidence: "关键依据", risks: "主要风险", unknowns: "未知项", next: "下一步建议" };
    if (!Object.values(sections).some(Boolean)) return '<p class="muted">这份报告尚未单独列出结论、依据和建议，请阅读完整报告。</p>';
    return `<div class="research-highlights">${Object.entries(labels).map(([key, label]) =>
      `<section><h4>${label}</h4>${sections[key] ? renderDocument(sections[key]) : '<p class="muted">报告未单独提供</p>'}</section>`).join("")}</div>`;
  }

  function renderResearchPage(model) {
    const reports = model?.reports || [];
    const workflow = model?.workflow || null;
    const rawClaims = (model?.claims?.length ? model.claims : workflow?.claims) || [];
    const claimGroups = groupClaimsForReading(rawClaims);
    const readableClaims = claimGroups.flatMap((group) => group.claims);
    const counts = claimCounts(readableClaims);
    const readingBrief = workflow?.readingBrief || model?.readingBrief || null;
    const research = model?.researchItems || [];
    const awaiting = research.some((item) => ["in_progress", "waiting_input"].includes(item.state));
    const completed = research.some((item) => ["completed", "accepted", "submitted", "waiting_approval"].includes(item.state));
    const workflowRunning = model?.workflow?.runState === "running" && !workflow?.synthesisRecommendation;
    const workflowFailed = model?.workflow?.runState === "failed";
    const hasWorkflowResults = Boolean(workflow?.synthesisRecommendation || readableClaims.length || readingBrief?.branches?.length);
    const latestTitle = research[0]?.title || research[0]?.problem || "";
    const empty = workflowRunning ? "调研工作流进行中，四个分支完成后会在这里汇总结论。"
      : workflowFailed ? `调研工作流未产出成果：${formatResearchFailure(model.workflow?.failureReason) || "未知错误"}。请在上方重试评估。`
      : awaiting ? "调研正在进行，正文生成后会显示在这里。"
      : completed ? "调研执行已结束，尚未找到调研正文。可打开对应任务，在工作台核对结果。"
      : research.length
        ? `已登记想法${latestTitle ? `「${latestTitle}」` : ""}。点上方「评估想法可行性」开始并行调研；结论会出现在这里。`
        : "还没有调研。登记一个问题，完成后在这里看结论与报告。";
    const directions = Array.isArray(readingBrief?.suggestedDirections)
      ? readingBrief.suggestedDirections
      : [];
    const decisionMemo = workflow?.decisionMemo || null;
    const formalReport = typeof workflow?.formalReport === "string" ? workflow.formalReport.trim() : "";
    if (formalReport && workflow?.synthesisRecommendation) {
      const branchAttachments = (readingBrief?.branches || []).map((branch) => {
        const label = branch.id === "code-data-research" ? "工作量原文" : branch.label;
        const group = claimGroups.find((entry) => entry.key === branch.id);
        return `<details class="attach-block">
          <summary>${escapeHtml(label)} · ${escapeHtml(String(branch.claimCount || group?.claims?.length || 0))} 条论断</summary>
          <div class="report-text digest-lines">${formatDigestLines(branch.summary)}</div>
          ${group?.claims?.length ? `<div class="claim-list">${group.claims.map(renderClaim).join("")}</div>` : ""}
        </details>`;
      }).join("");
      return `<article class="card delivery-card result-hero decision-memo" id="deliveryResearch">
        <div class="card-title"><div><p class="eyebrow">调研报告</p><h2>${escapeHtml(latestTitle || "调研报告")}</h2></div><span>${escapeHtml(workflow.waitingAtGate ? "待你决策" : "已汇总")}</span></div>
        ${renderDocument(formalReport)}
        <section class="memo-section">
          <h3>附件（默认折叠 · 备查） <span>三段依据原文与工作量原文</span></h3>
          ${branchAttachments || "<p class=\"muted\">暂无附件</p>"}
        </section>
      </article>`;
    }
    if (decisionMemo && workflow?.synthesisRecommendation) {
      return `<article class="card delivery-card result-hero decision-memo" id="deliveryResearch">
        <div class="card-title"><div><p class="eyebrow">可行性决策备忘录</p><h2>${escapeHtml(latestTitle || decisionMemo.title || "调研结论")}</h2></div><span>${escapeHtml(workflow.waitingAtGate ? "待你决策" : "已汇总")}</span></div>
        ${renderDecisionMemo(decisionMemo, {
          recommendation: workflow.synthesisRecommendation,
          waitingAtGate: workflow.waitingAtGate,
          synthesisSummary: workflow.synthesisSummary,
          claimCounts: counts,
        })}
        ${reports.length ? `<details class="attach-block"><summary>工作项报告（可选对照 · ${reports.length}）</summary>${reports.map((report) => `<section class="nested-report"><h4>${escapeHtml(report.workTitle || "调研报告")}</h4>${renderResearchHighlights(report)}</section>`).join("")}</details>` : ""}
      </article>`;
    }
    const synthesisBlock = workflow?.synthesisRecommendation
      ? `<section class="report-summary synthesis-verdict">
          <div class="card-title"><h3>① 总览结论</h3><span>${escapeHtml(workflow.waitingAtGate ? "待你决策" : "已汇总")}</span></div>
          ${latestTitle ? `<p class="hint">想法：${escapeHtml(latestTitle)}</p>` : ""}
          <p class="verdict-line"><b>${escapeHtml(recommendationLabel(workflow.synthesisRecommendation))}</b></p>
          <div class="report-text decision-card">${formatMultiline(readingBrief?.executiveSummary || recommendationDetail(workflow.synthesisRecommendation))}</div>
          <p class="hint">${escapeHtml(workflow.synthesisSummary || "")}</p>
          <p class="claim-legend-row claim-legend">
            <span class="claim-fact"><span class="claim-class">事实 ${counts.fact}</span></span>
            <span class="claim-inference"><span class="claim-class">推断 ${counts.inference}</span></span>
            <span class="claim-hypothesis"><span class="claim-class">假设 ${counts.hypothesis}</span></span>
            <span class="claim-unknown"><span class="claim-class">未知 ${counts.unknown}</span></span>
          </p>
        </section>`
      : "";
    const directionsBlock = directions.length
      ? `<section class="report-summary direction-board">
          <div class="card-title"><h3>② 建议方向</h3><span>系统判断 · ${directions.length} 条</span></div>
          <p class="hint">这不是被动复述调研，而是可执行的下一步。选一条另开短调研，或直接停止原想法。</p>
          <div class="direction-list">${directions.map((item, index) => `
            <article class="direction-card">
              <p class="verdict-line"><b>${index + 1}. ${escapeHtml(item.title || "")}</b></p>
              <p class="report-text">为什么：${escapeHtml(item.why || "")}</p>
              <p class="hint">下一步：${escapeHtml(item.nextStep || "")}</p>
            </article>`).join("")}</div>
        </section>`
      : "";
    const branchDigestBlock = readingBrief?.branches?.length
      ? `<section class="report-summary claim-board">
          <div class="card-title"><h3>${directions.length ? "③" : "②"} 分段结论</h3><span>${readingBrief.branches.length} 段</span></div>
          <p class="hint">每段三行：结论 / 为什么 / 还缺什么证据。下面「已掌握的事实」是公开资料摘录，不是缺口本身。</p>
          ${readingBrief.branches.map((branch) => {
            const group = claimGroups.find((entry) => entry.key === branch.id);
            const highlights = Array.isArray(branch.highlights) ? branch.highlights.filter(Boolean) : [];
            return `<article class="branch-digest">
              <div class="card-title"><h4>${escapeHtml(branch.label)}</h4><span>${escapeHtml(String(branch.claimCount))} 条依据</span></div>
              <div class="report-text digest-lines">${formatDigestLines(branch.summary)}</div>
              ${highlights.length
                ? `<div class="digest-highlights"><p class="hint">已掌握的公开事实（辅助理解结论，不是「还缺什么」）：</p><ul>${highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>`
                : ""}
              ${group?.claims?.length
                ? `<details class="claim-branch"><summary>查看原始论断（多为英文，${group.claims.length}）</summary>
                    <div class="claim-list">${group.claims.map(renderClaim).join("")}</div></details>`
                : ""}
            </article>`;
          }).join("")}
        </section>`
      : claimGroups.length
        ? `<section class="report-summary claim-board">
            <div class="card-title"><h3>${directions.length ? "③" : "②"} 研究依据</h3><span>${readableClaims.length} 条</span></div>
            <p class="hint">总结尚未生成时，可按分支展开原始论断。</p>
            ${claimGroups.map((group) => `<details class="claim-branch">
              <summary>${escapeHtml(group.label)}（${group.claims.length}）</summary>
              <div class="claim-list">${group.claims.map(renderClaim).join("")}</div>
            </details>`).join("")}
          </section>`
        : "";
    const reportsBlock = reports.length
      ? `<section class="report-summary">
          <div class="card-title"><h3>③ 工作项报告（可选对照）</h3><span>${reports.length} 份</span></div>
          <p class="hint">这些是工作中心旧路径产出的报告，与上方工作流结论可能不是同一轮。</p>
          ${reports.map((report) => `<section class="report-summary nested-report">
            <div class="card-title"><h4>${escapeHtml(report.workTitle || "调研报告")}</h4><span>${escapeHtml(labelState(report.workState))}</span></div>
            ${renderResearchHighlights(report)}
            <div class="report-excerpt">${renderDocument(report.content)}${report.content.length > 800 ? '<p class="muted">完整报告可点下方展开</p>' : ""}</div>
            <button type="button" class="primary" data-open-output="${escapeHtml(report.id)}" data-output-work="${escapeHtml(report.workItemId)}">阅读完整报告</button>
          </section>`).join("")}
        </section>`
      : "";
    const title = reports.length || hasWorkflowResults ? "读总结，再决策" : "等待调研结果";
    const badge = hasWorkflowResults
      ? (readingBrief?.branches?.length ? `${readingBrief.branches.length} 段总结` : `${readableClaims.length} 条依据`)
      : reports.length
        ? `${reports.length} 份报告`
        : "尚无正文";
    return `<article class="card delivery-card result-hero" id="deliveryResearch">
      <div class="card-title"><div><p class="eyebrow">调研成果</p><h2>${title}</h2></div><span>${badge}</span></div>
      ${synthesisBlock}
      ${directionsBlock}
      ${branchDigestBlock}
      ${reportsBlock}
      ${renderWorkspaceFiles(model)}
      ${reports.length || hasWorkflowResults ? "" : `<div class="result-empty"><p>${empty}</p>${research[0] ? `<button class="ghost" type="button" data-select-work="${escapeHtml(research[0].id)}">查看调研任务</button>` : ""}</div>`}
    </article>`;
  }

  function renderDecisionMemo(memo, meta = {}) {
    const sourcesHtml = (sources) => {
      const list = Array.isArray(sources) ? sources : [];
      const linked = list.filter((entry) => entry?.url && /^https?:\/\//i.test(entry.url));
      if (linked.length) {
        return linked.map((entry) =>
          `<a class="memo-source" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.label || shortEvidenceLabel(entry.url))}</a>`,
        ).join(" · ");
      }
      return '<span class="muted">无链接</span>';
    };
    const severityLabel = {
      veto: "一票否决级",
      high: "高",
      medium: "中",
      low: "低",
    };
    const reasons = (memo.reasons || []).map((reason) =>
      `<li>${escapeHtml(reason.text)} <span class="memo-source-row">（${sourcesHtml(reason.sources)}）</span></li>`,
    ).join("");
    const metrics = (memo.metrics || []).length
      ? `<section class="memo-section"><h3>关键指标 <span>可点击查看来源</span></h3>
          <div class="memo-metrics">${memo.metrics.map((metric) => `
            <article class="memo-metric"><p class="k">${escapeHtml(metric.label)}</p>
              <p class="v">${escapeHtml(metric.value)}</p>
              <p class="src">${sourcesHtml(metric.sources)}</p></article>`).join("")}</div></section>`
      : "";
    const competitors = (memo.competitors || []).length
      ? `<section class="memo-section"><h3>竞品 / 替代供给对照 <span>含来源链接</span></h3>
          <div class="memo-table-wrap"><table class="memo-table"><thead><tr>
            <th>名称</th><th>形态</th><th>规模 / 覆盖</th><th>含义</th><th>来源</th>
          </tr></thead><tbody>${memo.competitors.map((row) => `<tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.form || "—")}</td>
            <td>${escapeHtml(row.scale || "—")}</td>
            <td>${escapeHtml(row.implication || "—")}</td>
            <td>${sourcesHtml(row.sources)}</td>
          </tr>`).join("")}</tbody></table></div></section>`
      : "";
    const chart = memo.chart?.points?.length
      ? `<section class="memo-section"><h3>${escapeHtml(memo.chart.label || "可比规模")} <span>示意</span></h3>
          <div class="memo-bars">${memo.chart.points.map((point) => `
            <div class="memo-bar-row"><span>${escapeHtml(point.name)}</span>
              <div class="memo-bar-track"><div class="memo-bar-fill" style="width:${Math.round(Math.min(1, Math.max(0.06, Number(point.ratio) || 0)) * 100)}%"></div></div>
              <span class="n">${escapeHtml(point.valueLabel)}</span></div>`).join("")}</div></section>`
      : "";
    const risks = (memo.risks || []).length
      ? `<section class="memo-section"><h3>风险一览 <span>一票否决优先</span></h3>
          <div class="memo-table-wrap"><table class="memo-table"><thead><tr>
            <th>风险</th><th>严重度</th><th>含义</th><th>来源</th>
          </tr></thead><tbody>${memo.risks.map((row) => `<tr>
            <td>${escapeHtml(row.text)}</td>
            <td><span class="memo-tag memo-tag-${escapeHtml(row.severity)}">${escapeHtml(severityLabel[row.severity] || row.severity)}</span></td>
            <td>${escapeHtml(row.implication || "—")}</td>
            <td>${sourcesHtml(row.sources)}</td>
          </tr>`).join("")}</tbody></table></div></section>`
      : "";
    const directionsBlock = (memo.directions || []).length
      ? `<section class="memo-section"><h3>建议路径 <span>${memo.directions.length} 条</span></h3>
          <div class="direction-list">${memo.directions.map((item, index) => `
            <article class="direction-card">
              <p class="verdict-line"><b>${index + 1}. ${escapeHtml(item.title || "")}</b></p>
              <p class="report-text">为什么：${escapeHtml(item.why || "")}</p>
              <p class="hint">下一步：${escapeHtml(item.nextStep || "")}</p>
            </article>`).join("")}</div></section>`
      : "";
    const attachments = (memo.attachments || []).map((part) => `
      <details class="attach-block">
        <summary>${escapeHtml(part.label)} · 结论 / 为什么 / 还缺什么（${escapeHtml(String((part.claims || []).length))} 条论断）</summary>
        <div class="report-text digest-lines">${formatDigestLines(part.summary)}</div>
        ${(part.highlights || []).length
          ? `<div class="digest-highlights"><p class="hint">已掌握的公开事实（不是缺口本身）：</p><ul>${part.highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>`
          : ""}
        ${(part.claims || []).length ? `<div class="claim-list">${part.claims.map(renderClaim).join("")}</div>` : "<p class=\"muted\">无原始论断</p>"}
      </details>`).join("");

    return `
      <section class="memo-verdict">
        <p class="memo-label">决策建议</p>
        <h3>${escapeHtml(memo.verdictLabel || recommendationLabel(meta.recommendation))}</h3>
        <p class="hint">评估日 ${escapeHtml(memo.evaluatedAt || "—")} · 依据 ${escapeHtml(String(memo.claimTotal || 0))} 条论断
          · 事实 ${meta.claimCounts?.fact || 0} / 推断 ${meta.claimCounts?.inference || 0} / 未知 ${meta.claimCounts?.unknown || 0}</p>
        ${reasons ? `<ol class="memo-reasons">${reasons}</ol>` : ""}
        <p class="hint">${escapeHtml(meta.synthesisSummary || "")}${meta.waitingAtGate ? " 请到右侧「下一步」确认决策。" : ""}</p>
      </section>
      ${metrics}
      ${competitors}
      ${chart}
      ${risks}
      ${directionsBlock}
      <section class="memo-section">
        <h3>附件（默认折叠 · 备查） <span>四段调研论断与来源</span></h3>
        ${attachments || "<p class=\"muted\">暂无附件</p>"}
      </section>`;
  }

  function formatMultiline(text) {
    return escapeHtml(String(text || ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => `<p>${line}</p>`)
      .join("");
  }

  /** Render 结论/为什么/还缺什么 with clearer visual labels for bosses. */
  function formatDigestLines(text) {
    const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return "";
    return lines.map((line) => {
      const matched = line.match(/^(结论|判断|为什么|原因|还缺什么证据|缺口)[：:]\s*(.*)$/);
      if (!matched) return `<p>${escapeHtml(line)}</p>`;
      const rawLabel = matched[1];
      const body = matched[2] || "";
      const label =
        rawLabel === "判断" ? "结论"
          : rawLabel === "原因" ? "为什么"
            : rawLabel === "缺口" ? "还缺什么证据"
              : rawLabel;
      const kind =
        label === "结论" ? "verdict"
          : label === "为什么" ? "why"
            : "gap";
      return `<p class="digest-line digest-${kind}"><span class="digest-k">${escapeHtml(label)}</span><span class="digest-v">${escapeHtml(body)}</span></p>`;
    }).join("");
  }

  function recommendationLabel(value) {
    if (value === "enter_product_definition") return "建议进入需求设计";
    if (value === "continue_research") return "建议继续补充调研";
    if (value === "stop") return "建议不做原想法（停止或改方向）";
    return String(value || "");
  }

  function recommendationDetail(value) {
    if (value === "enter_product_definition") {
      return "综合用户、市场、代码数据与风险分支后，论断足够一致，可进入需求设计。请在「下一步」确认。";
    }
    if (value === "continue_research") {
      return "现有论断仍有缺口或冲突，不宜直接开工。可先补充一手访谈或收紧场景，再决定是否进入需求设计。";
    }
    if (value === "stop") {
      return "四段调研对原想法偏负。建议停止该形态；若改做教师/家长主导，请另开一轮短调研后再立项。";
    }
    return "";
  }

  function renderWorkspaceFiles(model) {
    const files = model?.workspaceFiles || [];
    const run = model?.workbenchRun || {};
    const researchId = model?.researchItems?.[0]?.id || "";
    if (!files.length && run.state !== "failed") return "";
    const failed = run.state === "failed";
    const openRun = run.runId
      ? `<button type="button" class="ghost" ${[
          `data-open-run="${escapeHtml(run.runId)}"`,
          run.sessionId ? `data-open-session="${escapeHtml(run.sessionId)}"` : "",
          run.cwd ? `data-session-cwd="${escapeHtml(run.cwd)}"` : "",
          researchId ? `data-work-item="${escapeHtml(researchId)}"` : "",
        ].filter(Boolean).join(" ")}>在工作台打开工作区</button>`
      : "";
    const takeover = failed
      ? `<button type="button" class="ghost" data-takeover-run="${escapeHtml(run.runId || "")}" data-takeover-step="${escapeHtml(run.stepId || run.runId || "")}" data-work-item="${escapeHtml(researchId)}" data-session="${escapeHtml(run.sessionId || "")}" data-cwd="${escapeHtml(run.cwd || "")}">在工作台接管</button>`
      : "";
    return `<section class="workspace-files">
      <p class="hint">${files.length
        ? `这次在工作台写了 ${files.length} 个文件。点文件名阅读；底稿仍留在工作区，不收入公司产物。`
        : "这次执行失败。去工作台看过程或接管。"}</p>
      ${files.length ? `<ul class="file-list">${files.map((file) => {
        const parts = fileParts(file.path);
        return `<li><button type="button" class="file-link" data-open-workspace-file="${escapeHtml(file.path)}" data-file-work="${escapeHtml(researchId)}" data-file-run="${escapeHtml(file.runId)}"><span class="file-ext">${escapeHtml(parts.ext)}</span><span class="file-copy"><b>${escapeHtml(parts.name)}</b><small>${escapeHtml(parts.dir || "工作区根目录")} · ${escapeHtml(file.path)}</small></span></button></li>`;
      }).join("")}</ul>` : ""}
      <div class="gate-actions">${openRun}${takeover}</div>
    </section>`;
  }

  function renderStageGatePanel(model) {
    if (model?.loadError) return '<article class="card delivery-card" id="deliveryGates"><h2>下一步</h2><p class="muted">正在获取决策状态，暂不可提交。若刷新后仍显示此提示，请检查服务连接。</p></article>';
    const gates = model?.gates || [];
    const research = gates.find((gate) => gate.kind === "research");
    const superseded = Boolean(model?.researchCreatedAt && research?.latest?.decidedAt && model.researchCreatedAt > research.latest.decidedAt);
    const decision = superseded ? null : research?.latest;
    const stopped = decision?.outcome === "stopped" && (!model?.snapshots || model.snapshots.research?.projectState === "completed");
    const followupNeeded = ["changes_requested", "rejected"].includes(decision?.outcome);
    const approved = decision?.outcome === "approved";
    const current = stopped ? null : approved
      ? (model?.hasDevelopment ? gates.find((gate) => gate.kind !== "research" && gate.latest?.outcome !== "approved") : null)
      : research;
    const history = gates.filter((gate) => gate.latest);
    const readinessReasons = {
      "research gate approval required": "请先根据调研成果决定是否继续开发。",
      "scope gate approval required": "请先确认开发范围。",
      "technical gate approval required": "请先确认开发方案。",
      "project is completed": "项目已归档，报告与产物仍可查看。",
      "project work items required": "请先登记需求并完成调研。",
      "research work item required": "请先登记调研需求。",
      "latest research run must succeed": "请先完成当前调研，再查看成果并决定下一步。",
      "research report or artifact required": "当前调研还没有可查看的报告或产物。",
      "accepted spec artifact required": "请先在工作中心确认开发规格。",
      "accepted plan artifact required": "请先在工作中心确认开发计划。",
      "release candidate required": "请先准备待发布版本并完成验证。",
    };
    const readinessReason = model?.snapshots?.[current?.kind]?.reason;
    const readinessMessage = readinessReasons[readinessReason] || (/[\u4e00-\u9fff]/.test(readinessReason || "") ? readinessReason : "当前检查尚未完成，请核对工作中心的任务与验收状态。");
    const serverReady = !model?.snapshots || model.snapshots[current?.kind]?.ready === true;
    // Workflow-path research has no linked work-item outputs: the server snapshot (workflow gate wait +
    // succeeded synthesis) is what makes it decidable.
    const researchDecidable = Boolean(model?.hasResults) || model?.snapshots?.research?.ready === true;
    const canDecide = serverReady && model?.projectId && current && (current.kind === "research" ? researchDecidable : model?.readyChecks?.includes(current.kind));
    const workflow = model?.workflow;
    const waitingSynthesis = !stopped && !approved && current?.kind === "research" && workflow?.waitingAtGate && workflow.synthesisSummary
      ? `<section class="synthesis-note" data-synthesis-recommendation="${escapeHtml(workflow.synthesisRecommendation || "")}">
          <p><b>系统建议：${escapeHtml(recommendationLabel(workflow.synthesisRecommendation))}</b></p>
          <p class="hint">详细论断在左侧「调研成果」。这里只做决策，不重复展开报告。</p>
        </section>`
      : "";
    return `<article class="card delivery-card" id="deliveryGates">
      <div class="card-title"><h2>下一步</h2><span>${stopped ? "已归档" : approved ? "继续开发" : "由你决定"}</span></div>
      <p class="hint">${stopped ? "调研已结束，报告与产物会保留。" : approved ? "已决定继续开发。在工作中心确认需求、安排执行；完成后再验收。" : "先读左侧调研结论与依据，再在这里决策。桌面研究可过，不等于批准开发。"}</p>
      ${approved && model?.hasDevelopment ? `<button type="button" class="ghost" data-select-work="${escapeHtml(model.developmentId || "")}">查看开发任务</button>` : ""}
      ${approved && !model?.hasDevelopment ? '<button type="button" data-followup="implementation">创建开发任务</button>' : ""}
      ${model?.followupId ? `<button type="button" class="ghost" data-select-work="${escapeHtml(model.followupId)}">继续补充调研</button>` : followupNeeded ? '<button type="button" data-followup="research">创建补充调研任务</button>' : ""}
      ${waitingSynthesis}
      ${canDecide ? `${current.kind !== "research" ? '<details class="decision-history"><summary>开发检查 · 按当前进度确认</summary>' : ""}<div data-gate="${escapeHtml(current.kind)}">
        ${current.kind !== "research" ? `<h3>${escapeHtml(GATE_LABELS[current.kind])}</h3>` : ""}
        <form id="deliveryGateForm" class="form-stack">
          <input type="hidden" name="projectId" value="${escapeHtml(model.projectId)}" />
          <input type="hidden" name="actorId" value="${escapeHtml(model.actorId || "")}" />
          <label>决策说明<textarea name="rationale" required rows="2" placeholder="${current.kind === "research" ? "桌面研究可过的话，先写清还缺哪块一手证据；不要直接批准开发。" : "根据哪些结论，决定如何继续？"}"></textarea></label>
          <div class="gate-actions">
            ${current.kind === "research" ? `<button type="button" ${model?.pending ? "disabled" : ""} data-gate-outcome="stopped">结束本轮调研</button><button type="button" class="ghost" ${model?.pending ? "disabled" : ""} data-gate-outcome="changes_requested">需要补充调研</button><button type="button" class="ghost" ${model?.pending ? "disabled" : ""} data-gate-outcome="approved">继续开发</button>` : `<button type="button" ${model?.pending ? "disabled" : ""} data-gate-outcome="approved">确认通过</button><button type="button" class="ghost" ${model?.pending ? "disabled" : ""} data-gate-outcome="changes_requested">需要修改</button>`}
          </div>
        </form>
      </div>${current.kind !== "research" ? "</details>" : ""}` : !stopped && !approved ? `<p class="muted">${escapeHtml(readinessReason ? readinessMessage : "有可查看的调研成果后，这里会提供下一步操作。")}</p>` : ""}
      ${history.length ? `<details class="decision-history"><summary>决策记录 · ${history.length}</summary>${history.map((gate) => `<p><b>${escapeHtml(GATE_LABELS[gate.kind])} · ${escapeHtml(labelOutcome(gate.latest.outcome))}</b><br>${escapeHtml(gate.latest.rationale || "未填写说明")}</p>`).join("")}</details>` : ""}
    </article>`;
  }

  function renderReleasePanel(model) {
    if (!model?.hasDevelopment) return "";
    return `<details class="card delivery-card delivery-details" id="deliveryRelease">
      <summary>发布准备</summary>
      <p class="hint">开发完成并验收后，再准备发布。高风险发布需要独立审批。</p>
      <p class="muted">发布前，请在工作台核对待发布版本、验证结果和回滚方案。</p>
      <div class="gate-actions"><button type="button" class="ghost" data-nav="approvals">查看验收与审批</button><button type="button" class="ghost" data-open-workbench>在工作台准备发布</button></div>
    </details>`;
  }

  function deliveryActiveStep(model) {
    const gates = model?.gates || {};
    if (gates.research?.outcome === "stopped") return "research";
    if (gates.release?.outcome === "approved") return "release";
    if (!model?.hasIntake) return "intake";
    if (!model?.hasClaims) return "research";
    if (!gates.research?.outcome || !gates.scope?.outcome || !gates.technical?.outcome) return "gates";
    return "release";
  }

  root.ForgeDeliveryUi = {
    CLAIM_LABELS,
    GATE_LABELS,
    OUTCOME_LABELS,
    STATE_LABELS,
    escapeHtml,
    labelOutcome,
    labelState,
    labelNextAction,
    takeoverRequest,
    openWorkbenchTakeover,
    buildResultsModel,
    renderOutputList,
    renderArtifactsPanel,
    renderDocument,
    renderIntakePage,
    renderFeasibilityStart,
    renderResearchPage,
    researchHighlights,
    renderWorkspaceFiles,
    renderStageGatePanel,
    renderReleasePanel,
    deliveryActiveStep,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
