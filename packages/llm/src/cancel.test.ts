import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmClient } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

describe("LlmClient cancellation", () => {
  it("aborts while an SSE reader is waiting for the next chunk", async () => {
    let streamCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(": stream opened and now stalls\n\n"),
              );
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const abort = new AbortController();
    const client = new LlmClient({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      name: "test-model",
    });
    const result = client.chat({
      messages: [{ role: "user", content: "wait" }],
      tools: [],
      signal: abort.signal,
      onTextDelta: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(streamCancelled).toBe(true);
  });
});
