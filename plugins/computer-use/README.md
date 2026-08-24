# Forge Computer Use

Forge-owned macOS desktop automation plugin. Its MCP server is implemented in
this repository and is started and registered automatically by Forge; users do
not need to add it to `mcp.servers`. It uses only system-provided `osascript`,
`open`, and `screencapture` executables. It does not load or copy the Codex
`SkyComputerUseClient` binary.

Capabilities:

- app discovery, launch, activation, and target-window screenshots
- flattened macOS Accessibility snapshots with snapshot and element ids
- bounded front-window traversal with compact-by-default responses and partial snapshots before MCP timeout
- coordinate or element-index clicks, text input, key presses, and four-way scrolling
- editable-element value changes and text selection
- accessibility secondary actions such as menus, increment, and decrement
- coordinate or element-origin pointer drag

Runtime requirements:

- macOS 13 or newer
- Accessibility permission for Forge. Source builds use the stable
  `apps/desktop/.forge-electron/Forge.app` development host; stale Electron or
  Forge entries do not authorize the current host (click, type, key and scroll)
- Screen Recording permission for Forge (target-app screenshots)

Privacy-sensitive reads and mutations follow Forge's Apps permission policy:
`allow` runs without another prompt, `confirm` requests MCP approval, and
`deny` blocks the operation. macOS Accessibility and Screen Recording grants
remain separate operating-system requirements.
