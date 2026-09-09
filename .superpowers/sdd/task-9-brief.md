### Task 9: Preload 白名单 + 工作链 UI

**Files:**
- Modify: `apps/company-desktop/src/preload-api.ts` — `COMPANY_INVOKE_METHODS = new Set(Object.values(DAEMON_COMPANY_METHODS))`；依赖 `@forge/protocol`
- Modify: `apps/company-desktop/package.json` — 加 `@forge/protocol`
- Modify: `apps/company-desktop/src/security.test.ts` — invoke `company.create` 允许，`run` 仍拒绝
- Modify: `apps/company-desktop/src/renderer/index.html`、`app.js`、`styles.css`
- Modify: `apps/desktop/src/product-shell-isolation.test.ts` 仍必须 PASS

**UI 范围（四页 + 抽屉，不要 SDLC 侧栏）：**

1. 经营总览：公司名、进行中 WorkItem 条数、员工数、待审批数、流水线进度列表（每条显示当前门：缺 spec / 缺 plan / 执行中 / 待验收）
2. 组织与员工：部门树 + 雇佣表单（姓名、岗位、L2）
3. 工作中心：登记需求（原话）→ 编辑 spec/plan 草稿 → 接受 → 派活 → 展示追溯链；红灯时「暂停并派修复」
4. 审批中心：列表 + 通过/驳回（驳回理由文本）；自己的提交不可点通过（按钮 disabled + RPC 仍拒绝）
5. CEO 抽屉：只能 `workItems.create` 草稿，文案写明不能跳过规格/计划门

`openWorkbench` 在已有 run 时传 `forge://workbench/run/<id>`。

- [ ] **Step 1: Extend security test**

```ts
it("allows company.create via invoke", async () => {
  const ipc = fakeIpc();
  const api = createCompanyPreloadApi(ipc);
  await api.invoke("company.create", { name: "曜石" });
  expect(ipc.invoke).toHaveBeenCalledWith("company:invoke", "company.create", { name: "曜石" });
});
```

`fakeIpc` 的 `invoke` 改为 `vi.fn(async () => ({ ok: true }))`。

- [ ] **Step 2: Run** `pnpm --filter @forge/company-desktop test` Expected: FAIL（白名单仍空）

- [ ] **Step 3: Fill allowlist + renderer** 用 `data-nav` 切换四页；所有写操作走 `window.forgeCompany.invoke`。

- [ ] **Step 4: Run**

```
pnpm --filter @forge/company-desktop test
pnpm --filter @forge/desktop exec vitest run src/product-shell-isolation.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/company-desktop apps/desktop/src/product-shell-isolation.test.ts
git commit -m "feat(company): wire org and work-chain UI to allowlisted RPC"
```

---
