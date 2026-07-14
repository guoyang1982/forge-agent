# Forge Agent 操作手册

本文按日常任务整理 Forge 的常用入口。安装和首次配置请先完成[快速开始](getting-started.md)。

## 对话与单次任务

在当前目录开始交互对话：

```bash
forge
```

指定项目目录：

```bash
forge chat -c /path/to/project
```

运行一次任务：

```bash
forge run "修复失败的测试" --cwd /path/to/project
forge run "解释这个文件" --cwd /path/to/project -f src/index.ts
forge run "应用安全的修改" --cwd /path/to/project -y
```

使用外部 Runtime：

```bash
forge run "审查当前改动" --cwd . --runtime codex
forge run "补充单元测试" --cwd . --runtime claude-code
forge run "定位类型错误" --cwd . --runtime cursor
```

## 计划与审查

`plan` 只生成实现计划，不修改代码：

```bash
forge plan "增加插件搜索" --cwd .
```

`review` 检查当前 Git diff，也可限制文件：

```bash
forge review --cwd .
forge review --cwd . -f src/index.ts
```

加上 `--json` 可把结果交给脚本处理。

## 交互命令

进入 `forge` 后常用斜杠命令：

| 命令 | 作用 |
|------|------|
| `/help` | 查看完整命令列表 |
| `/clear` | 创建新对话 |
| `/cwd [path]` | 查看或切换项目目录 |
| `/sessions` | 查看最近会话 |
| `/resume <id>` | 恢复历史会话 |
| `/compact [id]` | 压缩长会话上下文 |
| `/plan <goal>` | 生成只读计划 |
| `/review [file...]` | 审查当前变更 |
| `/run` | 执行最近变更建议的验证命令 |
| `/open <file>` | 用系统默认应用打开文件 |

## 会话管理

```bash
forge sessions
forge session <session-id-prefix>
forge compact <session-id-prefix>
forge compact <session-id-prefix> --keep-last 20 --json
```

桌面端还支持会话搜索、Markdown 导出、会话内查找和按消息检查点回滚。

## 项目规则

为项目生成 `AGENTS.md`：

```bash
forge init --agents --cwd /path/to/project
```

Forge 会结合 `AGENTS.md`、`.cursor/rules`、Git 状态、相关文件、Skills 和可用工具构建每次任务的上下文。项目专属配置可放在 `<repo>/.forge/config.json`。

## 人才中心与团队派活

人才中心内置 248 个中文职业模板。租用后可在对话中用 `@mention` 点名单个专家，或同时点名多人，由团队负责人按依赖关系调度并统一汇总。

```bash
forge talents catalog product
forge talents hire product-manager --name 方夏 --mention fangxia --cwd .
forge talents hire engineering-code-reviewer --name 老周 --mention laozhou --cwd .
forge talents list --cwd .

forge run "@fangxia! 为这个功能写一份 PRD" --cwd .
forge run "@fangxia 定义需求 @laozhou 审查风险 (并行)" --cwd .
```

人才的 Skills、工具、权限边界、多人串并行规则和完整管理命令见[人才中心指南](talent-center.md)。

## Skills 与插件

Skills 是可复用的任务说明；插件可以同时贡献 Skills、MCP、命令和工作流。

### 插件管理

桌面端打开 **定制 → 插件**，可查看已安装、Forge 内置和未纳管插件，并识别插件已经部署到哪些 Runtime。

*插件卡片集中显示版本、能力说明、启用状态以及 Forge、Cursor、Claude Code 和 Codex 的部署状态。*

```bash
forge plugins list
forge plugins import owner/plugin-repository
forge plugins enable <plugin-id>
forge plugins disable <plugin-id>
```

### Skills 管理

桌面端打开 **定制 → Skills**，可按来源筛选、启停 Skill，并通过 Extension Hub 分发到其他 Runtime。

*同一份 Skill 可以在 Forge 中启用，并按需导入 Extension Hub 后同步给其他 Agent。*

```bash
forge skills catalog excalidraw
forge skills import --catalog excalidraw-diagram
forge skills import owner/repository
forge skills list
forge skills enable excalidraw-diagram
```

用户扩展保存在 `~/.forge-agent/skills/` 和 `~/.forge-agent/plugins/`；项目扩展保存在 `.forge/skills/` 和 `.forge/plugins/`。

## Extension Hub

Extension Hub 用于在 Forge、Codex、Claude Code 等 Agent 之间统一分发扩展：

```bash
forge ext list
forge ext install owner/repository
forge ext deploy <extension-id>
forge ext discover
forge ext sync
```

先用 `forge ext list` 查看每个扩展在各 Agent 中的部署状态，再执行同步或移除。

## MCP

内置文件工具无需 MCP。数据库、浏览器或自定义系统可通过 `~/.forge-agent/mcp.json` 接入：

```bash
cp mcp.json.example ~/.forge-agent/mcp.json
```

编辑命令、参数和启用状态后重启 daemon。插件也可以携带独立的 MCP 声明。

## 移动端与消息渠道

桌面端打开 **渠道**，通过 Channel Gateway 把外部平台的消息转发给本机 Agent。所有渠道共用项目绑定、会话同步、Agent 执行和权限控制能力。

微信 iLink 是当前首个落地渠道：添加渠道、微信扫码登录、启用渠道并启动 Gateway 后，即可向绑定项目发送文字任务并接收结果。飞书、钉钉及自定义平台等可沿统一适配层继续扩展。完整架构、接入步骤、运行条件和安全建议见[移动端与消息渠道指南](mobile-access.md)。

*启动 Gateway 后，可查看监听地址、Daemon 连接状态并统一管理外部消息渠道。*

## 自动化与 Hooks

自动化默认关闭。启用后可创建 Cron 或手动任务：

```bash
forge config set permissions.automation.enabled true
forge automation list
forge automation init daily-brief --cwd .
```

完整命令见[自动化指南](automations-guide.md)。需要在模型调用、工具执行或会话结束前注入规则、运行脚本或拦截操作时，使用 [Hooks](hooks-guide.md)。

## Daemon 与状态

```bash
forge daemon start
forge daemon status
forge daemon stop
forge ping
forge status
```

桌面端会自动管理随应用打包的 daemon；CLI 和定时自动化需要 daemon 保持运行。

## 常见问题

| 现象 | 处理 |
|------|------|
| daemon socket 不存在 | `forge daemon start` 后运行 `forge ping` |
| 模型 Key 未设置 | `forge config show`，再配置当前 Profile 的 Key |
| 修改配置未生效 | 重启 daemon；插件命令通常会自动刷新 Runtime |
| `rg` 不存在 | macOS：`brew install ripgrep`；Windows：`winget install BurntSushi.ripgrep.MSVC` |
| MCP 启动失败 | 检查命令、参数、环境变量和 `enabled` 状态 |

## 相关文档

- [配置参考](configuration.md)
- [人才中心与团队派活](talent-center.md)
- [Agent 能力与边界](agent-capabilities.md)
- [构建与打包](构建打包运行手册.md)
- [返回首页](../README.md)
