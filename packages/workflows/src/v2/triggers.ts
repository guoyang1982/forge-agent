import type { Database } from "@forge/store";

export interface TriggerAcceptInput {
  source: string;
  externalId: string;
}

export class TriggerStore {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_workflow_trigger_receipts (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );
    `);
  }

  accept(input: TriggerAcceptInput): boolean {
    const acceptedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO core_workflow_trigger_receipts (
          source, external_id, accepted_at
        ) VALUES (?, ?, ?)`,
      )
      .run(input.source, input.externalId, acceptedAt);
    return result.changes === 1;
  }
}
