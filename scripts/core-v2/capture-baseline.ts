import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "dist",
  "node_modules",
  "release",
]);

export interface BaselineFileRecord {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface CoreV2BaselineReport {
  formatVersion: 1;
  capturedAt: string;
  repository: {
    root: string;
    commit: string;
    branch: string;
    dirty: boolean;
  };
  runtime: {
    node: string;
    pnpm: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  workspace: {
    packageNames: string[];
    rootScripts: string[];
  };
  schemas: {
    migrations: BaselineFileRecord[];
  };
}

export interface CaptureCoreV2BaselineInput {
  repositoryRoot: string;
  outputPath: string;
}

function assertExplicitAbsolutePath(input: string, label: string): string {
  if (!input || !isAbsolute(input)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalized = resolve(input);
  if (normalized === parse(normalized).root || normalized === resolve(homedir())) {
    throw new Error(`unsafe ${label}: ${normalized}`);
  }
  return normalized;
}

function toPortableRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function gitOutput(repositoryRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repositoryRoot });
  return stdout.trim();
}

async function collectPackageJsonPaths(
  root: string,
  currentDir = root,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        paths.push(...(await collectPackageJsonPaths(root, absolutePath)));
      }
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      paths.push(absolutePath);
    }
  }
  return paths;
}

async function readWorkspaceSummary(repositoryRoot: string): Promise<{
  packageNames: string[];
  rootScripts: string[];
}> {
  const packageJsonPaths = await collectPackageJsonPaths(repositoryRoot);
  const packageNames: string[] = [];
  let rootScripts: string[] = [];

  for (const packageJsonPath of packageJsonPaths) {
    const value = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      name?: unknown;
      scripts?: unknown;
    };
    if (typeof value.name === "string" && value.name.length > 0) {
      packageNames.push(value.name);
    }
    if (packageJsonPath === join(repositoryRoot, "package.json")) {
      if (value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts)) {
        rootScripts = Object.keys(value.scripts).sort();
      }
    }
  }

  packageNames.sort();
  return { packageNames, rootScripts };
}

async function readMigrationSummary(repositoryRoot: string): Promise<BaselineFileRecord[]> {
  const migrationsDir = join(repositoryRoot, "migrations");
  try {
    const migrationInfo = await lstat(migrationsDir);
    if (!migrationInfo.isDirectory() || migrationInfo.isSymbolicLink()) {
      throw new Error("migrations path must be a real directory");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries = await readdir(migrationsDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const migrations: BaselineFileRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const path = join(migrationsDir, entry.name);
    const contents = await readFile(path);
    migrations.push({
      relativePath: toPortableRelativePath(repositoryRoot, path),
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return migrations;
}

async function assertOutputDoesNotExist(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`baseline output already exists: ${outputPath}`);
}

export async function captureCoreV2Baseline(
  input: CaptureCoreV2BaselineInput,
): Promise<CoreV2BaselineReport> {
  const requestedRepositoryRoot = assertExplicitAbsolutePath(
    input.repositoryRoot,
    "repository root",
  );
  const outputPath = assertExplicitAbsolutePath(input.outputPath, "baseline output path");
  const repositoryInfo = await lstat(requestedRepositoryRoot);
  if (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink()) {
    throw new Error("repository root must be a real directory");
  }

  const repositoryRoot = await realpath(requestedRepositoryRoot);
  const [commit, branchOutput, statusOutput, pnpmOutput, workspace, migrations] =
    await Promise.all([
      gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
      gitOutput(repositoryRoot, ["branch", "--show-current"]),
      gitOutput(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]),
      execFileAsync("pnpm", ["--version"], { cwd: repositoryRoot }).then(({ stdout }) =>
        stdout.trim(),
      ),
      readWorkspaceSummary(repositoryRoot),
      readMigrationSummary(repositoryRoot),
    ]);

  const report: CoreV2BaselineReport = {
    formatVersion: 1,
    capturedAt: new Date().toISOString(),
    repository: {
      root: repositoryRoot,
      commit,
      branch: branchOutput || "(detached)",
      dirty: statusOutput.length > 0,
    },
    runtime: {
      node: process.version,
      pnpm: pnpmOutput,
      platform: process.platform,
      arch: process.arch,
    },
    workspace,
    schemas: { migrations },
  };

  await assertOutputDoesNotExist(outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(dirname(outputPath), `.core-v2-baseline-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporaryPath, outputPath);
  return report;
}

function readRequiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`missing required option ${name}`);
  }
  return value;
}

export async function runBaselineCli(args: string[]): Promise<void> {
  const report = await captureCoreV2Baseline({
    repositoryRoot: readRequiredOption(args, "--repository-root"),
    outputPath: readRequiredOption(args, "--output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  runBaselineCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Core v2 baseline capture failed: ${message}\n`);
    process.exitCode = 1;
  });
}
