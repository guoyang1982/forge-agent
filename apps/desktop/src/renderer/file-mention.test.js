import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function loadModule() {
  const source = readFileSync(join(here, "file-mention.js"), "utf-8");
  const sandbox = {};
  const fakeDocument = { addEventListener() {}, activeElement: null };
  // Shadow `window`/`document` so the IIFE registers into the sandbox.
  new Function("window", "document", source)(sandbox, fakeDocument);
  return sandbox.ForgeFileMention;
}

/** Minimal element stub for the palette container. */
function fakePalette() {
  return {
    classList: {
      hidden: true,
      add(c) {
        if (c === "hidden") this.hidden = true;
      },
      remove(c) {
        if (c === "hidden") this.hidden = false;
      },
      contains(c) {
        return c === "hidden" ? this.hidden : false;
      },
    },
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
  };
}

function fakeInput() {
  const listeners = {};
  return {
    value: "",
    selectionStart: 0,
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    contains: () => false,
    focus() {},
    setSelectionRange(s) {
      this.selectionStart = s;
    },
    fire(type, ev = {}) {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
  };
}

describe("file mention palette", () => {
  it("opens on an @token at the caret and filters by basename first", async () => {
    const api = loadModule();
    const input = fakeInput();
    const palette = fakePalette();
    const listDir = vi.fn(async () => ({
      items: [
        { type: "file", name: "ra.py", path: "ra.py" },
        { type: "file", name: "rapid.md", path: "docs/rapid.md" },
        { type: "dir", name: "node_modules", path: "node_modules" },
        { type: "dir", name: "docs", path: "docs" },
      ],
    }));
    api.init({ input, paletteEl: palette, listDir, getCwd: () => "/x" });

    input.value = "改一下 @ra";
    input.selectionStart = input.value.length;
    input.fire("input");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(palette.classList.hidden).toBe(false);
    expect(palette.innerHTML).toContain("ra.py");
    // node_modules must not be walked
    const walked = listDir.mock.calls.map((c) => c[0]);
    expect(walked).not.toContain("node_modules");
  });

  it("stays closed without an @token and closes when token breaks", () => {
    const api = loadModule();
    const input = fakeInput();
    const palette = fakePalette();
    api.init({
      input,
      paletteEl: palette,
      listDir: async () => ({ items: [] }),
      getCwd: () => "/x",
    });

    input.value = "普通消息没有引用";
    input.selectionStart = input.value.length;
    input.fire("input");
    expect(palette.classList.hidden).toBe(true);

    input.value = "邮箱 a@b.com 不触发";
    input.selectionStart = input.value.length;
    input.fire("input");
    expect(palette.classList.hidden).toBe(true);
  });
});

describe("composer integration", () => {
  it("Enter/history defer to either open palette", () => {
    const appSource = readFileSync(join(here, "app.js"), "utf-8");
    expect(appSource).toContain("function composerPaletteOpen()");
    expect(appSource).toContain("if (composerPaletteOpen()) return;");
    expect(appSource).toContain("if (!composerPaletteOpen()) handlePromptHistoryKey(e);");
    expect(appSource).toContain("bindFileMention();");
  });
});
