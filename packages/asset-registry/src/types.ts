export type AssetKind =
  | "skill"
  | "knowledge"
  | "agent_profile"
  | "workflow"
  | "position_template";

export type AssetState =
  | "draft"
  | "testing"
  | "published"
  | "deprecated"
  | "rolled_back";

export interface AssetVersionRef {
  assetId: string;
  version?: number;
}

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  name: string;
  ownerSubjectKind: string;
  ownerSubjectId: string;
  state: AssetState;
  createdAt: string;
  updatedAt: string;
}

export interface AssetVersion {
  id: string;
  assetId: string;
  kind: AssetKind;
  version: number;
  state: AssetState;
  ownerSubjectId: string;
  sourceRef: string;
  contentHash: string;
  dependencies: AssetVersionRef[];
  validationIds: string[];
  createdAt: string;
}

export interface CreateDraftInput {
  id?: string;
  kind: AssetKind;
  name: string;
  ownerSubject: { kind: string; id: string };
  sourceRef: string;
  contentHash: string;
  description?: string;
  content?: Record<string, unknown>;
  dependencies?: AssetVersionRef[];
}

export interface PublishInput {
  validationIds: string[];
  permissionReviewed?: boolean;
  securityValidationId?: string;
  description?: string;
}

export interface ResolveVersionInput {
  assetId: string;
  version?: number;
}
