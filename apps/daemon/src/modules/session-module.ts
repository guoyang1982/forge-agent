import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { loadConfig, saveConfig } from "@forge/config";
import { DAEMON_METHODS } from "@forge/protocol";
import type { DaemonModule } from "../host/types.js";
import {
  handleGetSessionMessages,
  handleListSessions,
  handleSearchSessions,
} from "../services/app-service.js";
import { handleCompactSession } from "../services/compact-service.js";
import { handleApplyPatch, handleRestoreCheckpoint } from "../services/patch-service.js";
import { handlePlan } from "../services/plan-service.js";
import { handleReview } from "../services/review-service.js";
import type { ForgeDaemonContext } from "./context.js";

type SharedProject = { id: string; name: string; cwd: string };

export function createSessionModule(): DaemonModule<ForgeDaemonContext> {
  return {
    id: "session",
    feature: { version: 1, enabled: true },
    register(router, context) {
      router.registerLegacy(DAEMON_METHODS.LIST_SESSIONS, async (params) =>
        handleListSessions(params, { sessions: context.sessions }));
      router.registerLegacy(DAEMON_METHODS.LIST_PROJECTS, async () => ({
        projects: sharedProjects(),
      }));
      router.registerLegacy(DAEMON_METHODS.REGISTER_PROJECT, async (params) =>
        registerSharedProject(params));
      router.registerLegacy(DAEMON_METHODS.SEARCH_SESSIONS, async (params) =>
        handleSearchSessions(params, { sessions: context.sessions }));
      router.registerLegacy(DAEMON_METHODS.GET_SESSION_MESSAGES, async (params) =>
        handleGetSessionMessages(params, { sessions: context.sessions }));
      router.registerLegacy(DAEMON_METHODS.APPLY_PATCH, async (params) =>
        handleApplyPatch(params));
      router.registerLegacy(DAEMON_METHODS.RESTORE_CHECKPOINT, async (params) =>
        handleRestoreCheckpoint(params, { sessions: context.sessions }));
      router.registerLegacy(DAEMON_METHODS.PLAN, async (params, rpc) =>
        handlePlan(params, rpc.emitLegacyAgentEvent));
      router.registerLegacy(DAEMON_METHODS.REVIEW, async (params, rpc) =>
        handleReview(params, rpc.emitLegacyAgentEvent));
      router.registerLegacy(DAEMON_METHODS.COMPACT_SESSION, async (params, rpc) =>
        handleCompactSession(params, rpc.emitLegacyAgentEvent, {
          sessions: context.sessions,
          getRuntime: context.getRuntime,
        }));
    },
  };
}

function sharedProjects(): SharedProject[] {
  const projects = loadConfig().ui?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.filter(
    (project): project is SharedProject =>
      Boolean(project) &&
      typeof project.id === "string" &&
      Boolean(project.id) &&
      typeof project.name === "string" &&
      Boolean(project.name) &&
      typeof project.cwd === "string" &&
      Boolean(project.cwd),
  );
}

function registerSharedProject(params: unknown): { project: SharedProject } {
  const raw = params && typeof params === "object"
    ? params as Record<string, unknown>
    : {};
  if (typeof raw.cwd !== "string" || !raw.cwd.trim()) {
    throw new Error("project cwd is required");
  }
  const cwd = realpathSync.native(raw.cwd.trim());
  if (!statSync(cwd).isDirectory()) throw new Error("project cwd must be a directory");
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim().slice(0, 200)
    : basename(cwd) || cwd;
  const current = sharedProjects();
  const existing = current.find((project) => project.cwd === cwd);
  const project = existing ?? { id: `project-${randomUUID()}`, name, cwd };
  if (!existing) {
    const cfg = loadConfig();
    saveConfig({ ui: { ...cfg.ui, projects: [...current, project] } });
  }
  return { project };
}
