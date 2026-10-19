import { describe, expect, it } from "vitest";
import { companyRunAutoApply } from "./employee-run-policy.js";

describe("employee run policy", () => {
  it("auto-applies writes only at autonomy L2 and above", () => {
    expect(companyRunAutoApply(0)).toBe(false);
    expect(companyRunAutoApply(1)).toBe(false);
    expect(companyRunAutoApply(2)).toBe(true);
    expect(companyRunAutoApply(undefined)).toBe(true);
    expect(companyRunAutoApply(2, "prod")).toBe(false);
    expect(companyRunAutoApply(2, "staging")).toBe(false);
    expect(companyRunAutoApply(3, "staging")).toBe(true);
    expect(companyRunAutoApply(2, "dev")).toBe(true);
  });
});
