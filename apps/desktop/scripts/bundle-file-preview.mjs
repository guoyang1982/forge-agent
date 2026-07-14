#!/usr/bin/env node
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const rendererDir = join(pkgRoot, "src", "renderer");

// Do not use globalName: it assigns the IIFE return value to window.ForgeFilePreview.
// Our entry sets globalThis.ForgeFilePreview inside the bundle; an undefined return overwrote it.
await esbuild.build({
  entryPoints: [join(rendererDir, "file-preview-entry.js")],
  bundle: true,
  outfile: join(rendererDir, "file-preview.bundle.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  legalComments: "none",
});

await esbuild.build({
  entryPoints: [join(rendererDir, "channel-login-qr-entry.js")],
  bundle: true,
  outfile: join(rendererDir, "channel-login-qr.bundle.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  legalComments: "none",
});

await esbuild.build({
  entryPoints: [join(rendererDir, "terminal-entry.js")],
  bundle: true,
  outfile: join(rendererDir, "terminal.bundle.js"),
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  legalComments: "none",
});

const xtermCssSrc = join(pkgRoot, "node_modules", "@xterm", "xterm", "css", "xterm.css");
const xtermCssDst = join(rendererDir, "xterm.css");
if (existsSync(xtermCssSrc)) {
  copyFileSync(xtermCssSrc, xtermCssDst);
} else {
  console.warn("[forge-desktop] xterm CSS not found, run pnpm install");
}

const hljsCssSrc = join(pkgRoot, "node_modules", "highlight.js", "styles", "github-dark.min.css");
const hljsCssDst = join(rendererDir, "hljs-theme.css");
if (existsSync(hljsCssSrc)) {
  copyFileSync(hljsCssSrc, hljsCssDst);
} else {
  console.warn("[forge-desktop] highlight.js theme CSS not found, run pnpm install");
}

console.log("[forge-desktop] file-preview.bundle.js ready");
console.log("[forge-desktop] channel-login-qr.bundle.js ready");
console.log("[forge-desktop] terminal.bundle.js ready");
