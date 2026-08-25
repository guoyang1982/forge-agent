import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7),
}));

import { MobileRelayClient } from "./mobile-relay-client.js";

afterEach(() => vi.useRealTimers());

describe("MobileRelayClient long-running calls", () => {
  it("keeps run.start pending beyond 30 seconds and resolves on the host response", async () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const client = Object.create(MobileRelayClient.prototype) as MobileRelayClient;
    Object.assign(client, {
      closed: false,
      pending: new Map(),
      subscriptions: new Map(),
      sealer: { seal: (_kind: string, payload: Uint8Array) => payload },
      opener: null,
      socket: { send: (frame: Uint8Array) => sent.push(frame) },
    });

    const run = client.startRun(
      { cwd: "/workspace/project", message: "long task" },
      () => undefined,
    );
    let settled = false;
    void run.result.finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(30_001);
    expect(settled).toBe(false);

    const request = JSON.parse(new TextDecoder().decode(sent[0])) as { id: string };
    (client as unknown as { handleResponse(frame: unknown): void }).handleResponse({
      type: "rpc.response",
      id: request.id,
      ok: true,
      result: { sessionId: "session_after_30_seconds" },
    });
    await expect(run.result).resolves.toEqual({ sessionId: "session_after_30_seconds" });
  });

  it("resolves run.start from done when the final RPC response is missing", async () => {
    const sent: Uint8Array[] = [];
    const client = Object.create(MobileRelayClient.prototype) as MobileRelayClient;
    Object.assign(client, {
      closed: false,
      pending: new Map(),
      subscriptions: new Map(),
      sealer: { seal: (_kind: string, payload: Uint8Array) => payload },
      opener: { open: (payload: Uint8Array) => ({ payload }) },
      socket: { send: (frame: Uint8Array) => sent.push(frame) },
    });
    const onEvent = vi.fn();
    const run = client.startRun(
      { cwd: "/workspace/project", message: "finish reliably" },
      onEvent,
    );
    const request = JSON.parse(new TextDecoder().decode(sent[0])) as {
      params: { subscriptionId: string };
    };
    const doneFrame = new TextEncoder().encode(JSON.stringify({
      type: "rpc.event",
      subscriptionId: request.params.subscriptionId,
      seq: 8,
      event: {
        type: "done",
        sessionId: "session_done_without_response",
        finalText: "Finished",
      },
    }));
    const never = new Promise<Uint8Array>(() => undefined);
    const inbox = {
      next: vi.fn()
        .mockResolvedValueOnce(doneFrame)
        .mockReturnValue(never),
    };
    let completion: unknown = "pending";
    void run.result.then((value) => { completion = value; });

    (client as unknown as { startRpcLoop(input: typeof inbox): void }).startRpcLoop(inbox);

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(completion).toEqual({
      sessionId: "session_done_without_response",
      finalText: "Finished",
    }));
  });
});
