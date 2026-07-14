import {
  DEFAULT_PERMISSIONS,
  type NetworkPermissions,
  type PermissionLevel,
  type PermissionsConfig,
} from "@forge/protocol";
import {
  hostMatchesAllowlist,
  validateHttpUrl,
} from "./host-policy.js";

export type NetworkAction = "search" | "web" | "api" | "download";

export type NetworkGuardResult =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: "confirm"; summary: string; detail: Record<string, unknown> };

const ACTION_FIELD: Record<NetworkAction, keyof NetworkPermissions> = {
  search: "search",
  web: "web",
  api: "api",
  download: "download",
};

export function resolveNetworkPermissions(
  permissions?: PermissionsConfig,
): NetworkPermissions {
  return permissions?.network ?? DEFAULT_PERMISSIONS.network;
}

export function checkNetworkPermission(
  permissions: NetworkPermissions | undefined,
  action: NetworkAction,
  detail: { url?: string; method?: string; query?: string; path?: string },
): NetworkGuardResult {
  const net = permissions ?? DEFAULT_PERMISSIONS.network;
  if (!net.enabled) {
    return { ok: false, reason: "Network access is disabled in permissions.network" };
  }

  const level = net[ACTION_FIELD[action]] as PermissionLevel;
  if (level === "deny") {
    return { ok: false, reason: `Network action "${action}" is denied` };
  }

  if (detail.url) {
    const urlCheck = validateHttpUrl(detail.url);
    if (!urlCheck.ok) {
      return { ok: false, reason: urlCheck.reason };
    }
    if (!hostMatchesAllowlist(urlCheck.hostname, net.allowedHosts)) {
      return {
        ok: false,
        reason: `Host not in permissions.network.allowedHosts: ${urlCheck.hostname}`,
      };
    }
  }

  if (level === "confirm") {
    const summary =
      action === "search"
        ? `Web search: ${detail.query ?? ""}`
        : action === "web"
          ? `Fetch URL: ${detail.url ?? ""}`
          : action === "api"
            ? (() => {
                const m = (detail.method ?? "GET").toUpperCase();
                const base = `${m} ${detail.url ?? ""}`;
                return m === "GET" ? base : `${base} (mutating request)`;
              })()
            : `Download to ${detail.path ?? "?"}: ${detail.url ?? ""}`;
    return {
      ok: "confirm",
      summary,
      detail: { action, ...detail } as Record<string, unknown> & { action: NetworkAction },
    };
  }

  return { ok: true };
}
