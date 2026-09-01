# Forge Company P2 Growth and Revenue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付从产品价值、GTM、内容生产、渠道发布、线索、销售、成交到客户反馈和收入归因的完整增长闭环。

**Architecture:** Company Domain 管理 Campaign、Content、Lead、Opportunity、Deal、Customer 和 Attribution；Workflow 编排内容与销售流程；所有外部渠道动作通过 Connector Gateway。首批渠道以小红书、抖音和公众号的结构化素材包与受控发布为主，实际账号写入仅在存在获授权适配器时启用，否则走人工发布回执。

**Tech Stack:** Company/Core v2 domain、Workflow、Connector Gateway、Policy/Approval、Budget/Evidence、Electron/React、Vitest、SQLite。

**Spec:** `docs/superpowers/specs/2026-08-28-forge-company-core-v2-design.md`

## Global Constraints

- 外部发布、私信、评论回复、邮件触达和 CRM 外部写入默认需要审批。
- 每个外部动作必须有幂等键、结果回读和审计。
- 内容中的事实、品牌、版权、敏感词和承诺检查必须保存为 Validation。
- Lead 必须支持去重、授权/退订、来源和负责人。
- 成交只有关联客户、金额、时间、证据和归因触点后才进入可归因收入。
- 初期同时保留首次、最后和多触点，不强制唯一归因模型。
- 代码片段中的 `*Fixture`、`fake*` 等名称均是在同一测试文件中创建的确定性测试夹具；写失败测试步骤必须同时实现这些夹具的最小定义。

---

## File Structure Map

| Path | Responsibility |
|---|---|
| `migrations/021_company_growth_revenue.sql` | campaign/content/publication/lead/opportunity/deal/customer/attribution |
| `packages/company-domain/src/growth/campaign.ts` | ICP、GTM、Campaign |
| `packages/company-domain/src/growth/content.ts` | 母稿、渠道资产、版本 |
| `packages/company-domain/src/growth/leads.ts` | ingestion、dedupe、consent、score、assignment |
| `packages/company-domain/src/growth/sales.ts` | opportunity、activity、deal |
| `packages/company-domain/src/growth/customers.ts` | health、success plan、feedback |
| `packages/company-domain/src/growth/attribution.ts` | first/last/multi-touch |
| `packages/workflows/src/templates/content-campaign.ts` | 内容工厂与发布流程 |
| `packages/workflows/src/templates/lead-to-deal.ts` | 线索到成交流程 |
| `packages/connectors/src/adapters/content-package.ts` | 人工发布包与回执 |
| `packages/connectors/src/adapters/xiaohongshu.ts` | 获授权的小红书适配器边界 |
| `packages/connectors/src/adapters/douyin.ts` | 获授权的抖音适配器边界 |
| `apps/company-desktop/src/renderer/features/growth/*` | 增长与客户 UI |
| `packages/company-analytics/src/*` | 漏斗、归因、单位经济性 |

## Public Interfaces Locked by This Plan

```ts
export interface ChannelAsset {
  id: string; sourceContentVersionId: string;
  channel: "xiaohongshu" | "douyin" | "wechat_official" | "manual";
  format: string; body: unknown; validationIds: string[]; version: number;
}

export interface AttributionTouch {
  id: string; leadId: string; campaignId?: string; contentId?: string;
  publicationId?: string; channel: string; occurredAt: string;
  kind: "first" | "interaction" | "conversion" | "sales_activity";
}
```

### Task 1: 添加 Growth/Revenue Schema 和领域类型

**Files:**
- Create: `migrations/021_company_growth_revenue.sql`
- Create: `packages/store/src/company-growth-migration.test.ts`
- Create: `packages/company-domain/src/growth/types.ts`
- Modify: `packages/company-domain/src/index.ts`

**Interfaces:**
- Consumes: Company P0/P1 schema。
- Produces: growth/revenue tables and DTOs。

- [ ] **Step 1: 写完整表族、金额和归因约束测试**

