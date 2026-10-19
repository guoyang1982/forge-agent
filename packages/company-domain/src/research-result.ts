import type { ResearchResult } from "@forge/protocol";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

const fields = ["schemaVersion", "conclusion", "evidence", "risks", "unknowns", "nextActions"];
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

/** Only the explicit versioned contract is data; Markdown is never inferred into facts. */
export function extractResearchResult(content: string, runId: string, outputRef: string): ResearchResult | null {
  const blocks: string[] = [];
  let fence: string | null = null;
  let collecting = false;
  let body: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        if (collecting) blocks.push(body.join("\n"));
        fence = null; collecting = false; body = [];
      } else if (collecting) body.push(line);
    } else if (marker) {
      fence = marker[1]!;
      collecting = marker[2]!.trim() === "forge-research-result";
    }
  }
  if (blocks.length !== 1) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(blocks[0]!); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in value)) || value.schemaVersion !== 1 ||
    !(value.conclusion === null || text(value.conclusion)) ||
    !strings(value.risks) || !strings(value.unknowns) || !strings(value.nextActions) ||
    !Array.isArray(value.evidence) || !value.evidence.every((entry) => entry &&
      typeof entry === "object" && Object.keys(entry).length === 2 && text(entry.claim) && text(entry.source))) return null;
  return {
    schemaVersion: 1,
    conclusion: value.conclusion as string | null,
    evidence: value.evidence as ResearchResult["evidence"],
    risks: value.risks, unknowns: value.unknowns, nextActions: value.nextActions,
    missingFields: fields.filter((key) => key !== "schemaVersion" && (value[key] === null || (Array.isArray(value[key]) && value[key].length === 0))),
    source: { runId, outputRef, reportHash: createHash("sha256").update(content).digest("hex") },
  };
}

/** Materialize from an exact successful attempt snapshot; never trust a cached payload's provenance. */
export function persistResearchResult(db: Database.Database, content: string, runId: string, outputRef: string): ResearchResult | null {
  const result = extractResearchResult(content, runId, outputRef);
  if (!result) return null;
  const source = db.prepare(`SELECT 1 FROM core_attempts AS a
    JOIN core_legacy_run_results AS r ON r.output_ref = a.output_ref
    WHERE a.run_id = ? AND a.output_ref = ? AND a.state = 'succeeded' AND r.final_text = ?`).get(runId, outputRef, content);
  if (!source) return null;
  db.prepare(`INSERT INTO company_research_results (run_id, output_ref, report_hash, schema_version, result_json)
    VALUES (?, ?, ?, 1, ?) ON CONFLICT (run_id, output_ref, report_hash, schema_version)
    DO UPDATE SET result_json = excluded.result_json`).run(runId, outputRef, result.source.reportHash, JSON.stringify(result));
  return result;
}
