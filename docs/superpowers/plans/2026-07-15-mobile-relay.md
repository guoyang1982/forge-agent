# Forge Mobile Relay 实施计划

> 状态：待实施 v3 · 2026-07-15
>
> 目标读者：后续负责协议、Relay、Daemon、Desktop 和 Mobile 的开发者或 Agent
>
> 执行方式：按阶段顺序完成复选框；每个 Gate 全绿后才能进入下一阶段

## 1. 目标

让公司电脑上的 Forge 在没有公网 IP、没有端口映射、手机不在同一局域网的情况下，仍能被已配对手机安全操作。

```text
家里的 Forge Mobile
        │
        │ 出站 WSS + 端到端加密帧
        ▼
公网 Forge Relay（只路由密文）
        ▲
        │ 出站 WSS + 端到端加密帧
        │
公司电脑 Channel Gateway
        └─ Mobile Adapter ── 本机 IPC ── Forge Daemon ── 项目 / Agent
```

首版交付以下能力：

- 公司电脑和手机都只建立出站 `wss://` 连接。
- 手机扫码完成短期邀请配对。
- 每台手机拥有独立、可轮换、可撤销的凭证。
- Relay 不持有端到端明文密钥，不保存 Prompt、文件、终端或 Agent 输出。
- 手机查看项目会话、历史消息和运行状态。
- 手机新建或继续 Agent 任务，实时接收 `AgentEvent`。
- 手机取消运行，审批或拒绝本次敏感操作。
- Desktop 查看 Relay 状态、已配对设备并撤销设备。
- 断网、公司电脑休眠和手机切前后台后自动恢复。

## 2. 已决设计

| 决策 | 选择 | 原因 |
|------|------|------|
| 公网路径 | 自建 Relay | 不依赖微信、公司 VPN 或第三方组网 |
| 首版拓扑 | 单节点 Relay + PostgreSQL | 先验证完整安全链路，不引入 Director/Cell 多集群 |
| Relay 语言 | Go | 长连接、并发转发、背压和优雅退出更符合 Go 的服务模型；产物为单二进制 |
| Relay 源码组织 | `services/forge-relay` 独立 Go module | 不依赖 pnpm/Node/Desktop 构建，但首版保持同仓便于协议联调 |
| Relay 发布单元 | 独立 OCI 镜像、版本和 CI/CD | Forge Desktop、Daemon 和 Channel Gateway 不随 Relay 发布 |
| Relay 拆仓策略 | 协议 v1 稳定后再评估 | 先避免跨仓协议漂移；独立 `go.mod`、镜像和流水线保证之后易于迁出 |
| 公司端进程 | 复用 `apps/channel-gateway` | 自研 App 作为自有渠道统一启停、监控和管理 |
| 公司端实现 | Channel Gateway 内新增 `MobileAdapter` | 进程与管理面统一，长连接、E2EE、设备身份和 Mobile RPC 保持独立模块 |
| 手机技术栈 | Expo / React Native | 需要系统安全存储、前后台生命周期和后续推送能力 |
| 首版连接策略 | Relay-only | 用户明确需要跨公网 Relay；LAN/Tailscale 直连留到后续 |
| 业务协议 | 独立 Mobile RPC 白名单 | 不把全部 Daemon RPC 暴露给手机 |
| 内容保护 | 应用层 E2EE | WSS 只保护链路，不能防止 Relay 读取业务正文 |
| Relay 身份 | 自托管 enrollment token | Forge 当前没有云账号体系，首版不先建设完整账号中心 |
| 数据持久化 | 元数据和凭证 hash | Relay 不落业务载荷；原始恢复凭证只在手机安全存储中 |

## 3. 非目标

首版不做：

- Relay 多地域、Director/Cell 调度和水平扩容。
- Relay 端 Agent 执行、项目镜像或会话数据库。
- 手机文件树、完整代码编辑器、Git 面板和浏览器画面。
- 交互式 PTY 终端。
- Android/iOS 推送唤醒。
- Web/PWA 手机客户端。
- 自动发现 LAN/Tailscale 并在直连和 Relay 之间迁移。
- 多租户计费、团队组织和 SSO。

这些能力只能在首版安全边界、恢复语义和压力数据稳定后追加。

## 4. Forge 当前基线与必须修复的缺口

### 4.1 可复用能力

- Daemon 已通过本机 socket 提供 JSON-RPC，入口为 `packages/bus/src/index.ts`。
- `RunRequest`、`RunResult`、`AgentEvent` 和 `DAEMON_METHODS` 已集中在 `packages/protocol/src/index.ts`。
- `run` 已支持会话续接、流式事件、取消和权限请求。
- `permission_response` 已能处理网络、命令、软件和外部 Runtime 审批。
- SessionStore 已支持会话列表、搜索、消息、检查点和派活计划。
- Channel Gateway 已证明“独立进程连接 Daemon，再执行本地项目”的进程模型可行。
- Daemon 已通过 `ChannelGatewayHost` 管理 Channel Gateway，可复用现有 PID、健康检查和日志边界；当前子进程退出后只清理状态，实施时需补充受控重启策略。

### 4.2 P0 阻断问题

1. **Daemon 事件当前广播到所有本机 socket。**

   `DaemonServer.broadcast()` 会把一个运行的事件写给所有连接。移动客户端接入后，这会造成不同 Desktop、Gateway 或设备之间的会话事件泄漏。

   必须改成：请求产生的事件只返回请求所属连接；显式订阅类事件再按 subscription 路由。不得依赖 Gateway 按 `sessionId` 事后过滤作为安全边界。

2. **现有 `connectDaemon()` 只有一个可覆盖的 `eventHandler`。**

   同一客户端并发调用时，后一个 `request(..., onEvent)` 会覆盖前一个 handler。`MobileAdapter` 必须支持多个并发手机和多个运行，所以需要 request-scoped event handler。

3. **Channel Gateway 的 `channelRun` 是非交互路径。**

   `run-service.ts` 会让 automation/channel 绕过命令确认。虽然自研 App 纳入 Channel Gateway 管理，`MobileAdapter` 仍不得将运行标记为 `channelRun`，必须保留交互式 `permission_request`，并把决定安全地绑定到发起运行的设备。

4. **当前没有移动设备注册表、Mobile RPC 白名单或 Relay 权限配置。**

5. **当前没有可跨进程复用的 E2EE 协议和测试向量。**

6. **Channel Gateway 当前的 `reloadAdapters()` 会先停止所有 Adapter，再串行重建。**

   启用、停用或重连 Forge Mobile 不应让微信等无关渠道短暂断线。必须改成按 adapterId 的差量 reconcile，并隔离每个 Adapter 的启动、停止和健康检查异常。

## 5. 目标组件

