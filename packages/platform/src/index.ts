export { resolveDaemonIpcPath } from "./ipc-path.js";
export {
  killDaemonInDataDir,
  killProcessesOnIpcPath,
} from "./process-kill.js";
export {
  openPathWithDefaultApp,
  resolveOpenPathCommand,
  type OpenPathCommand,
  type SpawnDetached,
} from "./shell-open.js";
export {
  clampTerminalSize,
  resolveDefaultShell,
  resolvePipeShell,
  resolveSpawnCwd,
  type ResolvedShell,
} from "./shell.js";
export { defaultPackageManagers, formatPackageManagerHint, ripgrepInstallHint } from "./package-managers.js";
