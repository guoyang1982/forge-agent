import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import {
  listRecentEmployeeMemories,
  type EmployeeMemory,
} from "./employee-memory.js";
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

export type EmployeeProfile = {
  talentTemplateId: string;
  talentRole: string;
  skills: string[];
  tools: string[];
  modelProfileId?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
  systemPrompt?: string;
  methodology?: string[];
  qualityGates?: string[];
  knowledgeRefs?: string[];
  connectors?: string[];
};

export type EmployeeWorkspaceGrant = {
  workspaceId: string;
  mode: "read" | "write";
  isDefault: boolean;
  env?: "dev" | "staging" | "prod";
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
      profile?: EmployeeProfile;
      workspaces: EmployeeWorkspaceGrant[];
      memories: EmployeeMemory[];
    }
  >;
};

export const MARKET_RESEARCHER_TITLE = "市场调查员";
export const MARKET_RESEARCHER_CHARTER =
  "负责市场、竞品与可行性调研，输出可验证结论。无实现权、无发布权。";

export const OPERATING_DEPARTMENTS = [
  { name: "产品部", match: /产品|市场|研究|设计/ },
  { name: "工程部", match: /工程|研发|开发|技术/ },
  { name: "质量部", match: /质量|测试|审查/ },
  { name: "运营部", match: /运营|增长|客服|财务|支持/ },
] as const;

/** Standard seats: position title → default talent pack used at hire / research routing. */
export const OPERATING_SEATS = [
  {
    title: "研发负责人",
    department: "工程部",
    charter: "负责技术方向与研发编排。有范围建议权，无对外发布权。",
    talentTemplateId: "engineering-software-architect",
  },
  {
    title: "执行工程师",
    department: "工程部",
    charter: "负责实现与改动。按已接受规格执行，无发布权。",
    talentTemplateId: "engineering-senior-developer",
  },
  {
    title: "质量负责人",
    department: "质量部",
    charter: "负责审查与验收建议。无实现权、无发布权。",
    talentTemplateId: "engineering-code-reviewer",
  },
  {
    title: "产品助理",
    department: "产品部",
    charter: "负责需求澄清与规格起草。无实现权、无发布权。",
    talentTemplateId: "product-behavioral-nudge-engine",
  },
  {
    title: MARKET_RESEARCHER_TITLE,
    department: "产品部",
    charter: MARKET_RESEARCHER_CHARTER,
    talentTemplateId: "product-trend-researcher",
  },
  {
    title: "设计师",
    department: "产品部",
    charter: "负责交互与界面方案。无实现权、无发布权。",
    talentTemplateId: "design-ui-designer",
  },
  {
    title: "增长运营",
    department: "运营部",
    charter: "负责获客、渠道与增长实验。无发布权、无付款权。",
    talentTemplateId: "marketing-growth-hacker",
  },
  {
    title: "客户支持",
    department: "运营部",
    charter: "负责用户问题与反馈归集。无实现权、无发布权。",
    talentTemplateId: "support-support-responder",
  },
  {
    title: "财务合规",
    department: "运营部",
    charter: "负责预算、合规与风险提示。无付款权、无发布权。",
    talentTemplateId: "support-legal-compliance-checker",
  },
] as const;

/** Research workflow step → preferred operating seat title(s), first match wins. */
export const RESEARCH_STEP_SEAT_TITLES: Record<string, readonly string[]> = {
  "user-research": [MARKET_RESEARCHER_TITLE],
  "market-research": ["增长运营"],
  "code-data-research": ["执行工程师", "研发负责人"],
  "risk-research": ["财务合规"],
  synthesis: [MARKET_RESEARCHER_TITLE, "产品助理"],
  "research-gate": [MARKET_RESEARCHER_TITLE, "产品助理"],
};

