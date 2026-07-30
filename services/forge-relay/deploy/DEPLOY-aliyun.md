# 阿里云部署 Forge Relay

本文说明如何在阿里云 ECS 上部署公网 Forge Relay，以及部署完成后如何在 Forge Desktop / 手机端完成连接。

若本机已有代码、不想先推 Git，可直接用 SSH/rsync 同步后起容器，见 [DEPLOY-aliyun-ssh.md](./DEPLOY-aliyun-ssh.md)。  
**已上线环境的日常运维与发版更新**见 [RUNBOOK.md](./RUNBOOK.md)。

Relay 只做外层认证与端到端加密帧转发，不解析、不持久化 Mobile RPC 正文。生产环境必须使用 HTTPS 公网 Origin。

## 1. 架构

```text
手机 App  ── HTTPS / WSS ──┐
                          ├─▶ 阿里云 ECS
公司电脑 Forge Desktop    ─┘      │
  / Channel Gateway                ├─ Caddy :443（TLS）
                                   ├─ forge-relay :8080（内网）
                                   └─ PostgreSQL :5432（仅容器网络）
```

硬性约束（代码与协议强制）：

| 项 | 要求 |
|----|------|
| `FORGE_RELAY_PUBLIC_ORIGIN` | 必须是 `https://host`，无路径、无 query、无 hash |
| Enrollment Token | 至少 32 个字符 |
| 公网端口 | 只开放 80/443；PostgreSQL 不出公网 |
| WebSocket 空闲超时 | 反代 ≥ 120 秒（本目录 `Caddyfile` 已配置） |
| TLS | 最低 1.2，优先 1.3（Caddy 默认） |

## 2. 资源准备

### 2.1 推荐规格

- ECS：2 vCPU / 2–4 GB 内存，Ubuntu 22.04 LTS（或兼容的 Alibaba Cloud Linux）
- 公网 IP / EIP
- 已备案或可解析的域名，例如 `relay.example.com`（Caddy 用 Let's Encrypt 自动签证书，**不能用裸 IP 当 Origin**）
- 磁盘：40 GB+ SSD 足够小规模验证；生产按备份与日志量扩容

个人联调最低可用 1c / 2g；长期生产建议 2c / 4g。

### 2.2 安全组

入方向：

| 端口 | 协议 | 来源 | 用途 |
|------|------|------|------|
| 22 | TCP | 仅运维 IP | SSH |
| 80 | TCP | `0.0.0.0/0` | ACME 验证 / HTTP→HTTPS |
| 443 | TCP | `0.0.0.0/0` | Relay HTTPS / WSS |

不要对公网开放 `5432`、`8080`。

### 2.3 DNS

将 `relay.你的域名` 的 A 记录指向 ECS 公网 IP。部署前确认：

```bash
dig +short relay.你的域名
```

## 3. 服务器初始化

SSH 登录 ECS 后：

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
# 重新登录后使 docker 组生效

# 可选：安装 Go（仅本机跑 keygen 时需要；也可用 golang 容器生成密钥）
# sudo apt-get update && sudo apt-get install -y golang-go
```

拉取包含 `services/forge-relay` 的仓库，进入目录：

```bash
git clone <forge-agent 仓库 URL>
cd forge-agent/services/forge-relay
```

## 4. 生成密钥与环境变量

### 4.1 JWT 签名私钥

容器以非 root 用户 `65532:65532` 运行，私钥需对该 UID 可读、且不要 world-readable：

```bash
mkdir -p deploy/secrets

# 方式 A：本机已安装 Go
go run ./cmd/keygen -out deploy/secrets/relay-jwt-private.pem

# 方式 B：用临时容器生成
docker run --rm -v "$PWD:/src" -w /src golang:1.25 \
  go run ./cmd/keygen -out deploy/secrets/relay-jwt-private.pem

