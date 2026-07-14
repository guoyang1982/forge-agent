import { describe, expect, it } from "vitest";
import {
  computeNextRun,
  shouldCatchUpMissedRun,
  validateCronExpr,
} from "./cron.js";
import { formatCronHuman } from "./cron-human.js";

describe("cron", () => {
  it("computes next weekday 9am in timezone", () => {
    const next = computeNextRun(
      "0 9 * * 1-5",
      "Asia/Shanghai",
      new Date("2026-06-05T00:00:00Z"),
    );
    expect(next).toBeTruthy();
    expect(validateCronExpr("not a cron")).toBe(false);
    expect(validateCronExpr("0 9 * * 1-5")).toBe(true);
  });

  it("detects missed runs", () => {
    expect(
      shouldCatchUpMissedRun(
        "2026-06-05T09:00:00.000Z",
        undefined,
        new Date("2026-06-05T10:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      shouldCatchUpMissedRun(
        "2026-06-05T09:00:00.000Z",
        "2026-06-05T09:30:00.000Z",
        new Date("2026-06-05T10:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      shouldCatchUpMissedRun(
        "2026-06-06T09:00:00.000Z",
        undefined,
        new Date("2026-06-05T10:00:00.000Z"),
      ),
    ).toBe(false);
  });
});

describe("formatCronHuman", () => {
  it("formats common patterns", () => {
    expect(formatCronHuman("0 9 * * 1-5")).toBe("每个工作日 09:00");
    expect(formatCronHuman("0 9 * * 1")).toBe("每周一 09:00");
    expect(formatCronHuman("0 */6 * * *")).toBe("每 6 小时");
    expect(formatCronHuman("0 9 * * *")).toBe("每天 09:00");
    expect(formatCronHuman("30 14 1 * *")).toBe("30 14 1 * *");
  });
});
