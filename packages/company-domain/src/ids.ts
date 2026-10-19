import { randomUUID } from "node:crypto";

export function newCompanyId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
