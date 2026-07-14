export function expandHookCommand(
  command: string,
  vars: { projectDir: string; pluginRoot?: string },
): string {
  let c = command.replace(/^"+|"+$/g, "");
  if (vars.pluginRoot) {
    c = c
      .replaceAll("${FORGE_PLUGIN_ROOT}", vars.pluginRoot)
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", vars.pluginRoot)
      .replaceAll("${PLUGIN_ROOT}", vars.pluginRoot)
      .replaceAll("${CURSOR_PLUGIN_ROOT}", vars.pluginRoot);
  }
  return c
    .replaceAll("${FORGE_PROJECT_DIR}", vars.projectDir)
    .replaceAll("${CLAUDE_PROJECT_DIR}", vars.projectDir);
}
