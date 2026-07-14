import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AutomationStore } from "./store.js";

function bootDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(
    join(process.cwd(), "../../migrations/003_automations.sql"),
    "utf-8",
  );
  db.exec(sql);
  return db;
}

describe("AutomationStore", () => {
  it("creates cron automation with next_run_at", () => {
    const store = new AutomationStore(bootDb());
    const row = store.create({
      name: "Morning",
      cwd: "/tmp/proj",
      trigger: { type: "cron", cron: "0 9 * * 1-5", timezone: "UTC" },
      prompt: "Summarize today",
      enabled: true,
    });
    expect(row.id).toBeTruthy();
    expect(row.nextRunAt).toBeTruthy();
    expect(row.trigger).toEqual({
      type: "cron",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    });
  });

  it("round-trips completion notification settings", () => {
    const store = new AutomationStore(bootDb());
    const created = store.create({
      name: "Push report",
      cwd: "/tmp/proj",
      trigger: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
      prompt: "Summarize today",
      notify: {
        enabled: true,
        channelKind: "ilink",
      },
    });

    expect(created.notify).toEqual({
      enabled: true,
      channelKind: "ilink",
    });

    const updated = store.update(created.id, {
      notify: { enabled: false },
    });

    expect(updated?.notify).toEqual({ enabled: false });
    expect(store.get(created.id)?.notify).toEqual({ enabled: false });
  });

  it("round-trips webhook notification channel kinds", () => {
    const store = new AutomationStore(bootDb());
    const created = store.create({
      name: "Push report",
      cwd: "/tmp/proj",
      trigger: { type: "manual" },
      prompt: "Summarize today",
      notify: {
        enabled: true,
        channelKind: "feishu",
        channelId: "channel-1",
      },
    });

    expect(store.get(created.id)?.notify).toEqual({
      enabled: true,
      channelKind: "feishu",
      channelId: "channel-1",
    });
  });

  it("CRUD and runs lifecycle", () => {
    const store = new AutomationStore(bootDb());
    const created = store.create({
      name: "Manual job",
      cwd: "/tmp/a",
      trigger: { type: "manual" },
      prompt: "Do work",
    });
    expect(store.get(created.id)?.name).toBe("Manual job");

    const updated = store.update(created.id, { enabled: true, name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.enabled).toBe(true);

    const other = store.create({
      name: "Other",
      cwd: "/tmp/b",
      trigger: { type: "manual" },
      prompt: "Other",
    });
    expect(store.list({ cwd: "/tmp/a" })).toHaveLength(1);
    expect(store.list()).toHaveLength(2);

    const run = store.insertRun({
      automationId: created.id,
      sessionId: "sess-1",
      status: "running",
      trigger: "manual",
    });
    expect(store.hasRunningRun(created.id)).toBe(true);

    const finished = store.finishRun(run.id, {
      status: "success",
      preview: "done",
    });
    expect(finished?.status).toBe("success");
    expect(finished?.preview).toBe("done");
    expect(store.hasRunningRun(created.id)).toBe(false);

    store.touchLastRun(created.id, "2026-06-05T10:00:00.000Z");
    expect(store.get(created.id)?.lastRunAt).toBe("2026-06-05T10:00:00.000Z");

    store.setNextRunAt(other.id, "2026-06-06T09:00:00.000Z");
    expect(store.get(other.id)?.nextRunAt).toBe("2026-06-06T09:00:00.000Z");

    expect(store.delete(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
    expect(store.listRuns(created.id)).toHaveLength(0);
  });

  it("lists enabled cron automations", () => {
    const store = new AutomationStore(bootDb());
    store.create({
      name: "Cron on",
      cwd: "/tmp",
      trigger: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
      prompt: "x",
      enabled: true,
    });
    store.create({
      name: "Cron off",
      cwd: "/tmp",
      trigger: { type: "cron", cron: "0 10 * * *", timezone: "UTC" },
      prompt: "x",
      enabled: false,
    });
    store.create({
      name: "Manual",
      cwd: "/tmp",
      trigger: { type: "manual" },
      prompt: "x",
      enabled: true,
    });

    const enabled = store.listEnabledCron();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Cron on");
  });
});
