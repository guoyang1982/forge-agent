import { describe, expect, it } from "vitest";
import { rpcTimeoutMs } from "./rpc-timeout-policy.js";

describe("Mobile RPC timeout policy", () => {
  it("does not apply the short request timeout to a long-running Agent run", () => {
    expect(rpcTimeoutMs("run.start")).toBeNull();
  });

  it("keeps bounded timeouts for ordinary request/response methods", () => {
    expect(rpcTimeoutMs("status.get")).toBe(30_000);
    expect(rpcTimeoutMs("project.list")).toBe(30_000);
    expect(rpcTimeoutMs("session.messages")).toBe(30_000);
  });
});
