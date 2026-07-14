# Forge 桌面端 A+B 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** 加固 Forge 桌面端 daemon/IPC/安全模型，并补齐补丁应用、目录选择、MCP daemon 化与资源页体验。

**Architecture:** 渲染进程仅经 preload 调 main；main 统一 `requestDaemonMethod*` 访问 daemon；新增 `list_mcp` RPC 替代渲染进程读盘。

**Tech Stack:** Electron 31, TypeScript (main/preload), vanilla JS (renderer), `@forge/protocol`, `@forge/daemon` app-service

---

## 文件地图

| 文件 | 职责 |
|------|------|
| `packages/protocol/src/index.ts` | `LIST_MCP` 类型与 method 常量 |
| `apps/daemon/src/services/app-service.ts` | `handleListMcp` |
| `apps/daemon/src/main.ts` | 注册 `list_mcp` |
| `apps/desktop/src/main.ts` | 安全 webPreferences、pick-directory、统一 RPC、PING 轮询 |
| `apps/desktop/src/preload.ts` | 暴露 `pickDirectory`、`listMcp` |
| `apps/desktop/src/renderer/app.js` | 去 require、补丁 UI、目录选择、MCP 页、转义、运行态 |
| `apps/desktop/src/renderer/index.html` | 搜索框、补丁按钮、选择目录按钮（按需） |
| `apps/desktop/src/renderer/styles.css` | 新控件样式 |
| `packages/config` 或 daemon 测试 | `handleListMcp` 单测（可选） |

---

## Phase 1 — Daemon 可靠性（A2 + A3）

- [ ] **1.1** 在 `main.ts` 将 `waitForDaemonReady(cfg)` 实现为 PING 轮询（100ms × 80）
- [ ] **1.2** `ensureDaemon` / `restartDaemon` 改用 `waitForDaemonReady`，删除单独 `sleep(1300)` 依赖
- [ ] **1.3** 新增 `requestDaemonMethodWithEvents`（`run` 用），共享 Unknown method 重试逻辑
- [ ] **1.4** 迁移 `list-sessions`、`daemon-status`、`cancel-run`、`apply-patch` 到 `requestDaemonMethod`
- [ ] **1.5** 手动验证：杀旧 daemon → 打开 Skills 仍成功

**验证:** `pnpm --filter @forge/desktop run build && pnpm --filter @forge/desktop start`，Skills/插件/会话列表正常。

---

## Phase 2 — MCP RPC + 去硬编码（B3 + A4）

- [ ] **2.1** `protocol`: 添加 `ListMcpRequest/Result`、`DAEMON_METHODS.LIST_MCP`
- [ ] **2.2** `handleListMcp` in `app-service.ts`（configured + fromPlugins + hints）
- [ ] **2.3** `daemon/main.ts` 注册 handler
- [ ] **2.4** `desktop/main.ts` + `preload.ts`: `forge:list-mcp`
- [ ] **2.5** `app.js`: `renderMcpView` 改用 `bridge.listMcp(cwd)`，删除 `node:fs` 块
- [ ] **2.6** `createDefaultProject()` 与项目模态默认值改为非硬编码（main 传 `userData` 或 renderer 用 `bridge.getDefaultCwd()`）
- [ ] **2.7** 可选：`forge:get-default-cwd` IPC 返回 `app.getPath('documents')`

**验证:** 在无 monorepo 硬编码路径的机器上 MCP 页仍能显示插件来源与 config。

---

## Phase 3 — Electron 安全（A1）

- [ ] **3.1** `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- [ ] **3.2** 移除 `app.js` 顶部 `window.require` 兜底；`bootstrap` 仅检查 `window.forgeDesktop`
- [ ] **3.3** `preload` 补齐 renderer 需要的全部 API（含 `pickDirectory` 占位若 Phase 4 未做可先 stub）
- [ ] **3.4** 全页冒烟：新对话、run 流式事件、设置保存、侧栏导航

**验证:** DevTools Console 执行 `typeof require` 为 `undefined`（或无法访问 node）。

---

## Phase 4 — 体验功能（B1 + B2 + B4 + B5）

- [ ] **4.1** `main.ts` + `preload`: `forge:pick-directory` → `dialog.showOpenDialog`
- [ ] **4.2** 项目模态「选择目录」按钮绑定
- [ ] **4.3** `showCodeDetail` / patch 流：`应用补丁` 调 `applyPatch`，显示结果
- [ ] **4.4** Skills 页：搜索 input + 过滤；失败 UI 含「重试」
- [ ] **4.5** `renderPluginView` 统一 `escapeHtml`
- [ ] **4.6** `running` 时 composer 禁用发送、`messageInput` readOnly
- [ ] **4.7** `styles.css` 补丁操作栏、搜索框、disabled 态

**验证:** 触发 `patch_proposed` 后手动应用；新建项目用目录选择器；Skills 搜索过滤生效。

---

## Phase 5 — 收尾（verification-before-completion）

- [ ] **5.1** `pnpm --filter @forge/daemon --filter @forge/desktop run build`
- [ ] **5.2** 按 `docs/superpowers/specs/2026-06-03-desktop-ab-design.md` 验收清单逐项勾选
- [ ] **5.3** 更新 `docs/构建打包运行手册.md` 桌面一节（安全模型、daemon 自动重启说明）

---

## 预估工作量

| Phase | 约时 |
|-------|------|
| 1 | 2–3h |
| 2 | 3–4h |
| 3 | 2–3h |
| 4 | 3–4h |
| 5 | 1h |

**合计:** 约 1–2 个工作日。

---

## Commit 建议（按 phase 拆分）

1. `fix(desktop): daemon ping poll and unified RPC retry`
2. `feat(daemon): list_mcp RPC for desktop`
3. `fix(desktop): remove hardcoded project paths`
4. `security(desktop): enable contextIsolation and preload-only bridge`
5. `feat(desktop): patch apply UI, directory picker, skills search`
