import { describe, expect, it } from "vitest";
import {
  bodyLooksLikeSse,
  extractSseJsonPayload,
  parseLlmResponseBody,
} from "./sse.js";

describe("extractSseJsonPayload", () => {
  it("strips data: prefix with space", () => {
    expect(extractSseJsonPayload('data: {"x":1}')).toBe('{"x":1}');
  });

  it("strips data: prefix without space", () => {
    expect(extractSseJsonPayload('data:{"id":"1"}')).toBe('{"id":"1"}');
  });
});

describe("parseLlmResponseBody", () => {
  it("parses SSE stream body", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      "data: [DONE]",
    ].join("\n");
    const r = parseLlmResponseBody(raw);
    expect(r.text).toBe("你好");
  });

  it("parses plain JSON completion", () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: "hello", role: "assistant" } }],
    });
    const r = parseLlmResponseBody(raw);
    expect(r.text).toBe("hello");
  });

  it("does not throw on data: prefixed body (was breaking res.json())", () => {
    const raw = 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"ok"}}]}';
    expect(() => parseLlmResponseBody(raw)).not.toThrow();
    expect(parseLlmResponseBody(raw).text).toBe("ok");
  });
});

describe("bodyLooksLikeSse", () => {
  it("detects SSE", () => {
    expect(bodyLooksLikeSse('data: {"a":1}')).toBe(true);
    expect(bodyLooksLikeSse('{"a":1}')).toBe(false);
  });
});
