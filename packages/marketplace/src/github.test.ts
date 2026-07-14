import { describe, expect, it } from "vitest";
import { parseGitHubSource } from "./github.js";
import { listCatalog } from "./import.js";

describe("parseGitHubSource", () => {
  it("parses owner/repo shorthand", () => {
    expect(parseGitHubSource("coleam00/excalidraw-diagram-skill")).toEqual({
      owner: "coleam00",
      repo: "excalidraw-diagram-skill",
      subdir: "",
    });
  });

  it("parses https github url with tree path", () => {
    const p = parseGitHubSource(
      "https://github.com/coleam00/excalidraw-diagram-skill/tree/main/skills/foo",
    );
    expect(p.owner).toBe("coleam00");
    expect(p.repo).toBe("excalidraw-diagram-skill");
    expect(p.branch).toBe("main");
    expect(p.subdir).toBe("skills/foo");
  });
});

describe("listCatalog", () => {
  it("includes excalidraw skill entry", () => {
    const hit = listCatalog("excalidraw");
    expect(hit.some((e) => e.id === "excalidraw-diagram")).toBe(true);
  });
});
