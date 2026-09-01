import { describe, expect, it } from "vitest";
import type { AgentCapabilitySnapshot } from "@forge/agent-profile";
import {
  ModelRouter,
  ModelRoutingError,
  buildModelRouteTrace,
  type ModelCandidate,
  type ModelRouteInput,
} from "./model-routing.js";

describe("ModelRouter", () => {
  it("selects the cheapest eligible model within the remaining budget", () => {
    const router = new ModelRouter();
    const selected = router.select(
      routeInput({ required: ["vision"], remainingMinor: 500n }),
    );
    expect(selected.modelId).toBe("vision-economy");
    expect(selected.reason).toContain("budget");
    expect(buildModelRouteTrace(selected).modelId).toBe("vision-economy");
  });

  it("rejects unavailable or unauthorized models", () => {
    const router = new ModelRouter();
    expect(() =>
      router.select(
        routeInput({
          required: ["vision"],
          remainingMinor: 5000n,
          candidates: [
            candidate({
              modelId: "vision-offline",
              capabilities: ["vision"],
              available: false,
            }),
          ],
        }),
      ),
    ).toThrow(ModelRoutingError);
    expect(() =>
      router.select(
        routeInput({
          required: ["vision"],
          remainingMinor: 5000n,
          candidates: [
            candidate({
              modelId: "vision-locked",
              capabilities: ["vision"],
              authorized: false,
            }),
          ],
        }),
      ),
    ).toThrow(ModelRoutingError);
  });

  it("requires all requested capabilities", () => {
    const router = new ModelRouter();
    expect(() =>
      router.select(
        routeInput({
          required: ["vision", "tools"],
          remainingMinor: 5000n,
          candidates: [candidate({ modelId: "vision-only", capabilities: ["vision"] })],
        }),
      ),
    ).toThrow(ModelRoutingError);
  });
});

function routeInput(options: {
  required: string[];
  remainingMinor: bigint;
  candidates?: ModelCandidate[];
}): ModelRouteInput {
  return {
    snapshot: snapshotFixture(),
    requiredCapabilities: options.required,
    remainingMinor: options.remainingMinor,
    routingPolicyVersion: "routing-v1",
    candidates: options.candidates ?? defaultCandidates(),
  };
}

function defaultCandidates(): ModelCandidate[] {
  return [
    candidate({
      modelId: "vision-premium",
      capabilities: ["vision"],
      costMinor: 900n,
    }),
    candidate({
      modelId: "vision-economy",
      capabilities: ["vision"],
      costMinor: 400n,
    }),
    candidate({
      modelId: "text-only",
      capabilities: ["text"],
      costMinor: 100n,
    }),
  ];
}

function candidate(overrides: Partial<ModelCandidate> & Pick<ModelCandidate, "modelId">): ModelCandidate {
  return {
    capabilities: ["text"],
    costMinor: 100n,
    available: true,
    authorized: true,
    ...overrides,
  };
}

function snapshotFixture(): AgentCapabilitySnapshot {
  return {
    id: "snap-1",
    profileId: "profile-1",
    profileVersionId: "version-1",
    modelPolicy: { model: "forge-default", routingPolicyVersion: "routing-v1" },
    runtime: { model: "forge-default", routingPolicyVersion: "routing-v1" },
    skills: [],
    tools: [],
    knowledge: [],
    memoryScopes: [],
    connectors: [],
    policyVersionId: "policy-v1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
