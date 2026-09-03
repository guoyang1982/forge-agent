import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type {
  AccountBalance,
  BudgetReservation,
  CreateBudgetAccountInput,
  RecordUsageInput,
  ReserveBudgetInput,
} from "./types.js";

export class BudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED" as const;

  constructor(message = "BUDGET_EXCEEDED") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class CurrencyMismatchError extends Error {
  readonly code = "CURRENCY_MISMATCH" as const;

  constructor(message = "CURRENCY_MISMATCH") {
    super(message);
    this.name = "CurrencyMismatchError";
  }
}

export class ReservationExpiredError extends Error {
  readonly code = "RESERVATION_EXPIRED" as const;

  constructor(message = "RESERVATION_EXPIRED") {
    super(message);
    this.name = "ReservationExpiredError";
  }
}

export class BudgetLedgerService {
  constructor(private readonly db: Database) {}

  createAccount(input: CreateBudgetAccountInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO core_budget_accounts (
          id, parent_account_id, name, currency, hard_limit_minor, soft_limit_minor,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.parentAccountId ?? null,
        input.name,
        input.currency,
        input.hardLimitMinor == null ? null : Number(input.hardLimitMinor),
        input.softLimitMinor == null ? null : Number(input.softLimitMinor),
        now,
        now,
      );
  }