```text
apps/mobile
  Expo 手机客户端：扫码、设备凭证、会话 UI、运行与审批

services/forge-relay
  独立 Go module 和发布单元：host control、phone connect、data splice、租约和撤销

protocol/relay/v1
  语言无关的 Relay 外层 JSON Schema、错误码和跨语言 golden fixtures

apps/channel-gateway
  公司电脑统一渠道进程：现有消息渠道 + MobileAdapter

packages/channel-mobile
  MobileAdapter：Relay 控制连接、E2EE、设备会话、Mobile RPC 和 Daemon Bridge

packages/channel-core
  所有 Adapter 共享的生命周期，以及消息型/交互型能力分类

packages/mobile-protocol
  Relay 外层契约的 TypeScript 绑定/客户端、E2EE 握手结构、加密后 Mobile RPC schema

packages/mobile-crypto
  密钥生成、HKDF、加解密、计数器和 transcript 校验

packages/daemon-client
  从 Channel Gateway 抽出的 request-scoped Daemon 客户端

packages/protocol
  Channel Gateway 移动渠道的本机控制 RPC、状态和设备管理类型

apps/daemon
  ChannelGatewayHost、移动设备管理、权限和 Desktop IPC 接口
```

### 5.1 统一管理，分离协议

Channel Gateway 的抽象是：

```text
InboundMessage → 单次 Agent Run → OutboundReply
```

Forge Mobile 需要：

```text
长连接 → 多并发 RPC → subscriptions → binary frames → reconnect/resume
```

自研 App 在产品上是一个自有渠道，因此与微信、飞书、钉钉共用一个 Channel Gateway 进程和管理页。但它不是普通 HTTP Webhook，不复用 `InboundMessage → OutboundReply` 数据模型。

现有 `packages/channel-core/src/adapter.ts` 的 `ChannelAdapter` 强制每个适配器使用 `onInbound` 消息回调。实施时将其拆成共同生命周期和两类能力，目标结构如下（泛型和 type guard 以实际 TypeScript 实现为准）：

```typescript
interface AdapterLifecycle<TContext> {
  readonly kind: "ilink" | "feishu" | "dingtalk" | "mobile" | "http";
  readonly mode: "message" | "interactive";
  start(ctx: TContext): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<ChannelAdapterHealth>;
}

interface MessageChannelAdapter extends AdapterLifecycle<MessageAdapterContext> {
  sendReply(reply: OutboundReply): Promise<void>;
}

interface InteractiveChannelAdapter extends AdapterLifecycle<InteractiveAdapterContext> {
  pushEvent(event: AgentEvent): Promise<void>;
  requestApproval(request: PermissionRequest): Promise<void>;
}

type ChannelAdapter = MessageChannelAdapter | InteractiveChannelAdapter;
```

统一的部分：Daemon 连接、进程 PID、启停、健康检查、日志、渠道列表和 Desktop 管理入口。

必须分开的部分：消息适配器与 Mobile RPC、设备凭证、E2EE、流控、订阅、审批、二进制传输和权限策略。`MobileAdapter` 的异常不得终止其他渠道，且需要独立状态机、指标和日志上下文。

### 5.2 管控与故障边界

| 对象 | 谁管理 | 启停粒度 | 故障影响 |
|------|----------|----------|----------|
| Channel Gateway 进程 | Daemon / `ChannelGatewayHost` | 整个进程 | 进程退出时所有渠道暂停，本计划补充受控重启 |
| 微信、飞书、钉钉 Adapter | Channel Gateway | 单渠道 | 只影响该平台 |
| `MobileAdapter` | Channel Gateway | 单渠道 | 只断开 Forge Mobile，其他渠道继续运行 |
| 已配对手机 | `MobileAdapter` + Desktop | 单设备撤销 | 只断开该设备并作废其凭证 |
| Forge Relay | 公网部署系统 | 独立服务 | 影响公网手机连接，不影响本地 Daemon 和消息渠道 |

Desktop 不再提供第二个移动网关进程启停按钮。用户先启动 Channel Gateway，再在渠道列表中单独启用、停用或重连 `Forge Mobile`。

### 5.3 Relay 项目与仓库边界

Relay 是公网基础设施，不是 Forge Desktop 的一个 Node 子进程。首版使用 Go 实现，放在 `services/forge-relay` 独立 module 中，不加入 pnpm workspace 依赖图。

选择 Go 的原因：

- Relay 的核心是长时间 WebSocket、双向密文转发、租约、超时和背压，不执行 Agent 也不解析 E2EE 内部 Mobile RPC。
- goroutine 和 `context` 适合每连接独立生命周期、联动取消和优雅退出。
- 单二进制和小型镜像更便于部署、回滚、漏洞扫描和资源限额。
- Relay 只需处理外层协议，不值得为复用 Zod 而绑定 Node.js 运行时。

首版不立即拆成独立 Git 仓库。协议、Mobile Adapter、手机端和 Relay 在联调期会频繁同时修改，同仓可以在一个 PR 中更新协议契约和全部实现。部署便利由独立构建产物、镜像、迁移、配置和流水线保证，不依赖是否独立 Git 仓库。

同时满足以下条件后，再评估迁出为 `forge-relay` 独立仓库：

- Relay 外层协议 v1 冻结，且具备 N/N-1 兼容规则。
- `protocol/relay/v1` 的 JSON Schema 和 golden fixtures 可以作为独立版本产物发布。
- Relay 发布频率、运维权限或安全审核人员已经与 Forge 客户端明显分离。
- 拆仓后的协议发布和兼容性 CI 已经验证，不需要人工复制类型或测试数据。

## 6. 信任边界

### 6.1 信任对象

- Forge Daemon 和含 `MobileAdapter` 的 Channel Gateway 运行在公司电脑，属于同一可信主机。
- 已配对手机属于可信设备，但权限受 Mobile RPC 白名单限制。
- Relay 按不可信基础设施设计。
- TLS 终止层、反向代理、PostgreSQL 管理员和 Relay 日志读取者都不能获得业务明文。

### 6.2 Relay 可以看到

- `hostId`、`deviceId`
- IP、连接时间、在线状态
- 密文帧大小、流量和错误码
- 邀请、租约、凭证版本和撤销状态

### 6.3 Relay 不得看到或持久化

- 项目绝对路径
- Prompt、Agent 回复和思考内容
- 文件正文、Diff 和终端内容
- 模型 API Key、MCP secrets 和 Forge 配置明文
- E2EE 会话密钥
- 手机原始 resume token

## 7. 身份与密钥

### 7.1 三类凭证必须分离

| 凭证 | 用途 | 存储位置 |
|------|------|----------|
| Host enrollment credential | 公司电脑首次注册 Relay | Channel Gateway 本地安全文件；完成注册后可轮换 |
| Relay resume token | 手机向 Relay 证明可路由到 host | 原文只存手机 SecureStore；Relay 存 SHA-256 hash |
| Forge device token | 手机在 E2EE 内向公司 Forge 证明设备身份 | 原文只存手机 SecureStore；公司电脑存 hash |

