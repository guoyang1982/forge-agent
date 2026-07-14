# Forge Agent 配置参考

Forge 支持用户配置、项目配置、模型 Profile 和环境变量覆盖。普通用户优先通过桌面端“设置”或 `forge config` 修改，避免手工维护重复字段。

## 配置文件

| 范围 | 路径 | 用途 |
|------|------|------|
| 用户 | `~/.forge-agent/config.json` | 模型、权限、界面和全局扩展 |
| 项目 | `<repo>/.forge/config.json` | 项目专属模型、限制和扩展开关 |
| 自定义 | `forge --config <path>` 或 `FORGE_CONFIG_PATH` | 使用指定的用户配置文件 |
| Hooks | `~/.forge-agent/settings.json`、`<repo>/.forge/settings.json` | 生命周期脚本和注入规则 |
| MCP | `~/.forge-agent/mcp.json` | 外部 MCP Server |

生效优先级从高到低为：环境变量、项目配置、用户或显式指定的配置、内置默认值。

查看路径和脱敏后的当前配置：

```bash
forge config path
forge config show
```

## 模型 Profile

查看已保存的 Profile 和内置服务商：

```bash
forge model list
forge model providers
```

切换模型：

```bash
forge model use openai gpt-4o-mini
forge model use deepseek deepseek-v4-flash
forge model use dashscope qwen3.7-plus
```

设置当前 Profile 的 Key：

```bash
forge config set model.apiKey <YOUR_API_KEY>
```

仓库提供两个示例：

- [`config.example.json`](../config.example.json)：OpenAI、DeepSeek 和 DashScope
- [`config.deepseek.example.json`](../config.deepseek.example.json)：默认使用 DeepSeek

不要把真实 API Key 提交到项目配置或 Git。

## 环境变量

| 变量 | 作用 |
|------|------|
| `OPENAI_API_KEY` | 当前 OpenAI Profile 的 Key |
| `DEEPSEEK_API_KEY` | 当前 DeepSeek Profile 的 Key |
| `DASHSCOPE_API_KEY` | 当前 DashScope Profile 的 Key |
| `FORGE_MODEL_API_KEY` | 强制覆盖当前模型 Key |
| `FORGE_MODEL_PROVIDER` | 强制选择服务商 |
| `FORGE_MODEL_NAME` | 强制选择模型 |
| `FORGE_MODEL_BASE_URL` | 强制覆盖 OpenAI 兼容地址 |
| `FORGE_ACTIVE_PROFILE` | 临时切换已保存 Profile |
| `FORGE_CONFIG_PATH` | 指定配置文件 |
| `FORGE_DATA_DIR` | 指定数据目录，默认 `~/.forge-agent` |
| `FORGE_MAX_STEPS` | 单次 Agent 最大步骤数 |
| `FORGE_TOOL_RESULT_MAX_CHARS` | 单个工具结果最大字符数 |
| `FORGE_MAX_CONTEXT_TOKENS` | 会话回放的上下文预算 |

自定义 OpenAI 兼容服务：

```bash
export FORGE_MODEL_PROVIDER=openai
export FORGE_MODEL_BASE_URL=https://example.com/v1
export FORGE_MODEL_NAME=my-model
export FORGE_MODEL_API_KEY=<YOUR_API_KEY>
forge
```

## 配置示例

```json
{
  "activeProfile": "openai",
  "profiles": {
    "openai": {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "<YOUR_API_KEY>",
      "name": "gpt-4o-mini"
    },
    "deepseek": {
      "provider": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "<YOUR_API_KEY>",
      "name": "deepseek-v4-flash"
    }
  },
  "limits": {
    "maxSteps": 40,
    "toolResultMaxChars": 12000,
    "maxContextTokens": 64000
  }
}
```

使用 `profiles` 时，当前模型由 `activeProfile` 派生，不需要再复制一份顶层 `model`。

## 权限

Forge 对文件、命令、网络、软件、自动化和渠道分别控制。操作级别通常为：

- `allow`：直接执行
- `confirm`：执行前确认
- `deny`：拒绝执行

示例：

```json
{
  "permissions": {
    "fileSystem": {
      "allowedRoots": ["~/Documents", "~/Downloads", "~/Desktop"],
      "read": "allow",
      "write": "confirm",
      "delete": "confirm"
    },
    "network": {
      "enabled": true,
      "search": "allow",
      "web": "allow",
      "api": "confirm",
      "download": "confirm"
    },
    "automation": {
      "enabled": false,
      "create": "confirm",
      "run": "confirm",
      "delete": "confirm"
    }
  }
}
```

个人目录的批量移动、文件删除、网络 API、下载和软件安装建议保留 `confirm`。无人值守自动化只应开放完成任务所需的最小权限。

## 项目配置

项目配置适合约束单个仓库：

```json
{
  "limits": { "maxSteps": 30 },
  "plugins": {
    "enabled": { "forge-demo": true }
  },
  "skills": {
    "enabled": { "excalidraw-diagram": true }
  }
}
```

项目规则与运行命令应写在 `AGENTS.md`，生命周期脚本应写在 `.forge/settings.json`；不要全部塞进 `config.json`。

## 配置变更未生效

先检查环境变量是否覆盖了文件配置：

```bash
forge config show
```

然后重启 daemon：

```bash
forge daemon stop
forge daemon start
```

## 相关文档

- [快速开始](getting-started.md)
- [操作手册](user-guide.md)
- [Hooks 指南](hooks-guide.md)
- [返回首页](../README.md)
