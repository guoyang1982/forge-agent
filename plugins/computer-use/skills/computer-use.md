---
name: Forge Computer Use
triggers: computer use, control app, desktop app, click app, screenshot app, 操作应用, 控制桌面, 应用截图
---

Use the `mcp_computer_use_*` tools to control macOS applications.

- Start with `list_apps`, then call `get_app_state` for the exact target app. Prefer the returned accessibility text and `element_index` values over screen coordinates.
- Use the default compact snapshot. If it times out or reports `truncated`, retry at most once with `max_elements=50`; never increase the limit after a timeout. If `front_window.context` is `file-dialog`, handle or report that dialog instead of repeatedly looking for the main editor inside it.
- Pass the returned `snapshot_id` with element operations. If Forge reports a stale element, get a fresh app state and derive the element index again.
- Prefer `set_value` for editable controls, `click` with `element_index` for buttons, and `perform_secondary_action` only with an action explicitly listed in the accessibility snapshot.
- Treat screenshot coordinates as absolute screen coordinates. Take a fresh app state after navigation, resizing, scrolling, or any action that changes the UI.
- Use `drag` for pointer drags and `scroll` with `left` or `right` when horizontal movement is required.
- Prefer the built-in Forge Browser tools for websites. Use Computer Use when the task truly requires a desktop application.
- When the user requests an image file, call `get_app_state` with `save_screenshot_to` so Forge persists the returned target-app capture inside the workspace.
- Never claim a click, input, key press, or screenshot succeeded unless the tool result confirms it. Verify consequential actions with a new `get_app_state`.
- Forge follows the configured Apps permission policy for privacy-sensitive reads and desktop mutations: allow proceeds automatically, confirm asks the user, and deny blocks the operation. Do not work around a denial with shell automation.

This plugin is implemented and distributed by Forge. It does not require Codex or a Codex plugin installation. On macOS it uses the system Accessibility and Screen Recording services, which the user must grant to Forge.
