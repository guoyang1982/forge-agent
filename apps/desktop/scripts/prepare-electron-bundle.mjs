import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const stagingRoot = join(repoRoot, ".electron-staging");
const legacyStagingRoot = join(appRoot, ".electron-staging");
const daemonStaging = join(stagingRoot, "daemon");
const appStaging = join(stagingRoot, "app");

function run(command, args, cwd = repoRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

async function main() {
  console.log("[prepare-electron-bundle] Building daemon + desktop dependency trees...");
  await run("pnpm", ["--filter", "@forge/daemon...", "run", "build"]);
  await run("pnpm", ["--filter", "@forge/desktop...", "run", "build"]);

  console.log("[prepare-electron-bundle] Deploying daemon + desktop to staging...");
  rmSync(stagingRoot, { recursive: true, force: true });
  // Older builds staged inside the desktop package. pnpm deploy would copy
  // that ignored build output recursively into the new package.
  rmSync(legacyStagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  await run("pnpm", ["--filter", "@forge/daemon", "deploy", "--prod", daemonStaging], appRoot);
  await run("pnpm", ["--filter", "@forge/desktop", "deploy", "--prod", appStaging], appRoot);
  // pnpm may recreate legacy bin links while running the desktop postinstall.
  // Remove those generated paths from both the source tree and deployment.
  rmSync(legacyStagingRoot, { recursive: true, force: true });
  rmSync(join(appStaging, ".electron-staging"), { recursive: true, force: true });
  rmSync(join(appStaging, "apps", "desktop", ".electron-staging"), {
    recursive: true,
    force: true,
  });

  console.log("[prepare-electron-bundle] Copying Forge runtime assets...");
  for (const asset of ["migrations", "plugins", "skills"]) {
    const source = join(repoRoot, asset);
    if (existsSync(source)) {
      cpSync(source, join(daemonStaging, asset), { recursive: true });
    }
  }

  if (!existsSync(join(daemonStaging, "dist", "main.js"))) {
    throw new Error(`Daemon entry missing: ${join(daemonStaging, "dist", "main.js")}`);
  }
  if (!existsSync(join(appStaging, "dist", "main.js"))) {
    throw new Error(`Desktop entry missing: ${join(appStaging, "dist", "main.js")}`);
  }

  const require = createRequire(join(appRoot, "package.json"));
  const electronVersion = require("electron/package.json").version;

  const ymlSource = readFileSync(join(appRoot, "electron-builder.yml"), "utf8");
  const ymlWithVersion = ymlSource.replace(
    /electronVersion:\s*["'][^"']+["']/,
    `electronVersion: "${electronVersion}"`,
  );
  writeFileSync(join(appStaging, "electron-builder.yml"), ymlWithVersion);

  console.log(
    `[prepare-electron-bundle] Rebuilding better-sqlite3 for Electron ${electronVersion}...`,
  );
  await run(
    "pnpm",
    [
      "exec",
      "electron-rebuild",
      "-f",
      "-w",
      "better-sqlite3",
      "-m",
      daemonStaging,
      "-v",
      electronVersion,
    ],
    appRoot,
  );

  console.log("[prepare-electron-bundle] Rebuilding node-pty for staged desktop...");
  try {
    await run(
      "pnpm",
      ["exec", "electron-rebuild", "-f", "-w", "node-pty", "-m", appStaging, "-v", electronVersion],
      appRoot,
    );
  } catch (error) {
    if (process.platform === "win32") {
      console.warn(
        "[prepare-electron-bundle] node-pty rebuild skipped on Windows (no MSVC); terminal uses piped fallback",
      );
    } else {
      throw error;
    }
  }

  console.log("[prepare-electron-bundle] Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