Relay resume token 泄漏只影响路由层；没有 Forge device token 和 E2EE 身份仍不能调用 Daemon。Forge device token 泄漏也不能单独让攻击者找到并通过 Relay 路由。

### 7.2 Host 密钥

`MobileAdapter` 首次启用时生成：

- Ed25519 identity key：对 Relay challenge 签名。
- X25519 E2EE key：与手机建立共享秘密。

私钥写入 Forge dataDir 的 owner-only 文件；公钥用于派生：

```text
hostId = base64url(SHA-256(ed25519PublicKey))[0:22]
```

二维码固定 X25519 公钥。手机不得接受 Relay 替换后的公钥。

### 7.3 手机密钥

- 每次物理连接生成新的 X25519 临时密钥和 32 字节 client nonce。
- 配对成功后，将设备凭证保存到 Expo SecureStore。
- iOS 使用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 等价级别。
- Android 使用系统 Keystore 支持的 SecureStore 默认加密。

## 8. 配对流程

```text
Desktop             Mobile Adapter             Relay                Phone
   │                      │                       │                    │
   │ 创建配对二维码       │                       │                    │
   │─────────────────────▶│ invite.create         │                    │
   │                      │──────────────────────▶│                    │
   │                      │◀── inviteToken, TTL ──│                    │
   │◀── QR payload ───────│                       │                    │
   │                      │                       │◀── scan + connect ─│
   │                      │◀── connection.open ───│                    │
   │                      │── host data attach ──▶│                    │
   │                      │◀════ E2EE handshake / device auth ═══════▶│
   │                      │── install resume hash▶│                    │
   │                      │◀════ pairing complete / credentials ═════▶│
```

二维码 payload 版本 `v: 1`：

```typescript
interface ForgeMobilePairingOfferV1 {
  v: 1;
  relayOrigin: string;        // 只允许 canonical https origin
  hostId: string;
  hostE2eePublicKey: string;  // canonical base64，32 bytes
  deviceId: string;
  pairingSecret: string;      // 32 bytes base64url，一次性
  inviteToken: string;        // Relay 一次性凭证
  expiresAt: number;          // 最长 10 分钟
  protocolVersion: 1;
}
```

约束：

- QR 使用 `forge://pair?code=<base64url-json>`。
- `relayOrigin` 必须是无 path/query/hash 的 `https://` origin；仅自动化端到端测试允许 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`。
- `inviteToken` 和 `pairingSecret` 只可成功消费一次。
- 重新生成二维码必须立即使旧邀请失效。
- 配对 journal 必须先落盘再发起网络请求，崩溃恢复后能判断“未安装、已安装、需回滚”。
- 手机必须同时验证 `expiresAt` 和 Relay 返回的凭证种类。

## 9. E2EE v1 协议

### 9.1 握手

```text
phone → host: e2ee.hello
  version, phoneEphemeralPublicKey, clientNonce,
  hostId, deviceId, transport="relay"

host → phone: e2ee.ready
  hostE2eePublicKey, desktopNonce, selectedFraming,
  transcriptHash

phone → host: encrypted e2ee.auth
  deviceId, pairingSecret|deviceToken, transcriptHash

host → phone: encrypted e2ee.authenticated
  deviceId, transcriptHash, permissionsDigest
```

共享秘密：

```text
sharedSecret = X25519(phoneEphemeralSecret, hostStaticPublicKey)
```

通过 HKDF-SHA256 派生 96 字节：

```text
phoneToHostKey  = bytes 0..31
hostToPhoneKey  = bytes 32..63
sessionId       = bytes 64..95
```

HKDF 的 salt 包含双方 nonce；info 包含 canonical transcript hash。Transcript 至少绑定：协议版本、双方公钥、双方 nonce、hostId、deviceId、Relay origin、transport 和 payload capabilities。

### 9.2 加密帧

首选 `tweetnacl.secretbox`，每个方向独立密钥和计数器：

```text
header = version | sessionId | direction | payloadKind | uint64(counter)
nonce  = sessionId-prefix | version | direction | payloadKind | uint64(counter)
frame  = nonce | secretbox(header | payload)
```

规则：

- counter 必须从 0 严格递增，乱序、重复或跳号直接关闭连接。
- text 和 binary 使用独立 payload kind，不能互相解析。
- 连续 5 次解密失败关闭连接。
- 握手 10 秒未完成关闭连接。
- 单帧最大 1 MiB；控制帧最大 64 KiB。
- 新物理连接必须重新派生 session key，不复用 nonce/counter。

## 10. Relay 外层协议

`protocol/relay/v1` 是 Relay 外层协议的唯一语言无关契约源，包含 JSON Schema、错误码、成功/失败 golden fixtures 和版本兼容规则。Go Relay 与 TypeScript `packages/mobile-protocol` 都必须通过同一契约测试，不得手工各自维护一份不受测试的结构定义。

### 10.1 HTTP 接口

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/v1/hosts/enroll` | enrollment token 换 host credential |
| `POST` | `/v1/hosts/token` | 刷新短期 host JWT |
| `POST` | `/v1/resolve` | 手机根据 hostId 获取当前 Relay origin |
| `GET` | `/healthz` | 进程健康 |
| `GET` | `/readyz` | PostgreSQL、租约和 WSS 接入就绪 |

### 10.2 WebSocket 接口

| 路径 | 连接方 | 用途 |
|------|--------|------|
| `/v1/host/control` | Channel Gateway / Mobile Adapter | host 注册、邀请、设备、connection.open、租约 |
| `/v1/host/data/:connId` | Channel Gateway / Mobile Adapter | 使用一次性 ticket 接入某个手机数据通道 |
| `/v1/connect/:hostId` | Mobile | 邀请或 resume credential 鉴权后建立数据通道 |

WebSocket 凭证统一通过 `Authorization: Bearer` 传递，不放 query：host control
使用短期 host JWT，host data 使用一次性 `connTicket`，phone connect 使用 invite
或 resume token。Phone connect 另带 `X-Forge-Credential-Kind: invite|resume`；resume
连接必须带 `X-Forge-Device-ID`，invite 的 deviceId 只以 Relay 已消费的邀请记录为准。

### 10.3 Host control 消息

至少定义以下带版本的 schema：

```text
host.hello / host.challenge / host.proof / host.ready
auth.refresh
invite.create / invite.created / invite.revoke
device.install / device.installed / device.revoke / device.revoked
connection.open / connection.closed
lease.renew / lease.renewed
ping / pong
error
```

所有会产生状态变化的请求必须带 `requestId`，Relay 以 `(hostId, requestId)` 做幂等。

### 10.4 Data splice

