# Forge Mobile Test Client

用于验证 Forge Mobile Relay/E2EE/Mobile RPC，不是最终 App。

## 一键真实链路测试

要求本机可使用 Docker/OrbStack：

```bash
pnpm --filter @forge/mobile-test-client test:e2e
```

脚本在隔离临时目录和独立容器网络中启动 PostgreSQL、Go Relay、Daemon、Channel Gateway 与挂起式 mock 模型，验证：

- 首次 enrollment、邀请配对和 E2EE；
- `session.list`、`session.messages`；
- `run.start`、request-scoped events 和即时 `run.cancel`；
- resume credential 重连；
- Relay 容器重启后 Host control 自动回连，手机使用原 resume credential 恢复，无需重新 enrollment 或配对；
- 设备撤销后本地断连，Relay resume 返回 401；
- 取消后的用户消息不会重复入库。

脚本退出时会清理临时进程、容器、网络、镜像和测试数据。

## 手工连接

```bash
node packages/mobile-test-client/dist/cli.js \
  --socket /path/to/daemon.sock \
  --adapter-id <mobile-adapter-id> \
  --state /tmp/mobile-state.json
```

`--state` 含设备恢复凭证，文件会以 `0600` 保存，不能提交到仓库或发送给他人。
