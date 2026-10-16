import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "../company-service.js";
import { OrganizationService } from "../organization-service.js";
import { WorkService } from "../work-service.js";
import { ReleaseService, type CreateReleaseCandidateInput } from "./release.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const clock = { now: () => "2026-09-11T08:00:00.000Z" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ReleaseService", () => {
  it.each(["missing", "failed", "inconclusive", "wrong-project"])("rejects %s validation evidence", (mode) => {
    const { releases, input, store } = fixture();
    if (mode === "missing") store.db.prepare("DELETE FROM core_validations WHERE id = 'result-1'").run();
    else if (mode === "wrong-project") store.db.prepare("UPDATE core_validations SET delivery_id = 'other' WHERE id = 'result-1'").run();
    else store.db.prepare("UPDATE core_validations SET status = ? WHERE id = 'result-1'").run(mode);
    const candidate = releases.createCandidate(input);
    expect(() => releases.submitForApproval(candidate.id)).toThrow("delivery validation evidence invalid");
  });
  it.each(["checkpoint", "artifact", "deleted-binding"])("rejects stale %s validation", (mode) => {
    const { releases, input, store } = fixture();
    if (mode === "checkpoint") input.checkpointHash = "new-checkpoint";
    if (mode === "artifact") store.db.prepare("UPDATE company_work_artifacts SET content_hash = 'new-content' WHERE id = ?").run(input.artifactIds[0]);
    if (mode === "deleted-binding") store.db.prepare("UPDATE core_validations SET details_json = '{}' WHERE id = 'result-1'").run();
    const candidate = releases.createCandidate(input);
    expect(() => releases.submitForApproval(candidate.id)).toThrow("delivery validation version mismatch");
  });

  it.each(["unknown", "failed", "wrong-version"])("rejects %s deployment receipt", (mode) => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    seedApproval(store, candidate.id);
    releases.approve({ candidateId: candidate.id, approvalId: "approval-1", checkpointHash: input.checkpointHash });
    seedDeployment(store, input, candidate.id);
    if (mode === "wrong-version") store.db.prepare("UPDATE core_connector_actions SET proposal_json = '{}' WHERE id = 'deployment-1'").run();
    else store.db.prepare("UPDATE core_connector_actions SET state = ? WHERE id = 'deployment-1'").run(mode);
    expect(() => releases.release(candidate.id, "deployment-1")).toThrow(/receipt/);
    expect(releases.get(candidate.id)?.state).toBe("approved");
  });

  it("requires a rollback plan artifact", () => {
    const { releases, input, store } = fixture();

    expect(() =>
      releases.createCandidate({ ...input, rollbackPlanArtifactId: "" }),
    ).toThrow("rollback plan artifact required");

    const intent = store.db
      .prepare(
        "SELECT id FROM company_work_artifacts WHERE company_id = ? AND kind = 'intent'",
      )
      .get(input.companyId) as { id: string };
    expect(() =>
      releases.createCandidate({ ...input, rollbackPlanArtifactId: intent.id }),
    ).toThrow("rollback plan artifact not found");
  });

  it("requires validation before requesting high-risk approval", () => {
    const { releases, input } = fixture();
    const candidate = releases.createCandidate({ ...input, validationIds: [] });

    expect(() => releases.submitForApproval(candidate.id)).toThrow(
      "delivery validations required",
    );
  });

  it("does not approve a candidate before it is waiting for approval", () => {
    const { releases, input } = fixture();
    const candidate = releases.createCandidate(input);

    expect(() =>
      releases.approve({
        candidateId: candidate.id,
        approvalId: "approval-1",
        checkpointHash: input.checkpointHash,
      }),
    ).toThrow("candidate is not waiting for approval");
  });

  it("invalidates approval when frozen candidate artifacts changed", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    store.db
      .prepare(
        "UPDATE company_release_candidates SET artifact_ids_json = ? WHERE id = ?",
      )
      .run(JSON.stringify([...input.artifactIds, "artifact-new"]), candidate.id);

    expect(() =>
      releases.approve({
        candidateId: candidate.id,
        approvalId: "approval-1",
        checkpointHash: input.checkpointHash,
      }),
    ).toThrow("candidate inputs changed");
  });

  it("invalidates approval when referenced artifact content changes", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    seedApproval(store, candidate.id);
    store.db
      .prepare("UPDATE company_work_artifacts SET content_hash = 'changed' WHERE id = ?")
      .run(input.artifactIds[0]);

    expect(() =>
      releases.approve({
        candidateId: candidate.id,
        approvalId: "approval-1",
        checkpointHash: input.checkpointHash,
      }),
    ).toThrow("candidate inputs changed");
  });

  it("invalidates approval when a referenced artifact is missing", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    seedApproval(store, candidate.id);
    store.db
      .prepare("DELETE FROM company_work_artifacts WHERE id = ?")
      .run(input.artifactIds.find((id) => id !== input.rollbackPlanArtifactId));

    expect(() =>
      releases.approve({
        candidateId: candidate.id,
        approvalId: "approval-1",
        checkpointHash: input.checkpointHash,
      }),
    ).toThrow("candidate inputs changed");
  });

  it.each([
    ["missing approval", undefined, "approval not found"],
    ["pending approval", { state: "pending" }, "approval not approved"],
    ["denied approval", { state: "denied" }, "approval not approved"],
    ["low-risk approval", { risk: "low" }, "approval not high risk"],
    [
      "expired approval",
      { expiresAt: "2026-09-11T08:00:00.000Z" },
      "approval expired",
    ],
    [
      "approval for another resource",
      { resourceId: "candidate-other" },
      "approval resource mismatch",
    ],
    [
      "approval with another hash",
      { parametersHash: "sha256:wrong" },
      "approval hash mismatch",
    ],
  ] as const)("rejects %s", (_label, approval, message) => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    if (approval) seedApproval(store, candidate.id, approval);

    expect(() =>
      releases.approve({
        candidateId: candidate.id,
        approvalId: "approval-1",
        checkpointHash: input.checkpointHash,
      }),
    ).toThrow(message);
  });

  it("binds approval hashes and releases only an approved candidate", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    seedApproval(store, candidate.id);
    const approved = releases.approve({
      candidateId: candidate.id,
      approvalId: "approval-1",
      checkpointHash: input.checkpointHash,
    });

    expect(approved).toMatchObject({
      approvalId: "approval-1",
      state: "approved",
    });
    expect(
      store.db
        .prepare(
          `SELECT approval_candidate_hash AS candidateHash,
                  approval_checkpoint_hash AS checkpointHash
             FROM company_release_candidates WHERE id = ?`,
        )
        .get(candidate.id),
    ).toEqual({
      candidateHash: inputHashFromRow(store, candidate.id),
      checkpointHash: input.checkpointHash,
    });
    expect(() => releases.release(candidate.id)).toThrow("deployment receipt required");
    seedDeployment(store, input, candidate.id);
    expect(releases.release(candidate.id, "deployment-1").state).toBe("released");
  });

  it("invalidates release when approved artifact content changes", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);
    releases.submitForApproval(candidate.id);
    seedApproval(store, candidate.id);
    releases.approve({
      candidateId: candidate.id,
      approvalId: "approval-1",
      checkpointHash: input.checkpointHash,
    });
    store.db
      .prepare("UPDATE company_work_artifacts SET content_hash = 'changed' WHERE id = ?")
      .run(input.artifactIds[0]);

    expect(() => releases.release(candidate.id)).toThrow("approval invalidated");
  });

  it("supports explicit rejection without invoking deployment", () => {
    const { releases, input } = fixture();
    const candidate = releases.createCandidate(input);

    expect(releases.reject(candidate.id).state).toBe("rejected");
    expect(() => releases.release(candidate.id)).toThrow(
      "candidate is not approved",
    );
  });

  it("creates feedback items from release review failures", () => {
    const { releases, input, store } = fixture();
    const candidate = releases.createCandidate(input);

    const review = releases.recordReview({
      candidateId: candidate.id,
      escapedDefects: ["bug-1"],
      summary: "One escaped defect",
    });

    expect(review.feedbackItemIds).toHaveLength(1);
    expect(
      store.db
        .prepare(
          "SELECT source, summary FROM company_feedback_items WHERE id = ?",
        )
        .get(review.feedbackItemIds[0]),
    ).toEqual({ source: "release_review", summary: "bug-1" });
  });
});

