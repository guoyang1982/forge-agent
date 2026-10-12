# 调研决策备忘录（老板一页纸）设计

> 状态：待实现计划（已与产品对齐原型）
>
> 日期：2026-10-12
>
> 范围：Company Desktop「调研结论」页信息架构与数据组装；从现有论断抽取正式表/指标/来源链接
>
> 本文不授权大范围改造调研工作流。实施任务在确认后单独拆分。

## 1. 目标与成功标准

### 1.1 目标

把当前「总览 + 建议方向 + 四段摘要 + 原始论断」堆叠，升级为**可当场拍板、可页内备查的正式决策备忘录**：

- **A（30 秒拍板）**：首屏给出做 / 不做 / 改方向，并带主操作
- **对外正式感**：指标卡、竞品表、风险表；重要数据与竞品带来源 URL，可点击核验
- **D（页内备查）**：同一页可回看；本轮不做导出/PDF
- **附件够用但不杂**：收齐本轮论断与来源；不挂工作区文件列表

### 1.2 成功标准

1. 打开已完成调研的项目（如「老年出行打车app」），首屏可见决策建议、三条硬理由、同意/改路径操作入口。
2. 竞品/替代供给表与关键指标尽量展示；有 evidence URL 时可点击；无 URL 显示「无链接」，不编造地址。
3. 风险表突出一票否决级项。
4. 附件默认折叠，展开后可见四段摘要、关键依据、**全部原始论断（含证据链接）**。
5. 无足够数字时不画空图；有 ≥3 个可比量级点时才显示简易对比条。

## 2. 非目标（本轮）

- 不重跑调研、不强制分支提示词输出结构化 JSON（预留字段即可）
- 不做一键复制/导出飞书/PDF
- 不引入重型图表库
- 附件不包含工作区文件、Run 中间日志、工具原始输出墙

## 3. 信息架构

自上而下固定五层（与已确认原型一致）：

1. **决策头**  
   想法标题、评估日、依据规模；大字结论；三条硬理由（尽量含竞品/数字 + 来源链）；主操作（同意结论 / 改选路径 / 停止原想法，对齐现有闸门能力）。

2. **关键指标条**  
   3–6 张数字卡（标签、数值、来源短链）。抽不出则整块隐藏。

3. **正式表**  
   - 竞品/替代供给：名称 | 形态 | 规模或覆盖 | 对我们的含义 | **来源**  
   - 风险一览：风险 | 严重度 | 含义 | **来源**  
   - 可选：可比规模简易条形图（仅当 ≥3 可比点）

4. **建议路径**  
   0–3 张方向卡（沿用 `suggestedDirections`）。

5. **附件（默认折叠）**  
   用户 / 市场 / 代码与数据 / 风险：各段摘要 → 关键依据 → 全部原始论断（含证据）。  
   不含工作区文件入口。

## 4. 数据模型

在 `@forge/company-domain` 新增组装函数（名称可微调）：

```ts
buildResearchDecisionMemo(input: {
  recommendation: ResearchRecommendation;
  readingBrief: ResearchReadingBrief;
  claims: ResearchBriefClaim[]; // 含 evidence / evidenceIds
  title?: string;
  evaluatedAt?: string;
}): ResearchDecisionMemo
```

`ResearchDecisionMemo` 建议字段：

| 字段 | 说明 |
|------|------|
| `title` / `evaluatedAt` / `claimTotal` | 页眉元信息 |
| `recommendation` / `verdictLabel` | 决策 |
| `reasons: { text: string; sources: { label: string; url?: string }[] }[]` | 硬理由 + 来源 |
| `metrics: { label: string; value: string; sources: ... }[]` | 指标卡 |
| `competitors: { name: string; form?: string; scale?: string; implication?: string; sources: ... }[]` | 竞品表 |
| `risks: { text: string; severity: "veto" \| "high" \| "medium" \| "low"; implication?: string; sources: ... }[]` | 风险表 |
| `chart?: { label: string; points: { name: string; valueLabel: string; ratio: number }[] }` | 可选条形 |
| `directions` | 透传建议方向 |
| `attachments` | 四段摘要 + highlights + claims（按分支） |

### 4.1 数据优先级

1. 若将来分支产物带结构化 `metrics[]` / `competitors[]` / `risks[]` → **优先使用**
2. 否则从 `fact` 论断 + 分支 `conclusionZh` **抽取**
3. 仍不足 → 该块降级短文案或隐藏，不画空表硬撑

### 4.2 来源链接规则

- URL 只来自论断已有 evidence（`http(s)`）
- 展示域名或短标；`target=_blank` + `rel=noopener noreferrer`
- 无 URL：UI 文案「无链接」，不可点击
- **禁止**模型或前端补搜/臆造网址

## 5. 抽取启发式（本轮实现）

- **竞品/供给**：匹配名称与形态关键词（滴滴/高德/95128/长辈版/小程序/热线/竞品/替代供给等），从 claim 文本取规模片段；`competitiveSignalScore` 可复用
- **指标**：抽取带单位的显著数字（人口、覆盖城、累计次数等），去重后取分最高的 3–6 个
- **风险**：优先含合规/许可/二清/敏感个人信息/一票否决等句；严重度用关键词粗分
- **硬理由**：优先从决策/市场结论中取「需求侧 / 供给侧 / 最大风险」三类各一条；每条挂上相关 claim 的 evidence

抽取质量以「可展示、可点击核验」为准，不追求完美 NLP；单测用老年出行样例论断回归。

## 6. UI 改动边界

- **改**：`apps/company-desktop` 调研结论渲染（`delivery-ui.js` + 样式），消费 `readingBrief` 之上的 memo（可由 status API 附带，或前端调用同构逻辑若仅桌面需要则 daemon status 组装更佳）
- **推荐**：daemon `researchStatus` 增加 `decisionMemo` 字段，桌面只负责渲染，避免两套抽取
- **不改**：调研工作流步骤定义、分支提示词强制 schema（仅预留）

## 7. 测试与验收

- domain：样例 claims → memo 含竞品行且 sources 来自 evidence；无 evidence 时为「无链接」
- domain：少于 3 个可比点不产出 chart
- desktop：渲染备忘录五层；附件折叠；链接可点
- 手工：老年出行项目页内对照原型结构

## 8. 后续（不在本轮）

- 分支输出标准 `metrics/competitors/risks`
- 一键复制/导出对外稿
- 更丰富图表

## 9. 原型参考

本地原型：`Desktop/调研决策备忘录-原型.html`（结构已确认「可以」）
