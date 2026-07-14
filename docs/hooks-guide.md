# Forge Hooks 配置指南

Hooks 在 Agent 运行生命周期的固定节点执行自定义逻辑：注入 prompt 规则、运行 shell 脚本、在工具调用前拦截等。

配置写在 **`settings.json`** 的 `hooks` 字段，与 `~/.forge-agent/config.json`（模型、MCP 等）分离。

---

## 配置文件位置

| 层级 | 路径 | 说明 |
|------|------|------|
| 用户 | `~/.forge-agent/settings.json` | 全局，所有项目生效 |
| 项目 | `<cwd>/.forge/settings.json` | 随仓库提交 |
| 项目本地 | `<cwd>/.forge/settings.local.json` | 本地覆盖，建议加入 `.gitignore` |
| 插件 | `<plugin>/hooks/hooks.json` | 插件启用时自动加载 |

**兼容读取**（便于从 Claude Code 迁移）：

- `~/.claude/settings.json`
- `<cwd>/.claude/settings.json`
- `<cwd>/.claude/settings.local.json`

同一轮 run 会按顺序合并各层配置，所有匹配的 hook 都会执行。

任意一层可设置 `"disableAllHooks": true` 禁用该文件中的 hooks。

---

## 配置结构

```json
{
  "disableAllHooks": false,
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "inject-text", "text": "Always read AGENTS.md first." }
        ]
      }
    ]
  }
}
```

三层含义：

1. **事件名**（如 `SessionStart`）
2. **匹配组** — 可选 `matcher` 过滤
3. **处理程序** — `hooks` 数组中的每一项

---

## 已支持的事件

| 事件 | 触发时机 |
|------|----------|
| `SessionStart` | 每轮 run 开始；`matcher` 常用 `startup` / `resume` / `clear` / `compact` |
| `UserPromptSubmit` | 用户消息交给模型前；可阻止本轮 prompt |
| `PreToolUse` | 工具执行前；`matcher` 为工具名；可拦截 |
| `PostToolUse` | 工具执行后 |
| `Stop` | 本轮结束前；可阻止发出 `done` |
| `PreCompact` | `/compact` 压缩历史前；可阻止压缩 |
| `SessionEnd` | Forge daemon 进程退出时 |

### SessionStart 与斜杠命令

- `/clear` 后第一条消息 → `clear`
- `/compact` 后第一条消息 → `compact`
- 无历史消息 → `startup`
- 有历史消息 → `resume`

---

## 处理程序类型

### `command`

执行 shell 命令：

- **stdin**：JSON 事件体（含 `hook_event_name`、`session_id`、`cwd` 等）
- **环境变量**：`FORGE_PROJECT_DIR`、`CLAUDE_PROJECT_DIR`、`FORGE_PLUGIN_ROOT`（插件 hook）
- **stdout**：JSON，支持 `hookSpecificOutput.additionalContext`、`permissionDecision: deny`
- **退出码**：`0` 成功；`2` 阻止（视事件类型拦截 prompt / 工具 / 结束等）
- **`async: true`**：异步触发，不等待（适用于 SessionStart）

脚本建议放在 `.forge/hooks/` 并在配置中引用：

```json
{ "type": "command", "command": ".forge/hooks/audit.sh" }
```

### `inject-text`（Forge 扩展）

将纯文本注入本轮 prompt 的 **Hook context** 区块。

### `inject-skill`（Forge 扩展）

按 `skillId` 注入已安装 Skill 的全文。

---

## 示例

### 项目级：新会话提醒

`.forge/settings.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "clear|compact",
        "hooks": [
          {
            "type": "inject-text",
            "text": "User cleared or compacted history. Ask them to restate the current task in one paragraph."
          }
        ]
      }
    ]
  }
}
```

### 压缩前备份

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".forge/hooks/backup-session.sh"
          }
        ]
      }
    ]
  }
}
```

### 拦截危险 shell

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {
            "type": "command",
            "command": ".forge/hooks/validate-shell.sh"
          }
        ]
      }
    ]
  }
}
```

---

## 桌面端配置

1. 左侧 **Hooks** → **说明** 查看速查；**项目** 编辑 `.forge/settings.json` / `settings.local.json`
2. **设置 → Hooks** 编辑用户全局 `~/.forge-agent/settings.json`
3. **已发现** 标签查看当前项目合并后的 hook 列表（含插件）

保存后立即生效，无需重启 daemon（下一轮 run 重新发现配置）。

---

## 运行时反馈

对话时间线会出现 **Hook 已注入: …** 事件，表示 SessionStart / UserPromptSubmit 等已注入上下文。

---

## 与 config.json 的区别

| 文件 | 内容 |
|------|------|
| `config.json` | 模型、API Key、MCP、Skill/插件启用开关 |
| `settings.json` | Hooks 生命周期脚本与注入规则 |

勿把 hooks 写入 `config.json`，daemon 不会读取。
