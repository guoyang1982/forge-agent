import {
  DEFAULT_PERMISSIONS,
  type ForgeConfig,
  type PermissionLevel,
  type PermissionsConfig,
} from "@forge/protocol";

const PERMISSION_LEVELS = new Set<PermissionLevel>(["allow", "confirm", "deny"]);

function parseScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const n = Number(trimmed);
  if (!Number.isNaN(n) && trimmed !== "") return n;
  return raw;
}

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && PERMISSION_LEVELS.has(value as PermissionLevel);
}

function patchPermissionsSection(
  current: PermissionsConfig,
  section: keyof PermissionsConfig,
  field: string,
  value: string | number | boolean,
): Partial<ForgeConfig> {
  const sectionObj = { ...(current[section] as object) } as Record<
    string,
    unknown
  >;
  if (!(field in sectionObj)) {
    throw new Error(`Unknown permissions key: permissions.${String(section)}.${field}`);
  }
  const existing = sectionObj[field];
  if (typeof existing === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(
        `permissions.${String(section)}.${field} expects true or false`,
      );
    }
  } else if (isPermissionLevel(existing)) {
    if (!isPermissionLevel(value)) {
      throw new Error(
        `permissions.${String(section)}.${field} expects allow, confirm, or deny`,
      );
    }
  } else if (Array.isArray(existing)) {
    throw new Error(
      `permissions.${String(section)}.${field} is an array; edit config.json directly`,
    );
  } else if (typeof existing === "number") {
    if (typeof value !== "number") {
      throw new Error(
        `permissions.${String(section)}.${field} expects a number`,
      );
    }
  }

  return {
    permissions: {
      ...current,
      [section]: {
        ...sectionObj,
        [field]: value,
      },
    },
  };
}

/** Build a config patch from a dot-notation key (e.g. model.apiKey, permissions.automation.enabled). */
export function buildConfigPatchFromDotKey(
  key: string,
  rawValue: string,
  current: ForgeConfig,
): Partial<ForgeConfig> {
  const value = parseScalar(rawValue);

  if (key === "model.apiKey") {
    return { model: { ...current.model, apiKey: String(value) } };
  }
  if (key === "model.name") {
    return { model: { ...current.model, name: String(value) } };
  }
  if (key === "model.baseUrl") {
    return { model: { ...current.model, baseUrl: String(value) } };
  }
  if (key === "limits.maxSteps") {
    if (typeof value !== "number") {
      throw new Error("limits.maxSteps expects a number");
    }
    return { limits: { ...current.limits, maxSteps: value } };
  }
  if (key === "limits.toolResultMaxChars") {
    if (typeof value !== "number") {
      throw new Error("limits.toolResultMaxChars expects a number");
    }
    return { limits: { ...current.limits, toolResultMaxChars: value } };
  }
  if (key === "limits.maxContextTokens") {
    if (typeof value !== "number") {
      throw new Error("limits.maxContextTokens expects a number");
    }
    return { limits: { ...current.limits, maxContextTokens: value } };
  }

  const permMatch = /^permissions\.([a-zA-Z]+)\.([a-zA-Z]+)$/.exec(key);
  if (permMatch) {
    const section = permMatch[1] as keyof PermissionsConfig;
    const field = permMatch[2]!;
    const base = current.permissions ?? DEFAULT_PERMISSIONS;
    if (!(section in base)) {
      throw new Error(`Unknown permissions section: ${permMatch[1]}`);
    }
    return patchPermissionsSection(base, section, field, value);
  }

  throw new Error(`Unknown key: ${key}`);
}
