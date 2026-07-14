import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultPackageManagers } from "@forge/platform";

const execFileAsync = promisify(execFile);

export interface ManagerCommand {
  manager: string;
  argv: string[];
  summary: string;
}

export function pickManager(
  requested: string | undefined,
  allowed: string[],
): string | null {
  const candidates = allowed.length > 0 ? allowed : defaultPackageManagers();
  if (requested?.trim()) {
    const normalized = requested.trim().toLowerCase();
    return candidates.includes(normalized) ? normalized : null;
  }
  return candidates[0] ?? null;
}

export function buildListCommand(
  manager: string,
  mode: "installed" | "outdated" | "info",
  packageName?: string,
): ManagerCommand {
  switch (manager) {
    case "brew":
      if (mode === "info") {
        if (!packageName) throw new Error("package is required for info mode");
        return {
          manager,
          argv: ["info", packageName],
          summary: `brew info ${packageName}`,
        };
      }
      if (mode === "outdated") {
        return { manager, argv: ["outdated", "--formula"], summary: "brew outdated --formula" };
      }
      return { manager, argv: ["list", "--formula"], summary: "brew list --formula" };
    case "winget":
      if (mode === "info") {
        if (!packageName) throw new Error("package is required for info mode");
        return {
          manager,
          argv: ["show", packageName],
          summary: `winget show ${packageName}`,
        };
      }
      if (mode === "outdated") {
        return { manager, argv: ["upgrade", "--include-unknown"], summary: "winget upgrade --include-unknown" };
      }
      return { manager, argv: ["list"], summary: "winget list" };
    case "choco":
      if (mode === "info") {
        if (!packageName) throw new Error("package is required for info mode");
        return {
          manager,
          argv: ["info", packageName],
          summary: `choco info ${packageName}`,
        };
      }
      if (mode === "outdated") {
        return { manager, argv: ["outdated"], summary: "choco outdated" };
      }
      return { manager, argv: ["list", "--local-only"], summary: "choco list --local-only" };
    default:
      throw new Error(`Unsupported package manager: ${manager}`);
  }
}

export function buildInstallCommand(manager: string, packageName: string): ManagerCommand {
  switch (manager) {
    case "brew":
      return {
        manager,
        argv: ["install", packageName],
        summary: `brew install ${packageName}`,
      };
    case "winget":
      return {
        manager,
        argv: ["install", "--id", packageName, "-e", "--accept-package-agreements", "--accept-source-agreements"],
        summary: `winget install --id ${packageName} -e`,
      };
    case "choco":
      return {
        manager,
        argv: ["install", packageName, "-y"],
        summary: `choco install ${packageName} -y`,
      };
    default:
      throw new Error(`Unsupported package manager: ${manager}`);
  }
}

export function buildUninstallCommand(manager: string, packageName: string): ManagerCommand {
  switch (manager) {
    case "brew":
      return {
        manager,
        argv: ["uninstall", packageName],
        summary: `brew uninstall ${packageName}`,
      };
    case "winget":
      return {
        manager,
        argv: ["uninstall", "--id", packageName, "-e"],
        summary: `winget uninstall --id ${packageName} -e`,
      };
    case "choco":
      return {
        manager,
        argv: ["uninstall", packageName, "-y"],
        summary: `choco uninstall ${packageName} -y`,
      };
    default:
      throw new Error(`Unsupported package manager: ${manager}`);
  }
}

export async function runManagerCommand(
  command: ManagerCommand,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  const binary = command.manager;
  try {
    const { stdout, stderr } = await execFileAsync(binary, command.argv, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
    };
    if (err.code === "ENOENT") {
      return {
        ok: false,
        stdout: "",
        stderr: `${binary} is not installed or not on PATH`,
        exitCode: null,
      };
    }
    return {
      ok: false,
      stdout: String(err.stdout ?? "").trim(),
      stderr: String(err.stderr ?? err.message ?? "").trim(),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}
