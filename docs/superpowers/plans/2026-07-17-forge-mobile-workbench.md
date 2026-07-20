# Forge Mobile Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Forge Mobile MVP: a multi-host mobile workbench with full session execution, workspace browsing, Git context controls, read-only file/Diff views, pairing, settings, and reconnect-safe cross-device history.

**Architecture:** Keep the daemon session store as the source of truth and the Relay as an E2EE transport. Add six narrowly scoped mobile RPCs behind the existing device project grants, expose them through a typed mobile data layer, then replace the monolithic mobile session screen with a small state shell and focused screens. Live events are merged into the current turn for latency, while persisted `session.messages` is reloaded after completion and reconnect for correctness.

**Tech Stack:** TypeScript, Zod, Node.js daemon/workspace utilities, React Native + Expo, Vitest, Expo SecureStore.

## Global Constraints

- Support multiple paired computers and automatically enter the last-used computer.
- Use four primary tabs: 工作台, 工作空间, 会话, 设置.
- Keep file browsing, file preview, and Diff strictly read-only.
- Display user turns, Agent status/thinking, tools, command output, file changes, Diff, final answers, and permission requests.
- The composer context bar must support workspace, Git branch, runtime/Agent, mode, and model; lock all five while a run is active.
- Reject branch switching while a run is active; surface dirty-worktree confirmation and never switch silently.
- Every path operation must enforce device `allowedProjects`, real-path validation, and symlink escape prevention.
- Relay payloads remain E2EE; diagnostics must not retain prompts, responses, credentials, or file contents.
- Do not add file editing, upload/download, Git commit/merge/rebase/push, automations, talents, skills, or plugin management.
- Preserve the visual tokens in the approved spec: background `#080B10`, card `#10151E`, border `#202936`, text `#F8FAFC`, muted `#788397`, brand `#8B5CF6`, success `#22C55E`, pending `#F59E0B`, error `#EF4444`.

---

## File Structure

- `packages/protocol/src/index.ts`: daemon method names only.
- `packages/mobile-protocol/src/index.ts`: mobile RPC method allowlist only.
- `apps/daemon/src/services/mobile-workspace-service.ts`: Git, file, and Diff operations guarded by `WorkspaceGuard`.
- `apps/daemon/src/services/mobile-workspace-service.test.ts`: path, size, dirty-tree, and Git behavior.
- `apps/daemon/src/main.ts`: route the six daemon methods to the service.
- `packages/channel-mobile/src/mobile-rpc-router.ts`: validate mobile inputs, enforce device project grants, and sanitize outputs.
- `packages/channel-mobile/src/mobile-rpc-router.test.ts`: authorization and routing regression coverage.
- `apps/mobile/src/data/forge-mobile-api.ts`: typed RPC facade and runtime/session/workspace loaders.
- `apps/mobile/src/data/forge-mobile-api.test.ts`: unsafe payload and result-shape tests.
- `apps/mobile/src/state/mobile-workbench-state.ts`: pure reducer for host, tab, navigation, run, unread, and reconnect state.
- `apps/mobile/src/state/mobile-workbench-state.test.ts`: reducer and live/persisted merge tests.
- `apps/mobile/src/ui/theme.ts`: approved colors, spacing, radii, and text styles.
- `apps/mobile/src/ui/components.tsx`: shared cards, chips, status bars, empty/error states, and bottom tabs.
- `apps/mobile/src/screens/WorkbenchScreen.tsx`: running tasks, recent sessions, favorite workspaces, and quick actions.
- `apps/mobile/src/screens/WorkspacesScreen.tsx`: searchable project list and create flow.
- `apps/mobile/src/screens/WorkspaceDetailScreen.tsx`: overview/files/sessions tabs.
- `apps/mobile/src/screens/FilePreviewScreen.tsx`: read-only text/metadata preview.
- `apps/mobile/src/screens/DiffScreen.tsx`: read-only unified Diff.
- `apps/mobile/src/screens/SessionsScreen.tsx`: cross-workspace search and status filters.
- `apps/mobile/src/screens/ConversationScreen.tsx`: persisted timeline, live execution, permissions, and context-aware composer.
- `apps/mobile/src/screens/SettingsScreen.tsx`: host management, security copy, appearance, notifications, and diagnostics entry.
- `apps/mobile/src/screens/PairingScreen.tsx`: QR/manual pairing and empty state.
- `apps/mobile/src/screens/SessionScreen.tsx`: remove after functionality is migrated to the focused screens.
- `apps/mobile/App.tsx`: connection lifecycle and top-level screen composition only.
- `apps/mobile/src/screens/mobile-workbench.test.ts`: source-level UI contract tests for critical controls and copy.
- `docs/mobile-access.md`: update supported mobile RPCs, limits, and security behavior.

