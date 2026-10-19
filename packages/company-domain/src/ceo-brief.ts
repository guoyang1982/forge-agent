import type { CompanyDashboard } from "./dashboard.js";

export type CeoBrief = {
  summary: string;
  priorities: string[];
};

export function buildCeoBrief(input: {
  companyName: string;
  dashboard: CompanyDashboard;
  employees?: Array<{ id: string; displayName: string }>;
}): CeoBrief {
  const names = new Map(
    (input.employees || []).map((employee) => [employee.id, employee.displayName]),
  );
  const priorities: string[] = [];
  for (const item of input.dashboard.decisions) {
    if (item.state === "waiting_approval") {
      priorities.push(`验收「${item.title}」`);
    } else if (item.state === "blocked") {
      priorities.push(`接管阻塞「${item.title}」`);
    }
    if (priorities.length >= 3) break;
  }
  if (priorities.length >= 3) {
    return {
      summary: `${input.companyName}：${input.dashboard.inProgressWorkItems} 条进行中，${input.dashboard.pendingApprovals} 条待验收，${input.dashboard.blockedWorkItems} 条阻塞。`,
      priorities: priorities.slice(0, 3),
    };
  }
  if (priorities.length < 3 && input.dashboard.goals === 0) {
    priorities.push("先立一个本周目标，再往下挂项目和需求");
  }
  if (priorities.length < 3 && input.dashboard.budget?.availableMinor === 0) {
    priorities.push("预算已耗尽，先加额度再派活");
  }
  if (priorities.length < 3) {
    const busy = [...input.dashboard.load].sort((left, right) =>
      right.openWorkItems - left.openWorkItems,
    )[0];
    if (busy) {
      priorities.push(
        `${names.get(busy.employeeId) || "执行人"} 手头有 ${busy.openWorkItems} 条未完成`,
      );
    }
  }
  if (priorities.length === 0) {
    priorities.push("没有待决策，可以登记下一条需求");
  }
  return {
    summary: `${input.companyName}：${input.dashboard.inProgressWorkItems} 条进行中，${input.dashboard.pendingApprovals} 条待验收，${input.dashboard.blockedWorkItems} 条阻塞。`,
    priorities: priorities.slice(0, 3),
  };
}
