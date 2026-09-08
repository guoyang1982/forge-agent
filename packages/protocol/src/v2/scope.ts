/** Generic isolation boundary shared by Core packages. */
export interface TenantScope {
  tenantId: string;
  organizationId?: string;
}

export function assertTenantScope(
  scope: Partial<TenantScope> | undefined,
): asserts scope is TenantScope {
  if (!scope?.tenantId?.trim()) {
    throw new Error("tenant scope is required");
  }
  if (scope.organizationId !== undefined && !scope.organizationId.trim()) {
    throw new Error("organization scope must not be empty");
  }
}

export function matchesTenantScope(
  stored: TenantScope,
  requested: TenantScope | undefined,
): boolean {
  if (!requested || stored.tenantId !== requested.tenantId) {
    return false;
  }
  return (
    stored.organizationId === undefined ||
    stored.organizationId === requested.organizationId
  );
}

export function isSameTenantScope(
  left: TenantScope,
  right: TenantScope,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.organizationId === right.organizationId
  );
}
