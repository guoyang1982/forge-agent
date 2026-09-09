import { describe, expect, it } from "vitest";
import { createProductShellMenuTemplate, routeForgeDeepLink } from "./product-shell-menu.js";

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
    expect(routeForgeDeepLink("forge://workbench/run/r_8f21")).toBe("workbench");
  });
});
