import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");
const electronExecutable = require("electron");

function run(command, args) {
  const child = spawn(command, args, {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function exec(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function ensureForgeApp() {
  const electronApp = resolve(electronExecutable, "..", "..", "..");
  const cacheDir = join(appRoot, ".forge-electron");
  const forgeApp = join(cacheDir, "Forge.app");
  const plistPath = join(forgeApp, "Contents", "Info.plist");

  if (!existsSync(plistPath)) {
    rmSync(forgeApp, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    await exec("/bin/cp", ["-R", electronApp, forgeApp]);
  }

  await exec("/usr/bin/plutil", ["-replace", "CFBundleName", "-string", "Forge", plistPath]);
  await exec("/usr/bin/plutil", ["-replace", "CFBundleDisplayName", "-string", "Forge", plistPath]);
  await exec("/usr/bin/plutil", [
    "-replace",
    "CFBundleIdentifier",
    "-string",
    "dev.forge.desktop",
    plistPath,
  ]);

  return join(forgeApp, "Contents", "MacOS", "Electron");
}

if (process.platform !== "darwin") {
  run(electronExecutable, [appRoot, ...process.argv.slice(2)]);
} else {
  ensureForgeApp()
    .then((forgeExecutable) => {
      if (process.argv.includes("--prepare-only")) {
        console.log(forgeExecutable);
        return;
      }
      run(forgeExecutable, [appRoot, ...process.argv.slice(2)]);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
