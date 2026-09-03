import { describe, expect, it } from "vitest";
import { rpcFault } from "@forge/protocol";
import { RpcFaultError, TypedRouter } from "./router.js";
import type { RpcContext } from "./types.js";

function requestContext(): RpcContext {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitAgentEvent: () => {},
  };
}

describe("TypedRouter", () => {
  it("rejects duplicate method registration", () => {
    const router = new TypedRouter();
    router.register("system.ping", async () => ({
      ok: true,
      version: "2",
      build: "first",
    }));

    expect(() =>
      router.register("system.ping", async () => ({
        ok: true,
        version: "2",
        build: "second",
      })),
    ).toThrow(/already registered/i);
  });

  it("dispatches typed params and request context to the registered handler", async () => {
    const router = new TypedRouter();
    const context = requestContext();
    router.register("system.ping", async (params, receivedContext) => {
      expect(params).toEqual({});
      expect(receivedContext).toBe(context);
      return { ok: true, version: "2", build: "router-test" };
    });

    await expect(router.handle("system.ping", {}, context)).resolves.toEqual({
      ok: true,
      version: "2",
      build: "router-test",
    });
  });

  it("reports registered method names for capability aggregation", () => {
    const router = new TypedRouter();
    router.register("system.ping", async () => ({
      ok: true,
      version: "2",
      build: "router-test",
    }));
    router.register("system.capabilities", async () => ({
      protocolVersion: 2,
      serverVersion: "2",
      methods: [],
      eventTypes: [],
      features: {},
    }));

    expect(router.methods()).toEqual(["system.ping", "system.capabilities"]);
  });

  it("dispatches product method names through the untyped handler", async () => {
    const router = new TypedRouter();
    const context = requestContext();
    router.registerProduct("run", async (params, receivedContext) => {
      expect(params).toEqual({ message: "hello" });
      expect(receivedContext).toBe(context);
      return { sessionId: "session-1" };
    });

    await expect(
      router.handleUntyped("run", { message: "hello" }, context),
    ).resolves.toEqual({ sessionId: "session-1" });
    expect(router.methods()).toContain("run");
  });

  it("returns METHOD_NOT_FOUND without exposing implementation details", async () => {
    const error = await new TypedRouter()
      .handle("missing" as never, {}, requestContext())
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error).toMatchObject({
      fault: {
        code: "METHOD_NOT_FOUND",
        message: "RPC method not found",
        retryable: false,
        correlationId: "correlation-1",
      },
    });
    expect(error.fault).not.toHaveProperty("stack");
  });

  it("preserves an explicit fault and supplies its missing correlation id", async () => {
    const router = new TypedRouter();
    router.register("system.ping", async () => {
      throw new RpcFaultError(
        rpcFault("WORKSPACE_CONFLICT", "workspace is busy", {
          retryable: true,
        }),
      );
    });

    await expect(
      router.handle("system.ping", {}, requestContext()),
    ).rejects.toMatchObject({
      fault: {
        code: "WORKSPACE_CONFLICT",
        message: "workspace is busy",
        retryable: true,
        correlationId: "correlation-1",
      },
    });
  });

  it("maps unknown handler failures to a safe INTERNAL_ERROR fault", async () => {
    const router = new TypedRouter();
    router.register("system.ping", async () => {
      throw new Error("database failed at /Users/private/data.db");
    });

    const error = await router
      .handle("system.ping", {}, requestContext())
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(RpcFaultError);
    expect(error).toMatchObject({
      fault: {
        code: "INTERNAL_ERROR",
        message: "Internal RPC error",
        retryable: false,
        correlationId: "correlation-1",
      },
    });
    expect(JSON.stringify(error.fault)).not.toContain("/Users/private");
  });
});
