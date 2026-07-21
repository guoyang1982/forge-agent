import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url).pathname, "utf-8");
}

const shellSource = readSource("../ui/components.tsx");
const themeSource = readSource("../ui/theme.ts");
const pairingSource = readSource("./PairingScreen.tsx");
const settingsSource = readSource("./SettingsScreen.tsx");
const appSource = readSource("../../App.tsx");
const workbenchSource = readSource("./WorkbenchScreen.tsx");
const workspacesSource = readSource("./WorkspacesScreen.tsx");
const workspaceDetailSource = readSource("./WorkspaceDetailScreen.tsx");
const filePreviewSource = readSource("./FilePreviewScreen.tsx");
const diffSource = readSource("./DiffScreen.tsx");
const sessionsSource = readSource("./SessionsScreen.tsx");
const conversationSource = readSource("./ConversationScreen.tsx");

const workspaceUiSources = [
  workbenchSource,
  workspacesSource,
  workspaceDetailSource,
  filePreviewSource,
  diffSource,
];

describe("Sessions and conversation UI contract", () => {
  it("exposes session search and status filters", () => {
    expect(sessionsSource).toContain("搜索");
    expect(sessionsSource).toContain("全部");
    expect(sessionsSource).toContain("运行中");
    expect(sessionsSource).toContain("未读");
    expect(sessionsSource).toContain("已完成");
  });

  it("exposes the five composer context controls and run controls", () => {
    for (const label of ["工作空间", "Git 分支", "Agent", "模式", "模型"]) {
      expect(conversationSource).toContain(label);
    }
    expect(conversationSource).toContain("permission.pending");
    expect(conversationSource).toContain("需要你的确认");
    expect(conversationSource).toContain("permissionMode: mode.id");
    expect(conversationSource).toContain("session.messages");
    expect(conversationSource).toContain("run.cancel");
    expect(conversationSource).toContain("停止");
    expect(conversationSource).toContain("正在停止…");
    expect(conversationSource).toContain('Alert.alert("停止失败"');
    expect(conversationSource).toContain("会话尚未就绪，请稍后再停止");
    expect(conversationSource).toContain("思考过程");
    expect(conversationSource).toContain("执行过程");
    expect(conversationSource).toContain("查看全部");
    expect(conversationSource).toContain("已完成");
    expect(conversationSource).toContain("文件变更");
    expect(conversationSource).toContain("styles.fileCard");
    expect(conversationSource).toContain("completedPill");
    expect(conversationSource).toContain("statusPill");
    expect(conversationSource).toContain("变更文件");
    expect(conversationSource).toContain("关键改动");
    expect(conversationSource).toContain("验证结果");
    expect(conversationSource).toContain("展开执行过程");
    expect(conversationSource).toContain("MarkdownBody");
    expect(conversationSource).toContain("conversation-view");
    expect(conversationSource).toContain("ListFooterComponent");
    expect(conversationSource).toMatch(/ListFooterComponent=\{\s*\n\s*running \?/);
    expect(conversationSource).toContain("需要你的确认");
    expect(conversationSource).toContain("允许一次");
    expect(conversationSource).toContain("styles.dock");
    expect(conversationSource).toContain("agentTurn");
    expect(conversationSource).toContain("sessionHistory");
    expect(appSource).toContain("hideTabs=");
  });

  it("wires SessionsScreen and ConversationScreen from App", () => {
    expect(appSource).toContain("SessionsScreen");
    expect(appSource).toContain("ConversationScreen");
    expect(appSource).not.toContain("SessionScreen");
  });
});

describe("Workbench workspace file Diff UI contract", () => {
  it("exposes workbench sections for running tasks, quick actions, recent sessions, and workspaces", () => {
    expect(workbenchSource).toContain("当前任务");
    expect(workbenchSource).toContain("新建会话");
    expect(workbenchSource).toContain("新建工作空间");
    expect(workbenchSource).toContain("最近会话");
    expect(workbenchSource).toContain("常用工作空间");
    expect(workbenchSource).toContain("快速操作");
    expect(workbenchSource).toContain("已用时");
    expect(workbenchSource).toContain("预计剩余");
    expect(workbenchSource).toContain("规划中");
    expect(workbenchSource).toContain("查看全部 >");
    expect(workbenchSource).toContain("onViewAllSessions");
    expect(workbenchSource).toContain("onViewAllWorkspaces");
  });

  it("exposes workspace detail tabs and read-only file/Diff badges", () => {
    expect(workspaceDetailSource).toContain("概览");
    expect(workspaceDetailSource).toContain("文件");
    expect(workspaceDetailSource).toContain("会话");
    expect(workspaceDetailSource).toContain("活跃任务");
    expect(workspaceDetailSource).toContain("运行中");
    expect(workspaceDetailSource).toContain("启动于");
    expect(workspaceDetailSource).toContain("onCancelRun");
    expect(workspaceDetailSource).toContain("查看全部 >");
    expect(workspaceDetailSource).toContain('label="最近变更"');
    expect(workspaceDetailSource).toContain('label="最近会话"');
    expect(workspaceDetailSource).not.toContain("从会话页继续运行中的任务");
    expect(filePreviewSource).toContain("只读");
    expect(diffSource).toContain("只读");
    expect(diffSource).toContain("在会话中提及");
  });

  it("renders an expandable file tree with typed icons and syntax-highlighted preview", () => {
    expect(workspaceDetailSource).toContain("flattenFileTree");
    expect(workspaceDetailSource).toContain("FileTypeIcon");
    expect(workspaceDetailSource).toContain("toggleDirectory");
    expect(workspaceDetailSource).toContain("▸");
    expect(workspaceDetailSource).toContain("▾");
    expect(workspaceDetailSource).not.toContain("上级目录");
    expect(workspaceDetailSource).not.toContain("📁");
    expect(filePreviewSource).toContain("CodeHighlight");
    expect(filePreviewSource).toContain("MarkdownBody");
  });

  it("never offers save, edit, upload, or download actions in workspace screens", () => {
    for (const source of workspaceUiSources) {
      expect(source).not.toMatch(/保存|编辑|上传|下载|save|edit|upload|download/i);
    }
  });

  it("wires workbench and workspace screens from App instead of placeholders", () => {
    expect(appSource).toContain("WorkbenchScreen");
    expect(appSource).toContain("WorkspacesScreen");
    expect(appSource).toContain("WorkspaceDetailScreen");
    expect(appSource).toContain("FilePreviewScreen");
    expect(appSource).toContain("DiffScreen");
    expect(appSource).not.toContain("工作台建设中");
    expect(appSource).not.toContain("工作空间建设中");
  });
});

describe("Mobile shell design system contract", () => {
  it("exposes all four bottom tab labels", () => {
    expect(shellSource).toContain('"工作台"');
    expect(shellSource).toContain('"工作空间"');
    expect(shellSource).toContain('"会话"');
    expect(shellSource).toContain('"设置"');
  });

  it("renders equal-size geometric tab icons instead of uneven glyphs", () => {
    expect(shellSource).toContain("TAB_ICON_SIZE = 24");
    expect(shellSource).toContain("HomeTabIcon");
    expect(shellSource).toContain("FolderTabIcon");
    expect(shellSource).toContain("ChatTabIcon");
    expect(shellSource).toContain("GearTabIcon");
    expect(shellSource).toContain("tabIconSlot");
    expect(shellSource).not.toContain('glyph: "⌂"');
    expect(shellSource).not.toContain('glyph: "⚙"');
    expect(shellSource).toContain("colors.brandActive");
    expect(shellSource).toContain("colors.textMuted");
  });

  it("uses compact Forge host header and E2EE status copy", () => {
    expect(shellSource).toContain("Forge");
    expect(shellSource).toContain("端到端加密 (E2EE)");
  });

  it("renders the desktop hammer brand mark instead of a letter F glyph", () => {
    expect(shellSource).toContain("forge-icon.png");
    expect(shellSource).toContain("ForgeMark");
    expect(shellSource).not.toMatch(/<Text[^>]*>\s*F\s*<\/Text>/);
  });

  it("uses one primary brand mark size for page titles and host headers", () => {
    expect(shellSource).toContain("FORGE_MARK_MD = 32");
    expect(shellSource).toMatch(/<ForgeMark size="md" \/>[\s\S]*styles\.title/);
    expect(shellSource).toMatch(/<ForgeMark size="md" \/>[\s\S]*compactHostCopy/);
    expect(shellSource).not.toMatch(/<ForgeMark size=\{24\}/);
    expect(shellSource).not.toMatch(/<ForgeMark size=\{32\}/);
    expect(pairingSource).toContain('<ForgeMark size="md" />');
  });

  it("exposes both pairing actions", () => {
    expect(pairingSource).toContain("扫描配对码");
    expect(pairingSource).toContain("粘贴配对链接");
  });

  it("explains end-to-end encryption during pairing", () => {
    expect(pairingSource).toContain("E2EE");
  });

  it("uses the approved background color from the theme", () => {
    expect(themeSource).toContain('background: "#080B10"');
  });

  it("defines the approved spacing and radii scales", () => {
    expect(themeSource).toContain("xs: 4");
    expect(themeSource).toContain("sm: 8");
    expect(themeSource).toContain("md: 12");
    expect(themeSource).toContain("lg: 16");
    expect(themeSource).toContain("xl: 24");
    expect(themeSource).toContain("sm: 10");
    expect(themeSource).toContain("sheet: 22");
  });

  it("lets users remove a paired host from settings", () => {
    expect(settingsSource).toContain("移除");
  });

  it("exposes a diagnostics entry point from settings", () => {
    expect(settingsSource).toContain("诊断");
  });

  it("explains E2EE and SecureStore handling in settings", () => {
    expect(settingsSource).toContain("E2EE");
    expect(settingsSource).toContain("安全存储");
    expect(settingsSource).toContain("设备与设置");
    expect(settingsSource).toContain("配对新电脑");
  });

  it("enforces the minimum 44pt touch target across shared pressables", () => {
    expect(shellSource).toContain("minHeight: 44");
    expect(pairingSource).toContain("minHeight: 44");
    expect(settingsSource).toContain("minHeight: 44");
  });

  it("cancels launch auto-selection before explicit host lookup or connection", () => {
    const selectHost = appSource.match(
      /const selectHost = \(hostId: string\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const cancelAutoSelect = selectHost.indexOf("autoSelectDone.current = true");
    const hostLookup = selectHost.indexOf("hosts.find");
    const clientLookup = selectHost.indexOf("clients.current");
    const connect = selectHost.indexOf("connectHost");

    expect(cancelAutoSelect).toBeGreaterThanOrEqual(0);
    expect(cancelAutoSelect).toBeLessThan(hostLookup);
    expect(cancelAutoSelect).toBeLessThan(clientLookup);
    expect(cancelAutoSelect).toBeLessThan(connect);
  });

  it("uses one pairing-close helper that clears every transient pairing value", () => {
    const closePairing = appSource.match(
      /const closePairing = \(\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";

    expect(closePairing).toContain("pendingOffer.current = null");
    expect(closePairing).toContain("setPendingPairing(null)");
    expect(closePairing).toContain('setManualCode("")');
    expect(appSource).toContain("onClose={closePairing}");
  });

  it("forgets host state and its connection entry through the removal path", () => {
    const removeHost = appSource.match(
      /const removeHostAndForget = \(hostId: string\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";

    expect(removeHost).toContain("clearConnectionState(hostId)");
    expect(removeHost).toContain('dispatch({ type: "host.forgotten", hostId })');
    expect(appSource).toContain("void saveLastHostId(state.lastHostId)");
  });

  it("preserves explicit selection intent across an in-flight launch connection", () => {
    const selectHost = appSource.match(
      /const selectHost = \(hostId: string\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const connectHost = appSource.match(
      /const connectHost = async \([\s\S]*?\n  \) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    expect(selectHost.indexOf("pendingExplicitHostId.current = hostId"))
      .toBeLessThan(selectHost.indexOf("clients.current.has"));
    expect(selectHost.indexOf("pendingExplicitHostId.current = hostId"))
      .toBeLessThan(selectHost.indexOf("connectHost(host"));
    expect(selectHost).toContain('connections[hostId] === "authenticated"');
    expect(connectHost.indexOf("const explicitlyRequested = pendingExplicitHostId.current === host.hostId"))
      .toBeGreaterThan(connectHost.indexOf("MobileRelayClient.resume"));
    expect(connectHost.indexOf("const explicitlyRequested = pendingExplicitHostId.current === host.hostId"))
      .toBeLessThan(connectHost.indexOf("clients.current.set"));
    expect(connectHost).toContain("options.select !== false || explicitlyRequested");
  });

  it("tombstones removal before closing and rejects a late resumed client", () => {
    const removeHost = appSource.match(
      /const removeHostAndForget = \(hostId: string\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const connectionCallback = appSource.match(
      /const onConnectionState = \(hostId: string, generation: number\)[\s\S]*?=> \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const connectHost = appSource.match(
      /const connectHost = async \([\s\S]*?\n  \) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const postResumeGuard = connectHost.slice(
      connectHost.indexOf("const explicitlyRequested"),
      connectHost.indexOf("clients.current.set"),
    );

    expect(removeHost.indexOf("removedHostIds.current.add(hostId)"))
      .toBeLessThan(removeHost.indexOf("closeHost(hostId)"));
    expect(removeHost).toContain("pendingExplicitHostId.current = null");
    expect(connectionCallback.indexOf("removedHostIds.current.has(hostId)"))
      .toBeLessThan(connectionCallback.indexOf("setConnections"));
    expect(postResumeGuard).toContain("removedHostIds.current.has(host.hostId)");
    expect(connectHost).toContain("client.close()");
    expect(connectHost).toContain("clearConnectionState(host.hostId)");
    expect(appSource).toContain("removedHostIds.current.delete(offer.hostId)");
  });

  it("guards callbacks and resolved clients with per-host generations", () => {
    const connectionCallback = appSource.match(
      /const onConnectionState = \(hostId: string, generation: number\)[\s\S]*?=> \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const connectHost = appSource.match(
      /const connectHost = async \([\s\S]*?\n  \) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const postResumeGuard = connectHost.slice(
      connectHost.indexOf("const explicitlyRequested"),
      connectHost.indexOf("clients.current.set"),
    );
    const completePairing = appSource.match(
      /const completePairing = async \(\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const closeHost = appSource.match(
      /const closeHost = \(hostId: string\) => \{([\s\S]*?)\n  \};/,
    )?.[1] ?? "";
    const resolvedPairGuard = completePairing.slice(
      completePairing.indexOf("client = await MobileRelayClient.pair"),
      completePairing.indexOf("clients.current.set"),
    );

    expect(connectionCallback.indexOf("connectionGenerations.current.isCurrent(hostId, generation)"))
      .toBeLessThan(connectionCallback.indexOf("setConnections"));
    expect(closeHost.indexOf("connectionGenerations.current.invalidate(hostId)"))
      .toBeLessThan(closeHost.indexOf("clients.current.get(hostId)"));
    expect(connectHost.indexOf("connectionGenerations.current.begin(host.hostId)"))
      .toBeLessThan(connectHost.indexOf("MobileRelayClient.resume"));
    expect(postResumeGuard).toContain(
      "connectionGenerations.current.isCurrent(host.hostId, generation)",
    );
    expect(completePairing.indexOf("connectionGenerations.current.begin(offer.hostId)"))
      .toBeLessThan(completePairing.indexOf("removedHostIds.current.delete(offer.hostId)"));
    expect(resolvedPairGuard).toContain(
      "connectionGenerations.current.isCurrent(offer.hostId, generation)",
    );
    expect(appSource).toContain("connectionGenerations.current.dispose()");
  });
});
