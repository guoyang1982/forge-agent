import type { AutomationDraft, AutomationTemplate } from "@forge/protocol";

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-brief",
    name: "Daily brief",
    description: "Summarize today's focus items (calendar/email placeholders).",
    draft: {
      name: "Daily brief",
      description: "Morning summary of today's priorities.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
      prompt:
        "Review this project and produce a brief daily summary of what to focus on today. " +
        "Note: calendar and email integrations are placeholders in v1 — use repo activity, " +
        "open issues, and recent changes as proxies.",
      enabled: false,
    },
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "Review last week's commits, open issues, and risks.",
    draft: {
      name: "Weekly review",
      description: "Monday morning retrospective for the project.",
      cron: "0 9 * * 1",
      timezone: "UTC",
      prompt:
        "Produce a weekly review for this project: summarize commits from the last 7 days, " +
        "list open or stale issues, and highlight risks or blockers.",
      enabled: false,
    },
  },
  {
    id: "project-monitor",
    name: "Project monitor",
    description: "Monitor CI health, dependencies, and growing TODO debt.",
    draft: {
      name: "Project monitor",
      description: "Periodic project health check.",
      cron: "0 */6 * * *",
      timezone: "UTC",
      prompt:
        "Check project health: CI status indicators, dependency drift or outdated packages, " +
        "and growth of TODO/FIXME comments. Report anything that needs attention.",
      enabled: false,
    },
  },
];

export function getTemplate(id: string): AutomationTemplate | undefined {
  const template = AUTOMATION_TEMPLATES.find((t) => t.id === id);
  if (!template) return undefined;
  return {
    ...template,
    draft: { ...template.draft },
  };
}

export function listTemplates(): AutomationTemplate[] {
  return AUTOMATION_TEMPLATES.map((t) => ({
    ...t,
    draft: { ...t.draft },
  }));
}