```ts
it("creates campaign through customer feedback tables", () => {
  expect(tableNames(openMigratedFixture().db)).toEqual(expect.arrayContaining([
    "company_campaigns", "company_contents", "company_content_versions",
    "company_channel_publications", "company_leads", "company_lead_activities",
    "company_opportunities", "company_deals", "company_customers",
    "company_customer_feedback", "company_attribution_touches",
  ]));
});
```

- [ ] **Step 2: 运行 migration test 确认表缺失**

Run: `pnpm exec vitest run packages/store/src/company-growth-migration.test.ts`

Expected: FAIL listing growth tables.

- [ ] **Step 3: 创建 migration 与 company/source/idempotency 索引**

```sql
CREATE UNIQUE INDEX uq_company_publication_external
ON company_channel_publications(company_id, channel, external_id)
WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX uq_company_lead_identity
ON company_leads(company_id, identity_hash)
WHERE identity_hash IS NOT NULL;
```

Amounts use integer minor units plus currency; identity data uses normalized encrypted/reference fields and hashes appropriate to local-first storage.

- [ ] **Step 4: 运行 Store/domain build**

Run: `pnpm --filter @forge/store test && pnpm --filter @forge/company-domain build`

Expected: PASS.

- [ ] **Step 5: 提交 Growth schema/types**

```bash
git add migrations/021_company_growth_revenue.sql packages/store/src/company-growth-migration.test.ts packages/company-domain/src/growth packages/company-domain/src/index.ts
git commit -m "feat(growth): add growth and revenue schema"
```

### Task 2: 实现 ICP、GTM 和 Campaign 生命周期

**Files:**
- Create: `packages/company-domain/src/growth/campaign.ts`
- Create: `packages/company-domain/src/growth/campaign.test.ts`

**Interfaces:**
- Consumes: product value、goal、budget、owner。
- Produces: `CampaignService.create()`、`approvePlan()`、`activate()`、`closeAndReview()`。

- [ ] **Step 1: 写无目标/预算/ICP 的激活拒绝测试**

```ts
it("requires ICP objective channels budget and owner before activation", () => {
  const campaign = campaigns.create(incompleteCampaign());
  expect(() => campaigns.activate(campaign.id)).toThrow("campaign readiness");
});

it("links campaign outcome metrics to a company goal", () => {
  const campaign = campaigns.create(validCampaign());
  expect(campaign.goalId).toBe("goal-growth-q3");
});
```

- [ ] **Step 2: 运行 campaign tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/campaign.test.ts`

Expected: FAIL because `CampaignService` is absent.

- [ ] **Step 3: 实现 Campaign 状态机和版本化 GTM brief**

```ts
export type CampaignState = "draft" | "planned" | "active" | "paused" | "completed" | "cancelled";
export interface GtmBrief {
  icp: IcpDefinition; valueProposition: string; objective: CampaignObjective;
  channels: string[]; budgetAccountId: string; successMetrics: MetricTarget[];
}
```

- [ ] **Step 4: 运行 campaign/domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for readiness, budget, state transitions, pause and close review.

- [ ] **Step 5: 提交 Campaign domain**

```bash
git add packages/company-domain/src/growth/campaign.ts packages/company-domain/src/growth/campaign.test.ts
git commit -m "feat(growth): add gtm and campaign lifecycle"
```

### Task 3: 实现母内容、渠道资产和内容验证

**Files:**
- Create: `packages/company-domain/src/growth/content.ts`
- Create: `packages/company-domain/src/growth/content.test.ts`
- Create: `packages/evidence/src/validators/content-validation.ts`
- Create: `packages/evidence/src/validators/content-validation.test.ts`

**Interfaces:**
- Consumes: product evidence、brand rules、channel rules。
- Produces: `ContentService`、`ContentValidationBundle`。

- [ ] **Step 1: 写源版本、渠道派生和阻断校验测试**

```ts
it("pins every channel asset to one source content version", () => {
  const asset = contents.createChannelAsset(channelAssetInput());
  expect(asset.sourceContentVersionId).toBe("content-v3");
});

it("blocks an unsupported factual promise", async () => {
  const result = await validateContent(contentFixture({ promise: "保证收入翻倍", evidenceIds: [] }));
  expect(result.accepted).toBe(false);
});
```

- [ ] **Step 2: 运行 content tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/content.test.ts packages/evidence/src/validators/content-validation.test.ts`

