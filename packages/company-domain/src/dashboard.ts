export type DashboardWorkItem = {
  id: string;
  title: string;
  state: string;
  goalId?: string | null;
  projectId?: string | null;
  assigneeId?: string | null;
};

export type CompanyDashboard = {
  companyId: string;
  employees: number;
  goals: number;
  projects: number;
  workItems: number;
  inProgressWorkItems: number;
  blockedWorkItems: number;
  pendingApprovals: number;
  goalHealth: Array<{ id: string; title: string; openWorkItems: number }>;
  decisions: Array<{ id: string; title: string; state: string }>;
  load: Array<{ employeeId: string; openWorkItems: number }>;
  budget?: {
    accountId: string;
    currency: string;
    availableMinor?: number;
    hardLimitMinor?: number;
  };
  pipelines: DashboardWorkItem[];
};

export function buildCompanyDashboard(input: {
  companyId: string;
  employees: number;
  goals: Array<{ id: string; title: string }>;
  projects: Array<{ id: string }>;
  workItems: DashboardWorkItem[];
  pendingApprovals: number;
  budget?: CompanyDashboard["budget"];
}): CompanyDashboard {
  const open = input.workItems.filter((item) =>
    !["accepted", "completed", "cancelled", "rejected"].includes(item.state),
  );
  const blocked = open.filter((item) => item.state === "blocked");
  const inProgress = open.filter((item) =>
    ["in_progress", "waiting_approval", "submitted", "verifying"].includes(item.state),
  );
  const decisions = input.workItems
    .filter((item) => item.state === "waiting_approval" || item.state === "blocked")
    .slice(0, 8);
  const byEmployee = new Map<string, number>();
  for (const item of open) {
    if (!item.assigneeId) continue;
    byEmployee.set(item.assigneeId, (byEmployee.get(item.assigneeId) || 0) + 1);
  }
  return {
    companyId: input.companyId,
    employees: input.employees,
    goals: input.goals.length,
    projects: input.projects.length,
    workItems: input.workItems.length,
    inProgressWorkItems: inProgress.length,
    blockedWorkItems: blocked.length,
    pendingApprovals: input.pendingApprovals,
    goalHealth: input.goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      openWorkItems: open.filter((item) => item.goalId === goal.id).length,
    })),
    decisions: decisions.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
    })),
    load: [...byEmployee.entries()].map(([employeeId, openWorkItems]) => ({
      employeeId,
      openWorkItems,
    })),
    ...(input.budget ? { budget: input.budget } : {}),
    pipelines: open,
  };
}
