# Forge 个人助理权限设计

**日期:** 2026-06-05  
**范围:** 统一 Forge Agent 的 workspace + 个人文件、软件管理、网络访问和个人助理扩展权限  
**状态:** 已批准（默认放开常用个人目录读取，预留软件、网络和个人助理能力）

## 目标

让 Forge 保持一个统一入口，同时能作为个人智能助理处理常用个人目录中的文件，并为后续安装/卸载软件、下载文件、访问网页/API、记忆偏好、自动化提醒、浏览器操作等能力留出同一套权限模型。用户不需要切换到单独的“个人助理模式”；Forge 根据配置知道哪些能力可用、哪些操作需要确认。

默认个人目录包括：

- `~/Documents`
- `~/Downloads`
- `~/Desktop`
- `~/Pictures`
- `~/Movies`
- `~/Music`

## 非目标（本阶段不做）

- 不开放全盘访问。
- 不默认读取敏感隐藏目录，例如 `~/.ssh`、`~/.gnupg`、`~/.config`、`~/Library`、浏览器 profile、钥匙串数据。
- 不自动删除个人文件。
- 不默认安装、卸载或升级软件；软件管理必须走专用工具和确认流程。
- 不默认执行任意网络请求、未知安装脚本或 `curl | sh`。
- 不实现复杂的系统级权限弹窗；macOS 文件权限仍由系统处理。
- 不新增用户可见的“个人助理模式”入口，避免把产品变成两个 agent。

## 现状摘要

Forge 当前定位和提示词都偏向代码助手：

- `packages/agent-core/src/prompts.ts` 明确写着只在 workspace 内工作。
- `WorkspaceGuard` 以单个 `cwd` 作为主要安全边界。
- `packages/tools` 的读写工具围绕 workspace path 设计。
- 当前没有安全的移动/重命名/删除工具，不能靠放开 shell 的 `mv` 或 `rm` 来整理个人文件。
- 配置里没有个人目录白名单、软件管理策略或网络访问策略。
- CLI 主要通过 `--cwd` 指定 workspace。

因此，现在遇到 `~/Documents` 这类路径时，模型层会主动拒绝，即使底层文件系统或 shell 可能有权限访问。

## 推荐方案：统一 Agent + 分层权限

新增一个底层权限配置，不作为单独模式暴露给用户：

```json
{
  "permissions": {
    "fileSystem": {
      "allowedRoots": [
        "~/Documents",
        "~/Downloads",
        "~/Desktop",
        "~/Pictures",
        "~/Movies",
        "~/Music"
      ],
      "read": "allow",
      "write": "confirm",
      "delete": "confirm"
    },
    "software": {
      "enabled": false,
      "managers": ["brew"],
      "install": "confirm",
      "uninstall": "confirm"
    },
    "network": {
      "enabled": true,
      "search": "allow",
      "web": "allow",
      "api": "confirm",
      "download": "confirm",
      "allowedHosts": []
    },
    "memory": {
      "enabled": true,
      "read": "allow",
      "write": "confirm",
      "delete": "confirm"
    },
    "automation": {
      "enabled": false,
      "create": "confirm",
      "run": "confirm",
      "delete": "confirm"
    },
    "notifications": {
      "enabled": false,
      "send": "confirm"
    },
    "browser": {
      "enabled": false,
      "open": "allow",
      "interact": "confirm",
      "submit": "confirm"
    },
    "apps": {
      "enabled": false,
      "open": "confirm",
      "control": "confirm"
    },
    "secrets": {
      "read": "deny"
    },
    "audit": {
      "enabled": true
    }
  }
}
```

### 行为规则

- Workspace 仍然是当前项目工作区，代码任务照常运行。
- `fileSystem.allowedRoots` 下的文件和目录允许 `list_dir`、`read_file`、`grep`。
- `fileSystem.allowedRoots` 下的写入、移动、重命名允许执行，但批量操作必须先给计划并等待确认。
- 删除永远需要明确确认。
- 默认拒绝未列入 `fileSystem.allowedRoots` 的绝对路径。
- 默认拒绝敏感目录，即使将来某个根目录覆盖到用户主目录。
- `software` 首版默认关闭；后续启用时只通过白名单包管理器执行，例如 Homebrew，不允许任意安装脚本。
- `network.search` 和 `network.web` 可用于搜索和读取网页内容；`network.api` 和 `network.download` 默认需要确认，避免对外部服务产生副作用或下载未知文件。
- 网络下载的文件默认只能保存到 workspace 或 `fileSystem.allowedRoots` 下。
- `memory` 可读取已有偏好；新增、修改、删除长期记忆需要确认。
- `automation`、`notifications`、`browser`、`apps` 首版默认关闭，后续通过工具、MCP 或插件启用。
- `secrets.read` 默认拒绝，避免读取密钥、密码、token、cookie、钥匙串或浏览器凭据。
- `audit.enabled` 默认开启，用于记录移动文件、下载、安装软件、API 请求等高影响操作。