Expected: FAIL because services/validator are absent.

- [ ] **Step 3: 实现 ContentVersion、ChannelAsset 和 validators**

```ts
export interface ContentValidationBundle {
  fact: ValidationResult; brand: ValidationResult; copyright: ValidationResult;
  sensitiveTerms: ValidationResult; promises: ValidationResult;
  accepted: boolean;
}
```

Editing the source creates a new version and marks derived assets stale; it never silently mutates already approved/published versions.

- [ ] **Step 4: 运行 content/evidence tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/evidence test`

Expected: PASS for stale derivatives, missing evidence, brand rules, copyright refs and validation severity.

- [ ] **Step 5: 提交 Content domain**

```bash
git add packages/company-domain/src/growth/content.ts packages/company-domain/src/growth/content.test.ts packages/evidence/src/validators/content-validation.ts packages/evidence/src/validators/content-validation.test.ts
git commit -m "feat(growth): add versioned channel content assets"
```

### Task 4: 实现内容工厂 Workflow

**Files:**
- Create: `packages/workflows/src/templates/content-campaign.ts`
- Create: `packages/workflows/src/templates/content-campaign.test.ts`
- Modify: `packages/workflows/src/index.ts`

**Interfaces:**
- Consumes: GTM brief、source evidence、channel list、employee profiles。
- Produces: `createContentCampaignWorkflow()`。

- [ ] **Step 1: 写母稿、并行渠道适配、验证和审批 DAG 测试**

```ts
it("adapts xiaohongshu and douyin in parallel after the source draft", () => {
  const workflow = createContentCampaignWorkflow(contentWorkflowInput());
  expect(step(workflow, "xiaohongshu-asset").dependsOn).toEqual(["source-draft"]);
  expect(step(workflow, "douyin-asset").dependsOn).toEqual(["source-draft"]);
  expect(step(workflow, "publish-approval").dependsOn.sort())
    .toEqual(["douyin-validation", "xiaohongshu-validation"]);
});
```

- [ ] **Step 2: 运行 workflow test 确认模板缺失**

Run: `pnpm exec vitest run packages/workflows/src/templates/content-campaign.test.ts`

Expected: FAIL because template is absent.

- [ ] **Step 3: 实现内容流水线与明确输出 Schema**

Xiaohongshu output: title options, body, cover copy, comment prompt, tags. Douyin output: hook, script, shots, voiceover, subtitles, cover, CTA. Both include source evidence refs and validation refs.

- [ ] **Step 4: 运行 workflow/content tests**

Run: `pnpm --filter @forge/workflows test && pnpm --filter @forge/company-domain test`

Expected: PASS for one/multiple channels, failed validation, changes requested and resume.

- [ ] **Step 5: 提交内容工厂 Workflow**

```bash
git add packages/workflows/src/templates/content-campaign.ts packages/workflows/src/templates/content-campaign.test.ts packages/workflows/src/index.ts
git commit -m "feat(growth): add multi-channel content workflow"
```

### Task 5: 实现渠道发布包、受控适配器和回执

**Files:**
- Create: `packages/connectors/src/adapters/content-package.ts`
- Create: `packages/connectors/src/adapters/content-package.test.ts`
- Create: `packages/connectors/src/adapters/xiaohongshu.ts`
- Create: `packages/connectors/src/adapters/douyin.ts`
- Create: `packages/connectors/src/adapters/channel-publish.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: approved ChannelAsset、CredentialRef 或人工模式。
- Produces: `PublicationReceipt`、externalId/url/metrics cursor。

- [ ] **Step 1: 写人工包、直接发布幂等和未授权拒绝测试**

```ts
it("creates a downloadable publication package without external side effects", async () => {
  const result = await contentPackageAdapter.execute(approvedAction(), noCredential());
  expect(result).toMatchObject({ mode: "manual", receiptRequired: true });
});

it("refuses direct publishing when the account capability is absent", async () => {
  await expect(xiaohongshuAdapter.execute(action(), credentialWithout("publish")))
    .rejects.toThrow("connector capability");
});
```

