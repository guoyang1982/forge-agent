import {
  DEFAULT_PERMISSIONS,
  type PermissionLevel,
  type PermissionsConfig,
  type SoftwarePermissions,
} from "@forge/protocol";

export type SoftwareAction = "list" | "install" | "uninstall";

export type SoftwareGuardResult =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: "confirm"; summary: string; detail: Record<string, unknown> };

export function resolveSoftwarePermissions(
  permissions?: PermissionsConfig,
): SoftwarePermissions {
  return permissions?.software ?? DEFAULT_PERMISSIONS.software;
}

export function checkSoftwarePermission(
  permissions: SoftwarePermissions | undefined,
  action: SoftwareAction,
  detail: {
    manager: string;
    package?: string;
    command?: string;
  },
): SoftwareGuardResult {
  const software = permissions ?? DEFAULT_PERMISSIONS.software;
  if (!software.enabled) {
    return { ok: false, reason: "Software management is disabled in permissions.software" };
  }

  if (!software.managers.includes(detail.manager)) {
    return {
      ok: false,
      reason: `Package manager "${detail.manager}" is not allowed. Allowed: ${software.managers.join(", ")}`,
    };
  }

  if (action === "list") {
    return { ok: true };
  }

  const level: PermissionLevel =
    action === "install" ? software.install : software.uninstall;
  if (level === "deny") {
    return { ok: false, reason: `Software ${action} is denied` };
  }

  if (level === "confirm") {
    const pkg = detail.package ?? "?";
    const command = detail.command ?? `${detail.manager} ${action} ${pkg}`;
    return {
      ok: "confirm",
      summary: `${action === "install" ? "Install" : "Uninstall"} ${pkg} via ${detail.manager}: ${command}`,
      detail: { action, ...detail },
    };
  }

  return { ok: true };
}