---

### Task 1: Secure Git, file, and Diff daemon operations

**Files:**
- Modify: `packages/protocol/src/index.ts:1289-1366`
- Create: `apps/daemon/src/services/mobile-workspace-service.ts`
- Create: `apps/daemon/src/services/mobile-workspace-service.test.ts`
- Modify: `apps/daemon/src/main.ts:250-300`

**Interfaces:**
- Produces:
  - `handleMobileGitBranches(params: { cwd: string }): Promise<GitBranchInfo & { dirty: boolean }>`
  - `handleMobileGitSwitch(params: { cwd: string; branch: string; confirmDirty?: boolean; running?: boolean }): Promise<{ ok: boolean; current?: string; message?: string }>`
  - `handleMobileFilesList(params: { cwd: string; path?: string }): Promise<{ entries: MobileFileEntry[] }>`
  - `handleMobileFileRead(params: { cwd: string; path: string }): Promise<MobileFilePreview>`
  - `handleMobileDiffList(params: { cwd: string }): Promise<{ files: MobileDiffSummary[] }>`
  - `handleMobileDiffGet(params: { cwd: string; path: string }): Promise<{ path: string; unifiedDiff: string; truncated: boolean }>`

- [ ] **Step 1: Write failing service tests**

```ts
it("rejects a symlink that escapes the workspace", async () => {
  await expect(handleMobileFileRead({ cwd, path: "escape/secret.txt" }))
    .rejects.toThrow(/escapes workspace|not allowed/i);
});

it("requires confirmation before switching a dirty worktree", async () => {
  await writeFile(join(cwd, "dirty.txt"), "dirty");
  expect(await handleMobileGitSwitch({ cwd, branch: "other" })).toEqual({
    ok: false,
    message: "WORKTREE_DIRTY",
  });
});

it("returns bounded read-only file and diff payloads", async () => {
  const preview = await handleMobileFileRead({ cwd, path: "src/a.ts" });
  expect(preview).toMatchObject({ path: "src/a.ts", kind: "text", truncated: false });
  expect(preview.content.length).toBeLessThanOrEqual(200_000);
  const diff = await handleMobileDiffGet({ cwd, path: "src/a.ts" });
  expect(diff.path).toBe("src/a.ts");
  expect(diff.unifiedDiff).toContain("diff --git");
});
```

- [ ] **Step 2: Run tests and verify the module is missing**

Run: `pnpm vitest run apps/daemon/src/services/mobile-workspace-service.test.ts`

Expected: FAIL because `mobile-workspace-service.ts` cannot be resolved.

- [ ] **Step 3: Add daemon method names**

Add to `DAEMON_METHODS`:

```ts
MOBILE_GIT_BRANCHES: "mobile.git.branches",
MOBILE_GIT_SWITCH: "mobile.git.switch",
MOBILE_WORKSPACE_FILES_LIST: "mobile.workspace.files.list",
MOBILE_WORKSPACE_FILE_READ: "mobile.workspace.file.read",
MOBILE_WORKSPACE_DIFF_LIST: "mobile.workspace.diff.list",
MOBILE_WORKSPACE_DIFF_GET: "mobile.workspace.diff.get",
```

- [ ] **Step 4: Implement the guarded service**

Use `WorkspaceGuard`, `gitBranchInfo`, `gitSwitchBranch`, `gitStatusLine`, and `isGitRepository` from `@forge/workspace`. Resolve every requested path through `guard.resolveSafe(path, "read")` before `stat`, `readdir`, or `readFile`. Enforce these exact limits:

```ts
export const MOBILE_FILE_MAX_BYTES = 200_000;
export const MOBILE_DIFF_MAX_BYTES = 500_000;
export const MOBILE_DIRECTORY_MAX_ENTRIES = 500;

export type MobileFileEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "binary";
  size: number;
};

export type MobileFilePreview =
  | { path: string; kind: "text"; language: string; content: string; size: number; truncated: boolean }
  | { path: string; kind: "binary"; mime: string; size: number; truncated: false };
```

Treat NUL bytes in the first 8 KiB as binary. Permit UTF-8 code, Markdown, TXT, JSON, YAML, and repository dotfiles except `.git`; return metadata for other/binary files. Build Diff output with `git diff --no-color --no-ext-diff HEAD -- <path>` using `spawn` argument arrays, never shell strings. Derive summaries from `git diff --numstat HEAD`.

- [ ] **Step 5: Route methods in daemon main**

Import the six handlers and dispatch each matching `DAEMON_METHODS` entry. Pass only parsed params; the service performs real-path checks.

- [ ] **Step 6: Run service and daemon tests**

Run: `pnpm vitest run apps/daemon/src/services/mobile-workspace-service.test.ts apps/daemon/src/main.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/index.ts apps/daemon/src/main.ts apps/daemon/src/services/mobile-workspace-service.ts apps/daemon/src/services/mobile-workspace-service.test.ts
git commit -m "feat: expose guarded mobile workspace operations"
```

---

### Task 2: Authorize and expose the new mobile RPCs

**Files:**
- Modify: `packages/mobile-protocol/src/index.ts:112-125`
- Modify: `packages/channel-mobile/src/mobile-rpc-router.ts:12-270`
- Modify: `packages/channel-mobile/src/mobile-rpc-router.test.ts`

**Interfaces:**
- Consumes: the six daemon methods from Task 1.
- Produces mobile methods:
  - `git.branches`
  - `git.switch`
  - `workspace.files.list`
  - `workspace.file.read`
  - `workspace.diff.list`
  - `workspace.diff.get`

- [ ] **Step 1: Add failing router authorization tests**

```ts
it.each([
  ["git.branches", { cwd: denied }],
  ["git.switch", { cwd: denied, branch: "main", confirmDirty: true }],
  ["workspace.files.list", { cwd: denied, path: "." }],
  ["workspace.file.read", { cwd: denied, path: "README.md" }],
  ["workspace.diff.list", { cwd: denied }],
  ["workspace.diff.get", { cwd: denied, path: "README.md" }],
])("rejects %s outside device grants", async (method, params) => {
  const response = await router.handle(deviceId, request(method, params), emit);
  expect(response).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(daemon.request).not.toHaveBeenCalled();
});
```

Also test that `git.switch` forwards `confirmDirty`, path strings are bounded, file content is truncated by the daemon contract, and unknown output fields are removed.

- [ ] **Step 2: Run the focused router tests**

Run: `pnpm vitest run packages/channel-mobile/src/mobile-rpc-router.test.ts`

Expected: FAIL because the method schema rejects the six method names.

- [ ] **Step 3: Extend the mobile protocol method enum**

```ts
"git.branches",
"git.switch",
"workspace.files.list",
"workspace.file.read",
"workspace.diff.list",
"workspace.diff.get",
```

- [ ] **Step 4: Add strict Zod request schemas and router cases**

Use:

```ts
const cwdParams = z.object({ cwd: z.string().min(1).max(4096) }).strict();
const workspacePathParams = cwdParams.extend({
  path: z.string().min(1).max(4096),
}).strict();
const filesListParams = cwdParams.extend({
  path: z.string().min(1).max(4096).default("."),
}).strict();
const gitSwitchParams = cwdParams.extend({
  branch: z.string().trim().min(1).max(255),
  confirmDirty: z.boolean().default(false),
}).strict();
```

For every case, call `this.assertProjectAccess(device.allowedProjects, params.cwd)` before invoking the daemon. Forward the canonical cwd. Sanitize object/array fields to the Task 1 public types and cap arrays at 500 entries.

- [ ] **Step 5: Run protocol and router tests**