- [ ] **Step 2: 运行 adapter tests 确认文件缺失**

Run: `pnpm exec vitest run packages/connectors/src/adapters/content-package.test.ts packages/connectors/src/adapters/channel-publish.test.ts`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: 实现 capability-gated adapter 和 receipt import**

```ts
export interface PublicationReceipt {
  publicationId: string; mode: "direct" | "manual";
  externalId?: string; url?: string; publishedAt: string;
  channelAccountId: string; contentVersionId: string; evidenceIds: string[];
}
```

Direct adapters remain disabled unless credential/account discovery proves the required capability. Manual receipt import validates channel, content hash and timestamp.

- [ ] **Step 4: 运行 connector/content/policy tests**

Run: `pnpm --filter @forge/connectors test && pnpm --filter @forge/policy test && pnpm --filter @forge/company-domain test`

Expected: PASS; repeated idempotency key yields one publication.

- [ ] **Step 5: 提交发布适配器**

```bash
git add packages/connectors/src/adapters packages/connectors/src/index.ts
git commit -m "feat(connectors): add governed channel publication adapters"
```

### Task 6: 实现 Lead ingestion、去重、Consent 和来源触点

**Files:**
- Create: `packages/company-domain/src/growth/leads.ts`
- Create: `packages/company-domain/src/growth/leads.test.ts`

**Interfaces:**
- Consumes: form/channel/connector events。
- Produces: `LeadService.ingest()`、`merge()`、`recordConsent()`、AttributionTouch。

- [ ] **Step 1: 写去重、合并、退订和来源保留测试**

```ts
it("deduplicates normalized email within one company", () => {
  const first = leads.ingest(leadInput("A@Example.com"));
  const second = leads.ingest(leadInput("a@example.com"));
  expect(second.leadId).toBe(first.leadId);
  expect(leads.touches(first.leadId)).toHaveLength(2);
});

it("blocks outreach after opt-out but keeps permitted audit history", () => {
  leads.recordConsent({ leadId: "l1", channel: "email", state: "opted_out" });
  expect(leads.canContact("l1", "email")).toBe(false);
});
```

- [ ] **Step 2: 运行 lead tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/leads.test.ts`

Expected: FAIL because `LeadService` is absent.

- [ ] **Step 3: 实现 identity normalization、merge journal 和 consent policy**

```ts
export interface LeadIngestResult {
  leadId: string; created: boolean; mergedIdentityIds: string[];
  attributionTouchId: string;
}
```

Identity hash is scoped by company; raw personal data follows retention settings and is never copied into Agent Memory.

- [ ] **Step 4: 运行 lead/domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for email/phone normalization, cross-company separation, opt-out and merge conflict.

- [ ] **Step 5: 提交 Lead ingestion**

```bash
git add packages/company-domain/src/growth/leads.ts packages/company-domain/src/growth/leads.test.ts
git commit -m "feat(growth): add governed lead ingestion"
```

### Task 7: 实现 Lead scoring、分配和销售下一步

**Files:**
- Create: `packages/company-domain/src/growth/lead-scoring.ts`
- Create: `packages/company-domain/src/growth/lead-scoring.test.ts`
- Modify: `packages/company-domain/src/growth/leads.ts`

**Interfaces:**
- Consumes: ICP fit、intent events、consent、owner capacity。
- Produces: `LeadScoringService.score()`、`assign()`、`recommendNextAction()`。

- [ ] **Step 1: 写可解释评分、硬排除和容量分配测试**

```ts
it("returns score components and rule version", () => {
  expect(scoring.score(qualifiedLead())).toMatchObject({
    total: 82, ruleVersion: "lead-score-v1",
    components: expect.arrayContaining([{ key: "icp_fit", points: 40 }]),
  });
});

it("never recommends contact for an opted-out lead", () => {
  expect(scoring.recommendNextAction(optedOutLead())).toEqual({ kind: "do_not_contact", reason: "opted_out" });
});
```

- [ ] **Step 2: 运行 scoring tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/lead-scoring.test.ts`