sudo chown 65532:65532 deploy/secrets/relay-jwt-private.pem
sudo chmod 0400 deploy/secrets/relay-jwt-private.pem
```

私钥不要提交到 Git。

### 4.2 `deploy/.env`

```bash
cd deploy

cat > .env <<EOF
FORGE_RELAY_DOMAIN=relay.你的域名
POSTGRES_PASSWORD=$(openssl rand -hex 24)
FORGE_RELAY_ENROLL_TOKEN=$(openssl rand -hex 32)
EOF

# 妥善保存 ENROLL_TOKEN，后续 Desktop 配置要用；勿提交仓库
chmod 600 .env
cat .env
```

说明：

- `FORGE_RELAY_DOMAIN`：公网主机名；`docker-compose.yml` 会将其拼为 `FORGE_RELAY_PUBLIC_ORIGIN=https://${FORGE_RELAY_DOMAIN}`
- `POSTGRES_PASSWORD`：仅容器内 Postgres 使用
- `FORGE_RELAY_ENROLL_TOKEN`：电脑首次向 Relay 注册 host 时使用的共享凭证，≥32 字符

## 5. 启动服务

迁移与启动**分开**执行；`forge-relay` 进程不会自动应用 schema：

```bash
cd /path/to/forge-agent/services/forge-relay

# 构建并执行迁移
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate

# 启动 Relay + Caddy（Postgres 由依赖自动拉起）
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d postgres relay caddy
```

查看状态：

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f --tail=100 caddy relay
```

## 6. 验收

```bash
# 容器内
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec relay wget -qO- http://127.0.0.1:8080/readyz

# 公网（等待 Caddy 完成证书签发，通常数十秒到两分钟）
curl -fsS "https://relay.你的域名/readyz"
```

期望类似：

```json
{"hostsOnline":0,"status":"ready","version":"..."}
```

对外应可达：

- `GET /healthz`
- `GET /readyz`
- `GET /metrics`（按需限制来源）
- `POST /v1/...`（Host / 手机认证与连接）

## 7. Desktop 与手机连接配置

部署完成后，运维把下面两个值安全交给被授权的 Forge Desktop 管理员：

| 字段 | 值 | 注意 |
|------|-----|------|
| Relay Origin | `https://relay.你的域名` | 必须 HTTPS；不要尾斜杠；不要带 `/v1` 等路径 |
| Enrollment Token | `.env` 中的 `FORGE_RELAY_ENROLL_TOKEN` | 首次注册电脑时使用；勿写入公开文档 |

### 7.1 Desktop

1. 打开 **设置 → 权限**（全局配置 `~/.forge-agent/config.json`）：
   - 启用 `permissions.channels`
   - 启用 `permissions.mobile`
   - 设置 `permissions.mobile.allowedProjects`（绝对路径，最小授权）
2. 进入左侧 **渠道**，确认 Daemon 已连接。
3. 在 **Forge Mobile** 区域点击 **配置全局连接**，填写 Relay Origin 与 Enrollment Token，保存。  
   Forge Mobile 是电脑级全局连接，不绑定项目工作目录。
4. 打开渠道开关，点击 **启动 Channel Gateway**。  
   首次启动会完成 host enrollment；就绪检查中「Relay 已注册」应变绿。
5. 打开 **配对与设备**，生成一次性二维码。重新生成会立即作废旧邀请。

### 7.2 手机

1. 安装 Forge Mobile（仓库 `apps/mobile`，真机需 Expo / 原生安装流程）。
2. 扫描 Desktop 生成的二维码完成配对。
3. 可访问目录 = 全局 `allowedProjects` ∩ 该设备在「配对与设备」中授权的路径。手机可在授权范围内创建与切换工作目录。

### 7.3 配置示例（仅权限段）

```json
{
  "permissions": {
    "channels": {
      "enabled": true,
      "create": "confirm",
      "start": "allow",
      "delete": "confirm"
    },
    "mobile": {
      "enabled": true,
      "pair": "confirm",
      "run": "confirm",
      "approve": "confirm",
      "allowedProjects": ["/absolute/path/to/allowed/root"],
      "maxDevices": 3,
      "maxConcurrentRunsPerDevice": 1
    }
  }
}
```

