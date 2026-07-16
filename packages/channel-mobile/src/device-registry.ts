import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";

export interface MobileDeviceRecord {
  adapterId: string;
  deviceId: string;
  displayName?: string;
  credentialVersion: number;
  allowedProjects: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

interface DeviceRow {
  adapter_id: string;
  device_id: string;
  display_name: string | null;
  token_hash: Buffer;
  credential_version: number;
  allowed_projects_json: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface PairingRow {
  pairing_secret_hash: Buffer;
  expires_at: string;
  state: string;
}

export class MobileDeviceRegistry {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly adapterId: string,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  recordPairing(input: {
    deviceId: string;
    inviteId: string;
    pairingSecret: string;
    expiresAt: number;
    displayName?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mobile_pairing_journal
         (adapter_id, device_id, invite_id, display_name, pairing_secret_hash, expires_at, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(adapter_id, device_id) DO UPDATE SET
           invite_id = excluded.invite_id,
           display_name = COALESCE(excluded.display_name, mobile_pairing_journal.display_name),
           pairing_secret_hash = excluded.pairing_secret_hash,
           expires_at = excluded.expires_at,
           state = 'pending',
           created_at = excluded.created_at,
           consumed_at = NULL`,
      )
      .run(
        this.adapterId,
        input.deviceId,
        input.inviteId,
        input.displayName?.slice(0, 100) ?? null,
        hashToken(input.pairingSecret),
        new Date(input.expiresAt).toISOString(),
        now,
      );
  }

  pairingDisplayName(deviceId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT display_name FROM mobile_pairing_journal
         WHERE adapter_id = ? AND device_id = ?`,
      )
      .get(this.adapterId, deviceId) as { display_name: string | null } | undefined;
    return row?.display_name ?? undefined;
  }

  consumePairing(deviceId: string, pairingSecret: string, now = Date.now()): boolean {
    const row = this.db
      .prepare(
        `SELECT pairing_secret_hash, expires_at, state
         FROM mobile_pairing_journal WHERE adapter_id = ? AND device_id = ?`,
      )
      .get(this.adapterId, deviceId) as PairingRow | undefined;
    if (
      !row ||
      row.state !== "pending" ||
      Date.parse(row.expires_at) <= now ||
      !equalHash(row.pairing_secret_hash, pairingSecret)
    ) {
      return false;
    }
    const result = this.db
      .prepare(
        `UPDATE mobile_pairing_journal SET state = 'consumed', consumed_at = ?
         WHERE adapter_id = ? AND device_id = ? AND state = 'pending'`,
      )
      .run(new Date(now).toISOString(), this.adapterId, deviceId);
    return result.changes === 1;
  }

  pendingPairings(now = Date.now()): Array<{ deviceId: string; inviteId: string }> {
    return this.db
      .prepare(
        `SELECT device_id AS deviceId, invite_id AS inviteId
         FROM mobile_pairing_journal
         WHERE adapter_id = ? AND state = 'pending' AND expires_at > ?
           AND invite_id NOT LIKE 'pending_%'`,
      )
      .all(this.adapterId, new Date(now).toISOString()) as Array<{
      deviceId: string;
      inviteId: string;
    }>;
  }

  revokePairing(deviceId: string): void {
    this.db
      .prepare(
        `UPDATE mobile_pairing_journal SET state = 'revoked'
         WHERE adapter_id = ? AND device_id = ? AND state = 'pending'`,
      )
      .run(this.adapterId, deviceId);
  }

  installDevice(input: {
    deviceId: string;
    displayName?: string;
    allowedProjects: string[];
    token?: string;
  }): { device: MobileDeviceRecord; token: string } {
    const token = input.token ?? `device_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mobile_devices
         (adapter_id, device_id, display_name, token_hash, credential_version,
          allowed_projects_json, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)
         ON CONFLICT(adapter_id, device_id) DO UPDATE SET
           display_name = excluded.display_name,
           token_hash = excluded.token_hash,
           credential_version = mobile_devices.credential_version + 1,
           allowed_projects_json = excluded.allowed_projects_json,
           last_seen_at = excluded.last_seen_at,
           revoked_at = NULL`,
      )
      .run(
        this.adapterId,
        input.deviceId,
        input.displayName ?? null,
        hashToken(token),
        JSON.stringify([...new Set(input.allowedProjects)]),
        now,
        now,
      );
    return { device: this.get(input.deviceId)!, token };
  }

  authenticate(deviceId: string, token: string): MobileDeviceRecord | null {
    const row = this.getRow(deviceId);
    if (!row || row.revoked_at || !equalHash(row.token_hash, token)) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE mobile_devices SET last_seen_at = ? WHERE adapter_id = ? AND device_id = ?",
      )
      .run(now, this.adapterId, deviceId);
    return { ...rowToDevice(row), lastSeenAt: now };
  }

  get(deviceId: string): MobileDeviceRecord | null {
    const row = this.getRow(deviceId);
    return row ? rowToDevice(row) : null;
  }

  list(): MobileDeviceRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM mobile_devices WHERE adapter_id = ? ORDER BY created_at DESC",
      )
      .all(this.adapterId) as DeviceRow[];
    return rows.map(rowToDevice);
  }

  updateAllowedProjects(deviceId: string, allowedProjects: string[]): MobileDeviceRecord | null {
    const result = this.db
      .prepare(
        `UPDATE mobile_devices SET allowed_projects_json = ?
         WHERE adapter_id = ? AND device_id = ? AND revoked_at IS NULL`,
      )
      .run(JSON.stringify([...new Set(allowedProjects)]), this.adapterId, deviceId);
    return result.changes === 1 ? this.get(deviceId) : null;
  }

  revoke(deviceId: string): boolean {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE mobile_devices SET revoked_at = ?
           WHERE adapter_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, this.adapterId, deviceId);
      if (result.changes === 1) {
        this.db
          .prepare(
            `INSERT INTO mobile_relay_outbox
             (id, adapter_id, operation, device_id, payload_json, created_at)
             VALUES (?, ?, 'device.revoke', ?, '{}', ?)`,
          )
          .run(randomUUID(), this.adapterId, deviceId, now);
      }
      return result.changes === 1;
    });
    return tx();
  }

  pendingRevocations(): Array<{ id: string; deviceId: string }> {
    return this.db
      .prepare(
        `SELECT id, device_id AS deviceId FROM mobile_relay_outbox
         WHERE adapter_id = ? AND operation = 'device.revoke' AND completed_at IS NULL
         ORDER BY created_at`,
      )
      .all(this.adapterId) as Array<{ id: string; deviceId: string }>;
  }

  completeOutbox(id: string): void {
    this.db
      .prepare(
        `UPDATE mobile_relay_outbox SET completed_at = ?
         WHERE id = ? AND adapter_id = ?`,
      )
      .run(new Date().toISOString(), id, this.adapterId);
  }

  private getRow(deviceId: string): DeviceRow | undefined {
    return this.db
      .prepare("SELECT * FROM mobile_devices WHERE adapter_id = ? AND device_id = ?")
      .get(this.adapterId, deviceId) as DeviceRow | undefined;
  }
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equalHash(expected: Buffer, value: string): boolean {
  const actual = hashToken(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function rowToDevice(row: DeviceRow): MobileDeviceRecord {
  let allowedProjects: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_projects_json) as unknown;
    if (Array.isArray(parsed)) {
      allowedProjects = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Treat corrupt grants as no access.
  }
  return {
    adapterId: row.adapter_id,
    deviceId: row.device_id,
    displayName: row.display_name ?? undefined,
    credentialVersion: row.credential_version,
    allowedProjects,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  };
}
