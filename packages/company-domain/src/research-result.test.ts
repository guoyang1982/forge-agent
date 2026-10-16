import { describe, expect, it } from "vitest";
import { extractResearchResult } from "./research-result.js";

const valid = { schemaVersion: 1, conclusion: "先访谈", evidence: [{ claim: "需求待验证", source: "interview:1" }], risks: [], unknowns: ["付费意愿"], nextActions: ["访谈"] };
const report = (value: unknown) => `# 任意标题\n完整报告\n\`\`\`forge-research-result\n${JSON.stringify(value)}\n\`\`\``;
describe("research result contract", () => {
  it("extracts only explicit data and binds source and missing fields", () => {
    const result = extractResearchResult(report(valid), "run-1", "output-1");
    expect(result).toMatchObject({ ...valid, missingFields: ["risks"], source: { runId: "run-1", outputRef: "output-1" } });
    expect(result?.source.reportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extractResearchResult(report(valid) + "\nchanged", "run-1", "output-1")?.source.reportHash).not.toBe(result?.source.reportHash);
  });
  it("ignores example contracts nested in a longer code fence", () => {
    expect(extractResearchResult("````markdown\n" + report(valid) + "\n````", "r", "o")).toBeNull();
  });
  it("rejects malformed, stale versions, incomplete evidence, forged provenance and ambiguous blocks", () => {
    for (const input of [null, [], { ...valid, schemaVersion: 2 }, { ...valid, evidence: [{ claim: "unsupported" }] }, { ...valid, source: { runId: "other" } }, { ...valid, unknowns: "none" }]) {
      expect(extractResearchResult(report(input), "run-1", "output-1")).toBeNull();
    }
    expect(extractResearchResult('```forge-research-result\n{invalid}\n```', "r", "o")).toBeNull();
    expect(extractResearchResult(report(valid) + '\n' + report(valid), "r", "o")).toBeNull();
    expect(extractResearchResult("## 结论\n旧报告", "r", "o")).toBeNull();
  });
});
