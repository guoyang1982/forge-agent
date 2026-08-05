---
name: Forge Computer Use
triggers: computer use, control app, desktop app, click app, screenshot app, 操作应用, 控制桌面, 应用截图
---

Use the `mcp_computer_use_*` tools to control macOS applications.

- Start with `list_apps`, then call `get_app_state` for the exact target app.
- Treat screenshot coordinates as screen coordinates. Take a fresh app state after navigation, resizing, scrolling, or any action that changes the UI.
- Prefer the built-in Forge Browser tools for websites. Use Computer Use when the task truly requires a desktop application.
- When the user requests an image file, call `get_app_state` with `save_screenshot_to` so Forge persists the returned target-app capture inside the workspace.
- Never claim a click, input, key press, or screenshot succeeded unless the tool result confirms it. Verify consequential actions with a new `get_app_state`.
- Forge asks the user to approve privacy-sensitive reads and all desktop mutations. Do not work around a denial with shell automation.

This plugin is implemented and distributed by Forge. It does not require Codex or a Codex plugin installation. On macOS it uses the system Accessibility and Screen Recording services, which the user must grant to Forge.
