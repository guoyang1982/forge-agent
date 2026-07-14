import type { ToolDefinition } from "@forge/protocol";

/** MCP tool names that write or edit files (after mcp_<server>_ prefix). */
const MCP_FILE_WRITE_SUFFIXES = [
  "edit_file",
  "write_file",
  "create_file",
  "write_text",
  "write_text_file",
] as const;

function stripMcpPrefix(name: string): string {
  if (!name.startsWith("mcp_")) return name;
  const parts = name.split("_");
  if (parts.length < 3) return name;
  return parts.slice(2).join("_");
}

/** True when registry includes MCP tools that can write/edit files on disk. */
export function registryHasMcpFilesystemWrites(
  definitions: ToolDefinition[],
): boolean {
  return definitions.some((d) => {
    if (!d.name.startsWith("mcp_")) return false;
    const local = stripMcpPrefix(d.name).toLowerCase();
    if (MCP_FILE_WRITE_SUFFIXES.some((s) => local === s || local.endsWith(`_${s}`))) {
      return true;
    }
    return (
      /edit_file|write_file|create_file|write_text/.test(local) &&
      !/read_file|list_directory|list_dir|search|grep/.test(local)
    );
  });
}
