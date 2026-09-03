import { describe, expect, it } from "vitest";
import { LlmError } from "./errors.js";

describe("LlmError.fromHttp", () => {
  it("explains DeepSeek 402 insufficient balance in Chinese", () => {
    const error = LlmError.fromHttp(
      402,
      JSON.stringify({
        error: { message: "Insufficient Balance", type: "invalid_request_error" },
      }),
    );
    expect(error.status).toBe(402);
    expect(error.message).toContain("余额不足");
    expect(error.message).toContain("充值");
    expect(error.message).toContain("Insufficient Balance");
  });
});
