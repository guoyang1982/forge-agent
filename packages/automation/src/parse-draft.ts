import type {
  AutomationDraft,
  ParseAutomationDraftResult,
} from "@forge/protocol";
import { validateCronExpr } from "./cron.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";

const META_CREATE_RE =
  /请帮我整理名称|cron\s*表达式和任务\s*prompt|整理名称、cron/i;
const SCHEDULE_INTENT_RE =
  /定时|cron|schedule|每\s*\d+\s*分钟|每分钟|每小时|每\s*\d+\s*小时|每天|每日|每周|工作日|每月|每週|每小時|every\s+(\d+\s+)?minutes?|every\s+(hour|\d+\s+hours?|day|week)|hourly|daily|weekly|weekdays?/i;
const ILINK_NOTIFY_INTENT_RE =
  /微信|iLink|ilink|发给我|發給我|通知我|推送给我|推送給我|send\s+(it\s+)?to\s+me/i;

const EVERY_N_MINUTES_RE = /每\s*(\d+)\s*分钟|every\s+(\d+)\s+minutes?/i;

const BOILERPLATE_RE =
  /^(?:我想)?(?:要)?(?:创建|做一个|建)(?:一个)?定时(?:任务|自动化)[，,：:\s]*/i;

export function buildAutomationDraftParsePrompt(
  message: string,
  cwd?: string,
): string {
  const workspace = cwd ? `Workspace: ${cwd}\n` : "";
  return `${workspace}Convert the user's automation request into JSON only (no markdown).

User request:
${message.trim()}

Output schema:
{
  "draft": {
    "name": "short title under 40 chars",
    "description": "optional one-line summary",
    "cron": "5-field cron expression",
    "timezone": "IANA timezone, default Asia/Shanghai",
    "prompt": "what the agent should do on each run",
    "notify": {"enabled": true, "channelKind": "ilink"} // only when user asks to send/push results to WeChat/iLink
  },
  "questions": []
}

Rules:
- Use standard 5-field cron (minute hour day month weekday).
- "every N minutes" / 每N分钟 → */N * * * * (e.g. every 3 minutes → */3 * * * *).
- "every hour" / 每小时 → 0 * * * *.
- If schedule is unclear, omit draft and ask in questions (Chinese).
- name must be a concise task title, not the full user message.
- prompt is the executable task instructions only (omit schedule frequency text).
- If the user asks to send/push/notify results to WeChat or "me", set notify.enabled true and channelKind "ilink".
- Default timezone Asia/Shanghai unless user specifies another.`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;

  const start = candidate.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return undefined;
}

function normalizeDraft(
  raw: Record<string, unknown>,
  cwd?: string,
): AutomationDraft | undefined {
  if (!isNonEmptyString(raw.name) || !isNonEmptyString(raw.prompt)) {
    return undefined;
  }
  const draft: AutomationDraft = {
    name: raw.name.trim().slice(0, 80),
    prompt: raw.prompt.trim(),
    cwd,
    enabled: true,
  };
  if (isNonEmptyString(raw.description)) {
    draft.description = raw.description.trim();
  }
  if (isNonEmptyString(raw.cron)) {
    const cron = raw.cron.trim();
    if (!validateCronExpr(cron)) return undefined;
    draft.cron = cron;
  }
  if (isNonEmptyString(raw.timezone)) {
    draft.timezone = raw.timezone.trim();
  } else if (draft.cron) {
    draft.timezone = DEFAULT_TIMEZONE;
  }
  const notifyRaw = raw.notify;
  if (notifyRaw && typeof notifyRaw === "object") {
    const notify = notifyRaw as Record<string, unknown>;
    if (notify.enabled === true || notify.channelKind === "ilink") {
      draft.notify = { enabled: true, channelKind: "ilink" };
    }
  }
  return draft;
}

export function parseAutomationDraftFromJson(
  text: string,
  cwd?: string,
): ParseAutomationDraftResult | undefined {
  const rawJson = extractJsonObject(text);
  if (!rawJson) return undefined;
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter(isNonEmptyString)
      : [];
    if (questions.length) return { questions };

    const draftRaw = parsed.draft;
    if (!draftRaw || typeof draftRaw !== "object") return undefined;
    const draft = normalizeDraft(draftRaw as Record<string, unknown>, cwd);
    if (!draft) return undefined;
    if (!draft.cron) {
      return { questions: ["请说明运行频率（例如：每小时、每天上午 9 点、每周一）。"] };
    }
    return { draft };
  } catch {
    return undefined;
  }
}

function stripBoilerplate(message: string): string {
  return message
    .trim()
    .replace(BOILERPLATE_RE, "")
    .replace(/^每\s*\d+\s*分钟[，,：:\s]*/iu, "")
    .replace(/^每\s*分钟[，,：:\s]*/iu, "")
    .replace(/^每\s*\d+\s*小时[，,：:\s]*/iu, "")
    .replace(/^每小时[，,：:\s]*/iu, "")
    .replace(/^(?:每个)?工作日(?:早上|上午)?\s*\d{0,2}:?\d{0,2}[点时]?\s*[，,：:\s]*/iu, "")
    .replace(/^(?:每天|每日)(?:早上|上午)?\s*\d{0,2}:?\d{0,2}[点时]?\s*[，,：:\s]*/iu, "")
    .trim();
}

function wantsSchedule(message: string): boolean {
  return SCHEDULE_INTENT_RE.test(message);
}

function isMetaCreateMessage(message: string): boolean {
  return META_CREATE_RE.test(message);
}

