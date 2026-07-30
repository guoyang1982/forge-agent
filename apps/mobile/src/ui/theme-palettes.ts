/** Semantic color tokens shared by every Forge mobile theme. */
export type ThemeColors = {
  background: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  border: string;
  borderAlt: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  brand: string;
  brandActive: string;
  brandSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  add: string;
  del: string;
};

export type ThemeId =
  | "forge-dark"
  | "forge-light"
  | "midnight"
  | "ocean"
  | "forest"
  | "sunset"
  | "slate"
  | "rose"
  | "sand"
  | "aurora";

export type ThemeDefinition = {
  id: ThemeId;
  label: string;
  mode: "dark" | "light";
  colors: ThemeColors;
};

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: "forge-dark",
    label: "Forge 紫夜",
    mode: "dark",
    colors: {
      background: "#080B10",
      surface: "#10151E",
      surfaceAlt: "#111923",
      surfaceRaised: "#141B26",
      border: "#202936",
      borderAlt: "#293242",
      textPrimary: "#F8FAFC",
      textSecondary: "#788397",
      textMuted: "#5B667A",
      brand: "#8B5CF6",
      brandActive: "#A78BFA",
      brandSoft: "#1A1430",
      success: "#22C55E",
      successSoft: "#0F2418",
      warning: "#F59E0B",
      warningSoft: "#241C10",
      danger: "#EF4444",
      dangerSoft: "#241216",
      add: "#86EFAC",
      del: "#FCA5A5",
    },
  },
  {
    id: "forge-light",
    label: "Forge 日光",
    mode: "light",
    colors: {
      background: "#F4F6FA",
      surface: "#FFFFFF",
      surfaceAlt: "#EEF1F6",
      surfaceRaised: "#FFFFFF",
      border: "#D8DEE8",
      borderAlt: "#C5CEDB",
      textPrimary: "#0F172A",
      textSecondary: "#64748B",
      textMuted: "#94A3B8",
      brand: "#7C3AED",
      brandActive: "#6D28D9",
      brandSoft: "#F3E8FF",
      success: "#16A34A",
      successSoft: "#DCFCE7",
      warning: "#D97706",
      warningSoft: "#FEF3C7",
      danger: "#DC2626",
      dangerSoft: "#FEE2E2",
      add: "#15803D",
      del: "#B91C1C",
    },
  },
  {
    id: "midnight",
    label: "午夜蓝",
    mode: "dark",
    colors: {
      background: "#070B16",
      surface: "#0E1526",
      surfaceAlt: "#121C30",
      surfaceRaised: "#172238",
      border: "#243049",
      borderAlt: "#2E3C58",
      textPrimary: "#E8EEF9",
      textSecondary: "#8B9BB8",
      textMuted: "#5F6F8C",
      brand: "#3B82F6",
      brandActive: "#60A5FA",
      brandSoft: "#10233F",
      success: "#34D399",
      successSoft: "#0C271C",
      warning: "#FBBF24",
      warningSoft: "#2A210C",
      danger: "#F87171",
      dangerSoft: "#2A1214",
      add: "#6EE7B7",
      del: "#FCA5A5",
    },
  },
  {
    id: "ocean",
    label: "深海青",
    mode: "dark",
    colors: {
      background: "#061216",
      surface: "#0C1C22",
      surfaceAlt: "#10242B",
      surfaceRaised: "#143039",
      border: "#1E3A44",
      borderAlt: "#2A4B57",
      textPrimary: "#E7F6F8",
      textSecondary: "#7FA4AE",
      textMuted: "#567880",
      brand: "#14B8A6",
      brandActive: "#2DD4BF",
      brandSoft: "#0C2F2C",
      success: "#22C55E",
      successSoft: "#0F2418",
      warning: "#F59E0B",
      warningSoft: "#241C10",
      danger: "#FB7185",
      dangerSoft: "#2A1218",
      add: "#86EFAC",
      del: "#FDA4AF",
    },
  },
  {
    id: "forest",
    label: "松林绿",
    mode: "dark",
    colors: {
      background: "#0A100C",
      surface: "#121A14",
      surfaceAlt: "#162019",
      surfaceRaised: "#1B281F",
      border: "#27352B",
      borderAlt: "#334538",
      textPrimary: "#ECF5EE",
      textSecondary: "#8FA696",
      textMuted: "#617568",
      brand: "#22C55E",
      brandActive: "#4ADE80",
      brandSoft: "#12301C",
      success: "#86EFAC",
      successSoft: "#0F2418",
      warning: "#EAB308",
      warningSoft: "#2A240C",
      danger: "#EF4444",
      dangerSoft: "#241216",
      add: "#BBF7D0",
      del: "#FCA5A5",
    },
  },
  {
    id: "sunset",
    label: "暮色橙",
    mode: "dark",
    colors: {
      background: "#120C0A",
      surface: "#1C1410",
      surfaceAlt: "#241811",
      surfaceRaised: "#2C1D14",
      border: "#3A2A20",
      borderAlt: "#4A372A",
      textPrimary: "#FFF7ED",
      textSecondary: "#B8A090",
      textMuted: "#857264",
      brand: "#F97316",
      brandActive: "#FB923C",
      brandSoft: "#3A1F0E",
      success: "#22C55E",
      successSoft: "#0F2418",
      warning: "#FBBF24",
      warningSoft: "#2A210C",
      danger: "#EF4444",
      dangerSoft: "#241216",
      add: "#86EFAC",
      del: "#FCA5A5",
    },
  },
  {
    id: "slate",
    label: "石墨灰",
    mode: "light",
    colors: {
      background: "#E8EAEE",
      surface: "#F7F8FA",
      surfaceAlt: "#DEE2E8",
      surfaceRaised: "#FFFFFF",
      border: "#C9CFD8",
      borderAlt: "#B0B8C4",
      textPrimary: "#111827",
      textSecondary: "#4B5563",
      textMuted: "#9CA3AF",
      brand: "#334155",
      brandActive: "#1E293B",
      brandSoft: "#E2E8F0",
      success: "#15803D",
      successSoft: "#DCFCE7",
      warning: "#B45309",
      warningSoft: "#FEF3C7",
      danger: "#B91C1C",
      dangerSoft: "#FEE2E2",
      add: "#166534",
      del: "#991B1B",
    },
  },
  {
    id: "rose",
    label: "玫瑰粉",
    mode: "light",
    colors: {
      background: "#FBF5F7",
      surface: "#FFFFFF",
      surfaceAlt: "#F5E8ED",
      surfaceRaised: "#FFFFFF",
      border: "#E8D0D8",
      borderAlt: "#D9B8C4",
      textPrimary: "#1F1218",
      textSecondary: "#7A5566",
      textMuted: "#A88896",
      brand: "#E11D48",
      brandActive: "#BE123C",
      brandSoft: "#FFE4EC",
      success: "#15803D",
      successSoft: "#DCFCE7",
      warning: "#C2410C",
      warningSoft: "#FFEDD5",
      danger: "#B91C1C",
      dangerSoft: "#FEE2E2",
      add: "#166534",
      del: "#9F1239",
    },
  },
  {
    id: "sand",
    label: "沙丘米",
    mode: "light",
    colors: {
      background: "#F3EEE6",
      surface: "#FAF7F2",
      surfaceAlt: "#E9E2D6",
      surfaceRaised: "#FFFFFF",
      border: "#D6CBB8",
      borderAlt: "#C4B59C",
      textPrimary: "#1C1915",
      textSecondary: "#6B5E4E",
      textMuted: "#9A8B76",
      brand: "#A16207",
      brandActive: "#854D0E",
      brandSoft: "#FEF3C7",
      success: "#166534",
      successSoft: "#DCFCE7",
      warning: "#B45309",
      warningSoft: "#FEF3C7",
      danger: "#B91C1C",
      dangerSoft: "#FEE2E2",
      add: "#15803D",
      del: "#991B1B",
    },
  },
  {
    id: "aurora",
    label: "极光紫",
    mode: "dark",
    colors: {
      background: "#0B0814",
      surface: "#14101F",
      surfaceAlt: "#1A1528",
      surfaceRaised: "#221C32",
      border: "#322A45",
      borderAlt: "#403655",
      textPrimary: "#F3EEFF",
      textSecondary: "#A89BC4",
      textMuted: "#746890",
      brand: "#C084FC",
      brandActive: "#E9D5FF",
      brandSoft: "#2A1848",
      success: "#34D399",
      successSoft: "#0C271C",
      warning: "#FBBF24",
      warningSoft: "#2A210C",
      danger: "#FB7185",
      dangerSoft: "#2A1218",
      add: "#6EE7B7",
      del: "#FDA4AF",
    },
  },
];

export const THEME_BY_ID: Record<ThemeId, ThemeDefinition> = Object.fromEntries(
  THEME_DEFINITIONS.map((theme) => [theme.id, theme]),
) as Record<ThemeId, ThemeDefinition>;

export const DEFAULT_THEME_ID: ThemeId = "forge-dark";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && value in THEME_BY_ID;
}
