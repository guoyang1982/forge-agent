# Forge Demo Plugin

This is a minimal built-in plugin template for Forge plugin authors.

It demonstrates:

- `plugin.json` metadata and capabilities.
- A skill contribution under `skills/`.
- A workflow declaration under `workflows/`.
- An optional MCP server declaration that is disabled by default.

Try it with:

```bash
forge plugins list
forge plugins validate forge-demo
forge plugins enable forge-demo
forge plugins disable forge-demo
```

The MCP entry is only a manifest example. It is marked `"enabled": false` so enabling
the plugin will not try to start a demo server.
