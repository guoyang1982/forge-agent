import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import { newCompanyId } from "./ids.js";
import type { Company } from "./types.js";

export class CompanyService {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  create(input: { name: string }): Company {
    const company: Company = {
      id: newCompanyId("company"),
      name: input.name,
      version: 1,
    };
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO company_companies
          (id, name, version, created_at, updated_at)
        VALUES
          (@id, @name, @version, @createdAt, @updatedAt)`,
      )
      .run({
        ...company,
        createdAt: now,
        updatedAt: now,
      });
    return company;
  }

  get(id: string): Company {
    const company = this.db
      .prepare("SELECT id, name, version FROM company_companies WHERE id = ?")
      .get(id) as Company | undefined;
    if (!company) {
      throw new Error("company not found");
    }
    return company;
  }
}
