import { randomUUID } from "node:crypto";
import type { Database } from "@forge/store";
import type {
  AgentCapabilitySnapshot,
  AgentProfileVersion,
  CreateFromTalentInput,
  ProfileVersionSnapshot,
  PublishVersionInput,
  ResolveSnapshotInput,
  RuntimePolicy,
  TalentProfileSource,
} from "./types.js";

export class AgentProfileStore {
  constructor(private readonly db: Database) {}

  publishVersion(input: PublishVersionInput): AgentProfileVersion {
    const profileId = input.profileId ?? randomUUID();
    const now = new Date().toISOString();
    if (!input.profileId) {
      this.db
        .prepare(
          `INSERT INTO core_agent_profiles (
            id, name, source_kind, source_ref, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          profileId,
          input.name ?? profileId,
          input.sourceKind ?? "custom",
          input.sourceRef ?? null,
          now,
          now,
        );
    } else {
      this.db
        .prepare(`UPDATE core_agent_profiles SET updated_at = ? WHERE id = ?`)
        .run(now, profileId);
    }

    const nextVersion =
      (this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) AS maxVersion
           FROM core_agent_profile_versions
           WHERE profile_id = ?`,
        )
        .get(profileId) as { maxVersion: number }).maxVersion + 1;

    const snapshot = buildSnapshot(input, input.name ?? profileId);
    const versionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO core_agent_profile_versions (
          id, profile_id, version, snapshot_json, policy_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        profileId,
        nextVersion,
        JSON.stringify(snapshot),
        input.policyVersionId ?? null,
        now,
      );

    return this.getVersion(versionId);
  }

  createFromTalent(input: CreateFromTalentInput): AgentProfileVersion {
    const skills = (input.hired?.skills ?? input.source.suggestedSkills).map(toAssetRef);
    const tools = (input.hired?.tools ?? input.source.suggestedTools).map((name) => ({
      name,
    }));
    return this.publishVersion({
      name: input.source.name,
      sourceKind: "talent_template",
      sourceRef: input.source.templateId,
      model: input.model ?? "forge-default",
      skills,
      tools,
      knowledge: (input.source.knowledgeRefs ?? []).map(toAssetRef),
      connectors: (input.source.connectors ?? []).map((connectorId) => ({
        connectorId,
      })),
      memoryScopes: input.hired?.strictSkills ? ["talent-bound"] : ["shared"],
      policyVersionId: input.policyVersionId,
    });
  }

  resolveSnapshot(input: ResolveSnapshotInput): AgentCapabilitySnapshot {
    const version = this.getVersion(input.profileVersionId);
    if (version.profileId !== input.profileId) {
      throw new Error("profile version does not belong to profile");
    }

    const snapshotId = randomUUID();
    const createdAt = new Date().toISOString();
    const capability = toCapabilitySnapshot({
      snapshotId,
      version,
      runId: input.runId,
      createdAt,
    });

    this.db
      .prepare(
        `INSERT INTO core_agent_capability_snapshots (
          id, profile_id, profile_version_id, run_id, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        version.profileId,
        version.id,
        input.runId ?? null,
        JSON.stringify(capability),
        createdAt,
      );

    return capability;
  }

  getSnapshot(snapshotId: string): AgentCapabilitySnapshot {
    const row = this.db
      .prepare(
        `SELECT snapshot_json
         FROM core_agent_capability_snapshots
         WHERE id = ?`,
      )
      .get(snapshotId) as { snapshot_json: string } | undefined;
    if (!row) {
      throw new Error(`capability snapshot not found: ${snapshotId}`);
    }
    return JSON.parse(row.snapshot_json) as AgentCapabilitySnapshot;
  }

  getVersion(versionId: string): AgentProfileVersion {
    const row = this.db
      .prepare(
        `SELECT id, profile_id, version, snapshot_json, policy_version_id, created_at
         FROM core_agent_profile_versions
         WHERE id = ?`,
      )
      .get(versionId) as VersionRow | undefined;
    if (!row) {
      throw new Error(`profile version not found: ${versionId}`);
    }
    return mapVersion(row);
  }
}

function buildSnapshot(
  input: PublishVersionInput,
  displayName: string,
): ProfileVersionSnapshot {
  const modelPolicy: RuntimePolicy = input.modelPolicy ?? {
    model: input.model ?? "forge-default",
  };
  return {
    displayName,
    modelPolicy,
    skills: input.skills ?? [],
    tools: input.tools ?? [],
    knowledge: input.knowledge ?? [],
    memoryScopes: input.memoryScopes ?? [],
    connectors: input.connectors ?? [],
  };
}

function toCapabilitySnapshot(options: {
  snapshotId: string;
  version: AgentProfileVersion;
  runId?: string;
  createdAt: string;
}): AgentCapabilitySnapshot {
  const { snapshot } = options.version;
  return {
    id: options.snapshotId,
    profileId: options.version.profileId,
    profileVersionId: options.version.id,
    runId: options.runId,
    modelPolicy: snapshot.modelPolicy,
    runtime: snapshot.modelPolicy,
    skills: snapshot.skills,
    tools: snapshot.tools,
    knowledge: snapshot.knowledge,
    memoryScopes: snapshot.memoryScopes,
    connectors: snapshot.connectors,
    policyVersionId: options.version.policyVersionId ?? "policy:none",
    createdAt: options.createdAt,
  };
}

function toAssetRef(id: string) {
  return { assetId: id, version: "latest" };
}

export function mapTalentToProfileSource(source: TalentProfileSource): TalentProfileSource {
  return source;
}

type VersionRow = {
  id: string;
  profile_id: string;
  version: number;
  snapshot_json: string;
  policy_version_id: string | null;
  created_at: string;
};

function mapVersion(row: VersionRow): AgentProfileVersion {
  return {
    id: row.id,
    profileId: row.profile_id,
    version: row.version,
    snapshot: JSON.parse(row.snapshot_json) as ProfileVersionSnapshot,
    policyVersionId: row.policy_version_id ?? undefined,
    createdAt: row.created_at,
  };
}

export { buildSnapshot, mapVersion, toCapabilitySnapshot };
