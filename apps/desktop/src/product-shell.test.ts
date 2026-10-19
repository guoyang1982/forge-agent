import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProductShellMenuTemplate, routeForgeDeepLink } from "./product-shell-menu.js";

const distDir = join(import.meta.dirname, "../dist");

describe("product shell menu", () => {
  it("builds a Window menu with workbench ⌘1 and company ⌘2", () => {
    const template = createProductShellMenuTemplate();
    const windowMenu = template.find((item) => item.label === "窗口");
    expect(windowMenu?.submenu).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "工作台", accelerator: "CmdOrCtrl+1" }),
        expect.objectContaining({ label: "公司", accelerator: "CmdOrCtrl+2" }),
      ]),
    );
  });

  it("routes company home links to company and run links to workbench", () => {
    expect(routeForgeDeepLink("forge://company/home")).toBe("company");
    expect(routeForgeDeepLink("forge://company/work/work_8f21")).toBe("company");
    expect(routeForgeDeepLink("forge://workbench/run/r_8f21")).toBe("workbench");
    expect(routeForgeDeepLink("forge://workbench/session/s_8f21")).toBe("workbench");
  });
});

describe("product shell desktop build", () => {
  it("registers company:invoke and forwards it to the daemon", () => {
    const compiledShell = readFileSync(join(distDir, "product-shell.js"), "utf8");
    const compiledMain = readFileSync(join(distDir, "main.js"), "utf8");
    expect(compiledShell).toContain('ipcMain.handle("company:invoke"');
    expect(compiledMain).toContain("requestDaemonMethod");
  });

  it("opens company work items from forge://company/work links", () => {
    const source = readFileSync(join(import.meta.dirname, "product-shell.ts"), "utf8");
    expect(source).toContain('ipcMain.handle("forge:open-company"');
    expect(source).toContain("company:open-work");
    expect(source).toContain("parseForgeDeepLink");
    expect(source).toContain("workbenchTargetFromLink");
    expect(source).toContain('link.kind === "session"');
  });
});
