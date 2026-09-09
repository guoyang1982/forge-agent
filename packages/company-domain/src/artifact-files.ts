import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

export type WorkArtifactFileKind = "intent" | "spec" | "plan";

export type CompanyArtifactOptions = {
  artifactRoot?: string;
};

export function writeWorkArtifactFile(input: {
  artifactRoot: string;
  companyId: string;
  workItemId: string;
  kind: WorkArtifactFileKind;
  content: string;
}): string {
  const relative = `${input.companyId}/work/${input.workItemId}/${input.kind}.md`;
  const absolute = join(
    input.artifactRoot,
    input.companyId,
    "work",
    input.workItemId,
    `${input.kind}.md`,
  );
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, input.content, "utf8");
  return relative;
}

export function persistWorkArtifactFile(
  options: CompanyArtifactOptions | undefined,
  artifact: {
    id: string;
    companyId: string;
    workItemId: string;
    kind: WorkArtifactFileKind;
    content: string;
  },
  db: Database.Database,
): string | null {
  const artifactRoot = options?.artifactRoot;
  if (!artifactRoot) {
    return null;
  }

  const relative = writeWorkArtifactFile({
    artifactRoot,
    companyId: artifact.companyId,
    workItemId: artifact.workItemId,
    kind: artifact.kind,
    content: artifact.content,
  });
  db.prepare(
    "UPDATE company_work_artifacts SET workspace_path = ? WHERE id = ?",
  ).run(relative, artifact.id);
  return relative;
}
