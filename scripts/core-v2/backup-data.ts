import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export interface BackupManifestFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  createdAt: string;
  sourceDir: string;
  backupDir: string;
  manifestPath: string;
  files: BackupManifestFile[];
}

export interface BackupForgeDataInput {
  dataDir: string;
  outputDir: string;
}

const DATABASE_FILES = new Set(["data.db", "data.db-shm", "data.db-wal"]);

function assertExplicitSafeDirectory(input: string, label: string): string {
  if (!input || !isAbsolute(input)) {
    throw new Error(`${label} must be an absolute path`);
  }

  const normalized = resolve(input);
  if (normalized === parse(normalized).root || normalized === resolve(homedir())) {
    throw new Error(`unsafe ${label}: ${normalized}`);
  }
  return normalized;
}

function isWithin(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return (
    childFromParent !== "" &&
    childFromParent !== ".." &&
    !childFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(childFromParent)
  );
}

function assertDirectoriesDoNotOverlap(dataDir: string, outputDir: string): void {
  if (
    dataDir === outputDir ||
    isWithin(dataDir, outputDir) ||
    isWithin(outputDir, dataDir)
  ) {
    throw new Error("backup output must not overlap the data directory");
  }
}

function toManifestPath(path: string): string {
  return path.split(sep).join(posix.sep);
}

async function collectBackupFiles(
  dataDir: string,
  currentDir = dataDir,
): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(dataDir, absolutePath);

    if (entry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in Forge data: ${toManifestPath(relativePath)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectBackupFiles(dataDir, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;

    const isRootDatabaseFile = dirname(relativePath) === "." && DATABASE_FILES.has(entry.name);
    if (isRootDatabaseFile || entry.name.endsWith(".json")) {
      files.push(relativePath);
    }
  }
  return files;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectStream);
    stream.on("end", resolveStream);
  });
  return hash.digest("hex");
}

function parseManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") {
    throw new Error("invalid backup manifest");
  }

  const candidate = value as Partial<BackupManifest>;
  if (
    typeof candidate.createdAt !== "string" ||
    typeof candidate.sourceDir !== "string" ||
    typeof candidate.backupDir !== "string" ||
    typeof candidate.manifestPath !== "string" ||
    !Array.isArray(candidate.files)
  ) {
    throw new Error("invalid backup manifest");
  }

  const files = candidate.files.map((file): BackupManifestFile => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.relativePath !== "string" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("invalid backup manifest file entry");
    }
    return {
      relativePath: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  });

  return {
    createdAt: candidate.createdAt,
    sourceDir: candidate.sourceDir,
    backupDir: candidate.backupDir,
    manifestPath: candidate.manifestPath,
    files,
  };
}

function resolveManifestFile(backupDir: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    posix.isAbsolute(relativePath) ||
    posix.normalize(relativePath) !== relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`unsafe backup manifest path: ${relativePath}`);
  }

  const absolutePath = resolve(backupDir, ...relativePath.split("/"));
  if (!isWithin(backupDir, absolutePath)) {
    throw new Error(`unsafe backup manifest path: ${relativePath}`);
  }
  return absolutePath;
}

export async function backupForgeData(
  input: BackupForgeDataInput,
): Promise<BackupManifest> {
  const requestedDataDir = assertExplicitSafeDirectory(input.dataDir, "data directory");
  const requestedOutputDir = assertExplicitSafeDirectory(input.outputDir, "output directory");
  assertDirectoriesDoNotOverlap(requestedDataDir, requestedOutputDir);

  const dataInfo = await lstat(requestedDataDir);
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) {
    throw new Error("data directory must be a real directory");
  }

  await mkdir(requestedOutputDir, { recursive: true });
  const dataDir = await realpath(requestedDataDir);
  const outputDir = await realpath(requestedOutputDir);
  assertExplicitSafeDirectory(dataDir, "data directory");
  assertExplicitSafeDirectory(outputDir, "output directory");
  assertDirectoriesDoNotOverlap(dataDir, outputDir);

  const relativeFiles = await collectBackupFiles(dataDir);
  if (relativeFiles.length === 0) {
    throw new Error("no Forge database or JSON data files found");
  }

  const createdAt = new Date().toISOString();
  const backupId = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(outputDir, `forge-data-${backupId}`);
  const stagingDir = join(outputDir, `.incomplete-forge-data-${backupId}`);
  const manifestPath = join(backupDir, "manifest.json");
  let published = false;

  await mkdir(stagingDir);
  try {
    const files: BackupManifestFile[] = [];
    for (const sourceRelativePath of relativeFiles) {
      const relativePath = toManifestPath(sourceRelativePath);
      const sourcePath = join(dataDir, sourceRelativePath);
      const destinationPath = join(stagingDir, sourceRelativePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      const destinationInfo = await stat(destinationPath);
      files.push({
        relativePath,
        bytes: destinationInfo.size,
        sha256: await sha256File(destinationPath),
      });
    }

    const manifest: BackupManifest = {
      createdAt,
      sourceDir: dataDir,
      backupDir,
      manifestPath,
      files,
    };
    const stagingManifestPath = join(stagingDir, "manifest.json");
    const stagingManifestTemporaryPath = join(stagingDir, ".manifest.json.tmp");
    await writeFile(
      stagingManifestTemporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(stagingManifestTemporaryPath, stagingManifestPath);
    await rename(stagingDir, backupDir);
    published = true;
    return manifest;
  } finally {
    if (!published) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

export async function verifyBackup(manifestPathInput: string): Promise<void> {
  if (!isAbsolute(manifestPathInput)) {
    throw new Error("manifest path must be an absolute path");
  }

  const manifestPath = resolve(manifestPathInput);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const backupDir = dirname(manifestPath);
  if (resolve(manifest.backupDir) !== backupDir || resolve(manifest.manifestPath) !== manifestPath) {
    throw new Error("backup manifest location does not match its contents");
  }

  const seenPaths = new Set<string>();
  for (const file of manifest.files) {
    if (seenPaths.has(file.relativePath)) {
      throw new Error(`duplicate backup manifest path: ${file.relativePath}`);
    }
    seenPaths.add(file.relativePath);

    const absolutePath = resolveManifestFile(backupDir, file.relativePath);
    const fileInfo = await lstat(absolutePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(`backup entry is not a regular file: ${file.relativePath}`);
    }
    if (fileInfo.size !== file.bytes) {
      throw new Error(`size mismatch for ${file.relativePath}`);
    }
    if ((await sha256File(absolutePath)) !== file.sha256) {
      throw new Error(`checksum mismatch for ${file.relativePath}`);
    }
  }
}

function readRequiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`missing required option ${name}`);
  }
  return value;
}

export async function runBackupCli(args: string[]): Promise<void> {
  const manifest = await backupForgeData({
    dataDir: readRequiredOption(args, "--data-dir"),
    outputDir: readRequiredOption(args, "--output-dir"),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  runBackupCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Core v2 backup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
