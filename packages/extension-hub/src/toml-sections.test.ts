import { describe, expect, it } from "vitest";
import { hasSection, removeSection, upsertSection } from "./toml-sections.js";

describe("toml-sections", () => {
  it("appends a new section, preserving existing content", () => {
    const out = upsertSection('model = "x"\n', '[plugins."a@forge-hub"]', ["enabled = true"]);
    expect(out).toContain('model = "x"');
    expect(out).toContain('[plugins."a@forge-hub"]');
    expect(out).toContain("enabled = true");
    expect(hasSection(out, '[plugins."a@forge-hub"]')).toBe(true);
  });

  it("appends to empty text", () => {
    const out = upsertSection("", "[marketplaces.forge-hub]", ['source_type = "local"']);
    expect(hasSection(out, "[marketplaces.forge-hub]")).toBe(true);
    expect(out).toContain('source_type = "local"');
  });

  it("replaces an existing section body instead of duplicating", () => {
    const initial = upsertSection("", "[m]", ["a = 1"]);
    const out = upsertSection(initial, "[m]", ["a = 2", "b = 3"]);
    expect(out).toContain("a = 2");
    expect(out).toContain("b = 3");
    expect(out).not.toContain("a = 1");
    expect(out.match(/\[m\]/g)?.length).toBe(1);
  });

  it("removes a section without touching neighbors", () => {
    let t = upsertSection("root = 1\n", "[a]", ["x = 1"]);
    t = upsertSection(t, "[b]", ["y = 2"]);
    const out = removeSection(t, "[a]");
    expect(out).not.toContain("[a]");
    expect(out).not.toContain("x = 1");
    expect(out).toContain("[b]");
    expect(out).toContain("y = 2");
    expect(out).toContain("root = 1");
  });

  it("stops a section body at the next header", () => {
    const t = ["[a]", "x = 1", "[b]", "y = 2"].join("\n");
    const out = removeSection(t, "[a]");
    expect(out).not.toContain("x = 1");
    expect(out).toContain("[b]");
    expect(out).toContain("y = 2");
  });

  it("is a no-op when removing a missing section", () => {
    const t = "[a]\nx = 1\n";
    expect(removeSection(t, "[missing]")).toBe(t);
  });
});
