import type {
  BrowserBackendCapabilities,
  BrowserBackendId,
  BrowserBackendSummary,
  BrowserElementActionInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserTypeInput,
} from "@forge/protocol";

export * from "./host.js";

export interface BrowserBackend {
  readonly id: BrowserBackendId;
  readonly label: string;
  readonly capabilities: BrowserBackendCapabilities;
  isConnected(): boolean;
  listTabs(): Promise<BrowserTab[]>;
  open(input: BrowserOpenInput): Promise<BrowserTab>;
  navigate(input: BrowserNavigateInput): Promise<BrowserTab>;
  snapshot(tabId: string): Promise<BrowserSnapshot>;
  click(input: BrowserElementActionInput): Promise<void>;
  type(input: BrowserTypeInput): Promise<void>;
  screenshot(tabId: string): Promise<BrowserScreenshot>;
  close(tabId: string): Promise<void>;
  dispose?(): Promise<void> | void;
}

export class BrowserService {
  private readonly backends = new Map<BrowserBackendId, BrowserBackend>();
  private defaultBackendId: BrowserBackendId | null = null;

  registerBackend(backend: BrowserBackend, options: { makeDefault?: boolean } = {}): () => void {
    const existing = this.backends.get(backend.id);
    if (existing && existing !== backend) throw new Error(`Browser backend already registered: ${backend.id}`);
    this.backends.set(backend.id, backend);
    if (options.makeDefault || this.defaultBackendId === null) this.defaultBackendId = backend.id;
    return () => {
      if (this.backends.get(backend.id) !== backend) return;
      this.backends.delete(backend.id);
      if (this.defaultBackendId === backend.id) this.defaultBackendId = this.backends.keys().next().value ?? null;
    };
  }

  listBackends(): BrowserBackendSummary[] {
    return [...this.backends.values()].map((backend) => ({
      id: backend.id,
      label: backend.label,
      connected: backend.isConnected(),
      capabilities: backend.capabilities,
    }));
  }

  async listTabs(backendId?: BrowserBackendId): Promise<BrowserTab[]> {
    if (backendId) return this.backend(backendId).listTabs();
    return (await Promise.all([...this.backends.values()].filter((backend) => backend.isConnected()).map((backend) => backend.listTabs()))).flat();
  }

  open(input: BrowserOpenInput): Promise<BrowserTab> { return this.backend(input.backendId).open(input); }
  navigate(input: BrowserNavigateInput): Promise<BrowserTab> { return this.backend(input.backendId).navigate(input); }
  snapshot(tabId: string, backendId?: BrowserBackendId): Promise<BrowserSnapshot> { return this.backend(backendId).snapshot(tabId); }
  click(input: BrowserElementActionInput): Promise<void> { return this.backend(input.backendId).click(input); }
  type(input: BrowserTypeInput): Promise<void> { return this.backend(input.backendId).type(input); }
  screenshot(tabId: string, backendId?: BrowserBackendId): Promise<BrowserScreenshot> { return this.backend(backendId).screenshot(tabId); }
  close(tabId: string, backendId?: BrowserBackendId): Promise<void> { return this.backend(backendId).close(tabId); }

  async dispose(): Promise<void> {
    const backends = [...this.backends.values()];
    this.backends.clear();
    this.defaultBackendId = null;
    await Promise.all(backends.map(async (backend) => backend.dispose?.()));
  }

  private backend(requested?: BrowserBackendId): BrowserBackend {
    const id = requested ?? this.defaultBackendId;
    if (!id) throw new Error("No Browser backend is registered");
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`Browser backend not found: ${id}`);
    if (!backend.isConnected()) throw new Error(`Browser backend is disconnected: ${id}`);
    return backend;
  }
}
