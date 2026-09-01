export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolCatalogEntry {
  toolId: string;
  name: string;
  description: string;
  risk: RiskLevel;
  requiredGrantActions: string[];
  schemaVersion: string;
  inputSchema: Record<string, unknown>;
  keywords?: string[];
}

export interface ToolSummary {
  toolId: string;
  name: string;
  description: string;
  risk: RiskLevel;
  requiredGrantActions: string[];
  schemaVersion: string;
}

export interface ToolSchema {
  toolId: string;
  inputSchema: Record<string, unknown>;
  schemaVersion: string;
}

export interface ToolSearchInput {
  query: string;
  limit?: number;
  grantedActions?: string[];
  allowedToolIds?: string[];
}

export interface ToolDiscoveryTrace {
  query: string;
  selectedToolIds: string[];
  loadedSchemaVersions: Record<string, string>;
}

export class ToolDiscovery {
  constructor(private readonly catalog: ToolCatalogEntry[]) {}

  search(input: ToolSearchInput): ToolSummary[] {
    const query = input.query.trim().toLowerCase();
    const allowed = input.allowedToolIds ? new Set(input.allowedToolIds) : null;
    const granted =
      input.grantedActions === undefined
        ? null
        : new Set(input.grantedActions);

    const scored = this.catalog
      .filter((entry) => (allowed ? allowed.has(entry.toolId) : true))
      .filter((entry) =>
        granted
          ? entry.requiredGrantActions.every((action) => granted.has(action))
          : true,
      )
      .map((entry) => ({
        entry,
        score: scoreTool(entry, query),
      }))
      .filter((item) => item.score > 0 || query.length === 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.entry.name.localeCompare(right.entry.name);
      });

    const limit = input.limit ?? 10;
    return scored.slice(0, limit).map(({ entry }) => summarize(entry));
  }

  loadSchemas(toolIds: string[]): ToolSchema[] {
    const byId = new Map(this.catalog.map((entry) => [entry.toolId, entry]));
    return toolIds.map((toolId) => {
      const entry = byId.get(toolId);
      if (!entry) {
        throw new Error(`tool not found: ${toolId}`);
      }
      return {
        toolId: entry.toolId,
        inputSchema: entry.inputSchema,
        schemaVersion: entry.schemaVersion,
      };
    });
  }

  buildTrace(input: ToolSearchInput, loadedToolIds: string[]): ToolDiscoveryTrace {
    return {
      query: input.query,
      selectedToolIds: loadedToolIds,
      loadedSchemaVersions: Object.fromEntries(
        this.loadSchemas(loadedToolIds).map((schema) => [
          schema.toolId,
          schema.schemaVersion,
        ]),
      ),
    };
  }
}

function summarize(entry: ToolCatalogEntry): ToolSummary {
  return {
    toolId: entry.toolId,
    name: entry.name,
    description: entry.description,
    risk: entry.risk,
    requiredGrantActions: [...entry.requiredGrantActions],
    schemaVersion: entry.schemaVersion,
  };
}

function scoreTool(entry: ToolCatalogEntry, query: string): number {
  if (!query) {
    return 1;
  }
  const haystacks = [
    entry.name,
    entry.description,
    ...(entry.keywords ?? []),
  ].map((value) => value.toLowerCase());
  let score = 0;
  for (const haystack of haystacks) {
    if (haystack === query) {
      score += 5;
    } else if (haystack.includes(query)) {
      score += 2;
    }
    for (const token of query.split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) {
        score += 1;
      }
    }
  }
  return score;
}

export function catalogFromDefinitions(
  definitions: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>,
  options?: {
    schemaVersion?: string;
    risk?: RiskLevel;
    requiredGrantActions?: string[];
  },
): ToolCatalogEntry[] {
  return definitions.map((definition) => ({
    toolId: definition.name,
    name: definition.name,
    description: definition.description,
    risk: options?.risk ?? "low",
    requiredGrantActions: options?.requiredGrantActions ?? [],
    schemaVersion: options?.schemaVersion ?? "v1",
    inputSchema: definition.parameters,
  }));
}

export { scoreTool, summarize };
