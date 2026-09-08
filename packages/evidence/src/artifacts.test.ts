import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  ArtifactAccessError,
  ArtifactDuplicateError,
  ArtifactIdError,
  ArtifactService,
} from "./artifacts.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ArtifactService", () => {
  it("rejects a symbolic-link artifact root without writing outside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-artifact-root-link-"));
    fixtureRoots.push(root);
    const external = join(root, "external");
    const linkedRoot = join(root, "artifact-store");
    mkdirSync(external);
    symlinkSync(external, linkedRoot);
    const store = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const artifacts = new ArtifactService(store.db, linkedRoot);

    await expect(
      artifacts.register({
        id: "root-link-attack",
        producerRunId: "run-1",
        mediaType: "text/plain",
        content: Buffer.from("must-not-escape"),
      }),
    ).rejects.toThrow(ArtifactAccessError);
    expect(() =>
      readFileSync(join(external, "artifacts", "ro", "root-link-attack")),
    ).toThrow();
    store.close();
  });

  it("rejects a symbolic-link directory before creating children outside the root", async () => {
    const { artifacts, artifactRoot } = artifactFixture();
    const external = join(dirname(artifactRoot), "external-shard");
    mkdirSync(external);
    mkdirSync(artifactRoot);
    symlinkSync(external, join(artifactRoot, "artifacts"));

    await expect(
      artifacts.register({
        id: "linked-directory",
        producerRunId: "run-1",
        mediaType: "text/plain",
        content: Buffer.from("must-not-escape"),
      }),
    ).rejects.toThrow(ArtifactAccessError);
    expect(readdirSync(external)).toEqual([]);
  });

  it.each(["../../outside", "../sibling", "/tmp/absolute", ".."])(
    "rejects artifact id %s",
    async (id) => {
      const { artifacts } = artifactFixture();
      await expect(
        artifacts.register({
          id,
          producerRunId: "run-1",
          mediaType: "text/plain",
          content: Buffer.from("bytes"),
        }),
      ).rejects.toThrow(ArtifactIdError);
    },
  );

  it("registers metadata before writing content and rejects duplicate ids", async () => {
    const { artifacts, artifactRoot } = artifactFixture();
    const input = {
      id: "artifact-safe-id",
      producerRunId: "run-1",
      mediaType: "text/plain",
      content: Buffer.from("first"),
    };
    await artifacts.register(input);
    const contentPath = join(
      artifactRoot,
      "artifacts",
      input.id.slice(0, 2),
      input.id,
    );
    expect(readFileSync(contentPath, "utf8")).toBe("first");

    await expect(
      artifacts.register({
        ...input,
        content: Buffer.from("second"),
      }),
    ).rejects.toThrow(ArtifactDuplicateError);
    expect(readFileSync(contentPath, "utf8")).toBe("first");
  });

  it("stores content under the artifact root only", async () => {
    const { artifacts, artifactRoot } = artifactFixture();
    const record = await artifacts.register({
      id: "safe-artifact-1",
      producerRunId: "run-1",
      mediaType: "text/plain",
      content: Buffer.from("payload"),
    });
    expect(record.contentRef.startsWith("artifacts/")).toBe(true);
    expect(
      readFileSync(join(artifactRoot, record.contentRef), "utf8"),
    ).toBe("payload");
  });

  it("rejects an artifact file replaced by an internal symbolic link", async () => {
    const { artifacts, artifactRoot } = artifactFixture();
    const record = await artifacts.register({
      id: "artifact-original",
      producerRunId: "run-1",
      mediaType: "text/plain",
      content: Buffer.from("same-content"),
    });
    const replacement = join(artifactRoot, "replacement.txt");
    writeFileSync(replacement, "same-content");
    const artifactPath = join(artifactRoot, record.contentRef);
    rmSync(artifactPath);
    symlinkSync(replacement, artifactPath);

    await expect(artifacts.readContent(record.id)).rejects.toThrow(
      ArtifactAccessError,
    );
  });
});

function artifactFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-artifacts-"));
  fixtureRoots.push(root);
  const artifactRoot = join(root, "artifact-store");
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return {
    store,
    artifactRoot,
    artifacts: new ArtifactService(store.db, artifactRoot),
    close: () => store.close(),
  };
}