Expected: FAIL because scoring service is absent.

- [ ] **Step 3: 实现版本化规则和 round-robin/skill assignment**

LLM may summarize signals, but score, thresholds and exclusions are deterministic and versioned. Assignment filters by company, active employment, role capability and capacity.

- [ ] **Step 4: 运行 scoring/domain tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for MQL/SQL thresholds, exclusions, tie breaking and unassigned queue.

- [ ] **Step 5: 提交 Lead scoring**

```bash
git add packages/company-domain/src/growth/lead-scoring.ts packages/company-domain/src/growth/lead-scoring.test.ts packages/company-domain/src/growth/leads.ts
git commit -m "feat(growth): add explainable lead scoring"
```

### Task 8: 实现 Opportunity、Sales Activity 和 Deal

**Files:**
- Create: `packages/company-domain/src/growth/sales.ts`
- Create: `packages/company-domain/src/growth/sales.test.ts`
- Create: `packages/workflows/src/templates/lead-to-deal.ts`
- Create: `packages/workflows/src/templates/lead-to-deal.test.ts`

**Interfaces:**
- Consumes: qualified Lead、sales employee、Connector proposals。
- Produces: `SalesService`、`createLeadToDealWorkflow()`。

- [ ] **Step 1: 写漏斗、外联审批和成交证据测试**

```ts
it("moves opportunity only through declared stages", () => {
  const opportunity = sales.createOpportunity(validOpportunity());
  expect(() => sales.moveStage(opportunity.id, "won")).toThrow("invalid stage transition");
});

it("requires customer amount currency and evidence to record a won deal", () => {
  expect(() => sales.recordDeal(incompleteDeal())).toThrow("deal evidence required");
});
```

- [ ] **Step 2: 运行 sales/workflow tests 确认实现缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/sales.test.ts packages/workflows/src/templates/lead-to-deal.test.ts`

Expected: FAIL because services/template are absent.

- [ ] **Step 3: 实现 pipeline、activities、forecast 和受控 outreach steps**

```ts
export type OpportunityStage = "discovery" | "qualified" | "proposal" | "negotiation" | "won" | "lost";
```

Outbound draft is L1; sending uses Connector proposal + approval + consent check. Deal `won` transition requires a Customer record and EvidenceRef.

- [ ] **Step 4: 运行 company/workflow/connector tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/workflows test && pnpm --filter @forge/connectors test`

Expected: PASS for stages, lost reasons, forecast, approval and duplicate send prevention.

- [ ] **Step 5: 提交 sales pipeline**

```bash
git add packages/company-domain/src/growth/sales.ts packages/company-domain/src/growth/sales.test.ts packages/workflows/src/templates/lead-to-deal.ts packages/workflows/src/templates/lead-to-deal.test.ts
git commit -m "feat(sales): add lead to deal workflow"
```

### Task 9: 实现首次、最后和多触点收入归因

**Files:**
- Create: `packages/company-domain/src/growth/attribution.ts`
- Create: `packages/company-domain/src/growth/attribution.test.ts`
- Create: `packages/company-analytics/package.json`
- Create: `packages/company-analytics/tsconfig.json`
- Create: `packages/company-analytics/src/attribution.ts`
- Create: `packages/company-analytics/src/attribution.test.ts`
- Create: `packages/company-analytics/src/index.ts`

**Interfaces:**
- Consumes: touches、deal amount/currency、campaign spend。
- Produces: `AttributionService` 和分析 read models。

- [ ] **Step 1: 写三种归因和不合格成交测试**

```ts
it("returns first last and linear multi-touch allocations", () => {
  const result = attributeDeal(dealFixture({ amountMinor: 900n }), threeTouches());
  expect(result.firstTouch[0]?.amountMinor).toBe(900n);
  expect(result.lastTouch[0]?.touchId).toBe("t3");
  expect(result.multiTouch.map((row) => row.amountMinor)).toEqual([300n, 300n, 300n]);
});

it("excludes a deal without evidence from attributable revenue", () => {
  expect(attributeDeal(dealFixture({ evidenceIds: [] }), threeTouches()).eligible).toBe(false);
});
```

