import { describe, expect, it } from "vitest";
import {
  acceptFormalReport,
  buildFormalReportPrompt,
} from "./formal-research-report.js";

const SAMPLE = `# 闲置互换 调研报告

评估日期：2026-10-15
结论：不做原想法
依据成色：事实 3 · 推断 1 · 未知 1

## 一、结论
贝壳互换覆盖更宽，但现金二手更可能做成。

## 关键指标
- 二手交易规模：约 1.82 万亿元（市场段）

## 二、依据

### 用户与场景
用户要的是省事回血，不是双向凑单。

### 市场与替代
闲鱼已经用现金把撮合成本压到很低。

### 竞品与替代
| 名称 | 形态 | 规模或覆盖 | 对本方案的含义 | 来源 |
| --- | --- | --- | --- | --- |
| 闲鱼 | 现金买卖 | 月活约 2 亿 | 贝壳要给出留下的理由 | 市场段 |

现金已经解决需求双重巧合。

### 风险与合规
| 风险 | 严重度 | 含义 | 来源 |
| --- | --- | --- | --- |
| 贝壳跨行业兑换 | 一票否决 | 挡住把贝壳当货币 | 风险段 |

## 三、建议
停止把贝壳当作可流转货币。

1. 推导：先做临期库存清仓
   为什么：市场段指出 B 端库存比全品类互换好启动。
   下一步：只用现金加站内权益，不做劳动力互换。

## 四、工作量参考
本节只估计实现成本，不作为做或不做的依据。
现有仓库没有撮合和账本，需要新建。

## 五、未核实事项
互换匹配成功率没有公开数字。
`;

describe("formal research report", () => {
  it("asks the writer to use three branches as evidence and code only as workload", () => {
    const prompt = buildFormalReportPrompt({
      title: "闲置互换",
      evaluatedAt: "2026-10-15",
      factCount: 3,
      inferenceCount: 1,
      unknownCount: 1,
      userConclusion: "判断：值得收窄到单品类",
      marketConclusion: "判断：停止全品类贝壳",
      riskConclusion: "判断：贝壳当货币有支付许可问题",
      codeConclusion: "仓库只有静态页",
    });
    expect(prompt).toContain("闲置互换");
    expect(prompt).toContain("判断：值得收窄到单品类");
    expect(prompt).toContain("判断：停止全品类贝壳");
    expect(prompt).toContain("支付许可");
    expect(prompt).toContain("仓库只有静态页");
    expect(prompt).toContain("不作为做或不做的依据");
    expect(prompt).toContain("推导");
    expect(prompt).toContain("### 竞品与替代");
    expect(prompt).toContain("无关的新题目不写");
  });

  it("accepts a report that keeps the agreed chapters", () => {
    expect(acceptFormalReport(SAMPLE)).toContain("## 一、结论");
    expect(acceptFormalReport(`\`\`\`markdown\n${SAMPLE}\n\`\`\``)).toContain("竞品与替代");
  });

  it("rejects a report that treats workload as the business verdict or drops competitors", () => {
    expect(acceptFormalReport(SAMPLE.replace("### 竞品与替代", "### 对手"))).toBeNull();
    expect(
      acceptFormalReport(SAMPLE.replace("本节只估计实现成本，不作为做或不做的依据。", "代码证明不该做。")),
    ).toBeNull();
  });
});
