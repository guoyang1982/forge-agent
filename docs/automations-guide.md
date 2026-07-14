# Forge Automations 使用指南

Automations 按 **Cron 计划** 或 **手动触发**，在指定项目目录下自动运行 Agent 任务。每次运行创建新 session，结果可在 Desktop 或会话列表查看。

设计文档：[自动化平台设计](superpowers/specs/2026-06-05-automation-platform-design.md)

---

## 启用权限

默认关闭。可用 CLI 启用：

```bash
pnpm forge config set permissions.automation.enabled true
```

或在 Desktop：**设置 → 权限** 中开启「启用 Automations」，并配置创建/运行/删除策略。

也可编辑 `~/.forge-agent/config.json`：

```json
{
  "permissions": {
    "automation": {
      "enabled": true,
      "create": "confirm",
      "run": "confirm",
      "delete": "confirm"
    }
  }
}
```

`enabled: false` 时创建/运行/删除均被拒绝。`confirm` 级别在 Desktop 弹确认，CLI 用 `--yes` 跳过。已启用且用户确认过的定时任务，到点由 Daemon 静默执行。

---

## Desktop 使用

**导航：** 侧栏 **Automations**（⏱）。顶栏提示：需保持 Daemon 运行，定时任务才会触发。

**空状态：** 三个模板 pill — Daily brief / Weekly review / Project monitor；或点「通过对话创建」。

**Create via chat：**

1. 从 Automations 页进入 Chat，用自然语言描述（如「每个工作日 9 点检查 README」）。
2. 发送后解析为草稿（名称、cron、时区、prompt）；信息不足时会追问。
3. 编辑器确认保存 → 返回列表。

**列表：** 名称、下次运行、上次状态、启用开关。行操作：立即运行、删除；点击行查看触发器、prompt、运行历史（可跳转 session）。

*自动化首页提供每日简报、每周回顾和项目巡检示例，也支持通过对话或表单创建任务。*

---

## CLI 命令

通过 Daemon JSON-RPC 操作；ID 支持 UUID 前缀。

```bash
forge automation list [--cwd <path>]

forge automation create \
  --name "工作日晨检" \
  --prompt "检查 README 与未关闭 issue" \
  --cwd /path/to/project \
  --cron "0 9 * * 1-5" \
  --timezone "Asia/Shanghai" \
  --yes

forge automation init daily-brief --cwd /path/to/project --yes
forge automation init weekly-review --cwd .
forge automation init project-monitor --cwd .

forge automation run <id> [--yes]
forge automation enable <id>
forge automation disable <id>
forge automation delete <id> [--yes]
forge automation runs <id> [--limit 20]
```

省略 `--cron` 则创建仅手动触发的自动化。

---

## Daemon 与定时触发

调度器内置于 **forge-daemon**（非系统 crontab）。

- **Daemon 必须常驻**，Cron 到点才会触发。
- 重启后重新加载任务；错过窗口会补跑一次。
- 上次运行仍在 `running` 时，本次调度跳过（`skipped`）。
- 手动运行仍需 Daemon 在线：`pnpm start:daemon` 或由 Desktop 自动拉起。

---

## 内置模板（v1 占位）

模板返回草稿，不自动保存；创建后默认禁用，需手动启用。

| ID | 名称 | 默认 Cron |
|----|------|-----------|
| `daily-brief` | Daily brief | 工作日 09:00 |
| `weekly-review` | Weekly review | 每周一 09:00 |
| `project-monitor` | Project monitor | 每 6 小时 |

**Daily brief** 的 prompt 提及日历/邮件，但 v1 **未接入**相关 MCP，实际以仓库活动、issue、近期变更等代理。日历、邮件、Webhook 等集成在后续版本。

---

## 常见问题

| 现象 | 处理 |
|------|------|
| `automation disabled` | 设置 `permissions.automation.enabled: true` |
| 定时不触发 | 确认 Daemon 运行且自动化已启用 |
| Cron 无效 | 检查 5 段表达式与时区 |
| 历史 `skipped` | 上次运行未结束，防重入跳过 |