Run: `pnpm vitest run packages/mobile-protocol packages/channel-mobile/src/mobile-rpc-router.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/mobile-protocol/src/index.ts packages/channel-mobile/src/mobile-rpc-router.ts packages/channel-mobile/src/mobile-rpc-router.test.ts
git commit -m "feat: add authorized mobile workspace RPCs"
```

---

### Task 3: Build the typed mobile API and reconnect-safe state

**Files:**
- Create: `apps/mobile/src/data/forge-mobile-api.ts`
- Create: `apps/mobile/src/data/forge-mobile-api.test.ts`
- Create: `apps/mobile/src/state/mobile-workbench-state.ts`
- Create: `apps/mobile/src/state/mobile-workbench-state.test.ts`
- Modify: `apps/mobile/src/screens/session-sanitize.ts`
- Modify: `apps/mobile/src/screens/run-event-sanitize.ts`

**Interfaces:**
- Produces `ForgeMobileApi(client: MobileRelayClient)` with `status`, `runtimes`, `projects`, `createProject`, `sessions`, `messages`, `branches`, `switchBranch`, `files`, `file`, `diffs`, `diff`, `startRun`, `cancelRun`, `pendingPermissions`, and `respondPermission`.
- Produces `mobileWorkbenchReducer(state, action)` and `initialMobileWorkbenchState`.

- [ ] **Step 1: Write failing API and reducer tests**

```ts
it("drops malformed workspace and runtime payloads", async () => {
  client.call.mockResolvedValue({ entries: [{ path: 3 }, { name: "src", path: "src", kind: "directory", size: 0 }] });
  expect(await api.files("/repo", ".")).toEqual([
    { name: "src", path: "src", kind: "directory", size: 0 },
  ]);
});

it("deduplicates replayed events by subscription and sequence", () => {
  const once = mobileWorkbenchReducer(initialMobileWorkbenchState, {
    type: "run.event", subscriptionId: "sub-12345678", seq: 4, event: { kind: "text", delta: "A" },
  });
  const twice = mobileWorkbenchReducer(once, {
    type: "run.event", subscriptionId: "sub-12345678", seq: 4, event: { kind: "text", delta: "A" },
  });
  expect(twice.liveText).toBe("A");
});

it("replaces live turn data with persisted history after completion", () => {
  const next = mobileWorkbenchReducer(runningState, {
    type: "session.persisted", sessionId: "session-12345678", messages,
  });
  expect(next.runningSessionId).toBeNull();
  expect(next.liveText).toBe("");
  expect(next.messagesBySession["session-12345678"]).toEqual(messages);
});
```

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run apps/mobile/src/data/forge-mobile-api.test.ts apps/mobile/src/state/mobile-workbench-state.test.ts`

Expected: FAIL because the two modules do not exist.

- [ ] **Step 3: Implement strict public types and API methods**

Define:

```ts
export type RunContext = {
  cwd: string;
  branch: string | null;
  provider: string;
  model: string;
  permissionMode: string;
  sandboxMode: string;
  effort?: string;
};

export type WorkspaceFile = {
  name: string;
  path: string;
  kind: "file" | "directory" | "binary";
  size: number;
};
```

Each method calls exactly one RPC and parses unknown data through pure sanitizer functions. `startRun` passes the existing runtime object shape and returns the Relay client's `{ subscriptionId, result }`.

- [ ] **Step 4: Expand run event parsing**

Map persisted/live tool result, command output, file change, and Diff events into:

```ts
type RunUiEvent =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; callId: string; name: string; status: "running" | "done"; output?: string }
  | { kind: "file_change"; path: string; status: "added" | "modified" | "deleted"; additions?: number; deletions?: number }
  | { kind: "permission"; requestId: string; sessionId?: string; summary: string; options: PermissionOption[] }
  | { kind: "text"; delta: string }
  | { kind: "status"; label: string }
  | { kind: "session"; sessionId: string }
  | { kind: "done"; sessionId: string; finalText?: string }
  | { kind: "error"; message: string };
