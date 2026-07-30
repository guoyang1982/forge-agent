import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const appRoot = resolve(__dirname, "..");

function resolveElectronExecutable() {
  // Fresh require each time — install.js may rewrite path.txt.
  return createRequire(import.meta.url)("electron");
}

function electronPackageDir() {
  return dirname(require.resolve("electron/package.json"));
}

function reinstallElectron() {
  const installJs = join(electronPackageDir(), "install.js");
  console.log("==> Electron binary missing; re-downloading…");
  const result = spawnSync(process.execPath, [installJs], {
    cwd: electronPackageDir(),
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`electron install.js failed with exit ${result.status ?? "unknown"}`);
  }
  // Reduce chance of immediate Gatekeeper quarantine deletes on first launch.
  const appBundle = join(electronPackageDir(), "dist", "Electron.app");
  if (process.platform === "darwin" && existsSync(appBundle)) {
    spawnSync("xattr", ["-cr", appBundle], { stdio: "ignore" });
  }
}

function ensureElectronExecutable() {
  let executable = resolveElectronExecutable();
  if (!existsSync(executable)) {
    reinstallElectron();
    executable = resolveElectronExecutable();
  }
  if (!existsSync(executable)) {
    throw new Error(
      [
        "Electron binary still missing after reinstall.",
        `Expected: ${executable}`,
        "Try: cd apps/desktop && node \"$(node -p \\\"require('path').dirname(require.resolve('electron/package.json'))\\\")/install.js\"",
      ].join("\n"),
    );
  }
  return executable;
}

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

/**
 * Optional: rename Electron.app → Forge.app for nicer menu bar.
 * Disabled by default on macOS because Gatekeeper/XProtect often flags the
 * copied ad-hoc-signed bundle as malware and deletes Electron.app from dist/.
 * Set FORGE_DESKTOP_BUNDLE_NAME=1 to opt back in.
 */
async function ensureForgeApp(electronExecutable) {
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

const electronExecutable = ensureElectronExecutable();
const wantNamedBundle =
  process.platform === "darwin" && process.env.FORGE_DESKTOP_BUNDLE_NAME === "1";

if (!wantNamedBundle) {
  if (process.argv.includes("--prepare-only")) {
    console.log(electronExecutable);
  } else {
    run(electronExecutable, [appRoot, ...process.argv.slice(2)]);
  }
} else {
  ensureForgeApp(electronExecutable)
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