1. 手机通过邀请或 resume token 连接 `/v1/connect/:hostId`。
2. Relay 验证凭证 hash、版本、到期时间和撤销状态。
3. Relay 在 host control 上发送 `connection.open`，包含 `connId`、一次性 `connTicket`、`deviceId`、credential kind 和 attach deadline。
4. Host 在 deadline 内连接 `/v1/host/data/:connId` 并发送 ticket。
5. 两边就绪后 Relay 只做二进制帧转发。
6. 任一侧关闭、超时或超过流控上限时同时关闭另一侧。

Relay 不解析 E2EE 内部 JSON-RPC。

## 11. Mobile RPC

### 11.1 Envelope

E2EE 内的文本 payload：

```typescript
type MobileRpcFrame =
  | { type: "rpc.request"; id: string; method: string; params?: unknown }
  | { type: "rpc.response"; id: string; ok: true; result: unknown }
  | { type: "rpc.response"; id: string; ok: false; error: MobileRpcError }
  | { type: "rpc.event"; subscriptionId: string; seq: number; event: unknown }
  | { type: "rpc.unsubscribe"; subscriptionId: string }
  | { type: "rpc.ping"; timestamp: number }
  | { type: "rpc.pong"; timestamp: number };
```

错误码固定为可枚举值，不把原始 stack、绝对秘密路径或 provider stderr 直接返回手机。

### 11.2 首版白名单

| Mobile method | Daemon 映射 | 限制 |
|---------------|-------------|------|
| `status.get` | `status` | 过滤内部路径和敏感配置 |
| `runtime.list` | `runtime.list` | 只返回 provider 状态、模式和模型摘要 |
| `session.list` | `list_sessions` | 只返回允许项目 |
| `session.search` | `search_sessions` | 强制 limit 和允许项目过滤 |
| `session.messages` | `get_session_messages` | 只读取已授权 session |
| `run.start` | `run` | `autoApply=false`；cwd 必须在允许项目中 |
| `run.cancel` | `cancel_run` | 只能取消该设备发起或显式接管的 run |
| `run.subscribe` | request-scoped events | 只订阅一个授权 session |
| `permission.pending` | MobileAdapter 本地 pending registry | 只返回本设备拥有的未处理请求 |
| `permission.respond` | `permission_response` | 绑定 deviceId/sessionId/requestId；首版禁止 remember |

首版禁止映射：

- `get_config`
- Skill/Plugin/Hub 安装和删除
- Automation 创建和删除
- Channel 创建、登录和删除
- `apply_patch`、`restore_checkpoint`
- 任意文件系统 RPC
- 任意未登记的 Daemon method passthrough

### 11.3 参数校验

- 所有方法使用 Zod schema 严格解析，拒绝未知字段。
- `limit`、字符串长度、附件大小和并发数必须有上限。
- 客户端不能传 `automationRun`、`channelRun` 或 `skipConfirm`。
- `MobileAdapter` 自己构造 `RunRequest`，不得把手机 JSON 直接 cast 为协议类型。
- `cwd` 使用 realpath 后再与允许项目比较，防止 `..` 和 symlink 逃逸。

## 12. 权限模型

在 `PermissionsConfig` 中新增：

```typescript
interface MobilePermissions {
  enabled: boolean;
  pair: PermissionLevel;
  run: PermissionLevel;
  approve: PermissionLevel;
  allowedProjects: string[];
  maxDevices: number;             // default 3
  maxConcurrentRunsPerDevice: number; // default 1
}
```

建议默认值：

```typescript
mobile: {
  enabled: false,
  pair: "confirm",
  run: "confirm",
  approve: "confirm",
  allowedProjects: [],
  maxDevices: 3,
  maxConcurrentRunsPerDevice: 1
}
```

执行原则：

- Mobile policy 与项目现有工具 policy 取更严格结果，不得放宽现有权限。
- 手机首次启动 run 可要求 Desktop 确认；用户显式选择“允许该设备远程运行此项目”后写项目授权。
- `permission.respond` 只能回应属于该 session 的 pending request。
- 首版手机审批永远强制 `remember=false`。
- Desktop 本地审批始终保留，不能被手机设备策略关闭。
- 设备撤销必须立即断开全部物理连接并取消其未完成审批；是否取消正在运行任务由 UI 明确选择。

## 13. 数据模型

### 13.1 Relay PostgreSQL

```text
relay_hosts
  host_id PK
  identity_public_key
  e2ee_public_key
  credential_hash
  credential_version
  status
  created_at / last_seen_at / revoked_at

relay_devices
  host_id + device_id PK
  resume_token_hash
  credential_version
  expires_at
  grace_token_hash nullable
  grace_expires_at nullable
  revoked_at

relay_invites
  invite_id PK
  host_id / device_id
  invite_token_hash
  expires_at / consumed_at / revoked_at

relay_audit_events
  id PK
  host_id / device_id nullable
  event_type
  result_code
  metadata_json（禁止业务 payload）
  created_at
```

在线 control socket、data splice 和 attach ticket 只存内存。单实例重启后客户端通过租约和 resume token 重连。

### 13.2 公司电脑

在 Forge `data.db` 增加：

```text
mobile_devices
  device_id PK
  display_name
  device_token_hash
  relay_credential_version
  allowed_projects_json
  paired_at / last_seen_at / revoked_at

mobile_pairing_journal
  pairing_id PK
  device_id
  phase
  expires_at
  metadata_json
```

Host 私钥和 Relay host credential 放 dataDir owner-only 文件，不写入 SQLite 明文字段。

### 13.3 手机

SecureStore：

- hostId
- deviceId
- host E2EE public key
- Forge device token
- Relay current/grace/pending resume credential

AsyncStorage：

- 显示名称
- 最近连接时间
- 非敏感 endpoint 和 UI 偏好

## 14. 事件路由与断线恢复

### 14.1 Daemon 请求作用域

修改本机 bus 协议：

- `agent.event` notification 增加 `requestId`。
- 请求产生的 emit 只写回请求所属 socket。
- `connectDaemon().request()` 维护 `requestId → event handler` map。
- 全局状态变化使用独立 `subscribe` RPC，不复用 run emit。
- 旧 Desktop 客户端兼容期内允许没有 requestId，但新 `MobileAdapter` 只接受 scoped event。

### 14.2 Mobile subscription

- 每个 subscription 有单调 `seq`。
- 手机记录最后处理的 seq。
- 重连后使用 `session.messages` 获取权威历史，再重新订阅 live event。
- 不承诺重放所有 text delta；最终消息和 session 数据库是权威状态。
- `permission_request` 必须持久或可重新查询，不能只存在易丢失的 socket event 中。

### 14.3 心跳和重连

- Relay control：15 秒 ping，30 秒无响应断开。
- Data socket：20 秒应用层 activity probe。
- Mobile Adapter Relay 连接：指数退避 `0.5s, 1s, 2s, 4s, 8s, 15s, 30s, 60s`，之后每 90 秒尝试；其他 Adapter 不受影响。
- 手机回到前台立即触发一次重连。
- Host JWT 到期前 60–120 秒随机提前刷新，避免同时刷新风暴。
- Relay lease 到期前 30 秒续租。

