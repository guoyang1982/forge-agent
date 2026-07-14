export type RuleSourceKind = "global" | "project" | "directory" | "cursor";

export interface RuleSource {
  kind: RuleSourceKind;
  path: string;
  content: string;
}

export interface ProjectRules {
  sources: RuleSource[];
  merged: string;
}

export interface GenerateAgentsOptions {
  projectName: string;
  runCommands?: string[];
  testCommands?: string[];
  conventions?: string[];
}
