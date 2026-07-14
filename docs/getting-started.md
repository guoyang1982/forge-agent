# Forge Agent 快速开始

本指南带你从安装到完成第一个 AI 编程任务。最快方式是安装桌面端；需要 CLI 或参与开发时再从源码安装。

## 方式一：安装桌面端

1. 打开 [Forge Agent CI](https://github.com/guoyang1982/forge-agent/actions/workflows/ci.yml)，选择最新成功的运行。
2. 在页面底部 **Artifacts** 下载对应安装包：
   - macOS：`forge-desktop-macos-latest`，解压后得到 `.dmg`
   - Windows：`forge-desktop-windows-latest`，解压后得到 `.exe`
3. 安装并打开 Forge，添加一个本地项目目录。
4. 打开 **设置 → 模型配置**，添加 API Key 并选择当前模型。
5. 返回对话页，输入“解释这个项目的结构”，确认 Agent 能读取项目。

安装包尚未签名。macOS 或 Windows 首次启动时可能显示安全提醒，详情见[桌面端指南](desktop-guide.md)。

## 方式二：从源码安装 CLI

### 环境要求

- Node.js 22 或更高版本
- pnpm 9 或更高版本
- Git
- 可选：ripgrep，用于更快的代码搜索

检查版本：

```bash
node -v
pnpm -v
git --version
```

没有 pnpm 时运行：

```bash
npm install -g pnpm@9
```

### 安装

```bash
git clone https://github.com/guoyang1982/forge-agent.git
cd forge-agent
pnpm install
pnpm build
pnpm link:global
```

验证 CLI：

```bash
forge --version
forge init
```

`forge init` 会创建 `~/.forge-agent/config.json` 和本地数据目录。

## 配置模型

使用 OpenAI：

```bash
forge model use openai gpt-4o-mini
forge config set model.apiKey <YOUR_OPENAI_API_KEY>
```

也可以只在当前终端使用环境变量，避免把 Key 写入配置文件：

```bash
export OPENAI_API_KEY=<YOUR_OPENAI_API_KEY>
forge model use openai gpt-4o-mini
```

PowerShell：

```powershell
$env:OPENAI_API_KEY="<YOUR_OPENAI_API_KEY>"
forge model use openai gpt-4o-mini
```

查看可选模型和当前生效配置：

```bash
forge model list
forge config show
```

DeepSeek、DashScope、自定义 OpenAI 兼容服务和多 Profile 配置见[配置参考](configuration.md)。

## 完成第一个任务

启动后台服务：

```bash
forge daemon start
forge ping
```

进入交互对话：

```bash
cd /path/to/your-project
forge
```

或者不进入对话，直接运行一次任务：

```bash
forge run "阅读 README 和 package.json，告诉我如何运行测试" --cwd /path/to/your-project
```

生成只读计划或审查当前 Git 变更：

```bash
forge plan "增加用户登录" --cwd /path/to/your-project
forge review --cwd /path/to/your-project
```

## 验证

```bash
forge daemon status
forge status
forge sessions
```

如果这些命令能显示 daemon、模型和会话状态，安装已经完成。

## 常见问题

### `connect ENOENT ...daemon.sock`

Daemon 未运行。执行：

```bash
forge daemon start
forge ping
```

### `Model API key not set`

检查当前 Profile 和环境变量：

```bash
forge model list
forge config show
```

然后设置对应服务商的 Key，或使用 `FORGE_MODEL_API_KEY` 统一覆盖。

### 原生依赖安装失败

确认使用 Node.js 22，并重新执行 `pnpm install`。Windows 桌面端打包还需要可用的 C++ 构建工具；普通 CLI 使用不需要自行打包桌面端。

## 下一步

- [桌面端指南](desktop-guide.md)
- [操作手册](user-guide.md)
- [配置参考](configuration.md)
- [返回首页](../README.md)
