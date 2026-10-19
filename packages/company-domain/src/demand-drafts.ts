import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { newCompanyId } from "./ids.js";
import type { WorkArtifact } from "./work-service.js";

export type DemandDraftInput = {
  type?: string;
  title: string;
  problem: string;
  expectedOutcome: string;
};

export function draftSpecFromDemand(demand: DemandDraftInput): string {
  return [
    `# ${demand.title.trim()}`,
    "",
    "## 问题",
    demand.problem.trim(),
    "",
    "## 验收标准",
    demand.expectedOutcome.trim(),
  ].join("\n");
}

export function draftPlanFromDemand(demand: DemandDraftInput): string {
  if (demand.type === "research") {
    return [
      `# ${demand.title.trim()} 调研计划`, "", "## 调研问题", demand.problem.trim(), "", "## 步骤",
      "1. 收集证据，记录信息来源、时间与适用范围。",
      "2. 区分已知结论与待验证问题，评估可行性与风险。",
      `3. 提交调研报告与下一步建议，对照预期结果核验：${demand.expectedOutcome.trim()}`,
      "报告使用以下二级标题：一句话结论、关键依据、主要风险、未知项、下一步建议。",
      "依据标明可核查来源；没有证据时明确写待验证，不把需求原文当成结论。",
    ].join("\n");
  }
  return [
    `# ${demand.title.trim()} 实施计划`,
    "",
    "## 依据",
    demand.problem.trim(),
    "",
    "## 步骤",
    "1. 按规格实现最小改动。",
    `2. 对照验收标准自验：${demand.expectedOutcome.trim()}`,
    "3. 提交结果并等待独立验收。",
  ].join("\n");
}

export function buildDemandDraftArtifacts(item: {
  id: string;
  companyId: string;
} & DemandDraftInput): WorkArtifact[] {
  return [
    draftArtifact(item, "intent", item.problem),
    draftArtifact(item, "spec", draftSpecFromDemand(item)),
    draftArtifact(item, "plan", draftPlanFromDemand(item)),
  ];
}

export function insertWorkArtifactRow(
  db: Database.Database,
  artifact: WorkArtifact,
  now: string,
): void {
  db.prepare(
    `INSERT INTO company_work_artifacts
      (id, company_id, work_item_id, kind, version, status, content,
        content_hash, workspace_path, accepted_at, accepted_by,
        created_at, updated_at)
    VALUES
      (@id, @companyId, @workItemId, @kind, @version, @status, @content,
        @contentHash, @workspacePath, @acceptedAt, @acceptedBy,
        @createdAt, @updatedAt)`,
  ).run({ ...artifact, createdAt: now, updatedAt: now });
}

function draftArtifact(
  item: { id: string; companyId: string },
  kind: WorkArtifact["kind"],
  content: string,
): WorkArtifact {
  return {
    id: newCompanyId("artifact"),
    companyId: item.companyId,
    workItemId: item.id,
    kind,
    version: 1,
    status: "draft",
    content,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    workspacePath: null,
    acceptedAt: null,
    acceptedBy: null,
  };
}
