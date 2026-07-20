# Forge Agent 移动端与消息渠道指南

Forge Agent 通过 Channel Gateway 连接移动端和外部消息平台。在不搬走本地代码与工作区的前提下，用户可以从外部渠道向电脑上的 Agent 派发任务并接收结果。

Channel Gateway 是统一的渠道层，不绑定某个特定平台。微信 iLink 与 Forge Mobile 都运行在同一个 Gateway 进程和 PID 中；Forge Mobile 通过公网 Relay 连接，Relay 只转发端到端加密后的数据。

## 当前支持范围

| 能力 | 当前状态 |
|------|----------|
| 统一 Channel Gateway | 已支持 |
| 消息/通知渠道绑定到指定本地项目 | 已支持 |
| 电脑级全局 Forge Mobile 渠道 | 已支持（每台电脑一个） |
| 桌面端同步显示渠道会话 | 已支持 |
| 微信 iLink 文字消息入站与回复 | 已接入 |
| Forge Mobile Relay、配对与设备撤销 | 已接入（测试客户端可用） |
| Forge Mobile iOS / Android App | MVP 工作台已实现（配对、工作空间只读浏览、完整会话执行、多电脑） |
| 微信图片、语音和文件消息 | 暂未支持 |
| 飞书、钉钉、自研 App HTTP Webhook | 自动化通知渠道 |

“自研 App (HTTP)”是单向 Webhook/自动化通知渠道，不是 Forge Mobile，也不提供远程交互会话。

## 工作方式

```text
外部消息渠道
    ↓
Channel Gateway
    ↓
本机 Forge Daemon / Agent
    ↓
绑定的本地项目
    ↓
执行结果回复到原渠道，并同步到桌面端会话
```

代码、项目目录、会话数据和工具仍由本机 Forge 管理。外部渠道只作为任务入口和结果接收端。

## 通用接入流程

1. 在 Forge 桌面端选择要配置消息渠道的项目；Forge Mobile 是电脑级全局连接，不绑定项目，可直接配置。
2. 打开 **设置 → 权限**，启用渠道能力。
3. 进入左侧 **渠道**，确认 Daemon 已连接。
4. 点击 **添加渠道**，选择已经可用的渠道适配器。
5. 根据渠道要求完成登录或连接配置。
6. 启用新建的渠道。
7. 启动 **Channel Gateway**。
8. 从外部渠道发送任务，例如“检查当前项目最近的代码变更”。

消息会进入绑定项目，对应会话也会出现在该项目的桌面端侧栏中。

### 当前渠道示例：微信 iLink

选择 **微信 iLink** 后，使用微信扫描二维码并确认授权，再启用渠道和 Gateway。首次使用时需要从微信给 Bot 发送一条文字消息；当前图片、语音和文件消息会被跳过。

### Forge Mobile 公网 Relay

1. 在 **全局** 权限（设置 → 权限）中同时启用 `channels` 与 `mobile`，并设置 `mobile.allowedProjects`。
2. 在电脑级 **Forge Mobile** 区域配置唯一的全局连接，填写 HTTPS Relay Origin 和 Enrollment Token。该表单不绑定项目目录，也不需要名称和描述；渠道默认关闭，已经配置后不会再提供重复创建入口。
3. 启用渠道并启动页面顶部唯一的 Channel Gateway；不要另起 Mobile Gateway。
4. 打开 **配对与设备**，生成一次性二维码。重新生成会立即撤销旧邀请。
5. 配对后可查看设备名称、配对时间、最后在线与允许项目，可收缩/切换单设备项目权限，也可立即撤销设备。项目访问由设备的 `allowedProjects` 管理，不能超出全局配置中的 `permissions.mobile.allowedProjects`。

Forge Mobile 在所有项目的渠道页面都可见。它的权限始终读取全局配置（`~/.forge-agent/config.json`），与任何项目目录无关；手机可以在 `allowedProjects` 授权范围内创建和切换工作目录。

Enrollment Token、host 私钥和设备 token 不会返回 Desktop renderer。二维码自身包含短期一次性秘密，截图泄漏时应立即点击“重新生成”。

## Forge Mobile App（MVP）

Forge Mobile 是桌面端的移动工作台，不是完整桌面镜像。手机通过 Relay 以端到端加密（E2EE）方式调用本机 Daemon；Relay 只转发密文，无法读取 Prompt、回答或文件内容。

### 信息架构

