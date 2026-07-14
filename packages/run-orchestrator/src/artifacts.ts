/**
 * Workspace-relative scratch location for talent hand-off artifacts.
 *
 * In a serial dispatch the orchestrator persists each upstream talent's full
 * output here so downstream talents can `read_file` the complete document
 * (rather than relying only on an inlined, possibly-truncated prefix). Sub-agents
 * stay strictly read-only — the orchestrator is the sole writer. Lives under the
 * existing `.forge/` project dir; cleaned up after the dispatch.
 */
const ARTIFACT_ROOT = ".forge/talent-artifacts";

function safeTurn(turnIndex: number): number {
  return Number.isFinite(turnIndex) && turnIndex >= 0 ? Math.floor(turnIndex) : 0;
}

/** Sanitize a mention into a filesystem-safe slug (no path traversal). */
export function talentArtifactSlug(mention: string): string {
  return (
    mention
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "talent"
  );
}

/** Directory (workspace-relative) holding one dispatch turn's artifacts. */
export function talentArtifactDirRelPath(turnIndex: number): string {
  return `${ARTIFACT_ROOT}/${safeTurn(turnIndex)}`;
}

/** File (workspace-relative) for one talent's persisted output. */
export function talentArtifactRelPath(turnIndex: number, mention: string): string {
  return `${talentArtifactDirRelPath(turnIndex)}/${talentArtifactSlug(mention)}.md`;
}
