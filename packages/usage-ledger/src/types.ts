export interface ReserveBudgetInput {
  reservationId: string;
  accountId: string;
  runId: string;
  stepId?: string;
  amountMinor: bigint;
  currency: string;
  expiresAt: string;
}

export interface BudgetReservation {
  id: string;
  accountId: string;
  runId: string;
  stepId?: string;
  amountMinor: bigint;
  committedMinor?: bigint;
  currency: string;
  state: "reserved" | "committed" | "released";
  expiresAt: string;
  createdAt: string;
  settledAt?: string;
}

export interface AccountBalance {
  accountId: string;
  currency: string;
  hardLimitMinor?: bigint;
  committedMinor: bigint;
  reservedMinor: bigint;
  availableMinor?: bigint;
}

export interface CreateBudgetAccountInput {
  id: string;
  name: string;
  currency: string;
  parentAccountId?: string;
  hardLimitMinor?: bigint;
  softLimitMinor?: bigint;
}

export interface RecordUsageInput {
  id: string;
  accountId: string;
  reservationId?: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  usageKind: string;
  provider?: string;
  model?: string;
  amountMinor: bigint;
  currency: string;
  dimensions?: Record<string, unknown>;
  recordedAt?: string;
}

export interface BudgetLedger {
  reserve(input: ReserveBudgetInput): BudgetReservation;
  commit(reservationId: string, actualMinor: bigint): BudgetReservation;
  release(reservationId: string, reason: string): BudgetReservation;
  recordUsage(input: RecordUsageInput): void;
  balance(accountId: string): AccountBalance;
}