export function talentTemplateIdForSeatTitle(title: string | null | undefined): string | undefined {
  const needle = String(title || "").trim();
  if (!needle) return undefined;
  return OPERATING_SEATS.find((seat) => seat.title === needle)?.talentTemplateId;
}

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

  ensureMarketResearcherSeat(companyId: string): Position | null {
    return this.db.transaction(() => {
      const existing = this.findPositionByTitle(companyId, MARKET_RESEARCHER_TITLE);
      if (existing) return existing;
      const departments = this.listDepartments(companyId);
      if (!departments.length) return null;
      const department =
        departments.find((entry) => /产品|市场|研究/.test(entry.name))
        ?? departments[0];
      return this.createSeat(companyId, department.id, {
        title: MARKET_RESEARCHER_TITLE,
        charter: MARKET_RESEARCHER_CHARTER,
      });
    })();
  }

  ensureOperatingSeats(companyId: string): Position[] {
    return this.db.transaction(() => {
      const departments = this.listDepartments(companyId);
      const positions: Position[] = [];
      for (const seat of OPERATING_SEATS) {
        const spec = OPERATING_DEPARTMENTS.find((entry) => entry.name === seat.department)
          ?? OPERATING_DEPARTMENTS[0];
        const department = this.ensureDepartment(companyId, departments, spec.name, spec.match);
        const existing = this.findPositionByTitle(companyId, seat.title);
        if (existing) {
          positions.push(
            existing.departmentId === department.id
              ? existing
              : this.movePosition(existing, department.id),
          );
          continue;
        }
        positions.push(this.createSeat(companyId, department.id, seat));
      }
      return positions;
    })();
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
    const occupied = this.db
      .prepare(
        `SELECT employee_id AS employeeId
        FROM company_employments
        WHERE company_id = ? AND position_id = ? AND status = 'active'`,
      )
      .get(input.companyId, input.positionId) as { employeeId: string } | undefined;
    if (occupied) {
      throw new Error("position already occupied");
    }

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

  bindCapability(input: {
    companyId: string;
    employeeId: string;
    talentTemplateId: string;
    talentRole: string;
    skills: string[];
    tools: string[];
    modelProfileId?: string | null;
    systemPrompt?: string;
    methodology?: string[];
    qualityGates?: string[];
    agentProfileId?: string | null;
    agentProfileVersionId?: string | null;
    knowledgeRefs?: string[];
    connectors?: string[];
    workspaces?: EmployeeWorkspaceGrant[];
  }): { profile: EmployeeProfile; workspaces: EmployeeWorkspaceGrant[] } {
    const employee = this.db
      .prepare(
        `SELECT id FROM company_employees WHERE company_id = ? AND id = ?`,
      )
      .get(input.companyId, input.employeeId) as { id: string } | undefined;
    if (!employee) {
      throw new Error("employee not found");
    }
    const workspaces = normalizeWorkspaceGrants(input.workspaces ?? []);
    const modelProfileId = input.modelProfileId?.trim() || undefined;
    const agentProfileId = input.agentProfileId?.trim() || undefined;
    const agentProfileVersionId = input.agentProfileVersionId?.trim() || undefined;
    const systemPrompt = input.systemPrompt?.trim() || undefined;
    const methodology = [...(input.methodology || [])];
    const qualityGates = [...(input.qualityGates || [])];
    const knowledgeRefs = [...(input.knowledgeRefs || [])];
    const connectors = [...(input.connectors || [])];
    const profile: EmployeeProfile = {
      talentTemplateId: input.talentTemplateId,
      talentRole: input.talentRole,
      skills: [...input.skills],
      tools: [...input.tools],
      ...(modelProfileId ? { modelProfileId } : {}),
      ...(agentProfileId ? { agentProfileId } : {}),
      ...(agentProfileVersionId ? { agentProfileVersionId } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(methodology.length ? { methodology } : {}),
      ...(qualityGates.length ? { qualityGates } : {}),
      ...(knowledgeRefs.length ? { knowledgeRefs } : {}),
      ...(connectors.length ? { connectors } : {}),
    };
    const now = this.clock.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO company_employee_profiles
            (id, company_id, employee_id, talent_template_id, talent_role,
              skills_json, tools_json, model_profile_id, agent_profile_id,
              agent_profile_version_id, system_prompt, methodology_json,
              quality_gates_json, knowledge_refs_json, connectors_json,
              version, created_at, updated_at)
          VALUES
            (@id, @companyId, @employeeId, @talentTemplateId, @talentRole,
              @skillsJson, @toolsJson, @modelProfileId, @agentProfileId,
              @agentProfileVersionId, @systemPrompt, @methodologyJson,
              @qualityGatesJson, @knowledgeRefsJson, @connectorsJson,
              1, @now, @now)
          ON CONFLICT (company_id, employee_id) DO UPDATE SET
            talent_template_id = excluded.talent_template_id,
            talent_role = excluded.talent_role,
            skills_json = excluded.skills_json,
            tools_json = excluded.tools_json,
            model_profile_id = excluded.model_profile_id,
            agent_profile_id = excluded.agent_profile_id,
            agent_profile_version_id = excluded.agent_profile_version_id,
            system_prompt = excluded.system_prompt,
            methodology_json = excluded.methodology_json,
            quality_gates_json = excluded.quality_gates_json,
            knowledge_refs_json = excluded.knowledge_refs_json,
            connectors_json = excluded.connectors_json,
            version = company_employee_profiles.version + 1,
            updated_at = excluded.updated_at`,
        )
        .run({
          id: newCompanyId("emp_profile"),
          companyId: input.companyId,
          employeeId: input.employeeId,
          talentTemplateId: profile.talentTemplateId,
          talentRole: profile.talentRole,
          skillsJson: JSON.stringify(profile.skills),
          toolsJson: JSON.stringify(profile.tools),
          modelProfileId: modelProfileId ?? "",
          agentProfileId: agentProfileId ?? "",
          agentProfileVersionId: agentProfileVersionId ?? "",
          systemPrompt: systemPrompt ?? "",
          methodologyJson: JSON.stringify(methodology),
          qualityGatesJson: JSON.stringify(qualityGates),
          knowledgeRefsJson: JSON.stringify(knowledgeRefs),
          connectorsJson: JSON.stringify(connectors),
          now,
        });
      this.replaceWorkspaceGrants(input.companyId, input.employeeId, workspaces, now);
    })();
    return { profile, workspaces };
  }

  grantWorkspaces(input: {
    companyId: string;
    employeeId: string;
    workspaces: EmployeeWorkspaceGrant[];
  }): EmployeeWorkspaceGrant[] {
    const employee = this.db
      .prepare(
        `SELECT id FROM company_employees WHERE company_id = ? AND id = ?`,
      )
      .get(input.companyId, input.employeeId) as { id: string } | undefined;
    if (!employee) {
      throw new Error("employee not found");
    }
    const workspaces = normalizeWorkspaceGrants(input.workspaces);
    this.replaceWorkspaceGrants(
      input.companyId,
      input.employeeId,
      workspaces,
      this.clock.now(),
    );
    return workspaces;
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
    const profiles = this.db
      .prepare(
        `SELECT employee_id AS employeeId, talent_template_id AS talentTemplateId,
          talent_role AS talentRole, skills_json AS skillsJson, tools_json AS toolsJson,
          model_profile_id AS modelProfileId,
          agent_profile_id AS agentProfileId,
          agent_profile_version_id AS agentProfileVersionId,
          system_prompt AS systemPrompt,
          methodology_json AS methodologyJson,
          quality_gates_json AS qualityGatesJson,
          knowledge_refs_json AS knowledgeRefsJson,
          connectors_json AS connectorsJson
        FROM company_employee_profiles
        WHERE company_id = ?`,
      )
      .all(companyId) as Array<{
      employeeId: string;
      talentTemplateId: string;
      talentRole: string;
      skillsJson: string;
      toolsJson: string;
      modelProfileId: string;
      agentProfileId: string | null;
      agentProfileVersionId: string | null;
      systemPrompt: string | null;
      methodologyJson: string | null;
      qualityGatesJson: string | null;
      knowledgeRefsJson: string | null;
      connectorsJson: string | null;
    }>;
    const grants = this.db
      .prepare(
        `SELECT employee_id AS employeeId, workspace_id AS workspaceId, mode,
          is_default AS isDefault, env
        FROM company_employee_workspaces
        WHERE company_id = ?
        ORDER BY created_at, id`,
      )
      .all(companyId) as Array<{
      employeeId: string;
      workspaceId: string;
      mode: "read" | "write";
      isDefault: number;
      env: "dev" | "staging" | "prod" | null;
    }>;
    const profileByEmployee = new Map(
      profiles.map((row) => [
        row.employeeId,
        {
          talentTemplateId: row.talentTemplateId,
          talentRole: row.talentRole,
          skills: parseStringArray(row.skillsJson),
          tools: parseStringArray(row.toolsJson),
          ...(row.modelProfileId?.trim()
            ? { modelProfileId: row.modelProfileId.trim() }
            : {}),
          ...(row.agentProfileId?.trim()
            ? { agentProfileId: row.agentProfileId.trim() }
            : {}),
          ...(row.agentProfileVersionId?.trim()
            ? { agentProfileVersionId: row.agentProfileVersionId.trim() }
            : {}),
          ...(row.systemPrompt?.trim() ? { systemPrompt: row.systemPrompt.trim() } : {}),
          ...(parseStringArray(row.methodologyJson || "[]").length
            ? { methodology: parseStringArray(row.methodologyJson || "[]") }
            : {}),
          ...(parseStringArray(row.qualityGatesJson || "[]").length
            ? { qualityGates: parseStringArray(row.qualityGatesJson || "[]") }
            : {}),
          ...(parseStringArray(row.knowledgeRefsJson || "[]").length
            ? { knowledgeRefs: parseStringArray(row.knowledgeRefsJson || "[]") }
            : {}),
          ...(parseStringArray(row.connectorsJson || "[]").length
            ? { connectors: parseStringArray(row.connectorsJson || "[]") }
            : {}),
        } satisfies EmployeeProfile,
      ]),
    );
    const workspacesByEmployee = new Map<string, EmployeeWorkspaceGrant[]>();
    for (const grant of grants) {
      const list = workspacesByEmployee.get(grant.employeeId) || [];
      list.push({
        workspaceId: grant.workspaceId,
        mode: grant.mode,
        isDefault: grant.isDefault === 1,
        ...(grant.env && grant.env !== "dev" ? { env: grant.env } : {}),
      });
      workspacesByEmployee.set(grant.employeeId, list);
    }

    const memoriesByEmployee = listRecentEmployeeMemories(this.db, companyId);
    return {
      departments,
      positions,
      employees: employees.map((employee) => ({
        ...employee,
        profile: profileByEmployee.get(employee.id),
        workspaces: workspacesByEmployee.get(employee.id) || [],
        memories: memoriesByEmployee.get(employee.id) || [],
      })),
    };
  }

  private replaceWorkspaceGrants(
    companyId: string,
    employeeId: string,
    workspaces: EmployeeWorkspaceGrant[],
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `DELETE FROM company_employee_workspaces
        WHERE company_id = ? AND employee_id = ?`,
      )
      .run(companyId, employeeId);
    const insertGrant = this.db.prepare(
      `INSERT INTO company_employee_workspaces
        (id, company_id, employee_id, workspace_id, mode, is_default, env, created_at)
      VALUES
        (@id, @companyId, @employeeId, @workspaceId, @mode, @isDefault, @env, @createdAt)`,
    );
    for (const grant of workspaces) {
      insertGrant.run({
        id: newCompanyId("emp_ws"),
        companyId,
        employeeId,
        workspaceId: grant.workspaceId,
        mode: grant.mode,
        isDefault: grant.isDefault ? 1 : 0,
        env: grant.env || "dev",
        createdAt,
      });
    }
  }

  private listDepartments(companyId: string): Department[] {
    return this.db
      .prepare(
        `SELECT id, company_id AS companyId, name, parent_id AS parentId, version
        FROM company_departments
        WHERE company_id = ?
        ORDER BY created_at, id`,
      )
      .all(companyId) as Department[];
  }

  private findPositionByTitle(companyId: string, title: string): Position | undefined {
    return this.db
      .prepare(
        `SELECT id, company_id AS companyId, department_id AS departmentId,
          template_id AS templateId, title, version
        FROM company_positions
        WHERE company_id = ? AND title = ?
        ORDER BY created_at, id`,
      )
      .get(companyId, title) as Position | undefined;
  }

  private ensureDepartment(
    companyId: string,
    departments: Department[],
    name: string,
    match: RegExp,
  ): Department {
    const existing = departments.find((entry) => entry.name === name)
      ?? departments.find((entry) => match.test(entry.name));
    if (existing) return existing;
    const created = this.createDepartment({ companyId, name });
    departments.push(created);
    return created;
  }

  private movePosition(position: Position, departmentId: string): Position {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE company_positions
        SET department_id = ?, version = version + 1, updated_at = ?
        WHERE company_id = ? AND id = ?`,
      )
      .run(departmentId, now, position.companyId, position.id);
    return {
      ...position,
      departmentId,
      version: position.version + 1,
    };
  }

  private createSeat(
    companyId: string,
    departmentId: string,
    seat: { title: string; charter: string },
  ): Position {
    let template = this.db
      .prepare(
        `SELECT id, company_id AS companyId, name, charter, version
        FROM company_position_templates
        WHERE company_id = ? AND name = ?
        ORDER BY created_at, id`,
      )
      .get(companyId, seat.title) as PositionTemplate | undefined;
    if (!template) {
      template = this.createPositionTemplate({
        companyId,
        name: seat.title,
        charter: seat.charter,
      });
    }
    return this.createPosition({
      companyId,
      departmentId,
      templateId: template.id,
      title: seat.title,
    });
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeWorkspaceGrants(
  grants: EmployeeWorkspaceGrant[],
): EmployeeWorkspaceGrant[] {
  const unique = new Map<string, EmployeeWorkspaceGrant>();
  for (const grant of grants) {
    unique.set(grant.workspaceId, {
      workspaceId: grant.workspaceId,
      mode: grant.mode === "write" || grant.isDefault ? "write" : "read",
      isDefault: Boolean(grant.isDefault),
      ...(grant.env ? { env: grant.env } : {}),
    });
  }
  const normalized = [...unique.values()];
  const defaults = normalized.filter((grant) => grant.isDefault);
  if (defaults.length > 1) {
    throw new Error("employee can have at most one default workspace");
  }
  if (defaults.length === 1 && defaults[0].mode !== "write") {
    defaults[0].mode = "write";
  }
  if (defaults.length === 0) {
    const firstWrite = normalized.find((grant) => grant.mode === "write");
    if (firstWrite) firstWrite.isDefault = true;
  }
  return normalized;
}
