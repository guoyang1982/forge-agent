import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { AdapterDaemonBridge } from "@forge/channel-core";
import { mobileRpcFrameV1Schema, type MobileRpcFrameV1 } from "@forge/mobile-protocol";
import { DAEMON_METHODS } from "@forge/protocol";
import { z } from "zod";
import { normalizeMobileAttachments } from "./mobile-attachments.js";
import type { MobileDeviceRegistry } from "./device-registry.js";

type RpcRequest = Extract<MobileRpcFrameV1, { type: "rpc.request" }>;
type RpcResponse = Extract<MobileRpcFrameV1, { type: "rpc.response" }>;
type RpcEvent = Extract<MobileRpcFrameV1, { type: "rpc.event" }>;
type EventSink = (frame: RpcEvent) => void;

const emptyParams = z.object({}).strict().default({});
/** Keep mobile history payloads small enough for relay + phone memory. */
const MOBILE_SESSION_EVENT_LIMIT = 400;
const MOBILE_FIRST_MESSAGE_LIMIT = 50;
const MOBILE_FIRST_EVENT_LIMIT = 120;
const MOBILE_PAGE_MESSAGE_LIMIT = 40;
const MOBILE_PAGE_EVENT_LIMIT = 100;
const MOBILE_MESSAGE_TEXT_LIMIT = 20_000;
const MOBILE_EVENT_STRING_LIMIT = 4_000;
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
    limit: z.number().int().min(1).max(500).default(MOBILE_FIRST_MESSAGE_LIMIT),
    eventLimit: z.number().int().min(1).max(MOBILE_SESSION_EVENT_LIMIT).optional(),
  })
  .strict();
const historyPageParams = z
  .object({
    sessionId: z.string().min(8).max(128),
    limit: z.number().int().min(1).max(500).default(MOBILE_PAGE_MESSAGE_LIMIT),
    eventLimit: z.number().int().min(1).max(MOBILE_SESSION_EVENT_LIMIT).default(MOBILE_PAGE_EVENT_LIMIT),
    beforeMessageId: z.number().int().positive().optional(),
    beforeEventSequence: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) => value.beforeMessageId != null || value.beforeEventSequence != null,
    { message: "beforeMessageId or beforeEventSequence is required" },
  );
const runtimeParams = z
  .object({
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(256).optional(),
    permissionMode: z.string().min(1).max(64).optional(),
    sandboxMode: z.string().min(1).max(64).optional(),
    effort: z.string().min(1).max(64).optional(),
  })
  .strict();
const attachmentParams = z
  .object({
    kind: z.enum(["image", "file"]),
    name: z.string().min(1).max(180),
    mimeType: z.string().min(1).max(120),
    dataUrl: z.string().min(1).max(2_000_000).optional(),
    text: z.string().max(500_000).optional(),
    rawBase64: z.string().min(1).max(2_800_000).optional(),
  })
  .strict();
