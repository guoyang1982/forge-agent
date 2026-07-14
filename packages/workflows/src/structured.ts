import type { StructuredPlan, StructuredReview } from "@forge/protocol";

const SEVERITIES = new Set(["high", "medium", "low"]);

export function parseStructuredPlan(text: string): StructuredPlan | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isNonEmptyString(parsed.summary) || !Array.isArray(parsed.steps)) {
      return undefined;
    }
    const steps: StructuredPlan["steps"] = parsed.steps
      .map((step, i) => {
        if (!step || typeof step !== "object") return null;
        const candidate = step as Record<string, unknown>;
        if (!isNonEmptyString(candidate.title)) return null;
        const out: StructuredPlan["steps"][number] = {
          id: isNonEmptyString(candidate.id) ? candidate.id : `step-${i + 1}`,
          title: candidate.title,
        };
        if (isNonEmptyString(candidate.description)) {
          out.description = candidate.description;
        }
        return out;
      })
      .filter((step): step is StructuredPlan["steps"][number] => Boolean(step));

    if (!steps.length) return undefined;
    return {
      summary: parsed.summary,
      steps,
      filesToInspect: stringArray(parsed.filesToInspect),
      risks: stringArray(parsed.risks),
      verification: stringArray(parsed.verification),
      questions: stringArray(parsed.questions),
    };
  } catch {
    return undefined;
  }
}

export function formatStructuredPlan(plan: StructuredPlan): string {
  const lines = ["## Plan", plan.summary, "", "## Steps"];
  for (const [i, step] of plan.steps.entries()) {
    lines.push(`${i + 1}. ${step.title}`);
    if (step.description) lines.push(`   ${step.description}`);
  }
  if (plan.filesToInspect.length) {
    lines.push("", "## Files", ...plan.filesToInspect.map((f) => `- ${f}`));
  }
  if (plan.risks.length || plan.questions?.length) {
    lines.push("", "## Risks / Questions");
    lines.push(...plan.risks.map((r) => `- ${r}`));
    lines.push(...(plan.questions ?? []).map((q) => `- ${q}`));
  }
  if (plan.verification.length) {
    lines.push("", "## Verification", ...plan.verification.map((v) => `- ${v}`));
  }
  return lines.join("\n");
}

export function parseStructuredReview(text: string): StructuredReview | undefined {
  const raw = extractJsonObject(text);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Array.isArray(parsed.findings) || !isNonEmptyString(parsed.summary)) {
      return undefined;
    }
    const findings: StructuredReview["findings"] = parsed.findings
      .map((finding) => {
        if (!finding || typeof finding !== "object") return null;
        const candidate = finding as Record<string, unknown>;
        if (!SEVERITIES.has(String(candidate.severity))) return null;
        if (!isNonEmptyString(candidate.message)) return null;
        const out: StructuredReview["findings"][number] = {
          severity: candidate.severity as "high" | "medium" | "low",
          message: candidate.message,
        };
        if (isNonEmptyString(candidate.file)) out.file = candidate.file;
        if (isNonEmptyString(candidate.suggestion)) {
          out.suggestion = candidate.suggestion;
        }
        return out;
      })
      .filter((finding): finding is StructuredReview["findings"][number] =>
        Boolean(finding),
      );

    return {
      findings,
      verificationGaps: stringArray(parsed.verificationGaps),
      summary: parsed.summary,
      residualRisk: isNonEmptyString(parsed.residualRisk)
        ? parsed.residualRisk
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function formatStructuredReview(review: StructuredReview): string {
  const lines = ["## Findings"];
  if (!review.findings.length) {
    lines.push("- No issues found.");
  } else {
    for (const finding of review.findings) {
      const file = finding.file ? `${finding.file}: ` : "";
      lines.push(`- [${finding.severity}] ${file}${finding.message}`);
      if (finding.suggestion) lines.push(`  Suggestion: ${finding.suggestion}`);
    }
  }
  if (review.verificationGaps.length) {
    lines.push("", "## Verification Gaps");
    lines.push(...review.verificationGaps.map((gap) => `- ${gap}`));
  }
  lines.push("", "## Summary", review.summary);
  if (review.residualRisk) {
    lines.push("", "## Residual Risk", review.residualRisk);
  }
  return lines.join("\n");
}

export function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;

  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => isNonEmptyString(item))
    : [];
}