  reserve(input: ReserveBudgetInput): BudgetReservation {
    const createdAt = new Date().toISOString();
    return this.db.transaction(() => {
      const account = this.getAccount(input.accountId);
      if (account.currency !== input.currency) {
        throw new CurrencyMismatchError();
      }
      this.assertWithinLimits(input.accountId, input.amountMinor, account.currency);
      this.db
        .prepare(
          `INSERT INTO core_budget_reservations (
            id, account_id, run_id, step_id, amount_minor, currency, state,
            expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          input.reservationId,
          input.accountId,
          input.runId,
          input.stepId ?? null,
          Number(input.amountMinor),
          input.currency,
          input.expiresAt,
          createdAt,
        );
      return this.getReservation(input.reservationId);
    })();
  }

  commit(reservationId: string, actualMinor: bigint): BudgetReservation {
    const settledAt = new Date().toISOString();
    return this.db.transaction(() => {
      const reservation = this.getReservation(reservationId);
      if (reservation.state !== "reserved") {
        throw new Error(`reservation is not active: ${reservationId}`);
      }
      if (reservation.expiresAt <= settledAt) {
        throw new ReservationExpiredError();
      }
      if (actualMinor > reservation.amountMinor) {
        throw new BudgetExceededError("actual usage exceeds reservation");
      }

      this.db
        .prepare(
          `UPDATE core_budget_reservations
           SET state = 'committed', committed_minor = ?, settled_at = ?
           WHERE id = ?`,
        )
        .run(Number(actualMinor), settledAt, reservationId);

      this.recordUsage({
        id: randomUUID(),
        accountId: reservation.accountId,
        reservationId,
        runId: reservation.runId,
        stepId: reservation.stepId,
        usageKind: "budget.commit",
        amountMinor: actualMinor,
        currency: reservation.currency,
        recordedAt: settledAt,
      });

      return this.getReservation(reservationId);
    })();
  }

  release(reservationId: string, reason: string): BudgetReservation {
    const settledAt = new Date().toISOString();
    void reason;
    this.db
      .prepare(
        `UPDATE core_budget_reservations
         SET state = 'released', settled_at = ?
         WHERE id = ? AND state = 'reserved'`,
      )
      .run(settledAt, reservationId);
    return this.getReservation(reservationId);
  }

  recordUsage(input: RecordUsageInput): void {
    const account = this.getAccount(input.accountId);
    if (account.currency !== input.currency) {
      throw new CurrencyMismatchError();
    }
    this.db
      .prepare(
        `INSERT INTO core_usage_entries (
          id, account_id, reservation_id, run_id, step_id, attempt_id,
          usage_kind, provider, model, amount_minor, currency, dimensions_json,
          recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.accountId,
        input.reservationId ?? null,
        input.runId ?? null,
        input.stepId ?? null,
        input.attemptId ?? null,
        input.usageKind,
        input.provider ?? null,
        input.model ?? null,
        Number(input.amountMinor),
        input.currency,
        JSON.stringify(input.dimensions ?? {}),
        input.recordedAt ?? new Date().toISOString(),
      );
  }

  balance(accountId: string): AccountBalance {
    const account = this.getAccount(accountId);
    const now = new Date().toISOString();
    const committedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM core_usage_entries
         WHERE account_id = ?`,
      )
      .get(accountId) as { total: number };
    const reservedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM core_budget_reservations
         WHERE account_id = ?
           AND state = 'reserved'
           AND expires_at > ?`,
      )
      .get(accountId, now) as { total: number };

    const committedMinor = BigInt(committedRow.total);
    const reservedMinor = BigInt(reservedRow.total);
    const hardLimitMinor =
      account.hardLimitMinor == null ? undefined : BigInt(account.hardLimitMinor);
    const availableMinor =
      hardLimitMinor == null
        ? undefined
        : hardLimitMinor - committedMinor - reservedMinor;

    return {
      accountId,
      currency: account.currency,
      hardLimitMinor,
      committedMinor,
      reservedMinor,
      availableMinor,
    };
  }

  private assertWithinLimits(
    accountId: string,
    additionalMinor: bigint,
    currency: string,
  ): void {
    for (const chainAccountId of this.accountChain(accountId)) {
      const balance = this.balance(chainAccountId);
      if (balance.currency !== currency) {
        throw new CurrencyMismatchError();
      }
      if (balance.hardLimitMinor == null) {
        continue;
      }
      const projected = balance.committedMinor + balance.reservedMinor + additionalMinor;
      if (projected > balance.hardLimitMinor) {
        throw new BudgetExceededError();
      }
    }
  }

  private accountChain(accountId: string): string[] {
    const chain: string[] = [];
    let current: string | null = accountId;
    while (current) {
      chain.push(current);
      const row = this.db
        .prepare(`SELECT parent_account_id FROM core_budget_accounts WHERE id = ?`)
        .get(current) as { parent_account_id: string | null } | undefined;
      current = row?.parent_account_id ?? null;
    }
    return chain;
  }

  private getAccount(accountId: string): {
    currency: string;
    hardLimitMinor: number | null;
  } {
    const row = this.db
      .prepare(
        `SELECT currency, hard_limit_minor
         FROM core_budget_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { currency: string; hard_limit_minor: number | null } | undefined;
    if (!row) {
      throw new Error(`budget account not found: ${accountId}`);
    }
    return { currency: row.currency, hardLimitMinor: row.hard_limit_minor };
  }

  getReservation(reservationId: string): BudgetReservation {
    const row = this.db
      .prepare(
        `SELECT id, account_id, run_id, step_id, amount_minor, committed_minor,
                currency, state, expires_at, created_at, settled_at
         FROM core_budget_reservations
         WHERE id = ?`,
      )
      .get(reservationId) as ReservationRow | undefined;
    if (!row) {
      throw new Error(`reservation not found: ${reservationId}`);
    }
    return mapReservation(row);
  }
}

type ReservationRow = {
  id: string;
  account_id: string;
  run_id: string;
  step_id: string | null;
  amount_minor: number;
  committed_minor: number | null;
  currency: string;
  state: "reserved" | "committed" | "released";
  expires_at: string;
  created_at: string;
  settled_at: string | null;
};

function mapReservation(row: ReservationRow): BudgetReservation {
  return {
    id: row.id,
    accountId: row.account_id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    amountMinor: BigInt(row.amount_minor),
    committedMinor: row.committed_minor == null ? undefined : BigInt(row.committed_minor),
    currency: row.currency,
    state: row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    settledAt: row.settled_at ?? undefined,
  };
}

export { mapReservation };
