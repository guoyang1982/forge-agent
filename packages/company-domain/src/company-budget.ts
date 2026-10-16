export const DEFAULT_COMPANY_BUDGET_HARD_LIMIT_MINOR = 1_000_000n;

export function companyBudgetAccountId(companyId: string): string {
  return `budget:${companyId}`;
}

export function bindCompanyBudgetAccount(
  db: { prepare(sql: string): { run(...args: unknown[]): unknown } },
  input: { companyId: string; accountId: string; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO company_budget_bindings (company_id, account_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT (company_id) DO UPDATE SET account_id = excluded.account_id`,
  ).run(input.companyId, input.accountId, input.createdAt);
}

export function getCompanyBudgetAccountId(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  companyId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT account_id AS accountId FROM company_budget_bindings
      WHERE company_id = ?`,
    )
    .get(companyId) as { accountId: string } | undefined;
  return row?.accountId;
}

/**
 * Idempotently create the company ledger account and bind it.
 * Used on company create and before governed research starts, so companies
 * created before budget binding still become runnable.
 */
export function ensureCompanyBudgetAccount(
  db: {
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
      run(...args: unknown[]): unknown;
    };
  },
  input: {
    companyId: string;
    companyName?: string;
    createdAt: string;
    createAccount: (account: {
      id: string;
      name: string;
      currency: "USD";
      hardLimitMinor: bigint;
    }) => void;
    hardLimitMinor?: bigint;
  },
): string {
  const existing = getCompanyBudgetAccountId(db, input.companyId);
  if (existing) return existing;

  const accountId = companyBudgetAccountId(input.companyId);
  const ledgerRow = db
    .prepare(`SELECT id FROM core_budget_accounts WHERE id = ?`)
    .get(accountId) as { id: string } | undefined;
  if (!ledgerRow) {
    input.createAccount({
      id: accountId,
      name: `${input.companyName?.trim() || "Company"} 经营预算`,
      currency: "USD",
      hardLimitMinor: input.hardLimitMinor ?? DEFAULT_COMPANY_BUDGET_HARD_LIMIT_MINOR,
    });
  }
  bindCompanyBudgetAccount(db, {
    companyId: input.companyId,
    accountId,
    createdAt: input.createdAt,
  });
  return accountId;
}

export function companyBudgetAllowsRun(balance?: {
  availableMinor?: number | bigint | null;
}): boolean {
  if (!balance || balance.availableMinor == null) return true;
  return BigInt(balance.availableMinor) > 0n;
}