```

Cap command/tool output at 50,000 characters per event and preserve no raw unknown fields.

- [ ] **Step 5: Implement reducer invariants**

Store `lastSeqBySubscription`, `messagesBySession`, `runningSessionId`, `liveEvents`, `liveText`, `pendingPermission`, `selectedHostId`, `lastHostId`, `activeTab`, `workspaceId`, and unread session IDs. Ignore duplicate/out-of-order events; on reconnect, set `needsHistoryRefresh` and reload active/running sessions.

- [ ] **Step 6: Run all mobile pure-logic tests**

Run: `pnpm vitest run apps/mobile/src`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/data apps/mobile/src/state apps/mobile/src/screens/session-sanitize.ts apps/mobile/src/screens/run-event-sanitize.ts
git commit -m "feat: add typed mobile workbench data state"
```

---

### Task 4: Create the mobile shell, design system, pairing, and settings

**Files:**
- Create: `apps/mobile/src/ui/theme.ts`
- Create: `apps/mobile/src/ui/components.tsx`
- Create: `apps/mobile/src/screens/PairingScreen.tsx`
- Create: `apps/mobile/src/screens/SettingsScreen.tsx`
- Modify: `apps/mobile/App.tsx`
- Create: `apps/mobile/src/screens/mobile-workbench.test.ts`

**Interfaces:**
- Consumes: Task 3 API/state.
- Produces `MobileShell`, `BottomTabs`, `HostPicker`, `ConnectionBanner`, `PairingScreen`, and `SettingsScreen`.

- [ ] **Step 1: Write failing UI contract tests**

Read the screen sources and assert that all four tab labels, both pairing actions, E2EE copy, host removal, diagnostics entry, and minimum touch style `minHeight: 44` are present.

```ts
expect(shellSource).toContain('"工作台"');
expect(shellSource).toContain('"工作空间"');
expect(shellSource).toContain('"会话"');
expect(shellSource).toContain('"设置"');
expect(pairingSource).toContain("扫描配对码");
expect(pairingSource).toContain("粘贴配对链接");
expect(themeSource).toContain('background: "#080B10"');
```

- [ ] **Step 2: Run UI contract tests**

Run: `pnpm vitest run apps/mobile/src/screens/mobile-workbench.test.ts`

Expected: FAIL because the new screens and theme do not exist.

- [ ] **Step 3: Implement theme and shared primitives**

Export exact approved colors plus spacing `{ xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }` and radii `{ sm: 10, md: 12, lg: 16, sheet: 22 }`. Shared pressables must use `minHeight: 44`.

- [ ] **Step 4: Extract pairing and settings from App**

Move camera/manual code UI into `PairingScreen`; move host list, remove host, security explanation, appearance/notification rows, and diagnostics link into `SettingsScreen`. Keep secret handling, client ownership, reconnect timers, and AppState handling in `App.tsx`.

- [ ] **Step 5: Implement last-host auto-entry**