### 提示词调整

系统提示从“只在 workspace 内工作”改成：

- 在 workspace 内完成代码任务。
- 可以读取配置授权的个人目录。
- 个人目录的批量写入、移动、重命名需要先提出计划并确认。
- 删除个人文件必须单独确认。
- 可以搜索和访问网页；调用 API 或下载文件前需要说明目标、URL、保存位置或请求影响并确认。
- 安装、卸载、升级软件必须使用专用软件管理工具并确认，不运行未知安装脚本。
- 记忆偏好前先说明将记住什么；自动化、通知、浏览器交互、本机 App 控制都需要明确用户意图和确认。
- 密钥、密码、token、cookie、钥匙串或浏览器凭据默认不可读取。
- 不访问敏感目录，除非用户明确点名且配置允许。

### 工具和路径守卫

引入一个比 `WorkspaceGuard` 更通用的授权路径判断，保留现有 workspace 行为：

- `WorkspaceGuard` 继续负责 workspace 内路径。
- 新增 `PermissionGuard` 或在 `WorkspaceGuard` 增加 `allowedRoots` 支持。
- 对读工具：允许 workspace 或 allowed roots。
- 对写工具：允许 workspace；个人目录写操作进入现有 patch/confirm 流程，并在批量操作提示词中要求确认。
- 新增专用文件整理工具，避免通过 shell 绕过权限：
  - `move_file`：只允许源路径和目标路径都在 workspace 或 allowed roots 下，目标冲突时拒绝并返回建议。
  - `rename_file`：等价于同目录 `move_file`，用于更清晰的模型意图。
  - `delete_file`：首版默认只提出计划，不自动执行；后续如接入确认机制，也必须单独确认每批删除。
- 对 shell：保持现有命令白名单，避免通过 shell 绕过路径权限。

### 软件和网络工具

软件管理和网络访问使用专用工具，不通过自由 shell 放开：

- `software_list`：列出 Homebrew 已安装包、过期包或某个包的信息。
- `software_install`：首版仅支持 Homebrew，执行前展示包名、来源和预计命令并确认。
- `software_uninstall`：执行前展示将卸载的包、依赖影响和确认提示。
- `web_search`：按关键词搜索网页，返回标题、摘要、链接和来源。
- `web_fetch`：读取网页内容，默认只做 GET。
- `api_request`：访问 API，默认需要确认；非 GET 请求必须说明副作用。
- `download_file`：下载文件，默认需要确认，保存位置必须在 workspace 或授权个人目录内。

首版实现可以先落地文件系统权限；软件和网络权限先进入配置、提示词和设计占位，后续按独立计划实现。网络内置工具的实现规格见 [网络工具设计](2026-06-08-network-tools-design.md)。安装 Skill 可以补充任务流程和使用说明；真正新增联网、搜索、下载或软件管理能力时，还需要对应的内置工具、MCP server 或插件工具，并由 `permissions` 控制是否允许使用。

### 个人助理扩展能力

以下能力进入权限模型，但不要求首版全部实现：

- `memory`：记住用户偏好、常用目录、命名习惯、常用软件和工作流；必须能查看、更新、删除。
- `automation`：定时任务、循环检查和提醒，例如每周整理 Downloads；创建、运行、删除都需要确认。
- `notifications`：系统通知、任务完成提醒、失败提醒。
- `browser`：打开网页、截图、填写表单、登录后操作网页；登录、购买、提交表单、删除内容必须确认。
- `apps`：打开本机 App、切换窗口、读取当前窗口标题；控制 UI 或破坏性操作必须确认。
- `calendar`：读日历、创建提醒或日程；创建、修改、删除必须确认（后续由插件/MCP 提供）。
- `contacts`：查询联系人、公司、邮箱；发送消息或共享联系人数据必须确认（后续由插件/MCP 提供）。
- `mail`：搜索、总结邮件，草拟回复；发送邮件必须确认（后续由插件/MCP 提供）。
- `notes`：读写备忘录、Markdown、Notion 类知识库，适合沉淀个人资料（后续由插件/MCP 提供）。
- `documents`：PDF/Word/Excel/PPT 的提取、总结、转换、批量改名、归档。
- `media`：图片、视频、音乐的元数据读取、去重、按时间地点整理；不默认上传云端。
- `secrets`：密钥、密码、token、cookie 和凭据默认禁止读取；如后续支持，也必须走安全工具和强确认。
- `audit`：记录高影响操作，方便用户回看和撤销。

