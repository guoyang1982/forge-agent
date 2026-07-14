import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { NetworkAction } from "./network-guard.js";

export async function appendNetworkAudit(
  auditDir: string | undefined,
  entry: {
    tool: string;
    action: NetworkAction;
    url?: string;
    query?: string;
    path?: string;
    method?: string;
    ok: boolean;
    bytes?: number;
    sessionId?: string;
  },
): Promise<void> {
  if (!auditDir) return;
  const dir = join(auditDir, "audit");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  });
  await appendFile(join(dir, "network.jsonl"), `${line}\n`, "utf-8");
}
