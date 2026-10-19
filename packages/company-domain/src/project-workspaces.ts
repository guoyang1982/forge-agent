export function bindProjectWorkspaceGroup(
  db: { prepare(sql: string): { run(...args: unknown[]): unknown } },
  input: {
    companyId: string;
    projectId: string;
    groupId: string;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO company_project_workspace_groups
      (project_id, company_id, group_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id) DO UPDATE SET group_id = excluded.group_id`,
  ).run(input.projectId, input.companyId, input.groupId, input.createdAt);
}

export function getProjectWorkspaceGroupId(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  projectId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT group_id AS groupId FROM company_project_workspace_groups
      WHERE project_id = ?`,
    )
    .get(projectId) as { groupId: string } | undefined;
  return row?.groupId;
}

export function pickProjectWriteGrant<T extends { workspaceId: string; mode: string; isDefault?: boolean }>(
  grants: T[],
  groupWorkspaceIds: string[],
): T | undefined {
  const allowed = new Set(groupWorkspaceIds);
  const inGroup = grants.filter((grant) =>
    grant.mode === "write" && allowed.has(grant.workspaceId),
  );
  return inGroup.find((grant) => grant.isDefault) || inGroup[0];
}
