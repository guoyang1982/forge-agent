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

    expect(source).toContain('kind.kind !== "mobile" || !hasGlobalMobile');
    expect(source).toContain('hiddenKinds: ["mobile"]');
    expect(source).toContain("配置全局连接");
    expect(source).toContain("删除电脑级连接");
  });

  it("gives the global connection its own visual hierarchy", () => {
    const styles = stylesSource();

    expect(styles).toContain(".channels-global-mobile-section");
    expect(styles).toContain(".channels-global-scope-pill");
    expect(styles).toContain(".channel-card.is-global-mobile");
  });
});
