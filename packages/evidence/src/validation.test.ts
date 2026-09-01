import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  ArtifactAccessError,
  ArtifactService,
  ArtifactTamperError,
  EvidenceService,
  ValidationService,
  ValidatorRegistry,
  layerValidator,
} from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ArtifactService", () => {
  it("hashes artifact content and links producer run", async () => {
    const { artifacts } = evidenceFixture();
    const artifact = await artifacts.register({
      id: "a1",
      producerRunId: "r1",
      mediaType: "text/markdown",
      content: Buffer.from("report"),
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.producerRunId).toBe("r1");
    expect(artifact.contentRef).toBe("artifacts/a1/a1");
  });

  it("detects tampered artifact content on read", async () => {
    const fixture = evidenceFixture();
    const artifact = await fixture.artifacts.register({
      id: "a2",
      producerRunId: "r1",
      mediaType: "text/plain",
      content: Buffer.from("original"),
    });
    const absolutePath = join(fixture.artifactRoot, artifact.contentRef);
    writeFileSync(absolutePath, "tampered");
    await expect(fixture.artifacts.readContent("a2")).rejects.toThrow(ArtifactTamperError);
  });

  it("enforces artifact access scope", async () => {
    const { artifacts } = evidenceFixture();
    await artifacts.register({
      id: "a3",
      producerRunId: "r1",
      mediaType: "text/plain",
      content: Buffer.from("scoped"),
      accessScope: { projectId: "proj-1" },
    });
    await expect(artifacts.readContent("a3", { projectId: "proj-2" })).rejects.toThrow(
      ArtifactAccessError,
    );
    await expect(artifacts.readContent("a3", { projectId: "proj-1" })).resolves.toEqual(
      Buffer.from("scoped"),
    );
  });
});

describe("EvidenceService", () => {
  it("links evidence claims to artifacts and runs", async () => {
    const { artifacts, evidence } = evidenceFixture();
    await artifacts.register({
      id: "a1",
      producerRunId: "r1",
      mediaType: "text/markdown",
      content: Buffer.from("report"),
    });
    const record = evidence.register({
      id: "e1",
      artifactId: "a1",
      runId: "r1",
      claim: "tests passed",
      sourceKind: "test_report",
      sourceRef: "artifact:a1",
    });
    expect(evidence.listForRun("r1")).toEqual([record]);
  });
});

describe("ValidationService", () => {
  it("fails delivery when any blocking layer fails", async () => {
    const { validations } = validationFixture({ answerLayer: "failed" });
    const result = await validations.validateDelivery(deliveryFixture());
    expect(result.accepted).toBe(false);
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "answer", status: "failed" }),
    );
  });

  it("accepts delivery when only inconclusive warnings are present", async () => {
    const fixture = evidenceFixture();
    const registry = new ValidatorRegistry();
    registry.register(
      layerValidator({
        id: "process-check",
        layer: "process",
        status: "inconclusive",
        severity: "warning",
        requiresEvidence: true,
      }),
    );
    registry.register(
      layerValidator({
        id: "answer-check",
        layer: "answer",
        status: "passed",
      }),
    );
    const validations = new ValidationService(fixture.store.db, registry);
    const result = await validations.validateDelivery({
      ...deliveryFixture(),
      evidenceIds: [],
    });
    expect(result.accepted).toBe(true);
    expect(result.results).toContainEqual(
      expect.objectContaining({ layer: "process", status: "inconclusive" }),
    );
  });

  it("accepts delivery when all blocking layers pass", async () => {
    const { validations } = validationFixture();
    const result = await validations.validateDelivery(deliveryFixture());
    expect(result.accepted).toBe(true);
  });
});

function evidenceFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-evidence-"));
  fixtureRoots.push(root);
  const artifactRoot = join(root, "artifact-store");
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  return {
    root,
    artifactRoot,
    store,
    artifacts: new ArtifactService(store.db, artifactRoot),
    evidence: new EvidenceService(store.db),
  };
}

function validationFixture(options?: { answerLayer?: "passed" | "failed" }) {
  const fixture = evidenceFixture();
  const registry = new ValidatorRegistry();
  registry.register(
    layerValidator({ id: "result-check", layer: "result", status: "passed" }),
  );
  registry.register(
    layerValidator({ id: "process-check", layer: "process", status: "passed" }),
  );
  registry.register(
    layerValidator({
      id: "answer-check",
      layer: "answer",
      status: options?.answerLayer ?? "passed",
      severity: "blocking",
    }),
  );
  return {
    ...fixture,
    validations: new ValidationService(fixture.store.db, registry),
  };
}

function deliveryFixture() {
  return {
    runId: "run-1",
    deliveryId: "delivery-1",
    artifactIds: ["a1"],
    evidenceIds: ["e1"],
  };
}