- [ ] **Step 2: 运行 attribution tests 确认 packages 缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/attribution.test.ts packages/company-analytics/src/attribution.test.ts`

Expected: FAIL because attribution implementations are absent.

- [ ] **Step 3: 实现可重复计算与规则版本**

```ts
export interface AttributionResult {
  eligible: boolean; ruleVersion: string;
  firstTouch: Allocation[]; lastTouch: Allocation[]; multiTouch: Allocation[];
  excludedReason?: string;
}
```

Allocations in minor units must sum exactly to deal amount; deterministic remainder goes to earliest touch.

- [ ] **Step 4: 运行 domain/analytics tests**

Run: `pnpm --filter @forge/company-domain test && pnpm --filter @forge/company-analytics test`

Expected: PASS for no touch, one touch, many touches, currency and rounding.

- [ ] **Step 5: 提交 attribution**

```bash
git add packages/company-domain/src/growth/attribution.ts packages/company-domain/src/growth/attribution.test.ts packages/company-analytics
git commit -m "feat(analytics): add revenue attribution models"
```

### Task 10: 实现 Customer Success、健康度和产品反馈回流

**Files:**
- Create: `packages/company-domain/src/growth/customers.ts`
- Create: `packages/company-domain/src/growth/customers.test.ts`
- Modify: `packages/company-domain/src/delivery/release.ts`

**Interfaces:**
- Consumes: Deal、usage/support signals、feedback evidence。
- Produces: `CustomerService`、health score、Product Feedback WorkItem。

- [ ] **Step 1: 写客户创建、健康度解释和反馈链接测试**

```ts
it("creates a customer from a won deal once", () => {
  const first = customers.createFromDeal(wonDeal());
  const second = customers.createFromDeal(wonDeal());
  expect(second.id).toBe(first.id);
});

it("links product feedback to the original campaign and product hypothesis", () => {
  const feedback = customers.recordFeedback(feedbackInput());
  expect(feedback).toMatchObject({ campaignId: "campaign-1", hypothesisId: "hypothesis-2" });
});
```

- [ ] **Step 2: 运行 customer tests 确认服务缺失**

Run: `pnpm exec vitest run packages/company-domain/src/growth/customers.test.ts`

Expected: FAIL because `CustomerService` is absent.

- [ ] **Step 3: 实现 onboarding、health、feedback 和 renewal fields**

Health score stores component inputs and rule version. Negative feedback can create a draft product WorkItem but requires product owner confirmation before entering the delivery pipeline.

- [ ] **Step 4: 运行 customer/delivery tests**

Run: `pnpm --filter @forge/company-domain test`

Expected: PASS for idempotent conversion, health changes, feedback dedupe and product draft.

- [ ] **Step 5: 提交 customer feedback loop**

```bash
git add packages/company-domain/src/growth/customers.ts packages/company-domain/src/growth/customers.test.ts packages/company-domain/src/delivery/release.ts
git commit -m "feat(customers): add success and feedback loop"
```

### Task 11: 实现“客户与增长”和经营分析 UI

**Files:**
- Create: `apps/company-desktop/src/renderer/features/growth/growth-page.tsx`
- Create: `apps/company-desktop/src/renderer/features/growth/campaign-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/growth/content-studio.tsx`
- Create: `apps/company-desktop/src/renderer/features/growth/lead-pipeline.tsx`
- Create: `apps/company-desktop/src/renderer/features/growth/customer-detail.tsx`
- Create: `apps/company-desktop/src/renderer/features/analytics/operating-analytics.tsx`
- Create: `apps/company-desktop/src/renderer/features/growth/growth-ui.test.tsx`

**Interfaces:**
- Consumes: growth domain and analytics DTOs。
- Produces: Campaign→Content→Lead→Deal→Customer 可视化闭环。

- [ ] **Step 1: 写渠道资产、漏斗和收入下钻 tests**

```tsx
it("shows source content and channel variants as one version tree", () => {
  render(<ContentStudio model={contentTreeFixture()} />);
  expect(screen.getByText("母稿 v3")).toBeVisible();
  expect(screen.getByText("小红书")).toBeVisible();
  expect(screen.getByText("抖音")).toBeVisible();
});

