<p align="center">
  <img src="apps/desktop/src/renderer/assets/forge-icon.png" width="96" alt="Forge Agent logo" />
</p>

# Forge Agent

本地优先的 AI 编程工作台。核心是自研的 **Forge Agent 执行引擎**，同时可在一个桌面端或 CLI 中使用 Codex、Claude Code 和 Cursor Agent，并统一管理会话、代码变更、Skills、插件、MCP 与自动化。

[桌面端下载](#桌面端下载) · [移动端与消息渠道](docs/mobile-access.md) · [人才中心](docs/talent-center.md) · [5 分钟快速开始](docs/getting-started.md) · [操作手册](docs/user-guide.md)

> 项目仍处于早期开发阶段。桌面安装包暂未签名，建议先在测试项目中使用。

## 为什么用 Forge

- **一个界面，多种 Agent**：每个任务可选择 Forge、Codex、Claude Code 或 Cursor Agent，无需切换工作环境。
- **过程可见，也可撤回**：实时查看工具调用、文件变更与终端输出；按轮次创建检查点，必要时回滚代码或对话。
- **本地优先的安全边界**：工作区操作与会话数据库在本机管理，模型请求只发往你配置的服务；文件、命令、网络和软件操作都可设为允许、确认或拒绝。
- **移动端与消息渠道**：通过 Channel Gateway 从外部消息平台连接本机 Agent；微信 iLink 是当前首个落地渠道，后续可继续扩展其他平台。
- **可持续扩展**：统一管理 Skills、插件、MCP、Hooks、定时自动化与消息渠道，并可在不同 Agent 间分发扩展。

## 自研 Forge Agent：从理解项目到验证交付

Forge Agent 不是把 Prompt 转发给模型的聊天外壳，而是项目自研的完整 Agent Runtime。它负责理解代码库、组织上下文、驱动模型与工具多轮执行，并把计划、修改、验证和审查串成一条可观察、可控制、可恢复的开发流程。

```text
项目规则 / Git / 相关代码 → 可见计划 → 工具执行 → 测试验证 → 反思纠错 → 交付与回滚
```

- **真正理解当前项目**：自动组合 `AGENTS.md`、Git 状态与 Diff、`@文件`、相关代码搜索、Skills、Hooks 和长期记忆，不靠用户反复粘贴上下文。
- **真正执行开发任务**：通过文件读写、精准 Patch、命令、网络、软件、MCP 等工具完成“分析 → 修改 → 测试”，编码任务首轮只说不做时会主动要求模型使用工具。
- **复杂任务有编排**：内置用户可见计划；只读搜索和子代理可并行，写操作保持顺序并由主代理统一落盘，兼顾速度与一致性。
- **交付前自检**：支持独立的 `plan`、`run`、`review` 工作流；可选审校模型会依据任务、结果和工具失败证据检查遗漏，发现阻断问题后要求返工。
- **全过程在控制内**：流式展示思考、工具调用、文件变化与终端输出；命令和外部操作可确认，任务可取消，每轮可用 Git 检查点回滚。

```bash
forge plan "为项目增加登录功能" --cwd /path/to/project
forge run "按计划实现并运行测试" --cwd /path/to/project
forge review --cwd /path/to/project
```

[查看 Forge Agent 的执行能力与安全边界 →](docs/agent-capabilities.md)

## 人才中心：把 Agent 变成可组建的 AI 团队

Forge 内置 **248 个中文职业人才模板，覆盖 17 个专业领域**。你可以从人才市场租用产品经理、架构师、代码审查工程师、设计师、营销专家、安全顾问等 AI 同事，为他们设置姓名、`@mention`、Skills、工具和权限，再像带团队一样直接派活。

```text
人才市场 → 租用专家 → 绑定 Skills / 工具 → @人才派活 → 团队负责人汇总交付
```

- **单人接管**：`@Nova! 重构登录模块`，指定人才带着自己的人设、技能和工具完成整轮任务。
- **多人协作**：`@方夏 定义需求 @Lumi 出方案 @老周 审查风险`，团队负责人拆分任务、识别依赖并按波次调度。
- **安全并行**：无依赖的专家可并行研究；后台人才保持只读，由团队负责人统一写盘、验证和汇总，避免多人同时修改代码造成冲突。
- **可管理的团队**：人才支持重命名、启停、技能/工具绑定、严格 Skill 模式和任务统计；项目人才名册可随仓库共享。

[了解人才中心与多人派活 →](docs/talent-center.md)

## 不只是聊天：一套完整的 Agent 工作台

| 能力 | 能解决什么问题 |
|------|----------------|
| **👩 人才中心 / 团队** | 从 248 个专业模板组建 AI 团队，通过 `@mention` 指定单人或多人协作，并查看派活与汇总进度。 |
| **🤖 Forge Agent（自研）** | 自主读取项目、制定计划、调用工具修改代码、运行验证并审查结果，而不只是生成一段回答。 |
| **⇄ 多 Runtime** | 在同一个项目和会话界面中切换 Forge、Codex、Claude Code 与 Cursor Agent。 |
| **🔌 插件** | 从 GitHub 搜索和安装能力包，一次带入 Skills、MCP、命令、Hooks 与工作流。 |
| **◆ Skills** | 为代码审查、测试、设计、文档等任务加载可复用的专业方法，并按项目启停。 |
| **⚙ MCP** | 连接数据库、浏览器和内部系统，把外部工具纳入同一权限与执行时间线。 |
| **⚡ Hooks** | 在会话、Prompt、工具调用和压缩等生命周期节点注入规则、运行脚本或阻止危险操作。 |
| **📡 移动端与消息渠道** | 通过统一的 Channel Gateway 接收外部消息、调用本机 Agent 并返回结果；当前已接入微信 iLink，可继续扩展其他平台。 |
| **⏱ 自动化** | 用自然语言或 Cron 创建定时 Agent 任务，保留独立会话、运行记录和结果通知。 |
| **🧩 Extension Hub** | 集中管理扩展，并把同一份 Skill / Plugin 部署到 Forge、Codex、Claude Code 和 Cursor。 |
| **↩ 检查点与回滚** | 每轮任务前保存 Git 检查点，可只恢复文件，也可同时撤回后续对话。 |

## 移动端与消息渠道：从外部连接本机 Forge

Forge 的 Channel Gateway 是连接外部消息平台与本机 Agent 的统一入口。渠道收到任务后，会把消息转发到绑定的本地项目，调用 Forge Agent 执行，再将结果返回原渠道；相关会话也会同步显示在桌面端。

```text
外部消息渠道 → Channel Gateway → 本机 Forge Agent → 项目执行 → 原渠道接收结果
```

- **无需把工作区搬到云端**：代码、项目目录、会话和工具仍由本机 Forge 管理。
- **统一接入与管理**：不同渠道使用同一套项目绑定、会话、Agent、工具和权限体系。
- **当前已接入微信**：微信 iLink 是首个可用渠道，可扫码绑定并收发文字任务。
- **面向更多平台扩展**：Channel Gateway 为飞书、钉钉及自定义平台等后续渠道保留统一适配层。
- **清晰的运行边界**：电脑需要保持 Forge Daemon 与 Gateway 在线；各渠道支持的消息类型以对应适配器为准。

[查看移动端与消息渠道指南 →](docs/mobile-access.md)

## 桌面端下载

CI 会为每次通过测试的提交生成安装包：

| 平台 | 安装包 | 下载 |
|------|--------|------|
| macOS（Apple Silicon） | `.dmg` | [下载最新构建](https://github.com/guoyang1982/forge-agent/actions/workflows/ci.yml) |
| Windows（x64） | `.exe` | [下载最新构建](https://github.com/guoyang1982/forge-agent/actions/workflows/ci.yml) |

打开最新成功的 **CI** 运行，在页面底部 **Artifacts** 下载 `forge-desktop-macos-latest` 或 `forge-desktop-windows-latest`。GitHub Actions 下载可能需要登录 GitHub。

安装、首次启动和系统安全提示见[桌面端指南](docs/desktop-guide.md)。正式版本发布后会出现在 [GitHub Releases](https://github.com/guoyang1982/forge-agent/releases)。

## 手机端下载（Android）

推荐在本机局域网发布，手机扫码即可安装，无需登录 GitHub。

### 本机扫码安装（推荐）

1. 电脑与 Android 手机连接**同一 Wi‑Fi**。
2. 在项目根目录执行：

```bash
pnpm publish:mobile:android
```

脚本会先打包 APK，再启动局域网安装页。终端会打印下载地址；用电脑浏览器打开 `http://<电脑IP>:8765/` 可看到二维码，手机扫码下载安装。

若 APK 已打好，只启动安装页：

```bash
pnpm serve:mobile:android
# 或
pnpm publish:mobile:android --skip-build
```

安装时若系统拦截，请在 Android 设置中允许「安装未知应用」。

**一次性环境**（仅首次打包需要）：JDK 17 + Android SDK（platform 36、build-tools 36.0.0、NDK 27.1.12297006）。macOS 可用 Android Studio 或 command-line tools，并设置 `ANDROID_HOME`。

手机端通过公网 Relay 配对桌面端使用；配置与配对见[移动端与消息渠道指南](docs/mobile-access.md)和 [Relay 部署说明](services/forge-relay/deploy/DEPLOY-aliyun.md)。当前不提供 iOS 侧载包。

### GitHub CI（可选）

CI 也会在通过测试后上传 `forge-mobile-android` Artifact，适合已有 GitHub 访问权限时使用：

| 平台 | 安装包 | 下载 |
|------|--------|------|
| Android | `.apk` | [下载最新构建](https://github.com/guoyang1982/forge-agent/actions/workflows/ci.yml) |

本地仅打包、不启动安装页：

```bash
pnpm pack:mobile:android
# → release/Forge-Mobile-<version>-android.apk
```

## 从源码快速开始

需要 Node.js 22+、pnpm 9+ 和 Git。

```bash
git clone https://github.com/guoyang1982/forge-agent.git
cd forge-agent
pnpm install
pnpm build
pnpm link:global

forge init
forge model use openai gpt-4o-mini
forge config set model.apiKey <YOUR_API_KEY>
forge daemon start
forge
```

进入任意代码仓库后，也可以直接运行单次任务：

```bash
forge run "解释这个项目并找出最值得先修的问题" --cwd /path/to/project
forge plan "为项目增加登录功能" --cwd /path/to/project
forge review --cwd /path/to/project
```

完整的 Windows 命令、环境变量配置和首次任务示例见[快速开始](docs/getting-started.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [快速开始](docs/getting-started.md) | 安装、模型配置、首次对话与验证 |
| [桌面端指南](docs/desktop-guide.md) | 下载、项目、Runtime、变更审查与回滚 |
| [人才中心与团队派活](docs/talent-center.md) | 浏览人才市场、租用专家、绑定能力与多人协作 |
| [移动端与消息渠道](docs/mobile-access.md) | Channel Gateway、渠道接入、项目绑定、运行条件与安全边界 |
| [移动端 Relay 实施计划](docs/superpowers/plans/2026-07-15-mobile-relay.md) | Channel Gateway 内的 Mobile Adapter、Go Relay 独立部署、E2EE、设备配对与分阶段执行清单 |
| [操作手册](docs/user-guide.md) | CLI、会话、Skills、插件、MCP 和常用工作流 |
| [配置参考](docs/configuration.md) | 模型 Profile、环境变量、权限和配置优先级 |
| [自动化指南](docs/automations-guide.md) | 定时任务、模板、运行记录与排障 |
| [Hooks 指南](docs/hooks-guide.md) | 生命周期事件、脚本拦截与上下文注入 |
| [Agent 能力与边界](docs/agent-capabilities.md) | 子代理、并行执行、检查点与安全边界 |
| [构建与打包](docs/构建打包运行手册.md) | 开发环境、测试、桌面端打包与排障 |

## 开发

```bash
pnpm build
pnpm test
pnpm smoke
pnpm dev:desktop
```

项目采用 pnpm workspace：`apps/desktop`、`apps/cli` 和 `apps/daemon` 提供客户端与后台服务，`packages/` 存放 Agent、工具、会话、配置和扩展能力。
