#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, "..", "src", "renderer");

await esbuild.build({
  entryPoints: [join(rendererDir, "markdown-preview-entry.js")],
  bundle: true,
  outfile: join(rendererDir, "markdown-preview.bundle.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  legalComments: "none",
});

console.log("[forge-company] markdown-preview.bundle.js ready");