Persist only `lastHostId` in non-secret storage. On launch, reconcile SecureStore-backed hosts first, connect all valid hosts, and select the remembered authenticated host; otherwise select the first authenticated host. Never copy device/resume tokens into reducer state or AsyncStorage.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run apps/mobile/src && pnpm --filter @forge/mobile typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/ui apps/mobile/src/screens/PairingScreen.tsx apps/mobile/src/screens/SettingsScreen.tsx apps/mobile/src/screens/mobile-workbench.test.ts
git commit -m "feat: add mobile shell pairing and settings"
```

---

### Task 5: Implement workbench, workspaces, file preview, and Diff

**Files:**
- Create: `apps/mobile/src/screens/WorkbenchScreen.tsx`
- Create: `apps/mobile/src/screens/WorkspacesScreen.tsx`
- Create: `apps/mobile/src/screens/WorkspaceDetailScreen.tsx`
- Create: `apps/mobile/src/screens/FilePreviewScreen.tsx`
- Create: `apps/mobile/src/screens/DiffScreen.tsx`
- Modify: `apps/mobile/App.tsx`
- Modify: `apps/mobile/src/screens/mobile-workbench.test.ts`

**Interfaces:**
- Consumes: `ForgeMobileApi` workspace/Git/file/Diff methods.
- Produces navigation targets `{ kind: "workspace"; cwd }`, `{ kind: "file"; cwd; path }`, and `{ kind: "diff"; cwd; path }`.

- [ ] **Step 1: Add failing source contracts**

Assert the workbench has running task, quick action, recent session, and favorite workspace sections; workspace detail has 概览/文件/会话; file and Diff screens show `只读`; no screen contains save/edit/upload/download actions.

- [ ] **Step 2: Run the focused UI tests**

Run: `pnpm vitest run apps/mobile/src/screens/mobile-workbench.test.ts`

Expected: FAIL for missing screen sections.

- [ ] **Step 3: Implement workbench and workspace list**

Load projects, recent sessions, and active run from Task 3 state. Implement search, pull-to-refresh, project creation, host/E2EE header, empty running-task guidance, and two-tap navigation to recent sessions/workspaces.

- [ ] **Step 4: Implement workspace detail**

Add local tabs `overview | files | sessions`. Display branch and read-only badges in Files. Load one directory at a time with `workspace.files.list`; do not recursively fetch the tree.

- [ ] **Step 5: Implement file and Diff screens**

Render text using a monospace font and Markdown as plain structured text in MVP; show binary metadata only. Render unified Diff lines with add/delete/context colors, path copy, and “在会话中提及” callback. Truncated payloads must show an explicit limit banner.

- [ ] **Step 6: Run mobile tests and typecheck**

Run: `pnpm vitest run apps/mobile/src && pnpm --filter @forge/mobile typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/screens/WorkbenchScreen.tsx apps/mobile/src/screens/WorkspacesScreen.tsx apps/mobile/src/screens/WorkspaceDetailScreen.tsx apps/mobile/src/screens/FilePreviewScreen.tsx apps/mobile/src/screens/DiffScreen.tsx apps/mobile/src/screens/mobile-workbench.test.ts
git commit -m "feat: add mobile workspace and file views"
```

---

### Task 6: Implement full sessions, execution context, permissions, and synchronization

**Files:**
- Create: `apps/mobile/src/screens/SessionsScreen.tsx`
- Create: `apps/mobile/src/screens/ConversationScreen.tsx`
- Modify: `apps/mobile/App.tsx`
- Modify: `apps/mobile/src/screens/mobile-workbench.test.ts`
- Delete: `apps/mobile/src/screens/SessionScreen.tsx`
- Modify: `apps/mobile/src/screens/SessionScreen.test.ts`

**Interfaces:**
- Consumes: Task 3 API/reducer, `RunContext`, branch/runtime lists, and workspace navigation.
- Produces complete run flow and persisted/live reconciliation.

- [ ] **Step 1: Add failing session UI contracts**

Assert search, workspace filter, 全部/运行中/未读/已完成 filters, five context controls, stop action, sticky permission card, tool/output/Diff timeline cards, and post-run history reload.

```ts
for (const label of ["工作空间", "Git 分支", "Agent", "模式", "模型"]) {
  expect(conversationSource).toContain(label);
}
expect(conversationSource).toContain("permission.pending");
expect(conversationSource).toContain("session.messages");
expect(conversationSource).toContain("run.cancel");
```

- [ ] **Step 2: Run session tests**

Run: `pnpm vitest run apps/mobile/src/screens/SessionScreen.test.ts apps/mobile/src/screens/mobile-workbench.test.ts`

Expected: FAIL because the focused session screens are not implemented.

- [ ] **Step 3: Implement session list**

Load cross-workspace sessions from each granted project, dedupe by ID, sort descending by `updatedAt`, and support search plus the four local status filters. Clear unread when a session opens.

- [ ] **Step 4: Implement persisted and live timeline**

Group persisted messages and live events by turn. Current live status/tool output is expanded; completed tool output is collapsed by default. A file-change card opens `DiffScreen`. Always reload `session.messages` after `run.result` settles and when an authenticated reconnect marks `needsHistoryRefresh`.

- [ ] **Step 5: Implement context controls and run lifecycle**

Load runtime/model options and Git branches before sending. Pass:

```ts
{
  cwd: context.cwd,
  message,
  sessionId,
  runtime: {
    provider: context.provider,
    model: context.model,
    permissionMode: context.permissionMode,
    sandboxMode: context.sandboxMode,
    effort: context.effort,
  },
}
```

Lock all controls while running. Disable branch switch while running. On `WORKTREE_DIRTY`, show confirmation and retry with `confirmDirty: true`; on success append a local system event and refresh branch state.

- [ ] **Step 6: Implement sticky permissions and recovery**

Display the newest permission above the composer, with 拒绝, 允许一次, and protocol-provided options. On reconnect call `permission.pending`, restore the matching card, resubscribe with `run.subscribe`, and fall back to persisted history when the run no longer exists.

- [ ] **Step 7: Remove the monolithic screen and update its tests**

Move sanitizer tests to the new pure modules, delete imports/usages of `SessionScreen`, and preserve regression checks for create project, start/cancel run, and permission response.

- [ ] **Step 8: Run all mobile tests and typecheck**

Run: `pnpm vitest run apps/mobile packages/mobile-protocol packages/channel-mobile && pnpm --filter @forge/mobile typecheck`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/App.tsx apps/mobile/src/screens apps/mobile/src/state apps/mobile/src/data
git commit -m "feat: add complete mobile session workbench"
```

