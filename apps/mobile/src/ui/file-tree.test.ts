import { describe, expect, it } from "vitest";
import { filterFileTreeRows, flattenFileTree, sortWorkspaceEntries } from "./file-tree";
import { resolveFileIconKind } from "./file-type";
import { resolveHighlightLanguage, tokenizeCode } from "./syntax-highlight";

describe("file tree helpers", () => {
  it("sorts directories before files", () => {
    const sorted = sortWorkspaceEntries([
      { name: "z.ts", path: "z.ts", kind: "file", size: 1 },
      { name: "apps", path: "apps", kind: "directory", size: 0 },
      { name: "a.ts", path: "a.ts", kind: "file", size: 1 },
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["apps", "a.ts", "z.ts"]);
  });

  it("flattens expanded directories with depth", () => {
    const rows = flattenFileTree({
      rootEntries: [
        { name: "apps", path: "apps", kind: "directory", size: 0 },
        { name: "README.md", path: "README.md", kind: "file", size: 10 },
      ],
      childrenByPath: {
        apps: [
          { name: "mobile", path: "apps/mobile", kind: "directory", size: 0 },
          { name: "desktop", path: "apps/desktop", kind: "directory", size: 0 },
        ],
        "apps/mobile": [
          { name: "App.tsx", path: "apps/mobile/App.tsx", kind: "file", size: 20 },
        ],
      },
      expandedPaths: new Set(["apps", "apps/mobile"]),
      loadingPaths: new Set(),
    });

    expect(rows.map((row) => [row.entry.path, row.depth, row.expanded])).toEqual([
      ["apps", 0, true],
      ["apps/desktop", 1, false],
      ["apps/mobile", 1, true],
      ["apps/mobile/App.tsx", 2, false],
      ["README.md", 0, false],
    ]);
  });

  it("filters rows by query", () => {
    const rows = flattenFileTree({
      rootEntries: [
        { name: "apps", path: "apps", kind: "directory", size: 0 },
        { name: "README.md", path: "README.md", kind: "file", size: 10 },
      ],
      childrenByPath: {},
      expandedPaths: new Set(),
      loadingPaths: new Set(),
    });
    expect(filterFileTreeRows(rows, "readme").map((row) => row.entry.name)).toEqual(["README.md"]);
  });
});

describe("file type icons", () => {
  it("maps common extensions to icon kinds", () => {
    expect(resolveFileIconKind("apps", "directory")).toBe("folder");
    expect(resolveFileIconKind("App.tsx", "file")).toBe("typescript");
    expect(resolveFileIconKind("styles.css", "file")).toBe("css");
    expect(resolveFileIconKind("package.json", "file")).toBe("json");
    expect(resolveFileIconKind(".gitignore", "file")).toBe("gitignore");
    expect(resolveFileIconKind("README.md", "file")).toBe("markdown");
    expect(resolveFileIconKind("blob.bin", "binary")).toBe("binary");
  });
});

describe("syntax highlight tokenizer", () => {
  it("resolves language from path and labels", () => {
    expect(resolveHighlightLanguage("typescript", "a.ts")).toBe("typescript");
    expect(resolveHighlightLanguage("", "foo.py")).toBe("python");
    expect(resolveHighlightLanguage("", "package.json")).toBe("json");
  });

  it("tokenizes keywords strings and comments", () => {
    const tokens = tokenizeCode(
      'const x = "hi"; // note\nclass Foo {}',
      "typescript",
    );
    const kinds = tokens.map((token) => token.kind);
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("string");
    expect(kinds).toContain("comment");
    expect(kinds).toContain("type");
    expect(tokens.map((token) => token.text).join("")).toContain("const");
  });

  it("tokenizes python comments and keywords", () => {
    const tokens = tokenizeCode("def hello():\n  # hi\n  return 1", "python");
    expect(tokens.some((token) => token.kind === "keyword" && token.text === "def")).toBe(true);
    expect(tokens.some((token) => token.kind === "comment")).toBe(true);
    expect(tokens.some((token) => token.kind === "number")).toBe(true);
  });
});
