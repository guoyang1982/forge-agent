const PATTERNS: Array<{ pattern: RegExp; format: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /^0 (\d{1,2}) \* \* 1-5$/,
    format: (m) => `每个工作日 ${padHour(m[1])}`,
  },
  {
    pattern: /^0 (\d{1,2}) \* \* (\d)$/,
    format: (m) => `每周${weekdayName(m[2])} ${padHour(m[1])}`,
  },
  {
    pattern: /^0 \*\/(\d+) \* \* \*$/,
    format: (m) => `每 ${m[1]} 小时`,
  },
  {
    pattern: /^0 (\d{1,2}) \* \* \*$/,
    format: (m) => `每天 ${padHour(m[1])}`,
  },
];

function padHour(h: string): string {
  return `${h.padStart(2, "0")}:00`;
}

function weekdayName(dow: string): string {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  return names[Number(dow)] ?? dow;
}

export function formatCronHuman(expr: string): string {
  const trimmed = expr.trim();
  for (const { pattern, format } of PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return format(match);
  }
  return trimmed;
}
