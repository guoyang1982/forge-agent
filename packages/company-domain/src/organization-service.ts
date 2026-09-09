import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import { newCompanyId } from "./ids.js";

export type Department = {
  id: string;
  companyId: string;
  name: string;
  parentId: string | null;
  version: number;
};

export type PositionTemplate = {
  id: string;
  companyId: string;
  name: string;
  charter: string;
  version: number;
};

export type Position = {
  id: string;
  companyId: string;
  departmentId: string;
  templateId: string;
  title: string;
  version: number;
};

export type Employee = {
  id: string;
  companyId: string;
  displayName: string;
  version: number;
};

export type Employment = {
  id: string;
  companyId: string;
  employeeId: string;
  positionId: string;
  status: "active";
  autonomyLevel: 0 | 1 | 2 | 3 | 4;
  version: number;
};

export type OrganizationTree = {
  departments: Department[];
  positions: Position[];
  employees: Array<
    Employee & {
      positionId: string;
      status: "active" | "inactive" | "ended";
      autonomyLevel: number;
      managerEmployeeId: string | null;
    }
  >;
};

export class OrganizationService {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  createDepartment(input: {
    companyId: string;
    name: string;
    parentId?: string;
  }): Department {
    const department: Department = {
      id: newCompanyId("dept"),
      companyId: input.companyId,
      name: input.name,
      parentId: input.parentId ?? null,
      version: 1,
    };
    this.insertWithTimestamps(
      `INSERT INTO company_departments
        (id, company_id, name, parent_id, version, created_at, updated_at)
      VALUES
        (@id, @companyId, @name, @parentId, @version, @createdAt, @updatedAt)`,
      department,
    );
    return department;
  }

  createPositionTemplate(input: {
    companyId: string;
    name: string;
    charter: string;
  }): PositionTemplate {
    const template: PositionTemplate = {
      id: newCompanyId("pos_tmpl"),
      companyId: input.companyId,
      name: input.name,
      charter: input.charter,
      version: 1,
    };
    this.insertWithTimestamps(
      `INSERT INTO company_position_templates
        (id, company_id, name, charter, version, created_at, updated_at)
      VALUES
        (@id, @companyId, @name, @charter, @version, @createdAt, @updatedAt)`,
      template,
    );
    return template;
  }

  createPosition(input: {
    companyId: string;
    departmentId: string;
    templateId: string;
    title: string;
  }): Position {
    const position: Position = {
      id: newCompanyId("pos"),
      companyId: input.companyId,
      departmentId: input.departmentId,
      templateId: input.templateId,
      title: input.title,
      version: 1,
    };
    this.insertWithTimestamps(
      `INSERT INTO company_positions
        (id, company_id, department_id, template_id, title, version, created_at, updated_at)
      VALUES
        (@id, @companyId, @departmentId, @templateId, @title, @version, @createdAt, @updatedAt)`,
      position,
    );
    return position;
  }

  hire(input: {
    companyId: string;
    displayName: string;
    positionId: string;
    managerEmployeeId?: string;
    autonomyLevel: 0 | 1 | 2 | 3 | 4;
  }): Employee & { employment: Employment } {
    const employee: Employee = {
      id: newCompanyId("emp"),
      companyId: input.companyId,
      displayName: input.displayName,
      version: 1,
    };
    const employment: Employment = {
      id: newCompanyId("employment"),
      companyId: input.companyId,
      employeeId: employee.id,
      positionId: input.positionId,
      status: "active",
      autonomyLevel: input.autonomyLevel,
      version: 1,
    };
    const now = this.clock.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO company_employees
            (id, company_id, display_name, version, created_at, updated_at)
          VALUES
            (@id, @companyId, @displayName, @version, @createdAt, @updatedAt)`,
        )
        .run({ ...employee, createdAt: now, updatedAt: now });
      this.db
        .prepare(
          `INSERT INTO company_employments
            (id, company_id, employee_id, position_id, status, autonomy_level, version, created_at, updated_at)
          VALUES
            (@id, @companyId, @employeeId, @positionId, @status, @autonomyLevel, @version, @createdAt, @updatedAt)`,
        )
        .run({ ...employment, createdAt: now, updatedAt: now });

      if (input.managerEmployeeId) {
        this.db
          .prepare(
            `INSERT INTO company_reporting_lines
              (id, company_id, employee_id, manager_employee_id, version, created_at, updated_at)
            VALUES
              (@id, @companyId, @employeeId, @managerEmployeeId, @version, @createdAt, @updatedAt)`,
          )
          .run({
            id: newCompanyId("reporting"),
            companyId: input.companyId,
            employeeId: employee.id,
            managerEmployeeId: input.managerEmployeeId,
            version: 1,
            createdAt: now,
            updatedAt: now,
          });
      }
    })();

    return { ...employee, employment };
  }

  tree(companyId: string): OrganizationTree {
    const departments = this.db
      .prepare(
        `SELECT id, company_id AS companyId, name, parent_id AS parentId, version
        FROM company_departments
        WHERE company_id = ?
        ORDER BY created_at, id`,
      )
      .all(companyId) as Department[];
    const positions = this.db
      .prepare(
        `SELECT id, company_id AS companyId, department_id AS departmentId,
          template_id AS templateId, title, version
        FROM company_positions
        WHERE company_id = ?
        ORDER BY created_at, id`,
      )
      .all(companyId) as Position[];
    const employees = this.db
      .prepare(
        `SELECT employee.id, employee.company_id AS companyId,
          employee.display_name AS displayName, employee.version,
          employment.position_id AS positionId, employment.status,
          employment.autonomy_level AS autonomyLevel,
          reporting.manager_employee_id AS managerEmployeeId
        FROM company_employees AS employee
        JOIN company_employments AS employment
          ON employment.company_id = employee.company_id
          AND employment.employee_id = employee.id
        LEFT JOIN company_reporting_lines AS reporting
          ON reporting.company_id = employee.company_id
          AND reporting.employee_id = employee.id
        WHERE employee.company_id = ?
        ORDER BY employee.created_at, employee.id`,
      )
      .all(companyId) as OrganizationTree["employees"];

    return { departments, positions, employees };
  }

  private insertWithTimestamps(
    sql: string,
    values: Record<string, unknown>,
  ): void {
    const now = this.clock.now();
    this.db
      .prepare(sql)
      .run({ ...values, createdAt: now, updatedAt: now });
  }
}
