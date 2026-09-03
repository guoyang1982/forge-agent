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

  it("keeps usage from a JSON completion", () => {
    const raw = JSON.stringify({
      choices: [{ message: { content: "hello", role: "assistant" } }],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
    });
    expect(parseLlmResponseBody(raw).usage).toEqual({
      promptTokens: 11,
      completionTokens: 2,
      totalTokens: 13,
      source: "api",
    });
  });

  it("keeps usage from a trailing SSE chunk", () => {
    const raw = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}',
      "data: [DONE]",
    ].join("\n");
    const r = parseLlmResponseBody(raw);
    expect(r.text).toBe("ok");
    expect(r.usage).toMatchObject({ promptTokens: 9, completionTokens: 1, source: "api" });
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
