import { join } from "node:path";
import type {
  FireTalentRequest,
  FireTalentResult,
  HireTalentRequest,
  HireTalentResult,
  HiredTalentListItem,
  ListTalentRosterRequest,
  ListTalentRosterResult,
  RenameTalentRequest,
  RenameTalentResult,
  TalentSyncRequest,
  TalentSyncResult,
  UpdateTalentBindingsRequest,
  UpdateTalentBindingsResult,
  ListTalentTemplatesRequest,
  ListTalentTemplatesResult,
  GetTalentTemplateRequest,
  GetTalentTemplateResult,
} from "@forge/protocol";
import {
  ensureTalentTemplatesSeeded,
  fireTalent,
  hireTalent,
  listTalentTemplates,
  readMergedTalentRoster,
  readTalentTemplate,
  renameTalent,
  resolveTalentStorePaths,
  resolveWritableRosterPath,
  syncTalentTemplates,
  updateTalentBindings,
  type HiredTalent,
  type TalentStorePaths,
  type TalentTemplate,
} from "@forge/talent-registry";

export function defaultTalentTemplatesDir(dataDir: string): string {
  return join(dataDir, "talents", "templates");
}

export function defaultTalentRosterPath(dataDir: string): string {
  return join(dataDir, "talents", "roster.json");
}

/**
 * Populate the user's talent templates directory from the templates bundled in
 * @forge/talent-registry on first run, so the talent market is usable offline
 * and pre-localized without requiring a `talents sync`.
 */
export async function seedTalentTemplates(deps: {
  dataDir: string;
}): Promise<{ seeded: number }> {
  return ensureTalentTemplatesSeeded(defaultTalentTemplatesDir(deps.dataDir));
}

function talentPaths(dataDir: string, cwd?: string): TalentStorePaths {
  return resolveTalentStorePaths(dataDir, cwd);
}

function cwdFromParams(params: unknown): string | undefined {
  const req = params as { cwd?: string } | undefined;
  const cwd = req?.cwd?.trim();
  return cwd || undefined;
}

export async function handleTalentSyncTemplates(
  params: unknown,
  deps: { dataDir: string },
): Promise<TalentSyncResult> {
  const req = params as TalentSyncRequest | undefined;
  const templatesDir = defaultTalentTemplatesDir(deps.dataDir);
  const result = await syncTalentTemplates({
    templatesDir,
    limitCategories: req?.categories,
    sourceDir: req?.sourceDir,
    timeoutMs: req?.timeoutMs,
  });
  await ensureTalentTemplatesSeeded(templatesDir);
  return result;
}

export async function handleListTalentTemplates(
  params: unknown,
  deps: { dataDir: string },
): Promise<ListTalentTemplatesResult> {
  const req = params as ListTalentTemplatesRequest | undefined;
  const paths = talentPaths(deps.dataDir, cwdFromParams(params));
  const templates = await listTalentTemplates(paths.templatesDir, paths.rosterPath, {
    category: req?.category,
    query: req?.query,
    globalRosterPath: paths.globalRosterPath,
  });
  return {
    templates: templates.map((item) => ({
      id: item.id,
      category: item.category,
      role: item.role,
      description: item.description,
      vibe: item.vibe,
      emoji: item.emoji,
      color: item.color,
      avatar: item.avatar,
      sourcePath: item.sourcePath,
      suggestedSkills: item.suggestedSkills,
      suggestedTools: item.suggestedTools,
      hired: item.hired,
    })),
  };
}

export async function handleHireTalent(
  params: unknown,
  deps: { dataDir: string },
): Promise<HireTalentResult> {
  const req = params as HireTalentRequest | undefined;
  if (!req?.templateId) throw new Error("templateId is required");
  const paths = talentPaths(deps.dataDir, req.cwd);
  const hired = await hireTalent({
    templatesDir: paths.templatesDir,
    rosterPath: paths.rosterPath,
    templateId: req.templateId,
    displayName: req.displayName,
    mention: req.mention,
  });
  const template = await readTalentTemplate(paths.templatesDir, hired.templateId);
  if (!template) throw new Error(`Talent template not found: ${hired.templateId}`);
  return { talent: toHiredTalentListItem(hired, template) };
}

