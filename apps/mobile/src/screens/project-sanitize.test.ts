import { describe, expect, it } from "vitest";
import { parseCreatedProject, parseProjects } from "./project-sanitize.js";

describe("Mobile project response sanitization", () => {
  it("keeps only project display fields", () => {
    expect(parseProjects({ projects: [
      { name: "forge", path: "/workspace/forge", kind: "project", secret: "drop" },
      { name: "bad", path: 12, kind: "project" },
    ] })).toEqual([{ name: "forge", path: "/workspace/forge", kind: "project" }]);
  });

  it("parses a created project envelope", () => {
    expect(parseCreatedProject({
      project: { name: "new-app", path: "/workspace/new-app", kind: "project" },
    })).toEqual({ name: "new-app", path: "/workspace/new-app", kind: "project" });
  });
});
