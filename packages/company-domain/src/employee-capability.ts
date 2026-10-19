import type { DraftTalentPack } from "./draft-assignment.js";
import type { EmployeeProfile } from "./organization-service.js";

export type EmployeeCapability = {
  role: string;
  skills: string[];
  tools: string[];
  qualityGates: string[];
  methodology: string[];
  systemPrompt: string;
  modelProfileId?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
  knowledgeRefs?: string[];
  connectors?: string[];
};

export function resolveEmployeeCapability(
  profile?: EmployeeProfile | null,
): EmployeeCapability {
  return {
    role: profile?.talentRole?.trim() || "",
    skills: [...(profile?.skills || [])],
    tools: [...(profile?.tools || [])],
    qualityGates: [...(profile?.qualityGates || [])],
    methodology: [...(profile?.methodology || [])],
    systemPrompt: profile?.systemPrompt?.trim() || "",
    ...(profile?.modelProfileId ? { modelProfileId: profile.modelProfileId } : {}),
    ...(profile?.agentProfileId ? { agentProfileId: profile.agentProfileId } : {}),
    ...(profile?.agentProfileVersionId
      ? { agentProfileVersionId: profile.agentProfileVersionId }
      : {}),
    ...(profile?.knowledgeRefs?.length ? { knowledgeRefs: [...profile.knowledgeRefs] } : {}),
    ...(profile?.connectors?.length ? { connectors: [...profile.connectors] } : {}),
  };
}

export function capabilityNeedsTemplateFill(capability: EmployeeCapability): boolean {
  return (
    !capability.systemPrompt &&
    capability.qualityGates.length === 0 &&
    capability.methodology.length === 0
  );
}

export function toDraftTalentPack(capability: EmployeeCapability): DraftTalentPack {
  return {
    role: capability.role,
    skills: capability.skills,
    qualityGates: capability.qualityGates,
    methodology: capability.methodology,
    systemPrompt: capability.systemPrompt,
  };
}
