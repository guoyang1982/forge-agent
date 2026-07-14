import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ChannelStore } from "./store.js";

function bootDb(): Database.Database {
  const db = new Database(":memory:");
  const sql = readFileSync(
    join(process.cwd(), "../../migrations/004_channels.sql"),
    "utf-8",
  );
  db.exec(sql);
  return db;
}

describe("ChannelStore", () => {
  it("stores the latest reply context for a binding", () => {
    const store = new ChannelStore(bootDb());
    store.upsertBinding({
      channelId: "channel-a",
      channel: "ilink",
      threadKey: "direct:user-1",
      sessionId: "session-1",
      cwd: "/tmp/proj",
      peerUserId: "user-1",
      lastContextToken: "ctx-1",
    });

    const binding = store.findLatestBinding({
      channel: "ilink",
      cwd: "/tmp/proj",
    });

    expect(binding).toMatchObject({
      channelId: "channel-a",
      channel: "ilink",
      threadKey: "direct:user-1",
      peerUserId: "user-1",
      lastContextToken: "ctx-1",
    });
  });

  it("keeps bindings isolated by channel id for the same thread", () => {
    const store = new ChannelStore(bootDb());
    store.upsertBinding({
      channelId: "channel-a",
      channel: "ilink",
      threadKey: "direct:user-1",
      sessionId: "session-a",
      cwd: "/tmp/a",
    });
    store.upsertBinding({
      channelId: "channel-b",
      channel: "ilink",
      threadKey: "direct:user-1",
      sessionId: "session-b",
      cwd: "/tmp/b",
    });

    expect(store.getBinding("channel-a", "direct:user-1")?.sessionId).toBe("session-a");
    expect(store.getBinding("channel-b", "direct:user-1")?.sessionId).toBe("session-b");
    expect(
      store.findLatestBinding({
        channel: "ilink",
        channelId: "channel-a",
        cwd: "/tmp/a",
      })?.sessionId,
    ).toBe("session-a");
  });
});
