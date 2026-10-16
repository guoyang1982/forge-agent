export type WorkspaceEnv = "dev" | "staging" | "prod";

export function companyRunAutoApply(
  autonomyLevel: number | null | undefined,
  env: WorkspaceEnv | null | undefined = "dev",
): boolean {
  if (env === "prod") return false;
  if (env === "staging") return (autonomyLevel ?? 2) >= 3;
  return (autonomyLevel ?? 2) >= 2;
}
