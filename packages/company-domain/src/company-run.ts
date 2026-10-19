export function buildCompanyRunMessage(input: {
  title: string;
  workType?: string;
  assigneeName: string;
  talentRole?: string;
  intent: string;
  spec: string;
  plan: string;
  capability?: {
    skills?: string[];
    tools?: string[];
    qualityGates?: string[];
    methodology?: string[];
    systemPrompt?: string;
    knowledgeRefs?: string[];
    connectors?: string[];
  };
  memories?: string[];
}): string {
  const role = input.talentRole?.trim() || "未绑定人才";
  const capability = input.capability || {};
  const memories = (input.memories || []).map((note) => note.trim()).filter(Boolean);
  const sections = [
    "# Company work item",
    `Title: ${input.title}`,
    `Assignee: ${input.assigneeName} (${role})`,
    "",
    "## Intent",
    input.intent,
    "",
    "## Accepted spec",
    input.spec,
    "",
    "## Accepted plan",
    input.plan,
  ];
  if ((capability.skills || []).length) {
    sections.push("", `Skills: ${capability.skills!.join(", ")}`);
  }
  if ((capability.tools || []).length) {
    sections.push(`Tools: ${capability.tools!.join(", ")}`);
  }
  if ((capability.qualityGates || []).length) {
    sections.push(`Quality gates: ${capability.qualityGates!.join("; ")}`);
  }
  if ((capability.methodology || []).length) {
    sections.push(`Method: ${capability.methodology!.join("; ")}`);
  }
  if ((capability.knowledgeRefs || []).length) {
    sections.push(`Knowledge: ${capability.knowledgeRefs!.join(", ")}`);
  }
  if ((capability.connectors || []).length) {
    sections.push(`Connectors: ${capability.connectors!.join(", ")}`);
  }
  if (capability.systemPrompt?.trim()) {
    sections.push("", "## Employee standing instructions", capability.systemPrompt.trim());
  }
  if (memories.length) {
    sections.push("", "## Lessons on this employee", ...memories.map((note) => `- ${note}`));
  }
  sections.push(
    "",
    "Execute the accepted plan in this workspace. Do not expand scope.",
    "Writes in this run are auto-applied. Do not wait for REPL y or a click to confirm; continue until the accepted plan is done.",
  );
  if (input.workType === "research") {
    sections.push("", "## Research result output contract",
      'End your report with exactly one fenced block labelled forge-research-result containing JSON: {"schemaVersion":1,"conclusion":null,"evidence":[],"risks":[],"unknowns":[],"nextActions":[]}.',
      "Replace conclusion with your supported conclusion (string), or null when unavailable. Evidence entries must have claim and source strings with a verifiable source reference. risks, unknowns and nextActions are arrays of strings. Use empty arrays for missing fields; explicitly record unresolved questions in unknowns. Do not invent evidence. Do not include run IDs, output references, hashes, source metadata or additional keys. Keep the readable report before the block.");
  }
  return sections.join("\n");
}

export function applyCompanyRunTerminalEvent(
  gates: {
    onRunTerminal(input: {
      runId: string;
      outcome: "succeeded" | "failed";
    }): void;
  },
  event: { type: string; runId?: string },
): void {
  if (!event.runId) return;
  if (event.type === "run.succeeded") {
    gates.onRunTerminal({ runId: event.runId, outcome: "succeeded" });
    return;
  }
  if (event.type === "run.failed" || event.type === "run.cancelled") {
    gates.onRunTerminal({ runId: event.runId, outcome: "failed" });
  }
}
