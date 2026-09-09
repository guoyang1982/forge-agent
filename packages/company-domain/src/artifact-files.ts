import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