export async function handleFireTalent(
  params: unknown,
  deps: { dataDir: string },
): Promise<FireTalentResult> {
  const req = params as FireTalentRequest | undefined;
  if (!req?.instanceIdOrMention) {
    throw new Error("instanceIdOrMention is required");
  }
  const paths = talentPaths(deps.dataDir, req.cwd);
  const rosterPath = await resolveWritableRosterPath(
    paths,
    req.instanceIdOrMention,
  );
  return fireTalent(rosterPath, req.instanceIdOrMention);
}

export async function handleRenameTalent(
  params: unknown,
  deps: { dataDir: string },
): Promise<RenameTalentResult> {
  const req = params as RenameTalentRequest | undefined;
  if (!req?.instanceIdOrMention) {
    throw new Error("instanceIdOrMention is required");
  }
  const paths = talentPaths(deps.dataDir, req.cwd);
  const rosterPath = await resolveWritableRosterPath(
    paths,
    req.instanceIdOrMention,
  );
  const hired = await renameTalent({
    rosterPath,
    instanceIdOrMention: req.instanceIdOrMention,
    displayName: req.displayName,
    mention: req.mention,
  });
  const template = await readTalentTemplate(paths.templatesDir, hired.templateId);
  if (!template) throw new Error(`Talent template not found: ${hired.templateId}`);
  return { talent: toHiredTalentListItem(hired, template) };
}

export async function handleUpdateTalentBindings(
  params: unknown,
  deps: { dataDir: string },
): Promise<UpdateTalentBindingsResult> {
  const req = params as UpdateTalentBindingsRequest | undefined;
  if (!req?.instanceIdOrMention) {
    throw new Error("instanceIdOrMention is required");
  }
  const paths = talentPaths(deps.dataDir, req.cwd);
  const rosterPath = await resolveWritableRosterPath(
    paths,
    req.instanceIdOrMention,
  );
  const hired = await updateTalentBindings({
    rosterPath,
    instanceIdOrMention: req.instanceIdOrMention,
    skills: req.skills,
    tools: req.tools,
    enabled: req.enabled,
    strictSkills: req.strictSkills,
  });
  const template = await readTalentTemplate(paths.templatesDir, hired.templateId);
  if (!template) throw new Error(`Talent template not found: ${hired.templateId}`);
  return { talent: toHiredTalentListItem(hired, template) };
}

export async function handleListTalentRoster(
  params: unknown,
  deps: { dataDir: string },
): Promise<ListTalentRosterResult> {
  const req = params as ListTalentRosterRequest | undefined;
  const paths = talentPaths(deps.dataDir, req?.cwd);
  const roster = await readMergedTalentRoster(paths);
  const templatesDir = paths.templatesDir;
  const talents: HiredTalentListItem[] = [];
  for (const hired of roster.hired) {
    const template = await readTalentTemplate(templatesDir, hired.templateId);
    if (template) talents.push(toHiredTalentListItem(hired, template));
  }
  return { talents };
}

export async function handleGetTalentTemplate(
  params: unknown,
  deps: { dataDir: string },
): Promise<GetTalentTemplateResult> {
  const req = params as GetTalentTemplateRequest | undefined;
  if (!req?.templateId) throw new Error("templateId is required");
  const paths = talentPaths(deps.dataDir, cwdFromParams(params));
  const template = await readTalentTemplate(paths.templatesDir, req.templateId);
  if (!template) return { template: null };
  return {
    template: {
      id: template.id,
      category: template.category,
      role: template.role,
      description: template.description,
      vibe: template.vibe,
      emoji: template.emoji,
      color: template.color,
      avatar: template.avatar,
      systemPrompt: template.systemPrompt,
      suggestedSkills: template.suggestedSkills,
      suggestedTools: template.suggestedTools,
    },
  };
}

function toHiredTalentListItem(
  hired: HiredTalent,
  template: TalentTemplate,
): HiredTalentListItem {
  return {
    instanceId: hired.instanceId,
    templateId: hired.templateId,
    displayName: hired.displayName,
    mention: hired.mention,
    role: template.role,
    category: template.category,
    description: template.description,
    emoji: template.emoji,
    color: template.color,
    avatar: template.avatar,
    enabled: hired.enabled,
    skills: hired.skills,
    tools: hired.tools,
    strictSkills: hired.strictSkills,
    permissionPreset: hired.permissionPreset,
    hiredAt: hired.hiredAt,
    stats: hired.stats,
  };
}
