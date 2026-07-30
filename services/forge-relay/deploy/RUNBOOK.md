# Forge Relay 部署与运维手册（阿里云 · 已上线）

本文记录当前公网 Relay 的落地形态、Desktop / 手机配置，以及日常运维与版本更新。  
首次从零部署可参考：

- [DEPLOY-aliyun.md](./DEPLOY-aliyun.md) — 标准说明
- [DEPLOY-aliyun-ssh.md](./DEPLOY-aliyun-ssh.md) — 本机 SSH 同步部署

## 1. 当前架构

```text
手机 Forge Mobile  ── HTTPS / WSS ──┐
                                   ├─▶ 阿里云 ECS（华北2 北京）
公司电脑 Desktop / Channel Gateway ─┘      │
                                           ├─ Caddy :443（Let's Encrypt）
                                           ├─ forge-relay :8080（仅容器网）
                                           └─ PostgreSQL :5432（仅容器网）
```

| 项 | 当前值（示例，按实际 `.env` 为准） |
|----|-----------------------------------|
| 代码目录 | `/opt/forge-relay` |
| 公网 IP | ECS 公网地址 |
| 域名 | `relay.qingyi001.com`（A 记录指向该 IP） |
| Public Origin | `https://relay.qingyi001.com` |
| 部署方式 | 本机 `ssh-sync.sh` → 服务器 Docker Compose |
| 组件 | `postgres` + `migrate` + `relay` + `caddy` |

Relay 只做外层认证与 E2EE 帧转发，不解析、不持久化 Mobile RPC 正文。

## 2. 服务器关键文件

```text
/opt/forge-relay/
├── cmd/ … internal/ …          # Go 源码
├── Dockerfile
├── deploy/
│   ├── .env                    # 机密：域名、DB 密码、Enrollment Token（勿入库）
│   ├── secrets/
│   │   └── relay-jwt-private.pem   # JWT 私钥文件（必须是文件，不能是目录）
│   ├── docker-compose.yml
│   ├── Caddyfile
│   ├── ssh-sync.sh             # 本机同步脚本
│   └── *.md                    # 部署文档
```

### 2.1 `deploy/.env`（模板）

```bash
FORGE_RELAY_DOMAIN=relay.qingyi001.com
POSTGRES_PASSWORD=<长随机串>
FORGE_RELAY_ENROLL_TOKEN=<至少32字符随机串>
```

- `FORGE_RELAY_DOMAIN` → 拼成 `FORGE_RELAY_PUBLIC_ORIGIN=https://该域名`
- `FORGE_RELAY_ENROLL_TOKEN` → Desktop 首次注册 host 用；已注册电脑后续用 host credential，换 Token 不影响已注册机

### 2.2 JWT 私钥

```bash
# 必须是普通文件；若误建成目录会导致 relay 不断 Restarting
file deploy/secrets/relay-jwt-private.pem   # 期望 PEM / ASCII，不是 directory
chown 65532:65532 deploy/secrets/relay-jwt-private.pem
chmod 0400 deploy/secrets/relay-jwt-private.pem
```

容器以 UID `65532` 只读挂载该文件。若路径在首次 `up` 时不存在，Docker 可能创建同名**目录**，需 `rm -rf` 后重新 `keygen`。

## 3. Desktop / 手机配置（已打通清单）

### 3.1 Desktop

1. **设置 → 权限（全局）**
   - 启用 `channels`、`mobile`
   - 配置 `permissions.mobile.allowedProjects`（绝对路径，最小授权）
2. **渠道 → Forge Mobile**
   - Relay Origin：`https://relay.qingyi001.com`（无尾斜杠、无 `/v1`）
   - Enrollment Token：与服务器 `.env` 中一致
3. **打开渠道右侧开关**（「已启用」），确认 **Channel Gateway** 在跑
4. 就绪检查应全部打勾：
   - Daemon 已连接
   - 共享 Gateway 运行中
   - Forge Mobile 已启用
   - Relay 已配置
   - **Relay 已注册**
5. **配对与设备** → 生成二维码（重新生成会作废旧邀请）

电脑需保持开机；Daemon + Channel Gateway 持续运行。

### 3.2 手机

1. 安装 Forge Mobile
2. 扫描 Desktop 二维码完成配对
3. 可访问目录 = 全局 `allowedProjects` ∩ 该设备授权路径

手机与公司电脑都只需**出站**访问公网 Relay，不要求同一局域网。

## 4. 日常运维命令

均在 ECS 上、目录 `/opt/forge-relay`：

```bash
cd /opt/forge-relay

# 状态
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps

# 日志
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f --tail=200 relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f --tail=100 caddy

# 重启某一服务
docker compose --env-file deploy/.env -f deploy/docker-compose.yml restart relay

# 健康检查
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec relay wget -qO- http://127.0.0.1:8080/readyz

# 公网（本机）
curl -fsS --cacert /etc/ssl/cert.pem "https://relay.qingyi001.com/readyz"
# 期望含 "status":"ready"；hostsOnline 随在线电脑变化
```

### 4.1 数据库备份

