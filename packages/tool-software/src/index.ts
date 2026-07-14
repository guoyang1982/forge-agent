import type { PermissionsConfig, ToolDefinition } from "@forge/protocol";
import type { ToolRegistry } from "@forge/tools";
import { ensureSoftwareAllowed } from "./confirm-flow.js";
import {
  buildInstallCommand,
  buildListCommand,
  buildUninstallCommand,
  pickManager,
  runManagerCommand,
} from "./managers.js";
import {
  checkSoftwarePermission,
  resolveSoftwarePermissions,
} from "./software-guard.js";

export {
  checkSoftwarePermission,
  resolveSoftwarePermissions,
  type SoftwareAction,
  type SoftwareGuardResult,
} from "./software-guard.js";
export {
  buildInstallCommand,
  buildListCommand,
  buildUninstallCommand,
  pickManager,
  runManagerCommand,
} from "./managers.js";

export interface RegisterSoftwareToolsOptions {
  permissions?: PermissionsConfig;
}

export function registerSoftwareTools(
  registry: ToolRegistry,
  options: RegisterSoftwareToolsOptions = {},
): number {
  const software = resolveSoftwarePermissions(options.permissions);
  if (!software.enabled) return 0;

  let count = 0;

  const listDef: ToolDefinition = {
    name: "software_list",
    description:
      "List installed packages, outdated packages, or show info for one package via an approved package manager (brew/winget/choco).",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["installed", "outdated", "info"],
          description: "installed (default), outdated, or info for one package",
        },
        package: { type: "string", description: "Package name or id (required for mode=info)" },
        manager: {
          type: "string",
          description: "Package manager to use (defaults to first allowed manager)",
        },
      },
    },
  };

  registry.register(listDef, async (args, ctx) => {
    const perms = ctx.permissions ?? options.permissions;
    const sw = resolveSoftwarePermissions(perms);
    const manager = pickManager(
      typeof args.manager === "string" ? args.manager : undefined,
      sw.managers,
    );
    if (!manager) {
      return JSON.stringify({
        ok: false,
        error: "No allowed package manager available for software_list",
      });
    }

    const mode =
      args.mode === "outdated" || args.mode === "info" ? args.mode : "installed";
    const packageName =
      typeof args.package === "string" ? args.package.trim() : undefined;

    const guard = checkSoftwarePermission(sw, "list", { manager, package: packageName });
    if (guard.ok === false) {
      return JSON.stringify({ ok: false, error: guard.reason });
    }

    try {
      const command = buildListCommand(manager, mode, packageName);
      const result = await runManagerCommand(command, ctx.signal);
      return JSON.stringify({
        ok: result.ok,
        manager,
        mode,
        command: command.summary,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  count++;

  const installDef: ToolDefinition = {
    name: "software_install",
    description:
      "Install a package via an approved package manager. Shows the exact command and requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name or winget id" },
        manager: { type: "string", description: "Package manager (brew/winget/choco)" },
      },
      required: ["package"],
    },
  };

  registry.register(installDef, async (args, ctx) => {
    const packageName = String(args.package ?? "").trim();
    if (!packageName) {
      return JSON.stringify({ ok: false, error: "package is required" });
    }

    const perms = ctx.permissions ?? options.permissions;
    const sw = resolveSoftwarePermissions(perms);
    const manager = pickManager(
      typeof args.manager === "string" ? args.manager : undefined,
      sw.managers,
    );
    if (!manager) {
      return JSON.stringify({
        ok: false,
        error: "No allowed package manager available for software_install",
      });
    }

    const command = buildInstallCommand(manager, packageName);
    const guard = checkSoftwarePermission(sw, "install", {
      manager,
      package: packageName,
      command: command.summary,
    });
    const allowed = await ensureSoftwareAllowed(ctx, guard);
    if (!allowed.ok) {
      return JSON.stringify(allowed.payload);
    }

    const result = await runManagerCommand(command, ctx.signal);
    return JSON.stringify({
      ok: result.ok,
      manager,
      package: packageName,
      command: command.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  });
  count++;

  const uninstallDef: ToolDefinition = {
    name: "software_uninstall",
    description:
      "Uninstall a package via an approved package manager. Shows the exact command and requires user confirmation.",
    parameters: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name or winget id" },
        manager: { type: "string", description: "Package manager (brew/winget/choco)" },
      },
      required: ["package"],
    },
  };

  registry.register(uninstallDef, async (args, ctx) => {
    const packageName = String(args.package ?? "").trim();
    if (!packageName) {
      return JSON.stringify({ ok: false, error: "package is required" });
    }

    const perms = ctx.permissions ?? options.permissions;
    const sw = resolveSoftwarePermissions(perms);
    const manager = pickManager(
      typeof args.manager === "string" ? args.manager : undefined,
      sw.managers,
    );
    if (!manager) {
      return JSON.stringify({
        ok: false,
        error: "No allowed package manager available for software_uninstall",
      });
    }

    const command = buildUninstallCommand(manager, packageName);
    const guard = checkSoftwarePermission(sw, "uninstall", {
      manager,
      package: packageName,
      command: command.summary,
    });
    const allowed = await ensureSoftwareAllowed(ctx, guard);
    if (!allowed.ok) {
      return JSON.stringify(allowed.payload);
    }

    const result = await runManagerCommand(command, ctx.signal);
    return JSON.stringify({
      ok: result.ok,
      manager,
      package: packageName,
      command: command.summary,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  });
  count++;

  return count;
}