## 15. Relay 构建、部署与更新基线

### 15.1 独立构建与版本

`services/forge-relay` 必须具备自己的 `go.mod`、`Dockerfile`、数据库迁移和测试入口。Relay 构建不得依赖 `pnpm install`、Desktop 打包或 Channel Gateway 构建。

发布产物：

```text
forge-relay                         # Linux 单二进制
ghcr.io/<org>/forge-relay:0.1.0     # 语义化版本镜像
ghcr.io/<org>/forge-relay@sha256:...# 生产环境锁定的不可变 digest
relay-v0.1.0                        # 单仓库内独立 Relay tag
```

CI 单独使用 `.github/workflows/relay.yml`，只在 `services/forge-relay/**`、`protocol/relay/**` 或该 workflow 变更时触发。至少执行：

- `gofmt` 格式检查、`go vet ./...`、`go test -race ./...` 和 Linux 构建。
- Relay 外层 JSON Schema/golden fixtures 兼容性测试。
- PostgreSQL 迁移的空库升级、已有数据升级和重复执行测试。
- Linux `amd64`/`arm64` OCI 镜像构建、SBOM 生成、依赖与镜像漏洞扫描。
- 发布 tag 时推送版本镜像；禁止生产环境只使用可变 `latest` tag。

### 15.2 首版部署

```text
Internet
   │ :443
   ▼
Caddy / Nginx（TLS）
   │
   ├── /healthz /readyz
   └── WebSocket upgrade
          │
          ▼
      forge-relay (Go)
          │
          ▼
      PostgreSQL
```

建议环境变量：

```text
FORGE_RELAY_PUBLIC_ORIGIN=https://relay.example.com
FORGE_RELAY_DATABASE_URL=postgresql://<user>:<password>@postgres:5432/forge_relay
FORGE_RELAY_ENROLL_TOKEN=<at-least-32-random-bytes>
FORGE_RELAY_JWT_PRIVATE_KEY_FILE=/run/secrets/relay-jwt-private.pem
FORGE_RELAY_LOG_LEVEL=info
FORGE_RELAY_MAX_HOSTS=100
FORGE_RELAY_MAX_CONNECTIONS_PER_HOST=8
FORGE_RELAY_MAX_FRAME_BYTES=1048576
```

部署要求：

- 只公开 443；PostgreSQL 不暴露公网。
- 反向代理 WebSocket idle timeout 至少 120 秒。
- TLS 最低 1.2，优先 1.3。
- 日志默认不打印 query、Authorization、token、完整 hostId/deviceId 或 payload。
- 容器使用非 root 用户和只读根文件系统。
- enrollment token 通过 secret 注入，不写进 compose 文件或仓库。
- 数据库备份只包含元数据和 token hash。

### 15.3 更新与回滚

首版是单节点 Relay，更新时允许已连接手机短暂重连，不宣称零停机。标准流程：

1. CI 构建一次镜像，生产环境按 digest 部署同一产物。
2. 备份 PostgreSQL，执行向后兼容的 expand 迁移；首版禁止与旧 Relay 不兼容的同版破坏性删列/改列。
3. 启动新版本，等待 `/readyz` 通过后恢复流量。
4. 验证 host control 重连、手机 resume、邀请创建和 Prometheus 错误率。
5. 失败时将镜像 digest 回退到上一版；数据库依靠向后兼容迁移保持可运行，不在故障现场盲目 down migration。
6. 观察窗结束后再在后续版本执行 contract 清理。

Relay 必须在独立运维手册中记录升级、回滚、JWT key 轮换、enrollment token 轮换、数据库恢复和紧急设备撤销操作。

## 16. 可观测性

指标：

```text
relay_hosts_online
relay_phone_connections_active
relay_splices_active
relay_pairing_success_total / failure_total
relay_auth_failure_total{reason}
relay_frames_total{direction}
relay_bytes_total{direction}
relay_attach_latency_ms
relay_connection_duration_ms
relay_backpressure_disconnect_total
mobile_adapter_reconnect_total
mobile_rpc_requests_total{method,result}
```

日志仅记录：requestId、截断后的 host/device 标识、状态迁移、错误码、耗时和字节数。不得记录 E2EE payload。

## 17. 分阶段执行

### Phase 0：协议与本机事件隔离

**目标：** 在不接公网之前，先建立不会跨连接泄漏的协议和测试基础。

**Files:**

