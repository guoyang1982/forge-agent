import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf8");
const stylesSource = () => readFileSync(join(here, "styles.css"), "utf8");

describe("computer-level Forge Mobile UI", () => {
  it("requests the global Mobile channel alongside project-scoped channels", () => {
    const source = appSource();

    expect(source).toContain("includeGlobalMobile: true");
    expect(source).toContain('channels.filter((channel) => channel.kind === "mobile")');
    expect(source).toContain("renderGlobalMobileSection(mobileChannels");
    expect(source).toContain("电脑级 · 全局唯一");
  });

  it("removes Mobile from the project channel picker after global setup", () => {
    const source = appSource();

    expect(source).toContain('prefillKind === "mobile" ? true : !hasGlobalMobile');
    expect(source).toContain('hiddenKinds: ["mobile"]');
    expect(source).toContain("配置全局连接");
    expect(source).toContain("删除电脑级连接");
  });

  it("configures the global Mobile connection without binding a project directory", () => {
    const source = appSource();

    // 表单：mobile 隐藏名称/描述/工作目录，且不要求当前项目。
    expect(source).toContain("function updateChannelEditorLayout(kind)");
    expect(source).toContain('$("channelCwdField")?.classList.toggle("hidden", isMobile)');
    expect(source).toContain('prefillKind !== "mobile" && !activeProject?.cwd');
    // 创建：mobile 不携带项目 cwd，名称固定。
    expect(source).toContain('const name = isMobile ? "Forge Mobile"');
    expect(source).toContain("...(isMobile ? {} : { cwd: activeProject.cwd })");
    // 卡片：不再展示“权限配置源”目录。
    expect(source).not.toContain("权限配置源");
  });

  it("gives the global connection its own visual hierarchy", () => {
    const styles = stylesSource();

    expect(styles).toContain(".channels-global-mobile-section");
    expect(styles).toContain(".channels-global-scope-pill");
    expect(styles).toContain(".channel-card.is-global-mobile");
  });
});
