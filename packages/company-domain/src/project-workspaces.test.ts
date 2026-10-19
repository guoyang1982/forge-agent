import { describe, expect, it } from "vitest";
import { pickProjectWriteGrant } from "./project-workspaces.js";

describe("project workspaces", () => {
  it("picks a write grant inside the project group", () => {
    expect(
      pickProjectWriteGrant(
        [
          { workspaceId: "ws-docs", mode: "read" },
          { workspaceId: "ws-app", mode: "write", isDefault: true },
          { workspaceId: "ws-api", mode: "write" },
        ],
        ["ws-api", "ws-docs"],
      ),
    ).toEqual({ workspaceId: "ws-api", mode: "write" });
    expect(
      pickProjectWriteGrant(
        [{ workspaceId: "ws-app", mode: "write", isDefault: true }],
        ["ws-api"],
      ),
    ).toBeUndefined();
  });
});