it("drills attributable revenue to deal and touches", async () => {
  render(<OperatingAnalytics model={analyticsFixture()} navigate={navigate} />);
  await user.click(screen.getByText("¥9,000 可归因收入"));
  expect(navigate).toHaveBeenCalledWith("/deals/deal-1/attribution");
});
```

- [ ] **Step 2: 运行 Growth UI tests 确认组件缺失**

Run: `pnpm exec vitest run apps/company-desktop/src/renderer/features/growth/growth-ui.test.tsx`

Expected: FAIL because pages are absent.

- [ ] **Step 3: 实现 Campaign、Content、Publication、Lead、Sales、Customer 和 Analytics views**

Every KPI states model/source freshness and links to records. Publication UI shows manual/direct mode, approval, idempotency, receipt and metrics sync status.

- [ ] **Step 4: 运行 Company UI tests/build**

Run: `pnpm --filter @forge/company-desktop test && pnpm --filter @forge/company-desktop build`

Expected: PASS for empty, partial, opt-out, failed publication and closed campaign states.

- [ ] **Step 5: 提交 Growth UI**

```bash
git add apps/company-desktop/src/renderer/features/growth apps/company-desktop/src/renderer/features/analytics
git commit -m "feat(company): add growth revenue experience"
```

### Task 12: 建立增长到收入 E2E 和 P2 门禁

**Files:**
- Create: `apps/daemon/src/company-growth-revenue.e2e.test.ts`
- Create: `scripts/eval-cases/company-growth-revenue.json`
- Modify: `package.json`
- Modify: `scripts/eval.mjs`
- Modify: `packages/protocol/src/v2/company.ts`
- Modify: `apps/daemon/src/modules/company-module.ts`
- Modify: `docs/roadmap.md`

**Interfaces:**
- Consumes: P2 全部领域、Workflow、Connector、UI contract。
- Produces: 一条有证据的产品→收入→反馈回流验收。

- [ ] **Step 1: 写完整 Mock/Sandbox E2E**

```ts
it("runs campaign content publication lead opportunity deal and feedback", async () => {
  const fx = await growthRevenueFixture();
  const result = await fx.run();
  expect(result.publications).toHaveLength(2);
  expect(result.connectorExternalWrites).toBe(2);
  expect(result.lead.sourceCampaignId).toBe(result.campaign.id);
  expect(result.deal.state).toBe("won");
  expect(result.attribution.multiTouch.reduce((n, row) => n + row.amountMinor, 0n)).toBe(result.deal.amountMinor);
  expect(result.feedback.productWorkItemState).toBe("draft");
});
```

- [ ] **Step 2: 运行 E2E 确认未集成 wiring 失败**

Run: `pnpm exec vitest run apps/daemon/src/company-growth-revenue.e2e.test.ts`

Expected: FAIL before all RPC/event projections are connected.

- [ ] **Step 3: 补齐 Company RPC、event projections 和 eval fixture**

Use deterministic mock adapters and verify actual connector action rows, receipts, lead rows, deal evidence and attribution allocations rather than prose. Add `@forge/company-analytics` to the root `test` filter list.

- [ ] **Step 4: 运行 P2 全门禁**

Run:

```bash
pnpm --filter @forge/company-domain test
pnpm --filter @forge/company-analytics test
pnpm --filter @forge/workflows test
pnpm --filter @forge/connectors test
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/company-desktop build
pnpm --filter @forge/daemon test
pnpm test
pnpm eval
```

Expected: all PASS; repeated E2E run with same external event IDs creates no duplicate publication, lead or deal.

- [ ] **Step 5: 提交 Company P2 gate**

```bash
git add package.json apps/daemon/src/company-growth-revenue.e2e.test.ts scripts/eval-cases/company-growth-revenue.json scripts/eval.mjs packages/protocol/src/v2/company.ts apps/daemon/src/modules/company-module.ts docs/roadmap.md
git commit -m "feat(company): complete growth and revenue loop"
```