底部四个入口：工作台、工作空间、会话、设置。支持多台已配对电脑，默认自动进入上次使用的电脑。

### 移动端 RPC

已有：

- `status.get`、`runtime.list`
- `project.list`、`project.create`
- `session.list`、`session.search`、`session.messages`
- `run.start`、`run.cancel`、`run.subscribe`
- `permission.pending`、`permission.respond`

首版新增（均受设备 `allowedProjects`、真实路径校验与符号链接防逃逸约束）：

| 方法 | 作用 |
|------|------|
| `git.branches` | 当前分支、可切换分支、detached / dirty |
| `git.switch` | 切换分支；运行中禁止；脏工作区需 `confirmDirty: true` |
| `workspace.files.list` | 只读目录列表，单目录最多 **500** 条 |
| `workspace.file.read` | 只读文本预览，最大 **200 KiB**；二进制仅元信息 |
| `workspace.diff.list` | 工作区 Diff 摘要 |
| `workspace.diff.get` | 单文件统一 Diff，最大 **500 KiB** |

文件与 Diff 始终只读：不支持编辑、保存、上传或下载。

### 同步与重连

- Daemon 会话存储是手机与电脑共同的事实来源。
- 实时事件用于低延迟展示；进入会话与断线恢复后通过 `session.messages` 拉取持久化历史。
- 按 `(subscriptionId, seq)` 去重事件；运行结束后重新加载持久化历史。
- 重连后调用 `permission.pending`，并尽量 `run.subscribe`；若运行已结束则回退到持久化历史。

### 首版不包含

文件编辑与附件、Git commit/merge/rebase/push、自动化管理、人才中心 / Skill / 插件、完整桌面设置镜像、后台推送基础设施。

## 使用条件与边界

- 电脑需要保持开机，Forge Daemon 与 Channel Gateway 需要持续运行。
- 公司电脑与手机都只需出站连接公网 Relay，不要求同一局域网，也不要求公司路由器开放入站端口。
- 每个渠道支持的消息类型和认证方式由对应适配器决定。
- 微信 iLink 当前仅处理文字消息，且 Bot 不能主动发起首次对话。
- 微信、飞书、钉钉和 HTTP 渠道与项目绑定；Forge Mobile 是电脑级全局渠道，通过设备授权控制可访问项目。
- 移动端任务会使用该项目可用的模型、Skills、工具和权限配置。
- 不建议为无人值守渠道开放不必要的删除、安装或外部网络权限。

## 适合的使用场景

- 离开电脑后查询项目状态或最近变更。
- 让 Agent 生成项目摘要、排查思路或代码审查报告。
- 触发耗时较长但权限边界清晰的本地任务。
- 接收自动化任务结果，并回到桌面端继续处理完整会话。

## 渠道扩展

Channel Gateway 按多渠道架构设计。消息 Adapter（微信等）、交互 Adapter（Forge Mobile）和通知 Webhook（飞书、钉钉、自研 App HTTP）共享进程管理，但保持独立连接和错误状态；Mobile Relay 故障不会重启其他 Adapter。

## 排障

### 渠道消息没有进入 Forge

依次检查：渠道权限是否启用、渠道是否完成登录或连接、渠道开关是否开启、Gateway 是否运行，以及 Daemon 是否显示已连接。

### 桌面端找不到渠道会话

消息渠道需要在其绑定项目下查看。Forge Mobile 连接会全局显示，但具体会话仍显示在会话所属项目的侧栏中。

### 外部渠道没有收到回复

先确认该适配器支持当前消息类型，并保持电脑、Daemon 和 Gateway 在线。若任务需要敏感权限，回到桌面端检查是否正在等待确认。

### Forge Mobile 显示未连接或错误

- “无法连接 Relay”：检查公司公网、代理、防火墙和 Relay Origin。
- “Relay 拒绝凭证”：检查 Enrollment Token；首次注册凭证错误时删除并重新添加渠道。
- “认证时间校验失败”：同步公司电脑系统时间。
- 关闭 Forge Mobile 只会断开手机；微信等其他渠道会继续运行。

## 相关文档

- [阿里云部署 Forge Relay](../services/forge-relay/deploy/DEPLOY-aliyun.md)
- [移动端 Relay 实施计划](superpowers/plans/2026-07-15-mobile-relay.md)
- [桌面端指南](desktop-guide.md)
- [配置参考](configuration.md)
- [操作手册](user-guide.md)
- [返回首页](../README.md)
