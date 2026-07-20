import { describe, expect, it } from "vitest";
import { ConnectionGenerations } from "./connection-generations.js";

describe("ConnectionGenerations", () => {
  it("makes only the latest generation current for each host", () => {
    const generations = new ConnectionGenerations();
    const first = generations.begin("host-a");
    const otherHost = generations.begin("host-b");
    const second = generations.begin("host-a");

    expect(second).toBeGreaterThan(first);
    expect(generations.isCurrent("host-a", first)).toBe(false);
    expect(generations.isCurrent("host-a", second)).toBe(true);
    expect(generations.isCurrent("host-b", otherHost)).toBe(true);
  });

  it("invalidates a pending attempt without disposing other hosts", () => {
    const generations = new ConnectionGenerations();
    const hostA = generations.begin("host-a");
    const hostB = generations.begin("host-b");

    generations.invalidate("host-a");

    expect(generations.isCurrent("host-a", hostA)).toBe(false);
    expect(generations.isCurrent("host-b", hostB)).toBe(true);
  });

  it("invalidates every generation permanently when disposed", () => {
    const generations = new ConnectionGenerations();
    const hostA = generations.begin("host-a");
    const hostB = generations.begin("host-b");

    generations.dispose();

    expect(generations.disposed).toBe(true);
    expect(generations.isCurrent("host-a", hostA)).toBe(false);
    expect(generations.isCurrent("host-b", hostB)).toBe(false);
    expect(generations.isCurrent("host-a", generations.begin("host-a"))).toBe(false);
  });
});
