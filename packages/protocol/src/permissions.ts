/** Permission policy levels for personal assistant capabilities. */
export type PermissionLevel = "allow" | "confirm" | "deny";

export interface FileSystemPermissions {
  allowedRoots: string[];
  read: PermissionLevel;
  write: PermissionLevel;
  delete: PermissionLevel;
}

export interface SoftwarePermissions {
  enabled: boolean;
  managers: string[];
  install: PermissionLevel;
  uninstall: PermissionLevel;
}

export type NetworkSearchMode = "cached" | "live";

export interface NetworkPermissions {
  enabled: boolean;
  search: PermissionLevel;
  web: PermissionLevel;
  api: PermissionLevel;
  download: PermissionLevel;
  allowedHosts: string[];
  /** Search mode when web_search is implemented. Default live. */
  searchMode?: NetworkSearchMode;
  /** Max response bytes for web_fetch / download. Default 2_000_000. */
  fetchMaxBytes?: number;
  /** Request timeout ms for network tools. Default 15_000. */
  fetchTimeoutMs?: number;
}

export interface MemoryPermissions {
  enabled: boolean;
  read: PermissionLevel;
  write: PermissionLevel;
  delete: PermissionLevel;
}

export interface AutomationPermissions {
  enabled: boolean;
  create: PermissionLevel;
  run: PermissionLevel;
  delete: PermissionLevel;
}

export interface ChannelsPermissions {
  enabled: boolean;
  create: PermissionLevel;
  start: PermissionLevel;
  delete: PermissionLevel;
}

export interface MobilePermissions {
  enabled: boolean;
  pair: PermissionLevel;
  run: PermissionLevel;
  approve: PermissionLevel;
  allowedProjects: string[];
  maxDevices: number;
  maxConcurrentRunsPerDevice: number;
}

export interface NotificationsPermissions {
  enabled: boolean;
  send: PermissionLevel;
}

export interface BrowserPermissions {
  enabled: boolean;
  open: PermissionLevel;
  interact: PermissionLevel;
  submit: PermissionLevel;
}

export interface AppsPermissions {
  enabled: boolean;
  open: PermissionLevel;
  control: PermissionLevel;
}

export interface SecretsPermissions {
  read: PermissionLevel;
}

export interface AuditPermissions {
  enabled: boolean;
}

export interface PermissionsConfig {
  fileSystem: FileSystemPermissions;
  software: SoftwarePermissions;
  network: NetworkPermissions;
  memory: MemoryPermissions;
  automation: AutomationPermissions;
  channels: ChannelsPermissions;
  mobile: MobilePermissions;
  notifications: NotificationsPermissions;
  browser: BrowserPermissions;
  apps: AppsPermissions;
  secrets: SecretsPermissions;
  audit: AuditPermissions;
}

export const DEFAULT_PERSONAL_ROOTS = [
  "~/Documents",
  "~/Downloads",
  "~/Desktop",
  "~/Pictures",
  "~/Movies",
  "~/Music",
] as const;

export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  fileSystem: {
    allowedRoots: [...DEFAULT_PERSONAL_ROOTS],
    read: "allow",
    write: "confirm",
    delete: "confirm",
  },
  software: {
    enabled: false,
    managers: ["brew"],
    install: "confirm",
    uninstall: "confirm",
  },
  network: {
    enabled: true,
    search: "allow",
    web: "allow",
    api: "confirm",
    download: "confirm",
    allowedHosts: [],
    searchMode: "live",
    fetchMaxBytes: 2_000_000,
    fetchTimeoutMs: 15_000,
  },
  memory: {
    enabled: true,
    read: "allow",
    write: "confirm",
    delete: "confirm",
  },
  automation: {
    enabled: false,
    create: "confirm",
    run: "confirm",
    delete: "confirm",
  },
  channels: {
    enabled: false,
    create: "confirm",
    start: "allow",
    delete: "confirm",
  },
  mobile: {
    enabled: false,
    pair: "confirm",
    run: "confirm",
    approve: "confirm",
    allowedProjects: [],
    maxDevices: 3,
    maxConcurrentRunsPerDevice: 1,
  },
  notifications: {
    enabled: false,
    send: "confirm",
  },
  browser: {
    enabled: true,
    open: "allow",
    interact: "confirm",
    submit: "confirm",
  },
  apps: {
    enabled: false,
    open: "confirm",
    control: "confirm",
  },
  secrets: {
    read: "deny",
  },
  audit: {
    enabled: true,
  },
};
