# Forge Agent 桌面端指南

桌面端把项目、对话、代码变更、终端和扩展管理放在一个窗口中，并自动启动随应用打包的 Forge Daemon。

## 下载与安装

当前安装包由 GitHub Actions 生成，尚未发布正式 Release：

1. 打开 [CI 工作流](https://github.com/guoyang1982/forge-agent/actions/workflows/ci.yml)。
2. 选择最新成功的运行。
3. 在 **Artifacts** 下载：
   - `forge-desktop-macos-latest`
   - `forge-desktop-windows-latest`
4. 解压后安装 `.dmg` 或 `.exe`。

安装包暂未签名：

- macOS 若提示无法验证开发者，可在“系统设置 → 隐私与安全性”中确认打开。
- Windows 若出现 SmartScreen，请核对下载来源为本仓库的 CI，再选择继续运行。

正式版本将发布到 [GitHub Releases](https://github.com/guoyang1982/forge-agent/releases)。

## 第一次使用

1. 点击 **新增项目**，选择本地 Git 仓库或代码目录。
2. 打开 **设置 → 模型配置**，添加至少一个模型 Profile。
3. 回到对话页，在输入框上方选择 Runtime 和模型。
4. 输入任务。Forge 会显示推理进度、工具调用、终端输出和文件变更。
5. 检查右侧变更视图，再决定应用、撤销或继续修改。

*新对话页可直接选择项目、Runtime 和模型；侧栏保留项目会话、团队和其他工作台入口。*

## 选择 Runtime

| Runtime | 适合场景 | 前置条件 |
|---------|----------|----------|
| Forge | 使用内置模型、工具、Skills、插件和权限系统 | 配置一个模型 Profile |
| Codex | 复用本机 Codex CLI 的登录与能力 | 安装并登录 `codex` CLI |
| Claude Code | 复用本机 Claude Code | 安装并登录 `claude` CLI |
| Cursor Agent | 复用 Cursor Agent | 安装可用的 Cursor Agent CLI |

Runtime 可按任务切换。外部 Runtime 的模型和权限选项取决于对应 CLI；Forge 负责统一会话展示、文件活动和项目上下文。

## 审查变更与回滚

- 对话时间线会把文件读取、编辑和命令执行合并为可读的活动记录。
- 右侧“代码 + 变动”视图可查看当前任务涉及的文件和 diff。
- 每轮任务前会为 Git 项目创建检查点。
- 将鼠标移到用户消息上，点击 **回到此处**，可只回滚文件，或同时撤回之后的对话。

回滚会覆盖检查点之后的文件修改。执行前先确认没有需要保留的未提交工作；详细边界见 [Agent 能力与边界](agent-capabilities.md)。

## 扩展与自动化

桌面端侧栏提供：

- **插件 / MCP / Skills**：安装、启用并查看 Agent 扩展。
- **Hooks**：编辑项目级或用户级生命周期脚本。
- **移动端与消息渠道**：通过 Channel Gateway 从外部平台向本机 Agent 派发任务；当前已接入微信 iLink，其他平台可沿统一渠道架构继续扩展。
- **自动化**：创建 Cron 或手动任务，查看每次运行结果。
- **终端**：在当前项目中运行命令，不必离开桌面端。

详细配置见 [移动端与消息渠道指南](mobile-access.md)、[操作手册](user-guide.md)、[自动化指南](automations-guide.md)和 [Hooks 指南](hooks-guide.md)。

## 内置终端

点击窗口右上角的终端按钮，可在当前项目旁边打开终端。对话和命令执行保持在同一个窗口中，便于查看 Agent 结果后立即补充检查或运行项目。

*左侧保留 Agent 对话和项目会话，右侧终端直接使用当前项目环境。*

## 从源码运行桌面端

```bash
git clone https://github.com/guoyang1982/forge-agent.git
cd forge-agent
pnpm install
pnpm build
pnpm dev:desktop
```

只生成本机未安装目录：

```bash
pnpm pack:desktop:dir
```

打包 `.dmg` 或 `.exe` 的完整说明见[构建与打包手册](构建打包运行手册.md)。

## 排障

### 页面提示 daemon 未就绪

退出应用后重新打开。源码运行时先确认 `pnpm build` 成功；CLI 可用 `forge daemon status` 检查后台服务。

### 外部 Runtime 不可用

在系统终端运行对应命令（`codex`、`claude` 或 Cursor Agent）确认已安装、已登录且在 `PATH` 中，然后重启 Forge。

### 终端不可用或降级

桌面端依赖 `node-pty` 提供完整终端。若原生模块未正确构建，会退回管道模式；源码环境可运行：

```bash
pnpm --filter @forge/desktop rebuild:native
```

## 相关文档

- [快速开始](getting-started.md)
- [移动端与消息渠道](mobile-access.md)
- [配置参考](configuration.md)
- [返回首页](../README.md)
