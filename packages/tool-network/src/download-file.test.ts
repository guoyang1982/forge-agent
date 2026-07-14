import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadFile } from "./download-file.js";

describe("downloadFile", () => {
  let workDir: string;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("writes response bytes to destination", async () => {
    workDir = await mkdtemp(join(tmpdir(), "forge-download-"));
    const dest = join(workDir, "nested", "out.txt");
    const payload = "hello download";

    const result = await downloadFile("https://example.com/file.txt", dest, {
      fetchImpl: async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(payload.length);
    expect(await readFile(dest, "utf-8")).toBe(payload);
  });

  it("blocks localhost URLs", async () => {
    workDir = await mkdtemp(join(tmpdir(), "forge-download-"));
    const dest = join(workDir, "out.txt");
    const result = await downloadFile("http://localhost/secret", dest);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Blocked host/);
  });
});
