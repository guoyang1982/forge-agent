import { createHash, randomUUID } from "node:crypto";

export interface CompressionSection {
  id: string;
  kind: string;
  text: string;
  priority: number;
  tokenEstimate?: number;
}

export interface CompressionContext {
  sections: CompressionSection[];
  tokenBudget?: number;
}

export interface CompressionPolicy {
  modelFailureThreshold?: number;
  maxModelAttempts?: number;
}

export interface CompressionResult {
  mode: "prune" | "structured" | "model" | "local_fallback";
  summary: string;
  retainedRefs: string[];
  removedTokenEstimate: number;
  evidenceId: string;
}

export type CompressionCircuitState = "closed" | "open";

const CRITICAL_KINDS = new Set([
  "decision",
  "path",
  "failure",
  "validation",
  "remaining",
]);

export class ContextCompressor {
  private modelFailures = 0;
  private circuitOpen = false;

  constructor(private readonly policy: CompressionPolicy = {}) {}

  compact(context: CompressionContext): CompressionResult {
    const tokenBudget = context.tokenBudget ?? 4_000;
    const critical = context.sections.filter((section) =>
      CRITICAL_KINDS.has(section.kind),
    );
    const optional = context.sections
      .filter((section) => !CRITICAL_KINDS.has(section.kind))
      .sort((a, b) => b.priority - a.priority);

    const retained: CompressionSection[] = [...critical];
    let usedTokens = estimateTokens(retained);
    for (const section of optional) {
      const next = usedTokens + estimateSectionTokens(section);
      if (next > tokenBudget) {
        continue;
      }
      retained.push(section);
      usedTokens = next;
    }

    const removedTokenEstimate = Math.max(
      0,
      estimateTokens(context.sections) - estimateTokens(retained),
    );

    return {
      mode: "structured",
      summary: retained.map((section) => section.text).join("\n"),
      retainedRefs: retained.map((section) => section.id),
      removedTokenEstimate,
      evidenceId: buildEvidenceId(retained),
    };
  }

  async compactWithFallback(
    context: CompressionContext,
    model?: (prompt: string) => Promise<string>,
  ): Promise<CompressionResult> {
    const maxAttempts = this.policy.maxModelAttempts ?? 3;
    if (this.circuitOpen || !model) {
      return { ...this.compact(context), mode: "local_fallback" };
    }

    try {
      const summary = await model(
        context.sections.map((section) => section.text).join("\n\n"),
      );
      this.modelFailures = 0;
      const pruned = this.compact(context);
      return {
        mode: "model",
        summary: summary.trim() || pruned.summary,
        retainedRefs: pruned.retainedRefs,
        removedTokenEstimate: pruned.removedTokenEstimate,
        evidenceId: pruned.evidenceId,
      };
    } catch {
      this.modelFailures += 1;
      if (this.modelFailures >= (this.policy.modelFailureThreshold ?? 3)) {
        this.circuitOpen = true;
      }
      if (this.modelFailures < maxAttempts && !this.circuitOpen) {
        return this.compactWithFallback(context, model);
      }
      return { ...this.compact(context), mode: "local_fallback" };
    }
  }

  circuitState(): CompressionCircuitState {
    return this.circuitOpen ? "open" : "closed";
  }
}

export function longContextFixture(): CompressionContext {
  return {
    tokenBudget: 120,
    sections: [
      {
        id: "decision-1",
        kind: "decision",
        text: "architecture decision: use durable execution store",
        priority: 100,
        tokenEstimate: 20,
      },
      {
        id: "path-1",
        kind: "path",
        text: "packages/execution/src/store.ts",
        priority: 90,
        tokenEstimate: 10,
      },
      {
        id: "failure-1",
        kind: "failure",
        text: "validation failed: missing approval",
        priority: 95,
        tokenEstimate: 15,
      },
      {
        id: "remaining-1",
        kind: "remaining",
        text: "remaining: release approval",
        priority: 85,
        tokenEstimate: 12,
      },
      {
        id: "noise-1",
        kind: "tool_result",
        text: "x".repeat(500),
        priority: 1,
        tokenEstimate: 200,
      },
      {
        id: "noise-2",
        kind: "trace",
        text: "y".repeat(500),
        priority: 1,
        tokenEstimate: 200,
      },
    ],
  };
}

function estimateSectionTokens(section: CompressionSection): number {
  return section.tokenEstimate ?? Math.ceil(section.text.length / 4);
}

function estimateTokens(sections: CompressionSection[]): number {
  return sections.reduce((sum, section) => sum + estimateSectionTokens(section), 0);
}

function buildEvidenceId(sections: CompressionSection[]): string {
  const digest = createHash("sha256")
    .update(sections.map((section) => section.id).join(":"))
    .digest("hex")
    .slice(0, 16);
  return `evidence:compression:${digest || randomUUID()}`;
}
