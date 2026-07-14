import { spawn, type ChildProcess } from "node:child_process";

export type SpawnDetached = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore"; windowsVerbatimArguments?: boolean },
) => Pick<ChildProcess, "unref">;

export interface OpenPathCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** Platform-specific argv for opening a path with the default application. */
export function resolveOpenPathCommand(targetPath: string): OpenPathCommand {
  switch (process.platform) {
    case "win32":
      return {
        command: "cmd",
        args: ["/c", "start", "", targetPath],
        windowsVerbatimArguments: true,
      };
    case "darwin":
      return { command: "open", args: [targetPath] };
    default:
      return { command: "xdg-open", args: [targetPath] };
  }
}

/** Open `targetPath` with the OS default handler (no shell interpolation). */
export function openPathWithDefaultApp(
  targetPath: string,
  spawnImpl: SpawnDetached = spawn,
): void {
  const { command, args, windowsVerbatimArguments } =
    resolveOpenPathCommand(targetPath);
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  child.unref();
}
