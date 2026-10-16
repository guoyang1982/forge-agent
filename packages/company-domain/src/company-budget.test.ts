import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./company-service.js";
import {
  bindCompanyBudgetAccount,
  companyBudgetAccountId,
  companyBudgetAllowsRun,
  ensureCompanyBudgetAccount,
  getCompanyBudgetAccountId,
} from "./company-budget.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("company budget", () => {
  it("binds a ledger account and blocks a drained balance", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-co-budget-"));
    roots.push(root);
    const store = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    stores.push(store);
    const company = new CompanyService(store.db, { now: () => "2026-09-11T00:00:00.000Z" })
      .create({ name: "曜石" });
    bindCompanyBudgetAccount(store.db, {
      companyId: company.id,
      accountId: "acc_1",
      createdAt: "2026-09-11T00:00:00.000Z",
    });
    expect(getCompanyBudgetAccountId(store.db, company.id)).toBe("acc_1");
    expect(companyBudgetAllowsRun({ availableMinor: 12 })).toBe(true);
    expect(companyBudgetAllowsRun({ availableMinor: 0 })).toBe(false);
    expect(companyBudgetAllowsRun(undefined)).toBe(true);
  });

  it("ensures a ledger account and binding for companies created without one", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-co-budget-ensure-"));
    roots.push(root);
    const store = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    stores.push(store);
    const company = new CompanyService(store.db, { now: () => "2026-09-11T00:00:00.000Z" })
      .create({ name: "曜石" });
    expect(getCompanyBudgetAccountId(store.db, company.id)).toBeUndefined();

    const created: string[] = [];
    const accountId = ensureCompanyBudgetAccount(store.db, {
      companyId: company.id,
      companyName: company.name,
      createdAt: "2026-09-11T00:00:00.000Z",
      createAccount: (account) => {
        created.push(account.id);
        store.db.prepare(
          `INSERT INTO core_budget_accounts (
            id, parent_account_id, name, currency, hard_limit_minor, soft_limit_minor,
            created_at, updated_at
          ) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          account.id,
          account.name,
          account.currency,
          Number(account.hardLimitMinor),
          "2026-09-11T00:00:00.000Z",
          "2026-09-11T00:00:00.000Z",
        );
      },
    });

    expect(accountId).toBe(companyBudgetAccountId(company.id));
    expect(created).toEqual([accountId]);
    expect(getCompanyBudgetAccountId(store.db, company.id)).toBe(accountId);
    expect(
      ensureCompanyBudgetAccount(store.db, {
        companyId: company.id,
        createdAt: "2026-09-11T00:01:00.000Z",
        createAccount: () => {
          throw new Error("should not recreate");
        },
      }),
    ).toBe(accountId);
  });
});
