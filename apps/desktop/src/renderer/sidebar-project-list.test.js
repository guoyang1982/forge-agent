import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");
const stylesSource = () => readFileSync(join(here, "styles.css"), "utf-8");

describe("project sidebar density", () => {
  it("renders projects with a compact menu and session action affordances", () => {
    const source = appSource();

    expect(source).toContain("project-menu-btn");
    expect(source).toContain('data-project-action="reveal"');
    expect(source).toContain('data-project-action="rename"');
    expect(source).toContain("创建永久工作树");
    expect(source).toContain('data-project-action="archive"');
    expect(source).toContain('data-session-action="pin"');
    expect(source).toContain('data-session-action="archive"');
    expect(source).toContain("sidebarIcon");
    expect(source).toContain("project-menu-icon");
    expect(source).toContain("session-action-icon");
    expect(source).not.toContain('">⌖</span>');
    expect(source).not.toContain('">▭</span>');
    expect(source).toContain("pinnedSessionIds");
    expect(source).toContain("archivedSessionIds");
  });

  it("offers a per-workspace compose button that opens a new conversation in that directory", () => {
    const source = appSource();

    expect(source).toContain("project-compose-btn");
    expect(source).toContain("在该工作空间新建对话");
    // Clicking compose starts a fresh chat scoped to that project's cwd.
    expect(source).toMatch(
      /project-compose-btn[\s\S]*?setActiveProject\(p\.id, \{ newChat: true \}\)/,
    );
  });

  it("uses compact row styling instead of nested heavy cards", () => {
    const styles = stylesSource();
    const sessionBlock =
      styles.match(/\.session-item \{[\s\S]*?\n\}/)?.[0] ?? "";
    const projectSessionsBlock =
      styles.match(/\.project-sessions \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(sessionBlock).toContain("min-height: 38px");
    expect(sessionBlock).toContain("background: transparent");
    expect(sessionBlock).toContain("align-items: center");
    expect(projectSessionsBlock).toContain("padding: 0 0 0 28px");
    expect(projectSessionsBlock).not.toContain("border-left");
  });
});
