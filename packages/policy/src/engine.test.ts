import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { PolicyEngine, hashAuthorizationInput } from "./engine.js";
import type { AuthorizationInput, PolicyGrant, PolicyRule, RiskLevel } from "./types.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PolicyEngine", () => {
  it("denies an action with no matching grant", () => {
    const engine = engineFixture({ grants: [] });
    expect(engine.authorize(action("connector.publish", "xhs"))).toMatchObject({
      outcome: "deny",
      reason: "no matching grant",
    });
  });

  it("requires approval for high-risk external writes", () => {
    const engine = engineFixture({
      rules: [
        {
          action: "connector.publish",
          resourceKind: "account",
          minRisk: "high",
          effect: "require_approval",
          approvalClass: "external_publish",
        },
      ],
    });
    const decision = engine.authorize(
      action("connector.publish", "xhs", { risk: "high" }),
    );
    expect(decision).toMatchObject({
      outcome: "require_approval",
      approvalClass: "external_publish",
    });
  });

  it("allows an explicitly granted action", () => {
    const engine = engineFixture({
      grants: [grant({ effect: "allow", action: "tool.echo", resourceKind: "tool" })],
    });
    expect(engine.authorize(action("tool.echo", "echo", { resourceKind: "tool" }))).toMatchObject({
      outcome: "allow",
    });
  });

  it("prefers explicit deny over allow for conflicting grants", () => {
    const engine = engineFixture({
      grants: [
        grant({ id: "allow-1", effect: "allow" }),
        grant({ id: "deny-1", effect: "deny" }),
      ],
    });
    expect(engine.authorize(action("connector.publish", "xhs"))).toMatchObject({
      outcome: "deny",
      reason: expect.stringContaining("deny-1"),
    });
  });

  it("ignores expired grants", () => {
    const engine = engineFixture({
      grants: [
        grant({
          effect: "allow",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(engine.authorize(action("connector.publish", "xhs"))).toMatchObject({
      outcome: "deny",
      reason: "no matching grant",
    });
  });

  it("matches resource scope ids", () => {
    const engine = engineFixture({
      grants: [
        grant({
          effect: "allow",
          resourceScope: { resourceIds: ["xhs"] },
        }),
      ],
    });
    expect(engine.authorize(action("connector.publish", "xhs"))).toMatchObject({
      outcome: "allow",
    });
    expect(engine.authorize(action("connector.publish", "other"))).toMatchObject({
      outcome: "deny",
    });
  });

  it("hashes authorization input without embedding sensitive context values", () => {
    const input = action("connector.publish", "xhs", {
      context: { token: "secret-token", note: "safe" },
    });
    const hash = hashAuthorizationInput(input);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("secret");
    expect(engineFixture({ grants: [] }).authorize(input).inputHash).toBe(hash);
  });

  it("loads grants and rules from the active policy version in the database", () => {
    const store = openStore();
    try {
      const now = new Date().toISOString();
      store.db
        .prepare(
          `INSERT INTO core_subjects (kind, subject_id, created_at, updated_at)
           VALUES ('agent_profile', 'forge-default', ?, ?)`,
        )
        .run(now, now);
      store.db
        .prepare(
          `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
           VALUES ('policy-v1', 'default', 1, ?, 1, ?)`,
        )
        .run(
          JSON.stringify({
            rules: [
              {
                action: "connector.publish",
                resourceKind: "account",
                minRisk: "high",
                effect: "require_approval",
                approvalClass: "external_publish",
              },
            ],
          }),
          now,
        );
      store.db
        .prepare(
          `INSERT INTO core_grants (
            id, subject_kind, subject_id, policy_version_id, action, resource_kind,
            resource_scope_json, effect, created_at
          ) VALUES (?, 'agent_profile', 'forge-default', 'policy-v1', 'tool.echo', 'tool', '{}', 'allow', ?)`,
        )
        .run("grant-echo", now);

      const engine = PolicyEngine.fromDatabase(store.db);
      expect(engine.authorize(action("tool.echo", "echo", { resourceKind: "tool" }))).toMatchObject({
        outcome: "allow",
      });
      expect(
        engine.authorize(action("connector.publish", "xhs", { risk: "high" })),
      ).toMatchObject({
        outcome: "require_approval",
        approvalClass: "external_publish",
        policyVersionId: "policy-v1",
      });
    } finally {
      store.close();
    }
  });
});

function engineFixture(options: { grants?: PolicyGrant[]; rules?: PolicyRule[] }) {
  return new PolicyEngine({
    policyVersionId: "policy-v1",
    grants: options.grants ?? [],
    rules: options.rules ?? [],
  });
}

function grant(overrides: Partial<PolicyGrant> = {}): PolicyGrant {
  return {
    id: overrides.id ?? "grant-1",
    subjectKind: "agent_profile",
    subjectId: "forge-default",
    policyVersionId: "policy-v1",
    action: "connector.publish",
    resourceKind: "account",
    resourceScope: {},
    effect: "allow",
    ...overrides,
  };
}

function action(
  actionName: string,
  resourceId: string,
  options: {
    risk?: RiskLevel;
    resourceKind?: string;
    context?: Record<string, unknown>;
  } = {},
): AuthorizationInput {
  return {
    subject: { kind: "agent_profile", id: "forge-default" },
    action: actionName,
    resource: {
      kind: options.resourceKind ?? "account",
      id: resourceId,
    },
    scope: {},
    risk: options.risk ?? "low",
    context: options.context ?? {},
  };
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "forge-policy-engine-"));
  fixtureRoots.push(root);
  return ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
}