- Create: `packages/mobile-protocol/`
- Create: `packages/mobile-crypto/`
- Create: `packages/daemon-client/`
- Create: `protocol/relay/v1/schemas/`
- Create: `protocol/relay/v1/testdata/`
- Create: `protocol/mobile-crypto/v1/test-vector.json`
- Modify: `packages/bus/src/index.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/channel-gateway/src/forge-bridge.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

- [x] 以语言无关 JSON Schema 定义 Relay HTTP/WSS 外层协议、错误码和版本字段。
- [x] 为 Relay 外层协议提交成功与失败 golden fixtures，Go 和 TypeScript 实现必须共用。
- [x] 在 `packages/mobile-protocol` 定义 pairing、E2EE 和 Mobile RPC Zod schemas；Relay 不解析这些内层结构。
- [x] 实现 X25519、HKDF-SHA256、双向 key schedule 和 secretbox frames。
- [x] 固定 canonical transcript 编码，提交跨 Node/React Native 测试向量。
- [x] 把 Daemon event 改为 request-scoped，不再广播 run event。
- [x] 实现并发安全的 `DaemonClient`，每个 request 独立事件 handler。
- [x] Channel Gateway 迁移到 `DaemonClient`，保证现有微信渠道不回归。
- [x] 增加两个并发 run 不串事件的集成测试。
- [x] 增加解密失败、重放、乱序、错误 transport/hostId transcript 的负向测试。

**Gate 0：**

- [x] `pnpm --filter @forge/mobile-protocol test`
- [x] `pnpm --filter @forge/mobile-crypto test`
- [x] `pnpm --filter @forge/daemon-client test`
- [x] `pnpm --filter @forge/channel-gateway test`
- [x] `pnpm --filter @forge/daemon test`
- [x] 证明连接 A 无法观察连接 B 的 `AgentEvent`。

### Phase 1：单节点 Relay

**目标：** 使用两个测试客户端，通过公网形态 Relay 转发不可读密文。

**Files:**

- Create: `services/forge-relay/go.mod`
- Create: `services/forge-relay/cmd/relay/main.go`
- Create: `services/forge-relay/internal/httpapi/`
- Create: `services/forge-relay/internal/control/`
- Create: `services/forge-relay/internal/splice/`
- Create: `services/forge-relay/internal/lease/`
- Create: `services/forge-relay/internal/store/`
- Create: `services/forge-relay/internal/audit/`
- Create: `services/forge-relay/internal/metrics/`
- Create: `services/forge-relay/migrations/`
- Create: `services/forge-relay/deploy/docker-compose.yml`
- Create: `services/forge-relay/deploy/Caddyfile`
- Create: `services/forge-relay/Dockerfile`
- Create: `services/forge-relay/Makefile`
- Create: `.github/workflows/relay.yml`
- Modify: `.github/dependabot.yml` (add Go module and Relay image dependency updates)

- [x] 实现 host enroll、短期 JWT 和 refresh。
- [x] 实现 host challenge/proof，challenge 绑定 origin、hostId、epoch 和 expiry。
- [x] 实现 host control 状态机和租约。
- [x] 实现一次性邀请、消费、过期和撤销。
- [x] 实现 resume token hash、current/grace 版本轮换。
- [x] 实现 phone connect、host data attach 和一次性 ticket。
- [x] 实现双向背压、大小限制和联动关闭。
- [x] 实现健康检查、结构化审计和 Prometheus 指标。
- [x] 实现 `relay migrate up` 或等价的独立迁移命令，服务启动不默认执行未审核迁移。
- [x] Go 服务端和 TypeScript 测试客户端共同通过 `protocol/relay/v1` 契约测试。
- [x] 提供 Docker Compose + PostgreSQL + Caddy 的本地部署方式。
- [x] 产出 Linux `amd64`/`arm64` 单二进制和独立 OCI 镜像，无 pnpm/Node 运行时依赖。

**Gate 1：**

- [x] 未授权手机不能触发 `connection.open`。
- [x] ticket 重放失败。
- [x] invite 第二次消费失败。
- [x] 被撤销设备现有 splice 立即关闭。
- [x] Relay 进程日志和数据库中搜索不到测试 payload 明文；Relay 只接触测试 secretbox 密文。
- [x] 1 MiB 上限和慢消费者背压测试通过。
- [x] Relay 重启后 current/grace credential 可以恢复连接。
- [x] `go test -race ./...`、协议契约测试、迁移测试和镜像扫描进入 Relay 独立 CI。
- [x] 更换 Relay 镜像后 host 和手机能按 resume 语义重连；回退上一版 digest 仍可读取升级后数据库。

### Phase 2：Channel Gateway Mobile Adapter

**目标：** 在现有 Channel Gateway 进程内增加自有移动渠道，通过出站 WSS 注册 Relay，并把安全 Mobile RPC 映射到本机 Daemon。

**Files:**

- Create: `packages/channel-mobile/`
- Create: `packages/channel-mobile/src/adapter.ts`
- Create: `packages/channel-mobile/src/relay-transport.ts`
- Create: `packages/channel-mobile/src/device-registry.ts`
- Create: `packages/channel-mobile/src/mobile-rpc-router.ts`
- Create: `packages/mobile-test-client/`（协议客户端、CLI 和真实 Relay E2E）
- Create: `apps/daemon/src/services/mobile-service.ts`
- Create: `packages/protocol/src/mobile.ts`
- Create: DB migration for `mobile_devices`, `mobile_pairing_journal`
- Modify: `packages/channel-core/src/adapter.ts`
- Modify: `packages/channel-core/src/types.ts`
- Modify: `packages/protocol/src/channel.ts`
- Modify: `apps/channel-gateway/src/gateway.ts`
- Modify: `apps/daemon/src/main.ts`
- Modify: `apps/daemon/src/services/channel-gateway-host.ts`
- Modify: `packages/protocol/src/permissions.ts`
- Modify: `packages/config/src/permissions.ts`
- Modify: `package.json`, `pnpm-workspace.yaml`

- [x] 定义 `ChannelAdapter` 共同生命周期，以及 `MessageChannelAdapter` / `InteractiveChannelAdapter` 分类能力。
- [x] 在 `packages/channel-core` 和 `packages/protocol/src/channel.ts` 中将 `mobile` 加入 `ChannelKind`。
- [x] 在 `apps/channel-gateway/src/gateway.ts#createAdapter()` 中注册 `MobileAdapter`，不注册为 HTTP Webhook。
- [x] 将 `reloadAdapters()` 改为按 adapterId 差量 reconcile；单个 Adapter 启停失败只记录到该渠道状态。
- [x] 生成并以 `0700` 目录、`0600` 原子文件安全保存 host Ed25519/X25519 密钥。
- [x] 实现 enrollment、host JWT 刷新、lease renew 和带抖动的 control reconnect。
- [x] 实现二维码邀请创建、旧邀请轮换撤销和先落盘的 pairing journal。
- [x] 实现 host data attach 与 E2EE server state machine。
- [x] 实现本地 device registry、token hash 和 constant-time 验证。
- [x] 实现 Mobile RPC 白名单、Zod 参数校验和错误脱敏。
- [x] 实现 allowed project realpath 检查。
- [x] 实现 run event subscription、取消和 pending permission 查询。
- [x] 强制手机 `permission.respond.remember=false`。
- [x] 手机发起的 run 不设置 `channelRun`、`automationRun` 或 `skipConfirm`。
- [x] 实现设备撤销、本地立即断连和 Relay durable revoke outbox。
- [x] Channel Gateway 启停时统一启停已启用 Adapter；Mobile Adapter 连接失败时只重连自身。
- [x] Mobile Adapter 未配置、鉴权失败或连接异常不得阻断微信、飞书、钉钉等其他 Adapter。
- [x] 状态接口同时返回 Gateway 总体状态和每个 Adapter 的独立状态。
- [x] `ChannelGatewayHost` 增加带抖动的有界重启，区分“用户主动停止”与“异常退出”，避免无限崩溃循环。

**Gate 2：**

- [x] 手机测试客户端能 list session、读取历史、启动 run、接收事件和取消（真实 Go Relay/PostgreSQL + Daemon/Gateway E2E）。
- [x] Channel Gateway 只有一个进程和 PID，可同时运行微信渠道与 Forge Mobile（同进程双 Adapter 集成测试断言唯一 Gateway PID）。
- [x] 断开 Relay 或提供错误凭证后，现有消息渠道仍可正常收发（真实 Mobile Adapter enrollment 网络失败时，健康消息 Adapter 保持连接且不重启）。
- [x] 启用、停用或重连 Forge Mobile 时，微信等无关 Adapter 的连接不重建（差量 reconcile 自动化测试覆盖）。
- [x] 强制终止 Channel Gateway 后能受控恢复；用户点击“停止 Gateway”后不会被自动拉起（真实子进程 `SIGKILL`、新 PID 恢复及显式停止测试覆盖）。
- [x] 不允许项目、symlink 逃逸和未知 RPC 全部失败关闭或返回 forbidden。
- [x] 手机不能读取 `get_config` 或调用安装/删除方法。
- [x] 一个设备不能审批另一个设备未授权的 session request（pending 查询与 respond 均按 deviceId/sessionId 绑定测试）。
- [x] 撤销设备后本地和 Relay 恢复凭证都失效（E2E 断言 resume 返回 HTTP 401）。