---

### Task 7: Cross-device regression, documentation, and final verification

**Files:**
- Modify: `apps/desktop/src/renderer/cross-device-session-sync.test.js`
- Modify: `packages/channel-mobile/src/mobile-rpc-router.test.ts`
- Modify: `apps/mobile/src/state/mobile-workbench-state.test.ts`
- Modify: `docs/mobile-access.md`

**Interfaces:**
- Consumes all previous tasks.
- Produces the release gate for the MVP.

- [ ] **Step 1: Add end-to-end contract regressions**

Cover:

```ts
it("mobile completion reloads the same persisted final answer shown by desktop", async () => {
  // Start through mobile router, persist daemon events, then fetch session.messages.
  expect(mobileMessages).toEqual(desktopPersistedMessages);
});

it("reconnect replay does not duplicate text or tool events", () => {
  const replayed = reduceFrames([...liveFrames, ...liveFrames]);
  expect(replayed.liveEvents).toHaveLength(liveFrames.length);
});

it("host-scoped state never leaks projects or sessions after host switch", () => {
  const next = mobileWorkbenchReducer(hostAState, { type: "host.selected", hostId: "host-b" });
  expect(next.projects).toEqual([]);
  expect(next.sessions).toEqual([]);
});
```

- [ ] **Step 2: Run the regressions and verify failures before final fixes**

Run: `pnpm vitest run apps/desktop/src/renderer/cross-device-session-sync.test.js packages/channel-mobile/src/mobile-rpc-router.test.ts apps/mobile/src/state/mobile-workbench-state.test.ts`

Expected: New assertions fail until integration gaps are corrected.

- [ ] **Step 3: Correct only the observed integration gaps**

Keep daemon persistence authoritative, clear host-scoped caches on host switch, and dedupe live frames by `(subscriptionId, seq)`. Do not introduce a second session store.

- [ ] **Step 4: Update mobile access documentation**

Document the six RPCs, 200 KiB file limit, 500 KiB Diff limit, 500-entry directory limit, dirty-tree confirmation, read-only guarantee, E2EE boundary, reconnect/history behavior, and unsupported features from the spec.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
pnpm vitest run apps/mobile packages/mobile-protocol packages/channel-mobile apps/daemon/src/services/mobile-workspace-service.test.ts apps/desktop/src/renderer/cross-device-session-sync.test.js
pnpm --filter @forge/mobile typecheck
pnpm --filter @forge/daemon typecheck
pnpm --filter @forge/channel-mobile typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Perform manual acceptance on iOS or Android Expo client**

Verify: pair two computers; auto-enter the last host; create/open a workspace; browse a text and binary file; view Diff; create and continue a session; switch branch with clean and dirty worktrees; change runtime/model/mode; observe tools/output/Diff; approve and reject permissions; stop a run; background/foreground during a run; confirm desktop/mobile history equality; switch hosts and confirm data isolation.

- [ ] **Step 7: Commit**

```bash
git add docs/mobile-access.md apps/desktop/src/renderer/cross-device-session-sync.test.js packages/channel-mobile/src/mobile-rpc-router.test.ts apps/mobile/src/state/mobile-workbench-state.test.ts
git commit -m "test: verify mobile workbench synchronization"
```