const runStartParams = z
  .object({
    cwd: z.string().min(1).max(4096),
    message: z.string().max(100_000),
    sessionId: z.string().min(8).max(128).nullable().optional(),
    subscriptionId: z.string().min(8).max(128),
    runtime: runtimeParams.optional(),
    attachments: z.array(attachmentParams).max(5).optional(),
    files: z.array(z.string().min(1).max(4096)).max(20).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.message.trim() && !(value.attachments?.length) && !(value.files?.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "message, attachments, or files required",
        path: ["message"],
      });
    }
  });
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
  /** Avoid re-listing hundreds of sessions just to authorize opening one already listed to mobile. */
  private readonly sessionCwdCache = new Map<string, string>();
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
        const allSessions = sessionItems(result);
        for (const session of allSessions) this.sessionCwdCache.set(session.id, session.cwd);
        return {
          sessions: allSessions
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
        for (const hit of hits) {
          const sessionId = stringField(hit, "sessionId");
          const cwd = stringField(hit, "cwd");
          if (sessionId && cwd) this.sessionCwdCache.set(sessionId, cwd);
        }
        return { hits };
      }
      case "session.messages": {
        const params = messagesParams.parse(frame.params);
        await this.assertSessionAccess(device.allowedProjects, params.sessionId);
        // First screen: recent window only; older history via session.history.page.
        const result = await this.options.daemon.request(DAEMON_METHODS.GET_SESSION_MESSAGES, {
          sessionId: params.sessionId,
          limit: params.limit,
          eventLimit: params.eventLimit ?? MOBILE_FIRST_EVENT_LIMIT,
        });
        return sanitizeSessionMessagesForMobile(result);
      }
      case "session.history.page": {
        const params = historyPageParams.parse(frame.params);
        await this.assertSessionAccess(device.allowedProjects, params.sessionId);
        const result = await this.options.daemon.request(DAEMON_METHODS.GET_SESSION_MESSAGES, {
          sessionId: params.sessionId,
          limit: params.limit,
          eventLimit: params.eventLimit,
          ...(params.beforeMessageId != null
            ? { beforeMessageId: params.beforeMessageId }
            : {}),
          ...(params.beforeEventSequence != null
            ? { beforeEventSequence: params.beforeEventSequence }
            : {}),
        });
        return sanitizeSessionMessagesForMobile(result);
      }
      case "run.start":
        this.assertPermissionLevel(this.options.runPermission, "remote run");
        return this.startRun(deviceId, device.allowedProjects, frame.params, emit);
      case "run.cancel": {
        // Stopping must not require the same start-run permission gate — paired
        // devices with session access should always be able to interrupt.
        const params = cancelParams.parse(frame.params);
        await this.assertCancelAccess(deviceId, device.allowedProjects, params.sessionId);
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
    // Register immediately for follow-up turns (same sessionId). Previously
    // activeRuns was only set when the event sessionId *changed*, so continuing
    // a session never appeared in activeRuns and run.cancel always failed.
    if (sessionId) this.activeRuns.set(sessionId, provisional);
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
      if (
        permissionId &&
        objectString(event, "type") === "permission_dismissed"
      ) {
        this.permissionOwners.delete(permissionId);
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
      let attachments;
      try {
        attachments = await normalizeMobileAttachments(params.attachments);
      } catch (cause) {
        throw new MobileRpcRouterError(
          "bad_request",
          cause instanceof Error ? cause.message : "附件无效",
          false,
        );
      }
      const message = params.message.trim() || (attachments.length ? "请查看附件" : "");
      const files = (params.files ?? [])
        .map((item) => item.trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .slice(0, 20);
      const result = await this.options.daemon.request(
        DAEMON_METHODS.RUN,
        {
          cwd,
          message: message || (files.length ? "请查看提及的文件" : ""),
          sessionId: params.sessionId,
          runtime: params.runtime,
          ...(attachments.length ? { attachments } : {}),
          ...(files.length ? { files } : {}),
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
    const cachedCwd = this.sessionCwdCache.get(sessionId);
    if (cachedCwd) {
      if (!this.canAccessCwd(deviceProjects, cachedCwd)) {
        throw new MobileRpcRouterError("forbidden", "session project is not allowed");
      }
      return;
    }
    const result = await this.options.daemon.request(DAEMON_METHODS.LIST_SESSIONS, {
      limit: 500,
    });
    const session = sessionItems(result).find((item) => item.id === sessionId);
    if (!session) throw new MobileRpcRouterError("not_found", "session not found");
    this.sessionCwdCache.set(session.id, session.cwd);
    if (!this.canAccessCwd(deviceProjects, session.cwd)) {
      throw new MobileRpcRouterError("forbidden", "session project is not allowed");
    }
  }

  /**
   * Cancel is allowed when this device owns the live run, or when the session
   * belongs to an allowed project (so Desktop-started runs can be stopped from
   * the phone and vice versa via the shared daemon cancel_run).
   */
  private async assertCancelAccess(
    deviceId: string,
    deviceProjects: string[],
    sessionId: string,
  ): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (run?.deviceId === deviceId) return;

    const result = await this.options.daemon.request(DAEMON_METHODS.LIST_SESSIONS, {
      limit: 500,
    });
    const session = sessionItems(result).find((item) => item.id === sessionId);
    if (!session) {
      // Race: brand-new session may not be listed yet while this device owns the
      // in-flight run under a different key — still forbid unknown sessions.
      throw new MobileRpcRouterError("not_found", "session not found");
    }
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

/**
 * Mobile only needs messages + a recent event window for timeline rebuild.
 * Drop desktop-only journals and truncate bulky tool/text payloads before E2EE.
 */
function sanitizeSessionMessagesForMobile(value: unknown): unknown {
  const root = record(value);
  const sessionId = typeof root.sessionId === "string" ? root.sessionId : "";
  const pageInfo = record(root.page);
  const messageIds = Array.isArray(pageInfo.messageIds)
    ? pageInfo.messageIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
    : [];
  const rawMessages = Array.isArray(root.messages) ? root.messages : [];
  const messages = rawMessages.flatMap((row, index) => {
    const sanitized = sanitizeMobileChatMessage(row);
    if (!sanitized) return [];
    const id = messageIds[index];
    if (typeof id === "number") sanitized.id = id;
    return [sanitized];
  });
  const events = Array.isArray(root.events)
    ? root.events
      .slice(-MOBILE_SESSION_EVENT_LIMIT)
      .map(sanitizeMobileSessionEvent)
      .filter((row) => row != null)
    : [];
  const oldestMessageId = typeof pageInfo.oldestMessageId === "number"
    ? pageInfo.oldestMessageId
    : messages.find((row) => typeof row.id === "number")?.id ?? null;
  const oldestEventSequence = typeof pageInfo.oldestEventSequence === "number"
    ? pageInfo.oldestEventSequence
    : events[0] && typeof events[0].sequence === "number"
      ? events[0].sequence
      : null;
  const truncated = pageInfo.truncated === true;
  return {
    sessionId,
    messages,
    events,
    truncated,
    oldestMessageId,
    oldestEventSequence,
  };
}

function sanitizeMobileChatMessage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.role !== "string") return null;
  const next: Record<string, unknown> = {
    role: row.role,
    content: truncateChatContent(row.content),
  };
  if (Array.isArray(row.tool_calls)) next.tool_calls = row.tool_calls.slice(0, 40);
  if (typeof row.tool_call_id === "string") next.tool_call_id = row.tool_call_id.slice(0, 120);
  return next;
}

function truncateChatContent(content: unknown): unknown {
  if (typeof content === "string") return content.slice(0, MOBILE_MESSAGE_TEXT_LIMIT);
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const row = part as Record<string, unknown>;
    if (row.type === "text" && typeof row.text === "string") {
      return { ...row, text: row.text.slice(0, MOBILE_MESSAGE_TEXT_LIMIT) };
    }
    // Never relay base64 image payloads back to the phone over E2EE.
    if (row.type === "image_url") {
      return {
        type: "image_url",
        image_url: { url: "about:blank#forge-image" },
        ...(typeof row.name === "string" ? { name: row.name.slice(0, 120) } : {}),
      };
    }
    return part;
  });
}

