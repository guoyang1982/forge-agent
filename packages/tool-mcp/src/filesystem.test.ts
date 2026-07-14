import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@forge/protocol";
import { registryHasMcpFilesystemWrites } from "./filesystem.js";

function def(name: string): ToolDefinition {
  return { name, description: name, parameters: { type: "object" } };
}

describe("registryHasMcpFilesystemWrites", () => {
  it("detects mcp filesystem edit/write tools", () => {
    expect(
      registryHasMcpFilesystemWrites([
        def("read_file"),
        def("mcp_filesystem_edit_file"),
      ]),
    ).toBe(true);
    expect(registryHasMcpFilesystemWrites([def("mcp_myserver_write_file")])).toBe(
      true,
    );
  });

  it("ignores read-only mcp tools", () => {
    expect(
      registryHasMcpFilesystemWrites([
        def("mcp_filesystem_read_file"),
        def("mcp_filesystem_list_directory"),
      ]),
    ).toBe(false);
  });

  it("ignores builtin write tools", () => {
    expect(
      registryHasMcpFilesystemWrites([def("write_patch"), def("write_file")]),
    ).toBe(false);
  });
});
