import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AdapterDaemonBridge } from "@forge/channel-core";
import { mobileRpcFrameV1Schema, type MobileRpcFrameV1 } from "@forge/mobile-protocol";
import { DAEMON_METHODS } from "@forge/protocol";
import { z } from "zod";
import type { MobileDeviceRegistry } from "./device-registry.js";

type RpcRequest = Extract<MobileRpcFrameV1, { type: "rpc.request" }>;
type RpcResponse = Extract<MobileRpcFrameV1, { type: "rpc.response" }>;
type RpcEvent = Extract<MobileRpcFrameV1, { type: "rpc.event" }>;
type EventSink = (frame: RpcEvent) => void;

const emptyParams = z.object({}).strict().default({});
const runtimeListParams = z
  .object({
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .default({});
const listParams = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .default({});
const searchParams = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(100).default(20),
    cwd: z.string().min(1).max(4096).optional(),
  })
  .strict();
const projectCreateParams = z
  .object({
    parentPath: z.string().min(1).max(4096),
    name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  })
  .strict();
const messagesParams = z
  .object({
    sessionId: z.string().min(8).max(128),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
const runtimeParams = z
  .object({
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(256).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
    sandboxMode: z.string().min(1).max(64).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .strict();
const runStartParams = z
  .object({
    cwd: z.string().min(1).max(4096),
    message: z.string().min(1).max(100_000),
    sessionId: z.string().min(8).max(128).nullable().optional(),
    subscriptionId: z.string().min(8).max(128),
    runtime: runtimeParams.optional(),
  })
  .strict();
const sessionSubscriptionParams = z
  .object({
    sessionId: z.string().min(8).max(128),
    subscriptionId: z.string().min(8).max(128),
  })
  .strict();
const cancelParams = z.object({ sessionId: z.string().min(8).max(128) }).strict();
const permissionParams = z
  .object({
    requestId: z.string().min(8).max(128),
    sessionId: z.string().min(8).max(128),
    approved: z.boolean(),
    optionId: z.string().min(1).max(128).optional(),
  })
  .strict();
const pendingPermissionParams = z
  .object({ sessionId: z.string().min(8).max(128).optional() })
  .strict()
  .default({});
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

interface ActiveRun {
  deviceId: string;
  subscribers: Map<string, EventSink>;
  nextSeq: number;
}

export interface MobileRpcRouterOptions {
  daemon: AdapterDaemonBridge;
  registry: MobileDeviceRegistry;
  allowedProjects: string[];
  maxConcurrentRunsPerDevice?: number;
  runPermission?: "allow" | "confirm" | "deny";
  approvePermission?: "allow" | "confirm" | "deny";
}

export class MobileRpcRouter {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingRunOwners = new Map<string, string>();
  private readonly permissionOwners = new Map<
    string,
    { deviceId: string; sessionId: string; event: unknown }
  >();
  private readonly allowedProjectRoots: string[];

  constructor(private readonly options: MobileRpcRouterOptions) {
    this.allowedProjectRoots = canonicalRoots(options.allowedProjects);
  }

  async handle(deviceId: string, input: unknown, emit: EventSink): Promise<RpcResponse> {
    const frame = mobileRpcFrameV1Schema.parse(input);
    if (frame.type !== "rpc.request") {
      throw new MobileRpcRouterError("bad_request", "expected rpc.request");
    }
    try {
      const result = await this.route(deviceId, frame, emit);
      return { type: "rpc.response", id: frame.id, ok: true, result };
    } catch (error) {
      const publicError = toPublicError(error);
      return {
        type: "rpc.response",
        id: frame.id,
        ok: false,
        error: publicError,
      };
    }
  }

  unsubscribe(deviceId: string, subscriptionId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.deviceId === deviceId) run.subscribers.delete(subscriptionId);
    }
  }

  disconnectDevice(deviceId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.deviceId === deviceId) run.subscribers.clear();
    }
  }

  private async route(deviceId: string, frame: RpcRequest, emit: EventSink): Promise<unknown> {
    const device = this.options.registry.get(deviceId);
    if (!device || device.revokedAt) {
      throw new MobileRpcRouterError("unauthorized", "device is not authorized");
    }
    switch (frame.method) {
      case "status.get": {
        emptyParams.parse(frame.params ?? {});
        const status = await this.options.daemon.request(DAEMON_METHODS.STATUS, {});
        return sanitizeStatus(status);
      }
      case "runtime.list": {
        const params = runtimeListParams.parse(frame.params ?? {});
        const runtimes = await this.options.daemon.request(
          DAEMON_METHODS.LIST_RUNTIMES,
          params.cwd ? { cwd: params.cwd } : {},
        );
        return sanitizeRuntimeList(runtimes);
      }
      case "project.list": {
        emptyParams.parse(frame.params ?? {});
        const registered = await this.options.daemon.request(DAEMON_METHODS.LIST_PROJECTS, {});
        return {
          projects: this.listProjects(
            device.allowedProjects,
            objectArray(registered, "projects"),
          ),
        };
      }
      case "project.create": {
        const params = projectCreateParams.parse(frame.params);
        return { project: await this.createProject(device.allowedProjects, params) };
      }
      case "session.list": {
        const params = listParams.parse(frame.params ?? {});
        const requestedProject = params.cwd
          ? this.assertProjectAccess(device.allowedProjects, params.cwd)
          : undefined;
        const result = await this.options.daemon.request(DAEMON_METHODS.LIST_SESSIONS, {
          limit: 500,
        });
        return {
          sessions: sessionItems(result)
            .filter((session) => this.canAccessCwd(device.allowedProjects, session.cwd))
            .filter((session) => !requestedProject || sameCanonicalPath(session.cwd, requestedProject))
            .slice(0, params.limit),
        };
      }
      case "session.search": {
        const params = searchParams.parse(frame.params);
        const requestedProject = params.cwd
          ? this.assertProjectAccess(device.allowedProjects, params.cwd)
          : undefined;
        const result = await this.options.daemon.request(DAEMON_METHODS.SEARCH_SESSIONS, {
          query: params.query,
          limit: params.limit,
        });
        const hits = objectArray(result, "hits")
          .filter((hit) =>
            this.canAccessCwd(device.allowedProjects, stringField(hit, "cwd")),
          )
          .filter(
            (hit) =>
              !requestedProject ||
              sameCanonicalPath(stringField(hit, "cwd"), requestedProject),
          )
          .slice(0, params.limit);
        return { hits };
      }
      case "session.messages": {
        const params = messagesParams.parse(frame.params);
        await this.assertSessionAccess(device.allowedProjects, params.sessionId);
        return this.options.daemon.request(DAEMON_METHODS.GET_SESSION_MESSAGES, params);
      }
      case "run.start":
        this.assertPermissionLevel(this.options.runPermission, "remote run");
        return this.startRun(deviceId, device.allowedProjects, frame.params, emit);
      case "run.cancel": {
        const params = cancelParams.parse(frame.params);
        const run = this.activeRuns.get(params.sessionId);
        if (!run || run.deviceId !== deviceId) {
          throw new MobileRpcRouterError("forbidden", "run is not owned by this device");
        }
        return this.options.daemon.request(DAEMON_METHODS.CANCEL_RUN, {
          sessionId: params.sessionId,
        });
      }
      case "run.subscribe": {
        const params = sessionSubscriptionParams.parse(frame.params);
        const run = this.activeRuns.get(params.sessionId);
        if (!run || run.deviceId !== deviceId) {
          throw new MobileRpcRouterError("forbidden", "run is not owned by this device");
        }
        run.subscribers.set(params.subscriptionId, emit);
        return { subscriptionId: params.subscriptionId };
      }
      case "permission.respond": {
        this.assertPermissionLevel(this.options.approvePermission, "remote approval");
        const params = permissionParams.parse(frame.params);
        const owner = this.permissionOwners.get(params.requestId);
        if (
          !owner ||
          owner.deviceId !== deviceId ||
          owner.sessionId !== params.sessionId
        ) {
          throw new MobileRpcRouterError(
            "forbidden",
            "permission request is not owned by this device",
          );
        }
        const result = await this.options.daemon.request(DAEMON_METHODS.PERMISSION_RESPONSE, {
          id: params.requestId,
          approved: params.approved,
          remember: false,
          ...(params.optionId ? { optionId: params.optionId } : {}),
        });
        this.permissionOwners.delete(params.requestId);
        return result;
      }
      case "permission.pending": {
        const params = pendingPermissionParams.parse(frame.params ?? {});
        return {
          requests: [...this.permissionOwners.entries()]
            .filter(
              ([, owner]) =>
                owner.deviceId === deviceId &&
                (!params.sessionId || owner.sessionId === params.sessionId),
            )
            .map(([requestId, owner]) => ({
              requestId,
              sessionId: owner.sessionId,
              event: owner.event,
            })),
        };
      }
      case "git.branches": {
        const params = cwdParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(DAEMON_METHODS.MOBILE_GIT_BRANCHES, {
          cwd,
        });
        return sanitizeGitBranches(result);
      }
      case "git.switch": {
        const params = gitSwitchParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(DAEMON_METHODS.MOBILE_GIT_SWITCH, {
          cwd,
          branch: params.branch,
          confirmDirty: params.confirmDirty,
        });
        return sanitizeGitSwitch(result);
      }
      case "workspace.files.list": {
        const params = filesListParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(
          DAEMON_METHODS.MOBILE_WORKSPACE_FILES_LIST,
          { cwd, path: params.path },
        );
        return sanitizeFilesList(result);
      }
      case "workspace.file.read": {
        const params = workspacePathParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(
          DAEMON_METHODS.MOBILE_WORKSPACE_FILE_READ,
          { cwd, path: params.path },
        );
        return sanitizeFileRead(result);
      }
      case "workspace.diff.list": {
        const params = cwdParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(
          DAEMON_METHODS.MOBILE_WORKSPACE_DIFF_LIST,
          { cwd },
        );
        return sanitizeDiffList(result);
      }
      case "workspace.diff.get": {
        const params = workspacePathParams.parse(frame.params);
        const cwd = this.assertProjectAccess(device.allowedProjects, params.cwd);
        const result = await this.options.daemon.request(
          DAEMON_METHODS.MOBILE_WORKSPACE_DIFF_GET,
          { cwd, path: params.path },
        );
        return sanitizeDiffGet(result);
      }
    }
  }

  private assertPermissionLevel(
    level: "allow" | "confirm" | "deny" | undefined,
    operation: string,
  ): void {
    if (level === "allow" || level === undefined) return;
    throw new MobileRpcRouterError(
      "forbidden",
      level === "confirm"
        ? `${operation} requires Desktop confirmation`
        : `${operation} is denied`,
    );
  }

  private listProjects(
    deviceProjects: string[],
    registeredProjects: Array<Record<string, unknown>>,
  ): Array<{
    name: string;
    path: string;
    kind: "workspace" | "project";
  }> {
    const grants = canonicalRoots(deviceProjects).filter((grant) =>
      this.allowedProjectRoots.some((root) => isWithin(root, grant)),
    );
    const projects: Array<{ name: string; path: string; kind: "workspace" | "project" }> = [];
    for (const root of grants) {
      projects.push({ name: basename(root) || root, path: root, kind: "workspace" });
      for (const registered of registeredProjects) {
        const path = stringField(registered, "cwd");
        if (!path || !this.canAccessCwd(deviceProjects, path)) continue;
        let canonicalPath: string;
        try {
          canonicalPath = realpathSync.native(path);
        } catch {
          // Skip registered projects whose cwd is missing or unreadable.
          continue;
        }
        projects.push({
          name: stringField(registered, "name") || basename(path) || path,
          path: canonicalPath,
          kind: "project",
        });
      }
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.name.startsWith(".") ||
          entry.name === "node_modules"
        ) continue;
        const path = resolve(root, entry.name);
        if (this.canAccessCanonical(deviceProjects, path)) {
          projects.push({ name: entry.name, path, kind: "project" });
        }
      }
    }
    return projects
      .filter((project, index, all) => all.findIndex((item) => item.path === project.path) === index)
      .slice(0, 200);
  }

  private async createProject(
    deviceProjects: string[],
    params: z.infer<typeof projectCreateParams>,
  ): Promise<{ name: string; path: string; kind: "project" }> {
    const parent = this.assertProjectAccess(deviceProjects, params.parentPath);
    const grants = canonicalRoots(deviceProjects);
    if (!grants.includes(parent)) {
      throw new MobileRpcRouterError("forbidden", "projects can only be created in a workspace root");
    }
    const target = resolve(parent, params.name);
    if (resolve(target, "..") !== parent || !isWithin(parent, target)) {
      throw new MobileRpcRouterError("forbidden", "project path is not allowed");
    }
    if (existsSync(target)) {
      throw new MobileRpcRouterError("conflict", "project already exists");
    }
    try {
      mkdirSync(target, { recursive: false, mode: 0o755 });
      const path = realpathSync.native(target);
      try {
        await this.options.daemon.request(DAEMON_METHODS.REGISTER_PROJECT, {
          name: params.name,
          cwd: path,
        });
      } catch {
        rmdirSync(path);
        throw new MobileRpcRouterError("internal", "project could not be registered", true);
      }
      return { name: params.name, path, kind: "project" };
    } catch {
      throw new MobileRpcRouterError("internal", "project could not be created", true);
    }
  }

  private async startRun(
    deviceId: string,
    deviceProjects: string[],
    rawParams: unknown,
    emit: EventSink,
  ): Promise<unknown> {
    const params = runStartParams.parse(rawParams);
    const cwd = this.assertProjectAccess(deviceProjects, params.cwd);
    if (params.sessionId) await this.assertSessionAccess(deviceProjects, params.sessionId);
    const activeCount = [...this.pendingRunOwners.values()].filter(
      (owner) => owner === deviceId,
    ).length;
    if (activeCount >= (this.options.maxConcurrentRunsPerDevice ?? 1)) {
      throw new MobileRpcRouterError("rate_limited", "device run limit reached", true);
    }

    this.pendingRunOwners.set(params.subscriptionId, deviceId);
    let sessionId = params.sessionId ?? undefined;
    const provisional: ActiveRun = {
      deviceId,
      subscribers: new Map([[params.subscriptionId, emit]]),
      nextSeq: 0,
    };
    const onEvent = (event: unknown) => {
      const eventSessionId = objectString(event, "sessionId");
      if (eventSessionId && eventSessionId !== sessionId) {
        if (sessionId) this.activeRuns.delete(sessionId);
        sessionId = eventSessionId;
        this.activeRuns.set(eventSessionId, provisional);
      }
      const permissionId = objectString(event, "id");
      if (
        eventSessionId &&
        permissionId &&
        objectString(event, "type") === "permission_request"
      ) {
        this.permissionOwners.set(permissionId, {
          deviceId,
          sessionId: eventSessionId,
          event,
        });
      }
      for (const [subscriptionId, sink] of provisional.subscribers) {
        sink({
          type: "rpc.event",
          subscriptionId,
          seq: provisional.nextSeq++,
          event,
        });
      }
    };

    try {
      const result = await this.options.daemon.request(
        DAEMON_METHODS.RUN,
        {
          cwd,
          message: params.message,
          sessionId: params.sessionId,
          runtime: params.runtime,
          // Mobile has no patch-confirm UI (desktop "应用补丁"). Without auto-apply,
          // write_file stays pending_confirmation and never lands on disk — the files
          // tab then looks empty even though the agent claimed the write succeeded.
          autoApply: true,
        },
        onEvent,
      );
      const resultSessionId = objectString(result, "sessionId");
      if (resultSessionId) sessionId = resultSessionId;
      return result;
    } finally {
      this.pendingRunOwners.delete(params.subscriptionId);
      if (sessionId) this.activeRuns.delete(sessionId);
      for (const [requestId, owner] of this.permissionOwners) {
        if (owner.deviceId === deviceId && owner.sessionId === sessionId) {
          this.permissionOwners.delete(requestId);
        }
      }
    }
  }

  private async assertSessionAccess(
    deviceProjects: string[],
    sessionId: string,
  ): Promise<void> {
    const active = this.activeRuns.get(sessionId);
    if (active) return;
    const result = await this.options.daemon.request(DAEMON_METHODS.LIST_SESSIONS, {
      limit: 500,
    });
    const session = sessionItems(result).find((item) => item.id === sessionId);
    if (!session) throw new MobileRpcRouterError("not_found", "session not found");
    if (!this.canAccessCwd(deviceProjects, session.cwd)) {
      throw new MobileRpcRouterError("forbidden", "session project is not allowed");
    }
  }

  private assertProjectAccess(deviceProjects: string[], requested: string): string {
    let canonical: string;
    try {
      canonical = realpathSync.native(requested);
    } catch {
      throw new MobileRpcRouterError("forbidden", "project is not allowed");
    }
    if (!this.canAccessCanonical(deviceProjects, canonical)) {
      throw new MobileRpcRouterError("forbidden", "project is not allowed");
    }
    return canonical;
  }

  private canAccessCwd(deviceProjects: string[], cwd: string): boolean {
    try {
      return this.canAccessCanonical(deviceProjects, realpathSync.native(cwd));
    } catch {
      return false;
    }
  }

  private canAccessCanonical(deviceProjects: string[], canonical: string): boolean {
    const grants = canonicalRoots(deviceProjects);
    return this.allowedProjectRoots.some(
      (root) => isWithin(root, canonical) && grants.some((grant) => isWithin(grant, canonical)),
    );
  }
}

