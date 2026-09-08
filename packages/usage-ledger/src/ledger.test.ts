import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import {
  BudgetExceededError,
  BudgetLedgerService,
  CurrencyMismatchError,
  ReservationExpiredError,
} from "./ledger.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("BudgetLedgerService", () => {
  it("prevents concurrent reservations from exceeding the hard limit", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    ledger.reserve(reservation("a", 700n));
    expect(() => ledger.reserve(reservation("b", 400n))).toThrow(BudgetExceededError);
  });

  it("commits actual usage and releases the unused remainder", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    const reserved = ledger.reserve(reservation("a", 700n));
    ledger.commit(reserved.id, 450n);
    expect(ledger.balance("account-1")).toMatchObject({
      committedMinor: 450n,
      reservedMinor: 0n,
    });
  });

  it("releases an unused reservation back to available budget", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    const reserved = ledger.reserve(reservation("a", 700n));
    ledger.release(reserved.id, "step cancelled");
    expect(ledger.balance("account-1")).toMatchObject({
      committedMinor: 0n,
      reservedMinor: 0n,
      availableMinor: 1000n,
    });
  });

  it("enforces parent account limits for child reservations", () => {
    const ledger = budgetFixture({
      limitMinor: 1000n,
      child: { id: "child-1", limitMinor: 800n },
    });
    ledger.reserve({
      ...reservation("parent-res", 700n),
      accountId: "account-1",
    });
    expect(() =>
      ledger.reserve({
        ...reservation("child-res", 400n),
        accountId: "child-1",
      }),
    ).toThrow(BudgetExceededError);
  });

  it("counts child reservations against the parent account total", () => {
    const ledger = budgetFixture({
      limitMinor: 1000n,
      children: [
        { id: "child-1", limitMinor: 800n },
        { id: "child-2", limitMinor: 800n },
      ],
    });
    ledger.reserve({
      ...reservation("child-1-res", 700n),
      accountId: "child-1",
    });
    expect(() =>
      ledger.reserve({
        ...reservation("child-2-res", 700n),
        accountId: "child-2",
      }),
    ).toThrow(BudgetExceededError);
    expect(ledger.balance("account-1")).toMatchObject({
      reservedMinor: 700n,
      availableMinor: 300n,
    });
  });

  it("rejects currency mismatches", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    expect(() =>
      ledger.reserve({
        ...reservation("a", 100n),
        currency: "EUR",
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("ignores expired reservations when computing available budget", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    ledger.reserve({
      ...reservation("expired", 700n),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(ledger.balance("account-1").reservedMinor).toBe(0n);
    expect(() => ledger.reserve(reservation("fresh", 900n))).not.toThrow();
  });

  it("rejects commits against expired reservations", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    const reserved = ledger.reserve({
      ...reservation("expired", 700n),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(() => ledger.commit(reserved.id, 100n)).toThrow(ReservationExpiredError);
  });

  it("renews a reservation so a late commit still settles", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    const reserved = ledger.reserve({
      ...reservation("long-task", 700n),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    ledger.renew(reserved.id, new Date(Date.now() + 60_000).toISOString());
    expect(ledger.commit(reserved.id, 100n).state).toBe("committed");
    expect(ledger.balance("account-1").committedMinor).toBe(100n);
  });

  it("rejects expired renewal when another reservation has used the capacity", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    const expiredAt = "2020-01-01T00:00:00.000Z";
    ledger.reserve({ ...reservation("old", 700n), expiresAt: expiredAt });
    ledger.reserve(reservation("new", 900n));
    expect(() => ledger.renew("old", reservation("unused", 0n).expiresAt))
      .toThrow(BudgetExceededError);
    expect(ledger.getReservation("old").expiresAt).toBe(expiredAt);
    expect(ledger.balance("account-1").reservedMinor).toBe(900n);
  });

  it("checks sibling usage on expired renewal without double counting active renewals", () => {
    const ledger = budgetFixture({ limitMinor: 1000n, children: [
      { id: "child-1", limitMinor: 1000n },
      { id: "child-2", limitMinor: 1000n },
    ] });
    ledger.reserve({ ...reservation("old", 700n), accountId: "child-1",
      expiresAt: "2020-01-01T00:00:00.000Z" });
    const fresh = ledger.reserve({ ...reservation("new", 900n), accountId: "child-2" });
    expect(() => ledger.renew("new", fresh.expiresAt)).not.toThrow();
    expect(() => ledger.renew("old", fresh.expiresAt)).toThrow(BudgetExceededError);
    expect(ledger.balance("account-1").reservedMinor).toBe(900n);
  });

  it("records direct usage with provider and model dimensions", () => {
    const ledger = budgetFixture({ limitMinor: 1000n });
    ledger.recordUsage({
      id: "usage-1",
      accountId: "account-1",
      usageKind: "model.tokens",
      provider: "openai",
      model: "gpt-test",
      amountMinor: 120n,
      currency: "USD",
      dimensions: { version: "v2" },
    });
    expect(ledger.balance("account-1").committedMinor).toBe(120n);
  });
});

function budgetFixture(options: {
  limitMinor: bigint;
  child?: { id: string; limitMinor: bigint };
  children?: Array<{ id: string; limitMinor: bigint }>;
}) {
  const store = openStore();
  const ledger = new BudgetLedgerService(store.db);
  ledger.createAccount({
    id: "account-1",
    name: "root",
    currency: "USD",
    hardLimitMinor: options.limitMinor,
  });
  const children = options.children ?? (options.child ? [options.child] : []);
  for (const child of children) {
    ledger.createAccount({
      id: child.id,
      name: child.id,
      currency: "USD",
      parentAccountId: "account-1",
      hardLimitMinor: child.limitMinor,
    });
  }
  return ledger;
}

function reservation(id: string, amountMinor: bigint) {
  return {
    reservationId: id,
    accountId: "account-1",
    runId: "run-1",
    amountMinor,
    currency: "USD",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "forge-usage-ledger-"));
  fixtureRoots.push(root);
  return ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
}
