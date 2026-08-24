import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function hasStableForgeSignature(forgeApp) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["-dv", "--verbose=2", forgeApp],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return result.status === 0 && output.includes("Identifier=dev.forge.desktop");
}

/**
 * Use a stable, ad-hoc-signed Forge.app development host on macOS. Launching
 * the versioned Electron binary directly makes Accessibility authorization
 * follow the terminal (or the agent that started it), and Electron upgrades
 * can silently invalidate that grant. LaunchServices gives this stable bundle
 * its own TCC identity. Set FORGE_DESKTOP_BUNDLE_NAME=0 only for diagnostics.
 */
async function ensureForgeApp(electronExecutable) {
  const electronApp = resolve(electronExecutable, "..", "..", "..");
  const cacheDir = join(appRoot, ".forge-electron");
  const forgeApp = join(cacheDir, "Forge.app");
  const plistPath = join(forgeApp, "Contents", "Info.plist");
  const versionPath = join(cacheDir, "electron-version");
  const electronVersion = require("electron/package.json").version;
  const cachedVersion = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim()
    : "";

  // Preserve the exact code requirement that macOS Accessibility authorized.
  // Rewriting Info.plist or re-signing an unchanged app can leave TCC pointing
  // at the previous signature even though the bundle id still looks identical.
  if (existsSync(plistPath) && hasStableForgeSignature(forgeApp)) {
    // Adopt caches created before the version marker was introduced. A later
    // Electron package upgrade will change this marker and rebuild the host.
    if (!cachedVersion) writeFileSync(versionPath, `${electronVersion}\n`);
    if (!cachedVersion || cachedVersion === electronVersion) return forgeApp;
  }

  if (existsSync(forgeApp)) {
    rmSync(forgeApp, { recursive: true, force: true });
  }
  mkdirSync(cacheDir, { recursive: true });
  await exec("/bin/cp", ["-R", electronApp, forgeApp]);

  if (!existsSync(plistPath)) {
    throw new Error(`Copied Forge app is missing Info.plist: ${plistPath}`);
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

  // Bind the edited Info.plist and stable bundle id to the copied app. Without
  // re-signing, TCC still identifies the executable as the generic "Electron".
  await exec("/usr/bin/xattr", ["-cr", forgeApp]);
  await exec("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", forgeApp]);
  writeFileSync(versionPath, `${electronVersion}\n`);

  return forgeApp;
}

const electronExecutable = ensureElectronExecutable();
const wantNamedBundle =
  process.platform === "darwin" && process.env.FORGE_DESKTOP_BUNDLE_NAME !== "0";

if (!wantNamedBundle) {
  if (process.argv.includes("--prepare-only")) {
    console.log(electronExecutable);
  } else {
    run(electronExecutable, [appRoot, ...process.argv.slice(2)]);
  }
} else {
  ensureForgeApp(electronExecutable)
    .then((forgeApp) => {
      if (process.argv.includes("--prepare-only")) {
        console.log(join(forgeApp, "Contents", "MacOS", "Electron"));
        return;
      }
      run("/usr/bin/open", ["-W", "-n", forgeApp, "--args", appRoot, ...process.argv.slice(2)]);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
