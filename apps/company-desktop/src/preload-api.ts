export const COMPANY_INVOKE_METHODS = new Set<string>([
  "company.get",
  "company.workflows.capabilities",
  "company.workflows.start",
  "company.workflows.researchStatus",
  "company.dashboard.get",
  "company.create",
  "company.organization.tree",
  "company.organization.ensureCrew",
  "company.employees.list",
  "company.employees.hire",
  "company.employees.onboardOptions",
  "company.employees.onboard",
  "company.employees.bind",
  "company.employees.grantDefaultWorkspace",
  "company.goals.list",
  "company.goals.create",
  "company.projects.list",
  "company.projects.create",
  "company.workItems.list",
  "company.workItems.create",
  "company.workItems.get",
  "company.workOutputs.read",
  "company.workFiles.read",
  "company.workArtifacts.upsert",
  "company.workArtifacts.accept",
  "company.workArtifacts.draft",
  "company.workItems.dispatch",
  "company.workItems.requestRun",
  "company.workItems.pauseForFix",
  "company.workItems.previewApproval",
  "company.approvals.list",
  "company.approvals.decide",
  "company.ceo.brief",
  "company.projects.bindWorkspaces",
  "company.delivery.gates.snapshot",
  "company.delivery.gates.decide",
  "company.delivery.gates.latest",
]);

export type CompanyIpc = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
};

export function createCompanyPreloadApi(ipc: CompanyIpc) {
  return {
    invoke(method: string, params?: unknown) {
      if (!COMPANY_INVOKE_METHODS.has(method)) {
        return Promise.reject(new Error(`blocked method: ${method}`));
      }
      return ipc.invoke("company:invoke", method, params);
    },
    subscribe(handler: (event: unknown) => void) {
      const wrapped = (_evt: unknown, data: unknown) => handler(data);
      ipc.on("company:event", wrapped);
      return () => ipc.off("company:event", wrapped);
    },
    openWorkbench(url?: string, extras?: { workItemId?: string; sessionId?: string; cwd?: string }) {
      return ipc.invoke("company:open-workbench", url, extras);
    },
    getAppInfo() {
      return ipc.invoke("company:get-app-info");
    },
    onOpenWork(handler: (payload: { workItemId?: string; id?: string }) => void) {
      const wrapped = (_evt: unknown, data: unknown) => {
        handler((data && typeof data === "object" ? data : {}) as { workItemId?: string; id?: string });
      };
      ipc.on("company:open-work", wrapped);
      return () => ipc.off("company:open-work", wrapped);
    },
  };
}
