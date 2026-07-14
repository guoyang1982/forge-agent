/** Default OS package managers for software install/uninstall tools. */
export function defaultPackageManagers(): string[] {
  switch (process.platform) {
    case "win32":
      return ["winget", "choco"];
    case "darwin":
      return ["brew"];
    default:
      return ["apt", "dnf", "pacman"];
  }
}

/** Human-readable package manager names for prompts and UI copy. */
export function formatPackageManagerHint(): string {
  const managers = defaultPackageManagers();
  if (managers.includes("brew")) return "Homebrew (brew)";
  if (managers.includes("winget")) return "winget or Chocolatey (choco)";
  return managers.join(" or ");
}

/** Platform-specific install hint when ripgrep (`rg`) is missing. */
export function ripgrepInstallHint(): string {
  switch (process.platform) {
    case "win32":
      return "winget install BurntSushi.ripgrep.MSVC  (or: choco install ripgrep)";
    case "darwin":
      return "brew install ripgrep";
    default:
      return "install ripgrep (rg) via your system package manager";
  }
}