Mobile 权限只从**全局配置**读取，项目级 `.forge/config.json` 中的 `permissions.mobile` 不会作用于 Forge Mobile。

## 8. 运维

### 8.1 日常命令

```bash
cd /path/to/forge-agent/services/forge-relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f --tail=200 relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml restart relay
```

### 8.2 Enrollment Token 轮换

1. 生成新 token（≥32 字符），更新 `deploy/.env` 中 `FORGE_RELAY_ENROLL_TOKEN`。
2. `docker compose ... up -d relay`（或 `restart relay`）。
3. **已注册成功的电脑不受影响**（后续用 host credential）；只有尚未注册或需要重新注册的电脑要换成新 token。

### 8.3 数据库备份

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T postgres pg_dump -U forge_relay forge_relay > "forge_relay_$(date +%Y%m%d).sql"
```

库中主要为元数据与 token hash，不含 E2EE 会话明文。备份文件按机密保管。

### 8.4 升级与回滚（单节点）

首版单节点：更新时允许手机短暂重连，不宣称零停机。

1. CI 构建镜像，按 digest 部署同一产物。
2. 备份 PostgreSQL；执行向后兼容的 expand 迁移（本仓库用 `migrate` 服务）。
3. 拉起新版本，等待 `/readyz` 通过。
4. 验证：host control 重连、手机 resume、邀请创建、错误率。
5. 失败则回退上一镜像 digest；不在故障现场盲目 down migration。

详细策略见 [移动端 Relay 实施计划](../../../docs/superpowers/plans/2026-07-15-mobile-relay.md) 第 15 节。

### 8.5 监控建议

关注 `/metrics` 中例如：

- `relay_hosts_online`
- `relay_phone_connections_active`
- `relay_auth_failure_total`
- `relay_pairing_success_total` / `relay_pairing_failure_total`

日志默认不应打印 Authorization、完整 token、完整 payload。

## 9. 排障

| 现象 | 排查 |
|------|------|
| Desktop「无法连接 Relay」 | 域名解析、安全组 443、Caddy 证书、本机代理/防火墙 |
| 「Relay 拒绝凭证」 | Enrollment Token 与服务器 `.env` 是否一致；是否被截断空格 |
| 证书失败 / ACME | 域名是否指向本机；80 是否放行；是否被 CDN 劫持未到源站 |
| `/readyz` 不通但容器在跑 | 先查容器内 8080，再查 Caddy 反代与 `FORGE_RELAY_DOMAIN` |
| 配对码无效 | 必须用 Desktop 生成的 `forge://pair`；过期后重新生成；Origin 必须与部署 Public Origin 一致 |
| 手机能连但无项目 | 检查全局 `allowedProjects` 与设备级授权交集 |

## 10. 安全清单

- [ ] 公网仅 80/443；5432/8080 未暴露
- [ ] `.env` 与 JWT 私钥权限收紧，未入库
- [ ] Enrollment Token ≥32，经安全渠道分发
- [ ] `allowedProjects` 最小授权
- [ ] 二维码含短期秘密，泄漏即重新生成
- [ ] 定期备份 Postgres

## 11. 相关文档

- 本目录 [`README`](../README.md)（本地 compose 概览）
- [SSH 本机代码部署](./DEPLOY-aliyun-ssh.md)、[`ssh-sync.sh`](./ssh-sync.sh)
- [`docker-compose.yml`](./docker-compose.yml)、[`.env.example`](./.env.example)、[`Caddyfile`](./Caddyfile)
- [移动端与消息渠道指南](../../../docs/mobile-access.md)
- [配置参考 · 渠道与 Forge Mobile](../../../docs/configuration.md)
- [移动端 Relay 实施计划](../../../docs/superpowers/plans/2026-07-15-mobile-relay.md)
