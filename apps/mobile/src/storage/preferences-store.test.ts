import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("expo-file-system", () => {
  class FakeFile {
    private readonly key: string;
    constructor(..._uris: unknown[]) {
      this.key = "forge-mobile-preferences.v1.json";
    }
    get exists() {
      return files.has(this.key);
    }
    create() {
      files.set(this.key, "");
    }
    write(content: string) {
      files.set(this.key, content);
    }
    textSync() {
      const value = files.get(this.key);
      if (value === undefined) throw new Error("File does not exist");
      return value;
    }
  }
  return {
    File: FakeFile,
    Paths: { document: {} },
  };
});

import { loadLastHostId, saveLastHostId } from "./preferences-store.js";

describe("Mobile non-secret preference storage", () => {
  beforeEach(() => files.clear());

  it("returns null when no preference file has been written yet", async () => {
    await expect(loadLastHostId()).resolves.toBeNull();
  });

  it("round-trips the last selected host id", async () => {
    await saveLastHostId("host_abc");
    await expect(loadLastHostId()).resolves.toBe("host_abc");
  });

  it("overwrites the previous preference on repeated selection", async () => {
    await saveLastHostId("host_abc");
    await saveLastHostId("host_def");
    await expect(loadLastHostId()).resolves.toBe("host_def");
  });

  it("clears the stored host id when null is saved", async () => {
    await saveLastHostId("host_abc");
    await saveLastHostId(null);
    await expect(loadLastHostId()).resolves.toBeNull();
  });

  it("returns null when the stored file contains malformed JSON", async () => {
    await saveLastHostId("host_abc");
    files.set("forge-mobile-preferences.v1.json", "{not json");
    await expect(loadLastHostId()).resolves.toBeNull();
  });
});