export class MobileRpcRouterError extends Error {
  constructor(
    readonly code:
      | "bad_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "timeout"
      | "internal",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function toPublicError(error: unknown): {
  code: MobileRpcRouterError["code"];
  message: string;
  retryable?: boolean;
} {
  if (error instanceof MobileRpcRouterError) {
    return { code: error.code, message: error.message, retryable: error.retryable || undefined };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { code: "bad_request", message: "request parameters are invalid" };
  }
  if (error instanceof Error) {
    const message = sanitizePublicErrorMessage(error.message);
    if (message) {
      return { code: "internal", message, retryable: true };
    }
  }
  return { code: "internal", message: "request failed", retryable: true };
}

function sanitizePublicErrorMessage(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, " ").trim().slice(0, 280);
  if (!trimmed) return null;
  // Never forward credential-looking payloads to the phone.
  if (/api[_-]?key|secret|password|authorization|bearer\s+\S{8,}/i.test(trimmed)) {
    return null;
  }
  if (/token\s*[=:]\s*\S{12,}/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function canonicalRoots(paths: string[]): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    try {
      const canonical = realpathSync.native(path);
      if (isAbsolute(canonical)) roots.push(canonical);
    } catch {
      // Missing paths do not grant access.
    }
  }
  return [...new Set(roots)];
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameCanonicalPath(path: string, canonical: string): boolean {
  try {
    return realpathSync.native(path) === canonical;
  } catch {
    return false;
  }
}

function objectArray(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function sessionItems(value: unknown): Array<Record<string, unknown> & { id: string; cwd: string }> {
  return objectArray(value, "sessions")
    .map((item) => ({ ...item, id: stringField(item, "id"), cwd: stringField(item, "cwd") }))
    .filter((item) => item.id && item.cwd);
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function sanitizeStatus(value: unknown): unknown {
  if (!value || typeof value !== "object") return {};
  const status = value as Record<string, unknown>;
  return {
    version: status.version,
    activeRun: status.activeRun,
    runtime: status.runtime,
    sessions: status.sessions,
  };
}

function sanitizeRuntimeList(value: unknown): unknown {
  // Daemon returns { providers: [{ id, status, modes, models }] }.
  // Accept legacy { runtimes: [{ provider, ... }] } for compatibility.
  const rows = objectArray(value, "providers").length > 0
    ? objectArray(value, "providers")
    : objectArray(value, "runtimes");
  const runtimes = rows.flatMap((runtime) => {
    const provider = typeof runtime.id === "string"
      ? runtime.id
      : typeof runtime.provider === "string"
        ? runtime.provider
        : "";
    if (!provider) return [];
    const status = typeof runtime.status === "string" ? runtime.status : "";
    return [{
      provider: provider.slice(0, 120),
      label: typeof runtime.label === "string" ? runtime.label.slice(0, 120) : provider.slice(0, 120),
      available: runtime.available === true || status === "ready",
      status: status.slice(0, 120),
      modes: summaryIds(runtime.modes, 50),
      models: summaryIds(runtime.models, 100),
    }];
  });
  return { runtimes };
}

function summaryIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim().slice(0, 256)];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && row.id.trim()) return [row.id.trim().slice(0, 256)];
    if (typeof row.model === "string" && row.model.trim()) return [row.model.trim().slice(0, 256)];
    return [];
  }).slice(0, limit);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === true;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function sanitizeGitBranches(value: unknown): unknown {
  const result = record(value);
  const current = result.current;
  return {
    isRepo: booleanField(result, "isRepo"),
    current: typeof current === "string" || current === null ? current : null,
    detached: booleanField(result, "detached"),
    dirty: booleanField(result, "dirty"),
    branches: Array.isArray(result.branches)
      ? result.branches.filter((branch): branch is string => typeof branch === "string").slice(0, 500)
      : [],
  };
}

