import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  ApprovalAlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalHashMismatchError,
  ApprovalService,
  hashApprovalParameters,
} from "./approvals.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ApprovalService", () => {
  it("binds approval to action and parameter hashes", () => {
    const service = approvalFixture();
    const approval = service.requestApproval(approvalInput());
    expect(approval).toMatchObject({
      action: "connector.publish",
      state: "pending",
      resource: { kind: "account", id: "xhs" },
    });
    expect(approval.parametersHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a second decision", () => {
    const service = approvalFixture();
    const id = pendingApproval(service).id;
    service.decide(id, approveDecision());
    expect(() => service.decide(id, denyDecision())).toThrow(ApprovalAlreadyDecidedError);
    expect(() => service.decide(id, denyDecision())).toThrow(/already decided/);
  });

  it("records approve and deny decisions with actor metadata", () => {
    const service = approvalFixture();
    const pending = pendingApproval(service);
    const approved = service.decide(pending.id, approveDecision());
    expect(approved.state).toBe("approved");
    expect(approved.decision).toMatchObject({
      decision: "approved",
      actor: { kind: "user", id: "operator-1" },
    });

    const denied = service.decide(pendingApproval(service).id, denyDecision());
    expect(denied.state).toBe("denied");
    expect(denied.decision?.decision).toBe("denied");
  });

  it("expires pending approvals", () => {
    const service = approvalFixture();
    const pending = service.requestApproval({
      ...approvalInput(),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const expired = service.expire(pending.id);
    expect(expired.state).toBe("expired");
  });

  it("rejects a decision made after the approval expiry", () => {
    const service = approvalFixture();
    const pending = service.requestApproval({
      ...approvalInput(),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(() => service.decide(pending.id, approveDecision())).toThrow(/expired/);
    expect(service.getApproval(pending.id).state).toBe("expired");
  });

  it("revokes a pending approval", () => {
    const service = approvalFixture();
    const pending = pendingApproval(service);
    const revoked = service.revoke(pending.id);
    expect(revoked.state).toBe("revoked");
  });

  it("rejects decisions when the parameters hash mismatches", () => {
    const service = approvalFixture();
    const pending = pendingApproval(service);
    expect(() =>
      service.decide(pending.id, {
        ...approveDecision(),
        parametersHash: "deadbeef".repeat(8),
      }),
    ).toThrow(ApprovalHashMismatchError);
  });

  it("rejects expired approved approvals on read", () => {
    const store = openStore();
    seedPolicyVersion(store);
    const service = new ApprovalService(store.db);
    const pending = service.requestApproval({
      ...approvalInput(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    service.decide(pending.id, approveDecision());
    store.db
      .prepare(`UPDATE core_approvals SET expires_at = ? WHERE id = ?`)
      .run("2020-01-01T00:00:00.000Z", pending.id);

    expect(() => service.getApproval(pending.id)).toThrow(ApprovalExpiredError);
    expect(service.getApproval(pending.id).state).toBe("expired");
  });

  it("lists only non-expired pending approvals", () => {
    const service = approvalFixture();
    const pending = pendingApproval(service);
    service.requestApproval({
      ...approvalInput(),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    service.decide(pending.id, approveDecision());

    const listed = service.listPending({ kind: "agent_profile", id: "forge-default" });
    expect(listed).toHaveLength(0);

    const fresh = pendingApproval(service);
    expect(service.listPending({ kind: "agent_profile", id: "forge-default" })).toEqual([
      expect.objectContaining({ id: fresh.id, state: "pending" }),
    ]);
  });
});

function approvalFixture(): ApprovalService {
  const store = openStore();
  seedPolicyVersion(store);
  return new ApprovalService(store.db);
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "forge-policy-approvals-"));
  fixtureRoots.push(root);
  return ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
}

function seedPolicyVersion(store: ForgeStore) {
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{}', 1, ?)`,
    )
    .run(now);
}

function approvalInput() {
  return {
    subject: { kind: "agent_profile", id: "forge-default" },
    action: "connector.publish",
    resource: { kind: "account", id: "xhs" },
    parameters: { channel: "xhs", caption: "launch post" },
    parametersSummary: "publish launch post to xhs",
    risk: "high" as const,
    policyVersionId: "policy-v1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId: "run-1",
    stepId: "step-1",
  };
}

function pendingApproval(service: ApprovalService) {
  return service.requestApproval(approvalInput());
}

function approveDecision() {
  return {
    decision: "approved" as const,
    actor: { kind: "user", id: "operator-1" },
    reason: "looks good",
    parametersHash: hashApprovalParameters({
      channel: "xhs",
      caption: "launch post",
    }),
  };
}

function denyDecision() {
  return {
    decision: "denied" as const,
    actor: { kind: "user", id: "operator-1" },
    reason: "too risky",
    parametersHash: hashApprovalParameters({
      channel: "xhs",
      caption: "launch post",
    }),
  };
}
