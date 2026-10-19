import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function toCjs(name) {
  const from = join(dist, `${name}.js`);
  const to = join(dist, `${name}.cjs`);
  if (!existsSync(from)) {
    throw new Error(`missing ${from}`);
  }
  rmSync(to, { force: true });
  renameSync(from, to);
}

toCjs("preload-api");
toCjs("preload");

const preloadPath = join(dist, "preload.cjs");
writeFileSync(
  preloadPath,
  readFileSync(preloadPath, "utf8").replaceAll("./preload-api.js", "./preload-api.cjs"),
);
