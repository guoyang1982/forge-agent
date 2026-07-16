export interface ProjectItem {
  name: string;
  path: string;
  kind: "workspace" | "project";
}

export function parseProjects(value: unknown): ProjectItem[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>).projects;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (
      typeof item.name !== "string" ||
      typeof item.path !== "string" ||
      (item.kind !== "workspace" && item.kind !== "project")
    ) return [];
    return [{
      name: item.name.slice(0, 100),
      path: item.path.slice(0, 4096),
      kind: item.kind,
    }];
  });
}

export function parseCreatedProject(value: unknown): ProjectItem | null {
  if (!value || typeof value !== "object") return null;
  const project = (value as Record<string, unknown>).project;
  const parsed = parseProjects({ projects: [project] });
  return parsed[0] ?? null;
}
