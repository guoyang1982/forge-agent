# Forge 桌面端 A+B — Review 说明

## 推荐 Review 方式（你要的交互）

1. 在 Cursor 聊天侧打开 Canvas：**「Forge 桌面端 A+B — Code Review」**（文件：`canvases/desktop-ab-review.canvas.tsx`）。
2. **左侧**点选修改的文件名。
3. **右侧**审查面板：
   - **仅改动**：红/绿高亮改动行（`DiffView`）
   - **完整文件**：小文件显示全文；大文件提示在工作区打开路径并对照改动区
4. 需要对照真实源码时：在资源管理器中打开下表路径（或 Cmd+P 输入路径）。

---

## 一、工作陈述（总结）

| 阶段 | 内容 |
|------|------|
| 起点 | Skills 页 `Unknown method: list_skills`（旧 daemon） |
| A 稳定 | 统一 daemon RPC + 自动重启重试；PING 轮询；`contextIsolation`；去硬编码路径 |
| B 功能 | `list_mcp`；补丁应用；目录选择；Skills 搜索；MCP 不再渲染进程读盘 |
| 修复 1 | 按钮无响应：恢复 `getBridge()`，`bootstrap` 先绑事件 |
| 修复 2 | preload 红条：`preload.cjs`（CommonJS），修复 `ERR_REQUIRE_ESM` |

---

## 二、修改文件列表（点击路径 → 编辑器打开完整文件）

工作区根目录：`/path/to/forge-agent`

| 文件 | 改动摘要 |
|------|----------|
| [apps/desktop/src/main.ts](../../../apps/desktop/src/main.ts) | IPC、daemon 重试、preload.cjs、安全选项 |
| [apps/desktop/src/preload.ts](../../../apps/desktop/src/preload.ts) | forgeDesktop API |
| [apps/desktop/src/renderer/app.js](../../../apps/desktop/src/renderer/app.js) | UI / bootstrap / MCP / 补丁 |
| [apps/desktop/src/renderer/index.html](../../../apps/desktop/src/renderer/index.html) | 错误条、搜索、选目录 |
| [apps/desktop/src/renderer/styles.css](../../../apps/desktop/src/renderer/styles.css) | 新样式 |
| [apps/desktop/package.json](../../../apps/desktop/package.json) | preload.cjs 构建 |
| [apps/desktop/tsconfig.json](../../../apps/desktop/tsconfig.json) | 排除 preload |
| [apps/desktop/tsconfig.preload.json](../../../apps/desktop/tsconfig.preload.json) | **新建** CJS preload |
| [packages/protocol/src/index.ts](../../../packages/protocol/src/index.ts) | ListMcp + LIST_MCP |
| [apps/daemon/src/services/app-service.ts](../../../apps/daemon/src/services/app-service.ts) | handleListMcp |
| [apps/daemon/src/main.ts](../../../apps/daemon/src/main.ts) | 注册 RPC |
| [docs/构建打包运行手册.md](../../../docs/构建打包运行手册.md) | 桌面端章节 |

设计/计划文档：`docs/superpowers/specs/`、`docs/superpowers/plans/`（无代码逻辑）。

---

## 三、标识改动的地方

- **交互式**：见 Canvas 右侧 `DiffView`（绿=新增，红=删除）。
- **静态**：各文件改动热点见 Canvas 内嵌 diff，或在本仓库提交后使用 **Source Control → Diff**。

构建后产物（勿手改）：`apps/desktop/dist/preload.cjs`、`apps/desktop/dist/main.js`。