优先级建议：先实现 `fileSystem`、`network`、`memory`、`automation`、`browser`、`software`。日历、联系人、邮件、笔记等更适合后续通过插件或 MCP 接入。

## 备选方案

### 方案 A：只改提示词

让提示词允许访问个人目录，但不改配置和守卫。

优点：实现快。  
缺点：边界不可靠，未来工具一扩展就容易越权。

### 方案 B：新增 `forge assistant`

提供单独入口和模式。

优点：权限边界显式。  
缺点：用户体验割裂，和 Codex 一类工具的“一个 agent”心智不一致。

### 方案 C：统一 Agent + 分层权限（推荐）

产品上仍然是一个 Forge；实现上有清晰权限模型。

优点：体验自然，安全边界清楚，可扩展到文件整理、软件管理、网络访问等个人助理任务。  
缺点：需要改配置、提示词、路径解析和测试。

## 验收标准

1. 普通 `forge chat` 中，用户请求整理 `~/Documents` 时，Forge 不再因为“workspace 外”直接拒绝。
2. 默认可读 `~/Documents`、`~/Downloads`、`~/Desktop`、`~/Pictures`、`~/Movies`、`~/Music`。
3. 未授权绝对路径仍被拒绝。
4. 敏感目录默认拒绝。
5. 个人目录批量移动/重命名前，Forge 会先列出计划并等待用户确认。
6. 个人目录移动/重命名通过专用工具执行，不能依赖 shell `mv`。
7. 删除个人文件必须明确确认；首版可以只生成删除计划，不实际删除。
8. 系统提示会明确网络和软件管理的权限边界：网页搜索和网页读取可用，API/下载/安装/卸载需要确认。
9. 系统提示会明确个人助理能力边界：记忆写入、自动化、通知、浏览器交互、本机 App 控制都需要确认。
10. `secrets.read` 默认拒绝，模型不会主动读取密钥、密码、token、cookie 或钥匙串数据。
11. 现有代码工作区读写、补丁确认、测试命令行为不回退。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 误读敏感文件 | 默认只放开常用个人目录，并保留敏感目录黑名单 |
| 误移动大量个人文件 | 批量写入、移动、重命名前必须先列计划确认 |
| shell 绕过权限 | 继续保持 shell 命令白名单，不新增 `mv`、`rm`、`find` 这类自由命令 |
| 网络请求造成副作用 | 网页搜索和网页 GET 可用；API 和下载默认确认，非 GET 请求必须说明影响 |
| 软件安装来源不可信 | 首版只考虑 Homebrew 这类包管理器，禁止未知脚本和 `curl | sh` |
| 个人助理能力过宽 | 默认关闭自动化、通知、浏览器交互和本机 App 控制，按工具/插件逐步启用 |
| 长期记忆写入错误 | 写入、更新、删除记忆都需要确认，并提供查看/删除能力 |
| 凭据泄露 | `secrets.read` 默认拒绝，敏感目录和浏览器凭据不纳入默认读取范围 |
| 高影响操作难追踪 | `audit.enabled` 默认开启，记录移动、下载、安装、API 请求等操作 |
| 影响代码任务 | 默认 workspace 行为保持不变，个人目录只作为额外授权根 |
| 配置膨胀 | 使用一个 `permissions` 块，后续可扩展但首版保持小而清楚 |

## 实施顺序

1. 在协议和配置层新增 `permissions.fileSystem/software/network/memory/automation/notifications/browser/apps/secrets/audit`，文件系统默认包含 6 个个人目录。
2. 增加路径权限解析，支持 `~` 展开、fileSystem allowed roots、敏感目录拒绝。
3. 修改 `read_file`、`list_dir`、`grep` 等读工具的路径判断。
4. 新增 `move_file`、`rename_file`，并让它们复用授权路径判断；删除首版先做计划，不执行。
5. 修改写工具在个人目录下的提示和确认行为，保留 workspace 写入路径。
6. 修改系统提示，表达统一 agent + 文件、软件、网络和个人助理能力的分层权限规则。
7. 增加单元测试覆盖默认放行、未授权拒绝、敏感目录拒绝、移动重命名、workspace 回归。
8. 更新 README 配置说明和示例。

