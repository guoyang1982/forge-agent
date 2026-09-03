import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
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
