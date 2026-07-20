import {
  parseCreatedProject,
  parseProjects,
  type ProjectItem,
} from "../screens/project-sanitize";
import {
  parseMessages,
  parseSessionEvents,
  parseSessions,
  type MessageItem,
  type SessionItem,
} from "../screens/session-sanitize";
import type { RunUiEvent } from "../screens/run-event-sanitize";
import type { MobileRelayClient } from "../transport/mobile-relay-client";

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

export type Runtime = {
  provider: string;
  label?: string;
  available: boolean;
  status: string;
  modes: string[];
  models: string[];
};

export type Branches = {
  isRepo: boolean;
  current: string | null;
  detached: boolean;
  dirty: boolean;
  branches: string[];
};

export type WorkspaceContent =
  | { path: string; kind: "text"; language: string; content: string; size: number; truncated: boolean }
  | { path: string; kind: "binary"; mime: string; size: number; truncated: false };

export type DiffItem = { path: string; additions: number; deletions: number; binary: boolean };
export type DiffContent = { path: string; unifiedDiff: string; truncated: boolean };
export type PendingPermission = {
  requestId: string;
  sessionId: string;
  summary: string;
  options: Array<{ optionId: string; name: string; allow: boolean }>;
};

export function createForgeMobileApi(client: MobileRelayClient) {
  return {
    status: async () => parseStatus(await client.call("status.get", {})),
    runtimes: async (cwd?: string): Promise<Runtime[]> =>
      parseRuntimes(await client.call("runtime.list", cwd?.trim() ? { cwd: cwd.trim() } : {})),
    projects: async (): Promise<ProjectItem[]> => parseProjects(await client.call("project.list", {})),
    createProject: async (parentPath: string, name: string): Promise<ProjectItem | null> =>
      parseCreatedProject(await client.call("project.create", { parentPath, name })),
    sessions: async (cwd?: string, query?: string): Promise<SessionItem[]> =>
      parseSessions(await client.call(
        query?.trim() ? "session.search" : "session.list",
        query?.trim() ? { cwd, query: query.trim(), limit: 50 } : { ...(cwd ? { cwd } : {}), limit: 50 },
      )),
    messages: async (sessionId: string): Promise<MessageItem[]> => {
      const payload = await client.call("session.messages", { sessionId, limit: 200 });
      return parseMessages(payload);
    },
    sessionHistory: async (sessionId: string): Promise<{
      messages: MessageItem[];
      events: RunUiEvent[];
    }> => {
      const payload = await client.call("session.messages", { sessionId, limit: 200 });
      return {
        messages: parseMessages(payload),
        events: parseSessionEvents(payload),
      };
    },
    branches: async (cwd: string): Promise<Branches> =>
      parseBranches(await client.call("git.branches", { cwd })),
    switchBranch: async (cwd: string, branch: string, confirmDirty = false) =>
      parseSwitch(await client.call("git.switch", { cwd, branch, confirmDirty })),
    files: async (cwd: string, path: string): Promise<WorkspaceFile[]> =>
      parseFiles(await client.call("workspace.files.list", { cwd, path })),
    file: async (cwd: string, path: string): Promise<WorkspaceContent | null> =>
      parseFile(await client.call("workspace.file.read", { cwd, path })),
    diffs: async (cwd: string): Promise<DiffItem[]> =>
      parseDiffs(await client.call("workspace.diff.list", { cwd })),
    diff: async (cwd: string, path: string): Promise<DiffContent | null> =>
      parseDiff(await client.call("workspace.diff.get", { cwd, path })),
    startRun: (
      context: RunContext,
      params: { message: string; sessionId?: string | null },
      onEvent: Parameters<MobileRelayClient["startRun"]>[1],
    ) => {
      if (!context.provider.trim()) {
        throw new Error("请先选择 Agent");
      }
      return client.startRun(
        {
          cwd: context.cwd,
          message: params.message,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          runtime: {
            provider: context.provider,
            ...(context.model.trim() ? { model: context.model } : {}),
            ...(context.permissionMode.trim()
              ? { permissionMode: context.permissionMode }
              : {}),
            ...(context.sandboxMode.trim() ? { sandboxMode: context.sandboxMode } : {}),
            ...(context.effort !== undefined ? { effort: context.effort } : {}),
          },
        },
        onEvent,
      );
    },
    subscribeRun: (
      sessionId: string,
      onEvent: Parameters<MobileRelayClient["startRun"]>[1],
    ) => {
      const subscriptionId = `subscription_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      return {
        subscriptionId,
        result: client.call(
          "run.subscribe",
          { sessionId, subscriptionId },
          { subscriptionId, onEvent },
        ),
      };
    },
    unsubscribe: (subscriptionId: string) => client.unsubscribe(subscriptionId),
    cancelRun: async (sessionId: string) => client.call("run.cancel", { sessionId }),
    pendingPermissions: async (sessionId?: string): Promise<PendingPermission[]> =>
      parsePendingPermissions(await client.call("permission.pending", sessionId ? { sessionId } : {})),
    respondPermission: async (params: {
      requestId: string;
      sessionId: string;
      approved: boolean;
      optionId?: string;
    }) => client.call("permission.respond", params),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown, limit = 500): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseStatus(value: unknown): { version?: string; activeRun: boolean; runtime: string; sessions: number } {
  const item = record(value);
  return {
    ...(typeof item?.version === "string" ? { version: item.version.slice(0, 120) } : {}),
    activeRun: item?.activeRun === true,
    runtime: typeof item?.runtime === "string" ? item.runtime.slice(0, 120) : "",
    sessions: nonNegative(item?.sessions),
  };
}

function parseRuntimes(value: unknown): Runtime[] {
  const payload = record(value);
  const rows = Array.isArray(payload?.runtimes)
    ? payload.runtimes
    : Array.isArray(payload?.providers)
      ? payload.providers
      : [];
  return rows.flatMap((row) => {
    const runtime = record(row);
    if (!runtime) return [];
    const provider = typeof runtime.provider === "string"
      ? runtime.provider
      : typeof runtime.id === "string"
        ? runtime.id
        : "";
    if (!provider) return [];
    const status = typeof runtime.status === "string" ? runtime.status.slice(0, 120) : "";
    return [{
      provider: provider.slice(0, 120),
      ...(typeof runtime.label === "string" ? { label: runtime.label.slice(0, 120) } : {}),
      available: runtime.available === true || status === "ready",
      status,
      modes: summaryIds(runtime.modes, 50),
      models: summaryIds(runtime.models, 100),
    }];
  });
}

function summaryIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim().slice(0, 256)];
    const row = record(item);
    if (typeof row?.id === "string" && row.id.trim()) return [row.id.trim().slice(0, 256)];
    if (typeof row?.model === "string" && row.model.trim()) return [row.model.trim().slice(0, 256)];
    return [];
  }).slice(0, limit);
}

function parseBranches(value: unknown): Branches {
  const item = record(value);
  return {
    isRepo: item?.isRepo === true,
    current: typeof item?.current === "string" ? item.current.slice(0, 300) : null,
    detached: item?.detached === true,
    dirty: item?.dirty === true,
    branches: strings(item?.branches),
  };
}

function parseSwitch(value: unknown): { ok: boolean; current?: string; message?: string } {
  const item = record(value);
  return {
    ok: item?.ok === true,
    ...(typeof item?.current === "string" ? { current: item.current.slice(0, 300) } : {}),
    ...(typeof item?.message === "string" ? { message: item.message.slice(0, 500) } : {}),
  };
}

function parseFiles(value: unknown): WorkspaceFile[] {
  const rows = record(value)?.entries;
  return Array.isArray(rows) ? rows.flatMap((row) => {
    const item = record(row);
    return typeof item?.name === "string" &&
      typeof item.path === "string" &&
      (item.kind === "file" || item.kind === "directory" || item.kind === "binary")
      ? [{ name: item.name.slice(0, 255), path: item.path.slice(0, 4096), kind: item.kind, size: nonNegative(item.size) }]
      : [];
  }) : [];
}

function parseFile(value: unknown): WorkspaceContent | null {
  const item = record(value);
  if (typeof item?.path !== "string") return null;
  if (item.kind === "text" && typeof item.language === "string" && typeof item.content === "string") {
    return { path: item.path.slice(0, 4096), kind: "text", language: item.language.slice(0, 100), content: item.content.slice(0, 1_000_000), size: nonNegative(item.size), truncated: item.truncated === true };
  }
  return item.kind === "binary" && typeof item.mime === "string"
    ? { path: item.path.slice(0, 4096), kind: "binary", mime: item.mime.slice(0, 200), size: nonNegative(item.size), truncated: false }
    : null;
}

function parseDiffs(value: unknown): DiffItem[] {
  const rows = record(value)?.files;
  return Array.isArray(rows) ? rows.flatMap((row) => {
    const item = record(row);
    return typeof item?.path === "string"
      ? [{ path: item.path.slice(0, 4096), additions: nonNegative(item.additions), deletions: nonNegative(item.deletions), binary: item.binary === true }]
      : [];
  }) : [];
}

function parseDiff(value: unknown): DiffContent | null {
  const item = record(value);
  return typeof item?.path === "string" && typeof item.unifiedDiff === "string"
    ? { path: item.path.slice(0, 4096), unifiedDiff: item.unifiedDiff.slice(0, 1_000_000), truncated: item.truncated === true }
    : null;
}

function parsePendingPermissions(value: unknown): PendingPermission[] {
  const rows = record(value)?.requests;
  return Array.isArray(rows) ? rows.flatMap((row) => {
    const item = record(row);
    const event = item ? record(item.event) : null;
    return typeof item?.requestId === "string" && typeof item.sessionId === "string" &&
      typeof event?.summary === "string"
      ? [{
          requestId: item.requestId.slice(0, 300),
          sessionId: item.sessionId.slice(0, 300),
          summary: event.summary.slice(0, 300),
          options: Array.isArray(event.options) ? event.options.flatMap((option) => {
            const parsed = record(option);
            return typeof parsed?.optionId === "string" && typeof parsed.name === "string"
              ? [{ optionId: parsed.optionId.slice(0, 100), name: parsed.name.slice(0, 100), allow: /allow|approve|accept|允许/i.test(`${parsed.kind ?? ""} ${parsed.name}`) }]
              : [];
          }).slice(0, 8) : [],
        }]
      : [];
  }) : [];
}
