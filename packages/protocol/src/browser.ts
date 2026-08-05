export type BrowserBackendId = "iab" | "chrome" | string;

export interface BrowserBackendCapabilities {
  existingTabs: boolean;
  persistentSession: boolean;
  domSnapshot: boolean;
  screenshot: boolean;
  downloads: boolean;
}

export interface BrowserBackendSummary {
  id: BrowserBackendId;
  label: string;
  connected: boolean;
  capabilities: BrowserBackendCapabilities;
}

export interface BrowserTab {
  id: string;
  backendId: BrowserBackendId;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserElement {
  ref: string;
  role?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}

export interface BrowserSnapshot {
  tabId: string;
  backendId: BrowserBackendId;
  url: string;
  title: string;
  text?: string;
  elements: BrowserElement[];
}

export interface BrowserScreenshot {
  tabId: string;
  backendId: BrowserBackendId;
  mime: "image/png" | "image/jpeg";
  data: string;
  width?: number;
  height?: number;
}

export interface BrowserOpenInput {
  backendId?: BrowserBackendId;
  url?: string;
}

export interface BrowserNavigateInput {
  backendId?: BrowserBackendId;
  tabId: string;
  url: string;
}

export interface BrowserElementActionInput {
  backendId?: BrowserBackendId;
  tabId: string;
  ref: string;
}

export interface BrowserTypeInput extends BrowserElementActionInput {
  text: string;
  clear?: boolean;
}