**2026-07-16 实现进度：** Phase 2 主链路与 Gate 2 已落地并通过 `@forge/channel-mobile` 6 个密钥/安全/路由测试、Mobile Protocol 6 个协议测试、Mobile Test Client 1 个 E2EE/RPC 集成测试、Channel Gateway 4 个回归测试、Daemon 25 个回归测试、LLM 7 个流式/取消测试、全 workspace 编译和 Relay 全量 Go 测试。`pnpm --filter @forge/mobile-test-client test:e2e` 已使用隔离的真实 Go Relay、PostgreSQL、Daemon、Gateway 和 mock 流模型验证配对、E2EE、会话列表/历史、run 事件、即时取消、resume、设备撤销及撤销后 401。额外的进程级测试已验证同一 Gateway PID 承载多 Adapter、真实 Mobile Relay enrollment 网络失败不重启健康消息 Adapter，以及 Gateway 被 `SIGKILL` 后换新 PID 受控恢复、显式停止后不再拉起。

### Phase 3：Desktop 管理面

**目标：** 用户可以在统一的“渠道接入”页添加 Forge Mobile，完成 Relay 配置和设备治理。

**Files:**

- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/renderer/app.js`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `docs/configuration.md`
- Modify: `docs/mobile-access.md`

- [x] 在现有“添加渠道”列表新增 `Forge Mobile`，类型为 `mobile`，默认关闭。
- [x] 保留独立的“自研系统 (HTTP API)”渠道类型，明确其只用于 Webhook/API，不代表 Forge Mobile。
- [x] Gateway 顶部仍只显示一个进程 PID，渠道卡片分别显示连接和错误状态。
- [x] 配置 Relay origin 和 enrollment credential，不在 renderer 暴露原文。
- [x] 显示 disconnected / connecting / registered / error 状态。
- [x] 生成、复制和重新生成 QR；重新生成立即撤销旧 invite。
- [x] 显示设备名称、配对时间、最后在线和允许项目。
- [x] 支持撤销设备和修改项目授权；设备授权只能是渠道 `allowedProjects` 的子集。
- [x] 显示最近安全事件，不显示业务内容。
- [x] 关闭 Forge Mobile 渠道时明确说明现有手机连接会断开，但其他渠道继续运行。

**Gate 3：**

- [x] Desktop renderer 无法通过 IPC 读取 enrollment credential 或私钥（渠道 CRUD 响应统一 secret redaction 测试覆盖）。
- [x] Relay 未配置、网络失败、token 失效和时钟偏差都有可操作错误提示。
- [x] QR 截图泄漏后，用户能通过“重新生成”使旧码立即失效。
- [x] 界面不会将 Forge Mobile 误标成 HTTP Webhook，也不要求用户启动第二个 Gateway。

**2026-07-16 实现进度：** Phase 3 与 Gate 3 已完成。统一渠道管理面已接入 Mobile 创建、共享 Gateway 状态、Relay 连接诊断、一次性二维码、设备列表/撤销、按设备项目授权和安全事件；所有渠道读取接口会脱敏 secret 字段。项目授权在 Mobile Adapter 服务端校验，renderer 只能将设备授权设置为渠道 `permissions.mobile.allowedProjects` 的子集，不能自行扩权。

### Phase 4：Expo Mobile MVP

**目标：** 交付可安装的 iOS/Android 手机端，覆盖远程 Agent 主流程。

**Files:**

- Create: `apps/mobile/`
- Create: `apps/mobile/src/transport/`
- Create: `apps/mobile/src/storage/`
- Create: `apps/mobile/src/screens/`
- Create: `apps/mobile/src/session/`

- [x] 扫码、粘贴 pairing code、Base64URL/schema/expiry 校验。
- [x] 实现 Relay outer auth 和 E2EE client state machine（React Native WebSocket headers、host key/transcript pinning、secretbox 双向帧和加密 RPC）。
- [x] device/relay credential 只写 SecureStore；只有收到 `e2ee.authenticated` 后才持久化。
- [x] 实现 host 列表、连接状态、resume 重连和移除 host。
- [x] 实现 session 列表、搜索、消息历史和下拉刷新；Mobile 端对白名单字段做二次清洗。
- [x] 实现授权工作区/项目选择、在授权根目录下创建项目，以及无历史会话时直接创建会话并启动 Agent。
- [x] 实现新建/续接 run、流式文本、工具状态和完成状态。
- [x] 实现取消 run；收到 `session_start` 后才开放取消按钮。
- [x] 实现 permission request 卡片，支持允许一次/拒绝；强制 `remember=false` 由 Host 端执行。
- [x] 实现前后台重连、指数退避和 activity probe。
- [x] 实现连接诊断页，日志自动脱敏。

**2026-07-16 实现进度：** Phase 4 代码项已完成。`apps/mobile` 基于 Expo SDK 57，已实现 Camera 扫码/粘贴、严格 pairing URI 校验、Host 列表、SecureStore、Relay invite/resume outer auth、E2EE handshake、加密 RPC client、session 列表/搜索/历史/刷新，以及新建/续接 run、流式文本、工具状态、取消和单次权限响应。应用进入后台时受控关闭连接，回到前台后自动 resume；网络故障使用 500ms–30s 带 jitter 的指数退避，每 30s 通过 E2EE `status.get` 做 activity probe，凭证失效或 E2EE 完整性错误会停止重试并要求重新配对。诊断页最多保留 100 条连接事件，对 Bearer、device/resume/invite token、URL secret 参数、长不透明串和 Host ID 统一脱敏，不记录 Prompt、回复、Webhook 或 Bot Token。`deviceToken` / `resumeToken` 只在收到 `e2ee.authenticated` 后以 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 写入 SecureStore；完整 pairing offer 仅保存在短生命周期 ref，握手开始即清空，React UI state 只保留非敏感 Host 摘要。启动及前台恢复时会对账 Host 摘要与 SecureStore 凭证，凭证缺失或损坏时自动移除旧 Host、清理连接状态并明确提示重新配对，不降级为明文存储。Daemon 返回的 session/message/run event 在 Mobile 端再次按渲染字段白名单清洗，工具参数、工具结果、未知事件与权限 detail 不直接进入 UI。Mobile TypeScript、10 个解析/脱敏/恢复/安全存储测试和真实 Metro iOS Hermes export（626 modules）均已通过。Gate 4 仍需在跨网络 iOS/Android 真机上验证。

**2026-07-16 项目工作流补充：** E2EE Mobile RPC 已增加 `project.list` / `project.create`，只列出设备授权工作区及其直接子目录；新项目只能在显式授权的工作区根下创建，目录名使用严格白名单，拒绝 `..`、符号链接逃逸和已存在路径。手机端已改为“电脑项目 → 项目会话 → Agent 运行”三层导航，项目无历史会话时也能直接输入任务创建会话。Mobile 12 个测试、Mobile RPC 10 个测试、全 workspace 编译及 Android Hermes export（634 modules）已通过。

**2026-07-16 真机超时修复：** 真机证明 Agent run 可在公司端正常完成，但原客户端对所有 RPC 统一使用 30s 请求超时，会将耗时 40s 以上的 `run.start` 误报失败。现在普通列表/状态 RPC 仍保留 30s 上限，`run.start` 由 E2EE 连接生命周期、完成事件和用户取消控制，不再使用固定墙钟超时。真实 `MobileRelayClient` 假时钟回归测试已验证 30.001s 后仍保持等待并能在 Host 响应后正常完成；Mobile 15/15 测试通过。

**Gate 4：**

- [ ] 手机使用蜂窝网络、公司电脑在另一网络时可完成全流程。
- [ ] 手机进后台 5 分钟后返回可自动恢复，不要求重新配对。
- [ ] 公司电脑休眠恢复后手机可自动恢复。
- [ ] 手机 SecureStore 清除后旧 host profile 自动失效，不静默降级。
- [ ] Android 和 iOS 都通过真机测试。

**2026-07-16 自动化进度：** 已通过 SecureStore mock 测试验证凭证清除后旧 Host profile 会自动失效，但本 Gate 保持未勾选，等待 iOS Keychain / Android Keystore 真机行为和跨网络验收。

### Phase 5：生产加固和灰度

- [ ] Relay 24 小时连接 soak test。
- [ ] 100 host / 500 phone 模拟连接压测。
- [ ] 网络抖动、代理断连、数据库短暂不可用和 Relay restart fault test。
- [ ] 第三方依赖和镜像漏洞扫描。
- [ ] E2EE 协议安全审查，重点检查 transcript、nonce、counter 和 credential rotation。
- [ ] 日志与数据库明文扫描。
- [ ] enrollment、host key、JWT key 和数据库恢复演练。
- [ ] 先对一个测试项目和一个设备灰度，不默认对所有项目开放。
- [ ] 完成运维手册、事故撤销流程和版本兼容矩阵。

**2026-07-16 故障测试进度：** 真实 Go Relay/PostgreSQL/Daemon/Channel Gateway/Mobile Test Client 链路已新增 Relay 容器重启演练，验证 Host control 使用原身份自动回连、手机使用原 resume credential 恢复且无需重新 enrollment/配对；恢复后设备撤销仍会使旧凭证返回 401。网络抖动、代理断连和数据库短暂不可用尚未验证，因此不提前勾选整个 fault-test 条目。

**Release Gate：**

- [ ] 不开放任何公司电脑公网入站端口。
- [ ] Relay 无法解密测试业务载荷。
- [ ] 默认配置下 Mobile Relay 关闭，allowedProjects 为空。
- [ ] 所有高风险负向测试进入 CI。
- [ ] 设备撤销、host credential 轮换和 JWT key 轮换均完成演练。

## 18. 测试矩阵

| 类别 | 必测场景 |
|------|----------|
| Pairing | 正常、过期、重放、旧 QR、并发扫码、崩溃恢复 |
| Crypto | 公钥替换、transcript 篡改、nonce 重用、counter 重放/跳号/乱序 |
| Relay auth | 错 host、错 device、过期 JWT、撤销、current/grace rotation |
| Routing | attach timeout、ticket 重放、host 离线、手机先到、host 重连 |
| Backpressure | 手机慢、host 慢、超过 1 MiB、队列溢出、半开 socket |
| RPC | 未知 method、未知字段、超长参数、越权 session、越权 cwd |
| Permissions | 网络/命令/软件允许与拒绝、跨设备审批、remember 强制 false |
| Recovery | 手机前后台、公司休眠、Relay restart、DB 抖动、代理 502 |
| Revocation | 本地立即断开、云端重试、离线撤销后恢复、旧凭证拒绝 |
| Privacy | 日志、数据库、metrics、错误响应无业务明文或 secrets |

## 19. 后续能力

首版稳定后按需求追加：

1. LAN/Tailscale direct endpoint，与 Relay 并发竞速。
2. Stable Logical Client，在 direct/relay 间迁移并重放 subscriptions。
3. 文件浏览、Diff、Git 操作和安全编辑。
4. 二进制终端流、viewport 和 backpressure。
5. APNs/FCM 推送，只传不敏感 notification id。
6. Director + 多 Cell + Redis 租约，实现多地域和滚动迁移。
7. Forge Cloud 账号、团队组织、设备策略和 Relay entitlement。

## 20. 实施时必须重新确认的事项

下列值在编码前通过设计评审锁定，不能由实现者临时猜测：

- Relay 部署域名、云厂商和数据区域。
- Go toolchain 版本、WebSocket/PostgreSQL 依赖和镜像基础层，在 Phase 1 短期 spike 后锁定。
- OCI 镜像仓库、发布授权与生产部署平台。
- enrollment token 的发放与轮换流程。
- 手机是否允许发起会修改文件的 Agent run，还是首版只读。
- Desktop 关闭后是否允许 Daemon/Channel Gateway 继续后台运行。
- 设备撤销时是否默认取消其正在运行的任务。
- Mobile 权限是按项目、按设备，还是设备与项目交集。
- App Store/TestFlight 与 Android 分发方式。

## 21. 完成定义

只有同时满足以下条件，才可以称为“Forge 支持公网移动 Relay”：

- 公司电脑无公网入站端口，手机在另一网络可稳定操作。
- 手机与 Channel Gateway 中的 `MobileAdapter` 完成端到端身份验证和内容加密。
- 公司端只运行一个 Channel Gateway 进程，Forge Mobile 作为自有渠道被独立启停和观测。
- Mobile Adapter 断连、凭证失效或 Relay 故障不会阻断其他渠道。
- Relay 只路由密文，不持有业务明文密钥，不保存业务 payload。
- Relay 以 `services/forge-relay` Go module 独立构建，通过版本化 OCI 镜像和独立 CI/CD 发布。
- Relay 可以独立升级或回滚，不要求重新发布 Desktop、Daemon 或 Channel Gateway。
- 每台设备独立凭证，可撤销、可轮换，撤销立即生效。
- Mobile RPC 使用显式白名单和严格 schema，不直通 Daemon。
- 并发连接和 Agent 事件不会跨设备、跨会话泄漏。
- 敏感操作仍经过 Forge 权限系统，手机不能扩大项目原有权限。
- 断线、休眠、前后台和 Relay 重启后能够恢复。
- 关键负向、安全、恢复和压力测试进入 CI。
