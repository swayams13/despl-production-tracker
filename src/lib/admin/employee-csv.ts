/**
 * Task 4.2 (SPEC §7.3) — bulk employee CSV import: pure parsing/validation,
 * no DB, no "use client". `_client.tsx` calls this for the preview step;
 * `admin.service.bulkImportEmployees` re-validates server-side regardless
 * (this is a fast-feedback preview, not the source of truth).
 *
 * ponytail: hand-rolled `split(",")` parser, not a CSV library. The
 * documented column format (displayName,username,email,employeeCode,roles,
 * departments) has no embedded-comma/quote requirement anywhere in the spec;
 * multi-value cells (roles, departments) use `|` as an in-cell separator
 * instead, which sidesteps needing real CSV quoting. Add a real parser
 * (e.g. papaparse) if DESPL's actual C9 staff list turns out to need quoted
 * commas — not assumed here.
 */

const ROLE_CODES = ["ADMIN", "MANAGEMENT", "PRODUCTION_HEAD", "SUPERVISOR", "QC", "CLIENT_VIEWER"] as const;
export type RoleCodeStr = (typeof ROLE_CODES)[number];

/** SPEC §7.3: departments are required on the Add-employee dialog and in
 * bulk import UNLESS the role set includes MANAGEMENT or ADMIN (these roles
 * are cross-department by nature). UI-level rule only — the service layer
 * does not enforce it (admin.service.createEmployee accepts `[]` from any
 * role). Shared by the dialog form and the CSV parser below so the rule is
 * defined exactly once. */
export function departmentsRequired(roles: string[]): boolean {
  return !roles.includes("MANAGEMENT") && !roles.includes("ADMIN");
}

export interface EmployeeCsvRowData {
  displayName: string;
  username: string;
  email?: string;
  employeeCode?: string;
  roles: RoleCodeStr[];
  departmentIds: number[];
}

export interface ParsedEmployeeRow {
  /** 1-indexed source line, including the header line (so line 2 = first data row). */
  line: number;
  /** Raw cell values as typed in the CSV, for echoing back in the preview/error report. */
  raw: { displayName: string; username: string; email: string; employeeCode: string; roles: string; departments: string };
  errors: string[];
  /** Present only when `errors` is empty. */
  data?: EmployeeCsvRowData;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitMulti(cell: string): string[] {
  return cell.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parses `displayName,username,email,employeeCode,roles,departments` CSV
 * text. First line is always treated as the header and skipped. `roles` and
 * `departments` cells may hold multiple values separated by `|`.
 */
export function parseEmployeeCsv(text: string, departments: { id: number; name: string }[]): ParsedEmployeeRow[] {
  const deptByName = new Map(departments.map((d) => [d.name.trim().toLowerCase(), d.id]));
  const lines = text.split(/\r?\n/);
  const rows: ParsedEmployeeRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const cells = line.split(",").map((c) => c.trim());
    const [displayName = "", username = "", email = "", employeeCode = "", rolesCell = "", departmentsCell = ""] = cells;
    const raw = { displayName, username, email, employeeCode, roles: rolesCell, departments: departmentsCell };
    const errors: string[] = [];

    if (!displayName) errors.push("Name is required.");
    if (!username) errors.push("Username is required.");
    if (email && !EMAIL_RE.test(email)) errors.push(`"${email}" is not a valid email address.`);

    const roleTokens = splitMulti(rolesCell).map((r) => r.toUpperCase());
    const roles: RoleCodeStr[] = [];
    for (const t of roleTokens) {
      if ((ROLE_CODES as readonly string[]).includes(t)) roles.push(t as RoleCodeStr);
      else errors.push(`"${t}" is not a valid role.`);
    }
    if (roleTokens.length === 0) errors.push("At least one role is required.");

    const deptTokens = splitMulti(departmentsCell);
    const departmentIds: number[] = [];
    for (const t of deptTokens) {
      const id = deptByName.get(t.toLowerCase());
      if (id == null) errors.push(`"${t}" is not a known department.`);
      else departmentIds.push(id);
    }
    if (departmentIds.length === 0 && departmentsRequired(roleTokens)) {
      errors.push("Departments are required unless the role is Management or Admin.");
    }

    rows.push({
      line: i + 1,
      raw,
      errors,
      data:
        errors.length === 0
          ? { displayName, username, email: email || undefined, employeeCode: employeeCode || undefined, roles, departmentIds }
          : undefined,
    });
  }

  return rows;
}

export interface BulkImportRowReport {
  line: number;
  displayName: string;
  username: string;
  ok: boolean;
  tempPassword?: string;
  effectiveEmail?: string;
  error?: string;
}

/** Builds the one-time downloadable result CSV (generated client-side from
 * the action's response — SPEC §7.3: never persisted server-side). */
export function buildResultCsv(rows: BulkImportRowReport[]): string {
  const header = "line,displayName,username,status,tempPassword,effectiveEmail,error";
  const body = rows.map((r) =>
    [r.line, csvCell(r.displayName), csvCell(r.username), r.ok ? "created" : "failed", r.tempPassword ?? "", r.effectiveEmail ?? "", csvCell(r.error ?? "")].join(","),
  );
  return [header, ...body].join("\n");
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