function sanitizeMobileSessionEvent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const event = row.event && typeof row.event === "object" && !Array.isArray(row.event)
    ? truncateDeepStrings(row.event as Record<string, unknown>, MOBILE_EVENT_STRING_LIMIT)
    : null;
  if (!event) return null;
  const next: Record<string, unknown> = {
    sequence: typeof row.sequence === "number" ? row.sequence : 0,
    sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
    turnIndex: typeof row.turnIndex === "number" || row.turnIndex === null ? row.turnIndex : null,
    eventType: typeof row.eventType === "string" ? row.eventType : stringField(event, "type"),
    emittedAtMs: typeof row.emittedAtMs === "number" ? row.emittedAtMs : 0,
    event,
  };
  if (typeof row.itemId === "string") next.itemId = row.itemId.slice(0, 120);
  return next;
}

function truncateDeepStrings(
  value: Record<string, unknown>,
  limit: number,
  depth = 0,
): Record<string, unknown> {
  if (depth > 6) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") {
      out[key] = field.length > limit ? `${field.slice(0, limit)}…` : field;
    } else if (Array.isArray(field)) {
      out[key] = field.slice(0, 40).map((item) => {
        if (typeof item === "string") {
          return item.length > limit ? `${item.slice(0, limit)}…` : item;
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return truncateDeepStrings(item as Record<string, unknown>, limit, depth + 1);
        }
        return item;
      });
    } else if (field && typeof field === "object") {
      out[key] = truncateDeepStrings(field as Record<string, unknown>, limit, depth + 1);
    } else {
      out[key] = field;
    }
  }
  return out;
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
      modes: summaryModes(runtime.modes, 50),
      models: summaryIds(runtime.models, 100),
    }];
  });
  return { runtimes };
}

function summaryModes(value: unknown, limit: number): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) {
      const id = item.trim().slice(0, 256);
      return [{ id, label: id }];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && row.id.trim()) {
      const id = row.id.trim().slice(0, 256);
      const label =
        typeof row.label === "string" && row.label.trim()
          ? row.label.trim().slice(0, 256)
          : id;
      return [{ id, label }];
    }
    return [];
  }).slice(0, limit);
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