function fixture(): {
  store: ForgeStore;
  releases: ReleaseService;
  input: CreateReleaseCandidateInput;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-release-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);

  const companies = new CompanyService(store.db, clock);
  const company = companies.create({ name: "Forge" });
  const org = new OrganizationService(store.db, clock);
  const department = org.createDepartment({ companyId: company.id, name: "Product" });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Owner",
    charter: "Deliver",
  });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "Owner",
  });
  const owner = org.hire({
    companyId: company.id,
    displayName: "Owner",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const work = new WorkService(store.db, clock);
  const goal = work.createGoal({
    companyId: company.id,
    title: "Ship",
    ownerId: owner.id,
  });
  const project = work.createProject({
    companyId: company.id,
    goalId: goal.id,
    title: "Delivery",
  });
  const workItem = work.createWorkItem({
    companyId: company.id,
    projectId: project.id,
    type: "implementation",
    title: "Release",
    problem: "Need release",
    expectedOutcome: "Released safely",
    ownerId: owner.id,
  });
  const artifacts = work.listArtifacts(workItem.id);
  const rollbackPlan = artifacts.find(({ kind }) => kind === "plan")!;
  store.db
    .prepare(
      `INSERT INTO core_policy_versions
        (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-release', 'release', 1, '{}', 1, ?)`,
    )
    .run(clock.now());
  for (const layer of ["result", "process", "answer"]) {
    store.db.prepare(`INSERT INTO core_validations
      (id, run_id, delivery_id, validator_id, layer, status, severity, summary, details_json, created_at)
      VALUES (?, 'run-release', ?, ?, ?, 'passed', 'info', 'verified', ?, ?)`)
      .run(`${layer}-1`, project.id, layer, layer, JSON.stringify({ inputBinding: {
        artifactIds: artifacts.map((a) => a.id).sort(), checkpointId: "checkpoint-1", checkpointHash: "sha256:checkpoint-1",
        artifactHashes: Object.fromEntries(artifacts.map((a) => [a.id, a.contentHash])),
      } }), clock.now());
  }
  const releases = new ReleaseService(store.db, clock);
  return {
    store,
    releases,
    input: {
      companyId: company.id,
      projectId: project.id,
      checkpointId: "checkpoint-1",
      checkpointHash: "sha256:checkpoint-1",
      artifactIds: artifacts.map(({ id }) => id),
      validationIds: ["result-1", "process-1", "answer-1"],
      rollbackPlanArtifactId: rollbackPlan.id,
    },
  };
}

function inputHashFromRow(store: ForgeStore, candidateId: string): string {
  return (
    store.db
      .prepare("SELECT candidate_hash AS hash FROM company_release_candidates WHERE id = ?")
      .get(candidateId) as { hash: string }
  ).hash;
}

function seedApproval(
  store: ForgeStore,
  candidateId: string,
  overrides: {
    state?: "pending" | "approved" | "denied";
    risk?: "low" | "high" | "critical";
    expiresAt?: string;
    resourceId?: string;
    parametersHash?: string;
  } = {},
): void {
  store.db
    .prepare(
      `INSERT INTO core_approvals (
        id, subject_kind, subject_id, action, resource_kind, resource_id,
        parameters_hash, parameters_summary, risk, policy_version_id, state,
        expires_at, created_at
      ) VALUES (?, 'employee', 'owner-1', 'release', 'release_candidate', ?,
                ?, '{}', ?, 'policy-release', ?, ?, ?)`,
    )
    .run(
      "approval-1",
      overrides.resourceId ?? candidateId,
      overrides.parametersHash ?? inputHashFromRow(store, candidateId),
      overrides.risk ?? "high",
      overrides.state ?? "approved",
      overrides.expiresAt ?? "2026-09-11T09:00:00.000Z",
      clock.now(),
    );
}

function seedDeployment(store: ForgeStore, input: CreateReleaseCandidateInput, candidateId: string): void {
  store.db.prepare(`INSERT INTO core_connectors (id,name,adapter_kind,created_at,updated_at)
    VALUES ('deploy', 'deploy', 'test', ?, ?)`).run(clock.now(), clock.now());
  store.db.prepare(`INSERT INTO core_connector_accounts (id,connector_id,name,credential_ref,created_at,updated_at)
    VALUES ('deploy-account','deploy','test','test',?,?)`).run(clock.now(), clock.now());
  store.db.prepare(`INSERT INTO core_connector_actions
    (id,connector_id,connector_account_id,action,state,idempotency_key,proposal_json,result_json,created_at,updated_at)
    VALUES ('deployment-1','deploy','deploy-account','deploy','succeeded','deployment-1',?,?,?,?)`)
    .run(JSON.stringify({ companyId: input.companyId, projectId: input.projectId, candidateId,
      candidateHash: inputHashFromRow(store, candidateId), checkpointHash: input.checkpointHash }),
      JSON.stringify({ ok: true, externalId: 'test-release-1' }), clock.now(), clock.now());
}