function parseHour(message: string): number | undefined {
  if (EVERY_N_MINUTES_RE.test(message) || /每分钟|every\s+minute/i.test(message)) {
    return undefined;
  }
  const atTime = message.match(
    /(?:早上|上午|凌晨)?\s*(\d{1,2})\s*[:：点时](?:\s*(\d{2}))?\s*(?:分)?|(?:下午|晚上|傍晚)\s*(\d{1,2})\s*[:：点时](?:\s*(\d{2}))?\s*(?:分)?|at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  );
  if (!atTime) return undefined;

  if (atTime[3] != null) {
    const h = Number(atTime[3]);
    return h >= 1 && h <= 11 ? h + 12 : h;
  }
  if (atTime[5] != null) {
    let hour = Number(atTime[5]);
    const ampm = atTime[7]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return hour;
  }
  const hour = Number(atTime[1]);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return undefined;
  if (/下午|晚上|傍晚/.test(message) && hour >= 1 && hour <= 11) return hour + 12;
  return hour;
}

function parseMinute(message: string): number {
  if (EVERY_N_MINUTES_RE.test(message) || /每分钟|every\s+minute/i.test(message)) {
    return 0;
  }
  const m = message.match(/(?<!每\s*\d{1,2})(\d{1,2})\s*分(?!钟)/);
  if (m) {
    const minute = Number(m[1]);
    if (!Number.isNaN(minute) && minute >= 0 && minute <= 59) return minute;
  }
  const atTime = message.match(/[:：](\d{2})/);
  if (atTime) {
    const minute = Number(atTime[1]);
    if (!Number.isNaN(minute) && minute >= 0 && minute <= 59) return minute;
  }
  return 0;
}

function inferCron(message: string): string | undefined {
  const everyNMinutes = message.match(EVERY_N_MINUTES_RE);
  if (everyNMinutes) {
    const n = Number(everyNMinutes[1] ?? everyNMinutes[2]);
    if (n >= 1 && n <= 59) return `*/${n} * * * *`;
  }
  if (/每分钟|every\s+minute/i.test(message)) {
    return "* * * * *";
  }

  const everyNHours = message.match(/每\s*(\d+)\s*小时|every\s+(\d+)\s+hours?/i);
  if (everyNHours) {
    const n = Number(everyNHours[1] ?? everyNHours[2]);
    if (n >= 1 && n <= 23) return `0 */${n} * * *`;
  }

  if (/每小时|every\s+hour|hourly/i.test(message)) {
    return "0 * * * *";
  }

  const hour = parseHour(message);
  const minute = parseMinute(message);

  if (/工作日|weekdays?/i.test(message)) {
    const h = hour ?? 9;
    return `${minute} ${h} * * 1-5`;
  }
  if (/每周一|every\s+monday/i.test(message)) {
    const h = hour ?? 9;
    return `${minute} ${h} * * 1`;
  }
  if (/每周|weekly/i.test(message)) {
    const h = hour ?? 9;
    return `${minute} ${h} * * 1`;
  }
  if (/每月|monthly/i.test(message)) {
    const h = hour ?? 9;
    return `${minute} ${h} 1 * *`;
  }
  if (/每天|每日|each\s+day|daily/i.test(message)) {
    const h = hour ?? 9;
    return `${minute} ${h} * * *`;
  }

  if (hour != null) {
    return `${minute} ${hour} * * *`;
  }

  return undefined;
}

function inferTitle(taskText: string): string {
  const cleaned = taskText
    .replace(/[。.!！?？]+$/u, "")
    .replace(/^(请|帮我|帮忙)/u, "")
    .trim();
  if (!cleaned) return "定时任务";
  return cleaned.length > 40 ? `${cleaned.slice(0, 37)}…` : cleaned;
}

function wantsIlinkNotification(message: string): boolean {
  return ILINK_NOTIFY_INTENT_RE.test(message);
}

export function parseAutomationDraftHeuristic(
  message: string,
  cwd?: string,
): ParseAutomationDraftResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { questions: ["请描述你想创建的自动化任务。"] };
  }

  if (isMetaCreateMessage(trimmed)) {
    return {
      questions: [
        "请直接描述任务内容和运行频率，例如：「每小时收集行业 AI 信息并写入 notes/ai-digest.md」。",
      ],
    };
  }

  const taskText = stripBoilerplate(trimmed);
  const cron = inferCron(trimmed);
  const needsSchedule = wantsSchedule(trimmed);

  if (!cron) {
    if (needsSchedule) {
      return {
        questions: [
          "未能从描述中解析出 cron。请补充运行频率，例如：每小时、每天上午 9 点、每周一早上。",
        ],
      };
    }
    return {
      questions: [
        "请说明这是定时任务还是手动任务；若是定时任务，请写明频率（例如：每小时、每天 9:00）。",
      ],
    };
  }

  const prompt = taskText || trimmed;
  return {
    draft: {
      name: inferTitle(prompt),
      prompt,
      cron,
      timezone: DEFAULT_TIMEZONE,
      cwd,
      enabled: true,
      notify: wantsIlinkNotification(trimmed)
        ? { enabled: true, channelKind: "ilink" }
        : undefined,
    },
  };
}

/** Sync fallback parser (heuristic). Daemon uses LLM + heuristic. */
export function parseAutomationDraft(
  message: string,
  cwd?: string,
): ParseAutomationDraftResult {
  return parseAutomationDraftHeuristic(message, cwd);
}
