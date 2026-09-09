export const COMPANY_INVOKE_METHODS = new Set<string>();

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
    openWorkbench(url?: string) {
      return ipc.invoke("company:open-workbench", url);
    },
    getAppInfo() {
      return ipc.invoke("company:get-app-info");
    },
  };
}
