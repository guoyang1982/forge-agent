# 阿里云 SSH 本机代码部署 Forge Relay

适合：本机已有可运行的 `services/forge-relay` 代码，不想先推远程 Git，直接用 SSH 同步到 ECS 再起 Docker。

`ssh-sync.sh` 优先用 rsync；远端没有 rsync 时自动改用 tar-over-ssh（阿里云精简镜像常见）。

上线后的日常运维、发版更新见 [RUNBOOK.md](./RUNBOOK.md)。

前提与安全组和域名要求与 [DEPLOY-aliyun.md](./DEPLOY-aliyun.md) 相同：公网域名、只开放 80/443、Origin 必须是 `https://host`。

## 0. 本机准备

```bash
# 能免密或带密钥登录 ECS（把变量换成你的）
export RELAY_HOST=root@你的公网IP   # 或 ubuntu@EIP；有域名也可用
export RELAY_SSH_KEY=~/.ssh/id_ed25519   # 可选
export REMOTE_DIR=/opt/forge-relay

# 本机仓库路径
cd /path/to/forge-agent/services/forge-relay

# 测连通
ssh ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} "$RELAY_HOST" 'uname -a'
```

## 1. 远程一次性初始化

仅首次执行：

```bash
ssh ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} "$RELAY_HOST" bash -s <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
# 非 root 用户时再加：usermod -aG docker "$USER"
mkdir -p /opt/forge-relay
REMOTE
```

## 2. 同步本机代码到 ECS

只同步 Relay 目录；**不会**覆盖远程已有的 `deploy/.env` / `deploy/secrets/`。

推荐直接用脚本（远端无 rsync 也能跑）：

```bash
cd /path/to/forge-agent/services/forge-relay
./deploy/ssh-sync.sh "$RELAY_HOST" "$REMOTE_DIR"
# 带密钥： SSH_KEY=~/.ssh/id_ed25519 ./deploy/ssh-sync.sh root@EIP /opt/forge-relay
```

可选：在 ECS 上装 rsync 后脚本会自动走更快的增量同步：

```bash
ssh "$RELAY_HOST" 'yum install -y rsync 2>/dev/null || (apt-get update && apt-get install -y rsync)'
```

## 3. 密钥与 `.env`（仅首次）

### 3.1 本机写 `.env` 再 scp（推荐）

```bash
cat > /tmp/forge-relay.env <<EOF
FORGE_RELAY_DOMAIN=relay.你的域名
POSTGRES_PASSWORD=$(openssl rand -hex 24)
FORGE_RELAY_ENROLL_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 /tmp/forge-relay.env
cat /tmp/forge-relay.env   # 保存 ENROLL_TOKEN，Desktop 要用

scp ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} \
  /tmp/forge-relay.env "${RELAY_HOST}:${REMOTE_DIR}/deploy/.env"
rm -f /tmp/forge-relay.env
```

### 3.2 在 ECS 上生成 JWT 私钥

```bash
ssh ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} "$RELAY_HOST" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}
mkdir -p deploy/secrets
if [[ ! -f deploy/secrets/relay-jwt-private.pem ]]; then
  docker run --rm -v "\$PWD:/src" -w /src golang:1.25 \
    go run ./cmd/keygen -out deploy/secrets/relay-jwt-private.pem
  chown 65532:65532 deploy/secrets/relay-jwt-private.pem
  chmod 0400 deploy/secrets/relay-jwt-private.pem
fi
ls -la deploy/secrets deploy/.env
REMOTE
```

私钥留在 ECS，不要用本机测试密钥覆盖生产机。

## 4. 远程构建并启动

```bash
ssh ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} "$RELAY_HOST" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}

docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build postgres relay caddy

docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec -T relay wget -qO- http://127.0.0.1:8080/readyz || true
REMOTE
```

公网验收（本机执行）：

```bash
curl -fsS "https://relay.你的域名/readyz"
```

## 5. 日常更新（改代码后再发）

```bash
# 本机
cd /path/to/forge-agent/services/forge-relay
./deploy/ssh-sync.sh "$RELAY_HOST" "$REMOTE_DIR"

# 远程重建 relay（Postgres 数据卷保留；.env / secrets 未被 rsync 覆盖）
ssh ${RELAY_SSH_KEY:+-i "$RELAY_SSH_KEY"} "$RELAY_HOST" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}
docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm migrate
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build relay
# 若 Caddyfile 也改了：再 up -d caddy
REMOTE
```

## 6. Desktop / 手机打通

与 [DEPLOY-aliyun.md §7](./DEPLOY-aliyun.md#7-desktop-与手机连接配置) 相同：

1. Relay Origin = `https://relay.你的域名`
2. Enrollment Token = 远程 `deploy/.env` 里的 `FORGE_RELAY_ENROLL_TOKEN`
3. Desktop 开 `channels` + `mobile` → 配置全局连接 → 启 Channel Gateway → 生成配对二维码
4. 手机扫码

## 7. 注意

| 项 | 说明 |
|----|------|
| 同步范围 | 只同步 `services/forge-relay`，不必整仓 |
| 机密 | `.env` / `secrets/` 默认不同步；远程生成后只留在 ECS |
| `--delete` | 会删远程多余文件；机密目录已 exclude，勿去掉 exclude |
| 域名 | 仍需 DNS A 记录；不能用裸 IP 作 Public Origin |
| 与 Git 部署 | 也可以后改成服务器 `git pull`；SSH rsync 适合未推送的本地改动 |

排障见 [DEPLOY-aliyun.md §9](./DEPLOY-aliyun.md#9-排障)。
