import { spawn } from "node:child_process";
import { validateShellCommand } from "./shell-safe.js";

export function runSafeShell(
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  const check = validateShellCommand(command);
  if (!check.ok) {
    return Promise.resolve(JSON.stringify({ ok: false, error: check.error }));
  }

  return new Promise((resolve, reject) => {
    const { file, args } = check.cmd;
    const proc = spawn(file, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      proc.kill();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(
        JSON.stringify({
          ok: false,
          error: "timeout",
          stdout: stdout.slice(-6000),
          stderr: stderr.slice(-6000),
        }),
      );
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const out = (stdout + stderr).slice(0, 12_000);
      resolve(
        JSON.stringify({
          ok: code === 0,
          exitCode: code,
          output: out,
        }),
      );
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(JSON.stringify({ ok: false, error: String(e) }));
    });
  });
}
