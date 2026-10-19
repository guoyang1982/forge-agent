import { expect, it } from "vitest";
import { assertCompanyInvokeMethod } from "./product-shell.js";

it("allows company.create and rejects run.create", () => {
  expect(assertCompanyInvokeMethod("company.create")).toBe("company.create");
  expect(() => assertCompanyInvokeMethod("run.create")).toThrow(/blocked method/);
});
