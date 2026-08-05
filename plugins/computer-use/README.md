# Forge Computer Use

Forge-owned macOS desktop automation plugin. The MCP server is implemented in
this repository and uses only system-provided `osascript`, `open`, and
`screencapture` executables. It does not load or copy the Codex
`SkyComputerUseClient` binary.

Runtime requirements:

- macOS 13 or newer
- Accessibility permission for Forge (click, type, key and scroll)
- Screen Recording permission for Forge (target-app screenshots)

All privacy-sensitive reads and mutations request approval through MCP
elicitation before execution.
