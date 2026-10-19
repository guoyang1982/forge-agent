import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

describe("model profile quick switch", () => {
  it("switches the active model when the composer profile select changes", () => {
    const source = appSource();

    expect(source).toContain('$("profileSelect").addEventListener("change"');
    expect(source).toContain("switchSelectedProfile");
  });

  it("shows a visible save result on the model profiles button", () => {
    const source = appSource();
    const handler =
      source.match(
        /\$\("saveModelProfilesBtn"\)\?\.addEventListener\("click"[\s\S]*?\n  \}\);/,
      )?.[0] ?? "";

    expect(handler).toContain('notifyUser("已保存模型配置", "done")');
    expect(handler).toContain("btn.textContent = \"已保存\"");
    expect(handler).toContain('notifyUser(`模型配置错误: ${String(e)}`, "err")');
  });
});