function sanitizeGitSwitch(value: unknown): unknown {
  const result = record(value);
  const response: { ok: boolean; current?: string; message?: string } = {
    ok: booleanField(result, "ok"),
  };
  if (typeof result.current === "string") response.current = result.current;
  if (typeof result.message === "string") response.message = result.message;
  return response;
}

function sanitizeFilesList(value: unknown): unknown {
  const entries = objectArray(value, "entries")
    .flatMap((entry) => {
      const kind = stringField(entry, "kind");
      if (!["file", "directory", "binary"].includes(kind)) return [];
      const name = stringField(entry, "name");
      const path = stringField(entry, "path");
      if (!name || !path) return [];
      return [{ name, path, kind, size: Math.max(0, numberField(entry, "size")) }];
    })
    .slice(0, 500);
  return { entries };
}

function sanitizeFileRead(value: unknown): unknown {
  const result = record(value);
  const path = stringField(result, "path");
  const kind = stringField(result, "kind");
  const size = Math.max(0, numberField(result, "size"));
  if (!path) return {};
  if (kind === "text" && typeof result.language === "string" && typeof result.content === "string") {
    return {
      path,
      kind,
      language: result.language,
      content: result.content,
      size,
      truncated: booleanField(result, "truncated"),
    };
  }
  if (kind === "binary" && typeof result.mime === "string") {
    return { path, kind, mime: result.mime, size, truncated: false };
  }
  return {};
}

function sanitizeDiffList(value: unknown): unknown {
  const files = objectArray(value, "files")
    .flatMap((file) => {
      const path = stringField(file, "path");
      if (!path) return [];
      return [{
        path,
        additions: Math.max(0, numberField(file, "additions")),
        deletions: Math.max(0, numberField(file, "deletions")),
        binary: booleanField(file, "binary"),
      }];
    })
    .slice(0, 500);
  return { files };
}

function sanitizeDiffGet(value: unknown): unknown {
  const result = record(value);
  const path = stringField(result, "path");
  const unifiedDiff = stringField(result, "unifiedDiff");
  if (!path) return {};
  return { path, unifiedDiff, truncated: booleanField(result, "truncated") };
}
