import { describe, expect, it } from "vitest";
import { readBodyLimited } from "./read-body-limited.js";

describe("readBodyLimited", () => {
  it("keeps the final partial chunk when truncating a streamed body", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.enqueue(new TextEncoder().encode(" world"));
        controller.close();
      },
    });

    const result = await readBodyLimited(new Response(stream), 8);

    expect(result.truncated).toBe(true);
    expect(new TextDecoder().decode(result.bytes)).toBe("hello wo");
  });
});
