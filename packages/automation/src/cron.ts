import { CronExpressionParser } from "cron-parser";

export function validateCronExpr(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

export function computeNextRun(
  expr: string,
  tz: string,
  from = new Date(),
): string {
  const it = CronExpressionParser.parse(expr, { tz, currentDate: from });
  const next = it.next().toISOString();
  if (!next) throw new Error(`no next run for cron: ${expr}`);
  return next;
}

export function shouldCatchUpMissedRun(
  nextRunAt: string | undefined,
  lastRunAt: string | undefined,
  now = new Date(),
): boolean {
  if (!nextRunAt) return false;
  if (now <= new Date(nextRunAt)) return false;
  if (!lastRunAt) return true;
  return new Date(lastRunAt) < new Date(nextRunAt);
}
