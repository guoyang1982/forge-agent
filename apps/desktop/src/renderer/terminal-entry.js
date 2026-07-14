// Bundled (esbuild) into terminal.bundle.js. Exposes xterm to the renderer's
// classic scripts via a global, mirroring file-preview-entry.js's pattern.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

globalThis.ForgeTerminal = { Terminal, FitAddon };
