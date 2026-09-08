import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isCapabilityManifest,
  isRpcFault,
  isRpcRequestEnvelope,
  rpcFault,
  V2_RPC_METHODS,
  type CapabilityManifest,
  type RpcResult,
  type SystemStatusResult,
} from "./rpc.js";

describe("v2 RPC request envelopes", () => {
  it("accepts a known v2 request with protocol and request ids", () => {
    expect(
      isRpcRequestEnvelope({
        jsonrpc: "2.0",
        id: "r1",
        protocolVersion: 2,
        requestId: "req-1",
        method: "system.ping",
        params: {},
      }),
    ).toBe(true);
  });

  it("rejects version skew, missing correlation, and unknown methods", () => {
    const valid = {
      jsonrpc: "2.0",
      id: "r1",
      protocolVersion: 2,
      requestId: "req-1",
      method: "system.ping",
      params: {},
    };

    expect(isRpcRequestEnvelope({ ...valid, protocolVersion: 1 })).toBe(false);
    expect(isRpcRequestEnvelope({ ...valid, requestId: "" })).toBe(false);
    expect(isRpcRequestEnvelope({ ...valid, method: "system.unknown" })).toBe(false);
    expect(isRpcRequestEnvelope({ ...valid, params: [] })).toBe(false);
    expect(isRpcRequestEnvelope({ ...valid, params: { unexpected: true } })).toBe(false);
  });

  it("exposes the exact system.ping result type", () => {
    expectTypeOf<RpcResult<"system.ping">>().toEqualTypeOf<{
      ok: true;
      version: string;
      build: string;
    }>();
  });

  it("accepts system.status as a typed v2 request", () => {
    expect(V2_RPC_METHODS).toContain("system.status");
    expect(
      isRpcRequestEnvelope({
        jsonrpc: "2.0",
        id: "status-1",
        protocolVersion: 2,
        requestId: "request-status-1",
        method: "system.status",
        params: {},
      }),
    ).toBe(true);
    expectTypeOf<RpcResult<"system.status">>().toEqualTypeOf<SystemStatusResult>();
  });
});

describe("capability negotiation", () => {
  it("accepts a versioned capability manifest", () => {
    const manifest = {
      protocolVersion: 2,
      serverVersion: "0.2.0",
      methods: ["system.ping", "system.capabilities"],
      eventTypes: ["run.updated"],
      features: {
        typedRpc: { version: 1, enabled: true },
      },
    } satisfies CapabilityManifest;

    expect(isCapabilityManifest(manifest)).toBe(true);
    expect(
      isCapabilityManifest({
        ...manifest,
        features: { typedRpc: { version: 0, enabled: true } },
      }),
    ).toBe(false);
  });
});

describe("structured RPC faults", () => {
  it("normalizes retryability and preserves trace references", () => {
    expect(
      rpcFault("CORE_TIMEOUT", "timed out", {
        retryable: true,
        correlationId: "corr-1",
        detailsRef: "artifact://fault-1",
      }),
    ).toEqual({
      code: "CORE_TIMEOUT",
      message: "timed out",
      retryable: true,
      correlationId: "corr-1",
      detailsRef: "artifact://fault-1",
    });
    expect(rpcFault("VALIDATION_FAILED", "invalid input").retryable).toBe(false);
  });

  it("rejects malformed or unrecognized faults", () => {
    expect(
      isRpcFault({ code: "CORE_TIMEOUT", message: "timed out", retryable: true }),
    ).toBe(true);
    expect(
      isRpcFault({ code: "SOMETHING_ELSE", message: "failed", retryable: false }),
    ).toBe(false);
    expect(isRpcFault({ code: "CORE_TIMEOUT", message: "timed out" })).toBe(false);
  });
});
