import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ValidationService,
  ValidatorRegistry,
  clock,
  createDeliveryProject,
  createDeliveryValidatorBundle,
  createProductDeliveryWorkflow,
  hireNamed,
  openCompanyE2eFixture,
  validateHandoff,
} from "./company-p1-e2e-fixture.js";

const fixtures: Array<ReturnType<typeof openCompanyE2eFixture>> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe("company delivery e2e", () => {
  it.each([false, true])("runs real workspace delivery checks (failed command: %s)", async (failTests) => {
    const fx = openCompanyE2eFixture();
    fixtures.push(fx);
    const created = fx.company.companies.create({ name: "曜石" });
    const product = hireNamed(fx.company, created.id, "产品");
    const architect = hireNamed(fx.company, created.id, "架构");
    const frontend = hireNamed(fx.company, created.id, "前端");
    const backend = hireNamed(fx.company, created.id, "后端");
    const validator = hireNamed(fx.company, created.id, "验证");
    const goal = fx.company.work.createGoal({
      companyId: created.id,
      title: "交付闭环",
      ownerId: product.id,
    });
    const project = fx.company.work.createProject({
      companyId: created.id,
      goalId: goal.id,
      title: "经营台",
    });
    const delivery = createDeliveryProject(fx.store.db, clock, {
      companyId: created.id,
      projectId: project.id,
      groupId: "group-delivery",
      approvedScope: {
        title: "经营台",
        problem: "需求到交付缺少闭环",
        expectedOutcome: "可验证交付",
      },
      assignments: [
        { employeeId: product.id, responsibility: "product", workspaceBindingId: "workspace:product" },
        { employeeId: architect.id, responsibility: "architecture", workspaceBindingId: "workspace:architecture" },
        { employeeId: frontend.id, responsibility: "implementation", workspaceBindingId: "workspace:frontend" },
        { employeeId: backend.id, responsibility: "implementation", workspaceBindingId: "workspace:backend" },
        { employeeId: validator.id, responsibility: "validation", workspaceBindingId: "workspace:validation" },
      ],
    });
    const workflow = createProductDeliveryWorkflow({
      projectId: project.id,
      approvedScopeRef: "scope-gate:v1",
      technicalGateRef: "technical-gate:v1",
      workspaceBindingIds: {
        frontend: "workspace:frontend",
        backend: "workspace:backend",
        docs: "workspace:docs",
      },
      deliveryProject: delivery,
    });
    validateHandoff({
      conclusion: "Implementation streams are ready.",
      recommendedActions: ["Run integrated validation."],
      completedScope: ["frontend", "backend"],
      incompleteScope: [],
      artifactRefs: ["artifact:frontend", "artifact:backend"],
      evidenceIds: ["evidence:tests"],
      assumptions: [],
      uncertainties: [],
      risks: [],
      downstreamQuestions: ["Is staging available?"],
      version: 1,
      from: frontend.id,
      to: validator.id,
      timestamp: clock.now(),
    });

    const workspaceRoot = join(fx.root, "workspaces");
    const writes: Record<string, string> = {};
    for (const assignment of delivery.assignments.filter(
      (item) => item.responsibility === "implementation",
    )) {
      expect(assignment.accessMode).toBe("write");
      const name = assignment.workspaceBindingId!.replace("workspace:", "");
      const directory = join(workspaceRoot, name);
      mkdirSync(directory, { recursive: true });
      const source = name === "backend"
        ? `export const total = (items) => items.reduce((sum, item) => sum + item, ${failTests ? 1 : 0});\n`
        : 'export const render = (total) => `<main>Total: ${total}</main>`;\n';
      writeFileSync(join(directory, "index.mjs"), source);
      writes[name] = readFileSync(join(directory, "index.mjs"), "utf8");
    }
    writeFileSync(join(workspaceRoot, "delivery.test.mjs"), `
      import test from "node:test";
      import assert from "node:assert/strict";
      import { total } from "./backend/index.mjs";
      import { render } from "./frontend/index.mjs";
      test("frontend renders the backend total", () => {
        assert.equal(render(total([2, 3])), "<main>Total: 5</main>");
      });
    `);
    writeFileSync(join(workspaceRoot, "build.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { total } from "./backend/index.mjs";
      import { render } from "./frontend/index.mjs";
      mkdirSync("dist", { recursive: true });
      writeFileSync("dist/index.html", render(total([2, 3])));
      console.log("Built dist/index.html");
    `);
    const runCommand = (args: string[]) => {
      const result = spawnSync(process.execPath, args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    };
    const tests = runCommand(["--test", "delivery.test.mjs"]);
    const build = runCommand(["build.mjs"]);
    expect(tests.stdout).toContain("frontend renders the backend total");
    expect(tests.status).toBe(failTests ? 1 : 0);
    expect(build.status).toBe(0);
    expect(build.stdout).toContain("Built dist/index.html");
    expect(readFileSync(join(workspaceRoot, "dist/index.html"), "utf8"))
      .toBe(`<main>Total: ${failTests ? 6 : 5}</main>`);
    const evidencePath = join(workspaceRoot, "command-evidence.json");
    writeFileSync(evidencePath, JSON.stringify({
      tests: { status: tests.status, stdout: tests.stdout, stderr: tests.stderr },
      build: { status: build.status, stdout: build.stdout, stderr: build.stderr },
    }, null, 2));

    const rollback = fx.company.work.listArtifacts(
      delivery.assignments.find((assignment) => assignment.responsibility === "implementation")!.workItemId,
    ).find((artifact) => artifact.kind === "plan")!;
    const registry = new ValidatorRegistry();
    for (const item of createDeliveryValidatorBundle()) registry.register(item);
    const validations = new ValidationService(fx.store.db, registry);
    const validation = await validations.validateDelivery({
      runId: "run-delivery",
      deliveryId: project.id,
      artifactIds: [rollback.id],
      evidenceIds: [evidencePath],
      context: {
        testsPassed: tests.status === 0,
        buildPassed: build.status === 0,
        checkpointId: "checkpoint-1",
        checkpointHash: "sha256:checkpoint-1",
        trace: { id: "trace-1", checkpointId: "checkpoint-1" },
        finalClaim: "测试与构建通过，关键交付等待发布审批",
      },
    });

    const candidate = fx.releases.createCandidate({
      companyId: created.id,
      projectId: project.id,
      checkpointId: "checkpoint-1",
      checkpointHash: "sha256:checkpoint-1",
      artifactIds: [rollback.id],
      validationIds: validation.validationIds,
      rollbackPlanArtifactId: rollback.id,
    });
    if (failTests) {
      expect(validation.accepted).toBe(false);
      expect(() => fx.releases.submitForApproval(candidate.id)).toThrow();
      expect(() => fx.releases.release(candidate.id)).toThrow();
      return;
    }
    expect(() => fx.releases.release(candidate.id)).toThrow();
    fx.releases.submitForApproval(candidate.id);
    expect(() => fx.releases.release(candidate.id)).toThrow();
    fx.store.db.prepare(
      `INSERT INTO core_policy_versions
        (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-release', 'release', 1, '{}', 1, ?)`,
    ).run(clock.now());
    const candidateHash = (
      fx.store.db
        .prepare("SELECT candidate_hash AS hash FROM company_release_candidates WHERE id = ?")
        .get(candidate.id) as { hash: string }
    ).hash;
    fx.store.db.prepare(
      `INSERT INTO core_approvals (
        id, subject_kind, subject_id, action, resource_kind, resource_id,
        parameters_hash, parameters_summary, risk, policy_version_id, state,
        expires_at, created_at
      ) VALUES ('approval-release', 'employee', ?, 'release', 'release_candidate', ?,
                ?, '{}', 'high', 'policy-release', 'approved', ?, ?)`,
    ).run(product.id, candidate.id, candidateHash, "2026-09-11T13:00:00.000Z", clock.now());
    fx.releases.approve({
      candidateId: candidate.id,
      approvalId: "approval-release",
      checkpointHash: "sha256:checkpoint-1",
    });
    expect(() => fx.releases.release(candidate.id)).toThrow();
    // This fixture models the release connector boundary with a local deploy;
    // ConnectorGateway authorization/credentials are covered by its own suite.
    const deploy = runCommand(["--input-type=module", "-e", `
      import { copyFileSync, mkdirSync } from "node:fs";
      mkdirSync("deployed", { recursive: true });
      copyFileSync("dist/index.html", "deployed/index.html");
      console.log("local-deployment-1");
    `]);
    expect(deploy.status).toBe(0);
    expect(readFileSync(join(workspaceRoot, "deployed/index.html"), "utf8"))
      .toBe("<main>Total: 5</main>");
    fx.store.db.prepare(`INSERT INTO core_connectors
      (id, name, adapter_kind, created_at, updated_at)
      VALUES ('release-connector', 'Local release fixture', 'mock', ?, ?)`)
      .run(clock.now(), clock.now());
    fx.store.db.prepare(`INSERT INTO core_connector_accounts
      (id, connector_id, name, credential_ref, created_at, updated_at)
      VALUES ('release-account', 'release-connector', 'fixture', 'cred://mock', ?, ?)`)
      .run(clock.now(), clock.now());
    fx.store.db.prepare(`INSERT INTO core_connector_actions
      (id, connector_id, connector_account_id, action, state, idempotency_key,
       proposal_json, result_json, created_at, updated_at)
      VALUES ('release-action', 'release-connector', 'release-account', 'deploy',
        'succeeded', 'release-fixture-1', ?, ?, ?, ?)`)
      .run(JSON.stringify({
        companyId: created.id,
        projectId: project.id,
        candidateId: candidate.id,
        candidateHash,
        checkpointHash: "sha256:checkpoint-1",
      }), JSON.stringify({ ok: deploy.status === 0, externalId: deploy.stdout.trim() }),
      clock.now(), clock.now());
    const released = fx.releases.release(candidate.id, "release-action");

    expect(workflow.steps.find((step) => step.id === "integrated-validation")?.dependsOn.sort())
      .toEqual(["backend", "docs", "frontend"]);
    expect(writes.frontend).toContain("export const render");
    expect(writes.backend).toContain("export const total");
    expect(validation.accepted).toBe(true);
    expect(released.state).toBe("released");
  });
});