```bash
cd /opt/forge-relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T postgres pg_dump -U forge_relay forge_relay \
  > "forge_relay_$(date +%Y%m%d_%H%M%S).sql"
```

库中主要为元数据与 token hash，不含 E2EE 会话明文。备份文件按机密保管。

### 4.2 Enrollment Token 轮换

1. 改 `deploy/.env` 中 `FORGE_RELAY_ENROLL_TOKEN`（≥32 字符）
2. `docker compose ... up -d --force-recreate relay`
3. **已注册成功的电脑不受影响**；仅尚未注册或需重新 enrollment 的电脑改用新 Token

### 4.3 换域名

1. DNS A 记录指向当前 ECS 公网 IP；安全组放行 80/443
2. 改 `.env` 的 `FORGE_RELAY_DOMAIN`
3. `up -d --force-recreate relay caddy`，等 Caddy 重新签证书
4. Desktop 更新 Relay Origin；已用旧 Origin 注册的电脑可能需删除全局连接后重配

## 5. 版本更新（改代码后发版）

首版单节点：更新时允许手机短暂重连，不宣称零停机。

### 5.1 本机同步代码

`ssh-sync.sh` **不会**覆盖远程 `deploy/.env` 与 `deploy/secrets/`。

```bash
# 在开发机仓库内
cd /path/to/forge-agent/services/forge-relay

./deploy/ssh-sync.sh root@<公网IP> /opt/forge-relay
# 可选：SSH_KEY=~/.ssh/xxx ./deploy/ssh-sync.sh root@IP /opt/forge-relay
```

远端无 `rsync` 时脚本会自动改用 tar-over-ssh。

### 5.2 服务器构建并滚动

```bash
ssh root@<公网IP>
cd /opt/forge-relay

# 有 schema 变更时先迁移（无变更也安全）
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate

# 重建并拉起 relay（Postgres 数据卷保留）
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build relay

# 若只改了 Caddyfile
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --force-recreate caddy

# 验收
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
curl -fsS "https://relay.qingyi001.com/readyz"
```

国内构建已默认 `GOPROXY=goproxy.cn`。若仍超时：

```bash
GOPROXY=https://mirrors.aliyun.com/goproxy/,direct \
  docker compose --env-file deploy/.env -f deploy/docker-compose.yml build --no-cache relay
```

### 5.3 回滚思路

1. 备份 Postgres（见 §4.1）
2. 用上一份已知可用的代码树再 `ssh-sync`（或服务器上保留旧目录副本）
3. `up -d --build relay`，确认 `/readyz` 与 Desktop「Relay 已注册」
4. 不在故障现场盲目 down migration

### 5.4 一键更新备忘（复制用）

```bash
# --- 开发机 ---
cd ~/path/to/forge-agent/services/forge-relay
./deploy/ssh-sync.sh root@8.152.102.234 /opt/forge-relay

# --- ECS ---
cd /opt/forge-relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build relay
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
```

## 6. 国内环境注意（已踩过）

| 问题 | 处理 |
|------|------|
| `docker pull` 超时 | `/etc/docker/daemon.json` 配 registry-mirrors，再 `systemctl restart docker` |
| `go mod download` 访问 proxy.golang.org 超时 | Dockerfile / compose 已默认 `goproxy.cn` |
| 仅有公网 IP、无域名 | 不能作 Public Origin；可用正式域名或临时 `x.x.x.x.sslip.io` |
| 北京等大陆机房 + 自有域名 | 通常需 ICP 备案接入；80/443 才稳定 |
| Mac `curl: (77) cacert` | 检查 `~/.curlrc` 是否指向不存在的 CA 路径 |
| JWT `is a directory` | 删除错误目录后重新 `keygen`，再 `chown 65532` |

## 7. 排障速查

| 现象 | 排查 |
|------|------|
| 公网 502 | `ps` 看 relay 是否 Restarting；先看 `logs relay` |
| Desktop「Relay 已配置」但不「已注册」 | 打开渠道开关；核对 Origin/Token；删除全局连接后重配 |
| Relay 拒绝凭证 | Token 与 `.env` 是否一致（无空格） |
| 证书失败 | DNS 是否指向本机；安全组 80/443；Caddy 日志 |
| 手机无项目 | `allowedProjects` 与设备授权交集 |
| `Couldn't find env file: .../deploy/.env` | 必须在 `/opt/forge-relay` 下执行 compose，不要在 `/root` |

## 8. 安全清单

- [ ] 公网仅 80/443；5432、8080 不暴露
- [ ] `.env`、JWT 私钥权限收紧，不同步进 Git
- [ ] Enrollment Token 经安全渠道分发
- [ ] `allowedProjects` 最小授权
- [ ] 配对二维码含短期秘密，泄漏即重新生成
- [ ] 定期 Postgres 备份

## 9. 相关文件

- [`ssh-sync.sh`](./ssh-sync.sh)
- [`docker-compose.yml`](./docker-compose.yml)
- [`Caddyfile`](./Caddyfile)
- [`../README.md`](../README.md)
