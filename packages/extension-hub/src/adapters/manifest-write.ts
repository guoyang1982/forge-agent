import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginManifest } from "@forge/plugin-registry";
import type { ManifestVariant } from "../manifest-codec.js";
import { pathExists } from "./fs-ops.js";

/**
 * Ensure a deployed plugin package has the agent-specific pointer manifest
 * (`.{agent}-plugin/plugin.json`). If the package already ships one, it is left
 * untouched. Otherwise it is generated from the Forge `plugin.json` (or a
 * minimal fallback). Returns the manifest variant path, or undefined on no-op.
 */
export async function ensureAgentManifest(
  sourcePath: string,
  target: string,
  extId: string,
  toManifest: (forge: PluginManifest) => ManifestVariant,
): Promise<string | undefined> {
  const variant = toManifest({ id: extId, name: extId, version: "0.0.0" }).path;
  if (await pathExists(join(target, variant))) return variant;

  let forge: PluginManifest | null = null;
  try {
    forge = JSON.parse(await readFile(join(sourcePath, "plugin.json"), "utf-8")) as PluginManifest;
  } catch {
    forge = null;
  }
  if (!forge) forge = { id: extId, name: extId, version: "0.0.0" };

  const { manifest } = toManifest(forge);
  const dest = join(target, variant);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return variant;
}
