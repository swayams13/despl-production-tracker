import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";

export interface AdminUserRow {
  id: number;
  name: string;
  email: string;
  username: string;
  employeeCode: string | null;
  active: boolean;
  roleCodes: string[];
  departmentIds: number[];
  departmentNames: string[];
  /** ISO timestamp of the last successful login, or null = never logged in. */
  lastLogin: string | null;
  /** ProcessPlan rows assigned to this user that are not COMPLETE. */
  openItemsCount: number;
}

export interface AdminDelayCategoryRow {
  id: number;
  code: string;
  name: string;
  active: boolean;
}

export interface AdminTemplateProcessRow {
  id: number;
  seq: number;
  code: string;
  name: string;
  durationMinDays: number | null;
  durationMaxDays: number | null;
  provisional: boolean;
}

export interface AdminView {
  users: AdminUserRow[];
  roles: { code: string; name: string }[];
  departments: { id: number; name: string }[];
  delayCategories: AdminDelayCategoryRow[];
  templateVersionId: number | null;
  templateVersionNo: number | null;
  standardDurations: AdminTemplateProcessRow[];
}

/** `/admin` (§4.10). Users/roles/departments, master delay-reason list, and
 * the newest PRESSURE_VESSEL template version's standard durations — every
 * edit there targets whichever version is newest so successive edits build
 * forward rather than always branching off v1 (invariant #9). */
export async function loadAdminView(actor: Actor): Promise<AdminView> {
  return withTenant(actor.tenantId, async (tx) => {
    const [userRows, roles, departments, delayCategories, latestVersion, openCounts] = await Promise.all([
      tx.user.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: { name: "asc" },
        include: { roles: { include: { role: true } }, departments: { include: { department: true } } },
      }),
      tx.role.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" } }),
      tx.department.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" } }),
      tx.delayCategoryRef.findMany({ where: { tenantId: actor.tenantId }, orderBy: { name: "asc" } }),
      tx.processTemplateVersion.findFirst({
        where: { template: { tenantId: actor.tenantId, family: { code: "PRESSURE_VESSEL" } } },
        orderBy: { version: "desc" },
        include: { processes: { orderBy: { seq: "asc" } } },
      }),
      // ProcessPlan carries no tenantId of its own and is NOT covered by RLS
      // (see the codebase note on child tables like this one) — every filter
      // here goes through the jobProcess -> job -> tenantId join explicitly,
      // never relying on withTenant's session-local RLS setting alone.
      tx.processPlan.groupBy({
        by: ["assigneeUserId"],
        where: {
          assigneeUserId: { not: null },
          status: { not: "COMPLETE" },
          jobProcess: { job: { tenantId: actor.tenantId } },
        },
        _count: { _all: true },
      }),
    ]);

    const openCountByUserId = new Map(openCounts.map((c) => [c.assigneeUserId as number, c._count._all]));

    const users: AdminUserRow[] = userRows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      username: u.username,
      employeeCode: u.employeeCode,
      active: u.active,
      roleCodes: u.roles.map((r) => r.role.code),
      departmentIds: u.departments.map((d) => d.departmentId),
      departmentNames: u.departments.map((d) => d.department.name),
      lastLogin: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      openItemsCount: openCountByUserId.get(u.id) ?? 0,
    }));

    return {
      users,
      roles: roles.map((r) => ({ code: r.code, name: r.name })),
      departments: departments.map((d) => ({ id: d.id, name: d.name })),
      delayCategories: delayCategories.map((c) => ({ id: c.id, code: c.code, name: c.name, active: c.active })),
      templateVersionId: latestVersion?.id ?? null,
      templateVersionNo: latestVersion?.version ?? null,
      standardDurations: (latestVersion?.processes ?? []).map((p) => ({
        id: p.id,
        seq: p.seq,
        code: p.code,
        name: p.name,
        durationMinDays: p.durationMinDays,
        durationMaxDays: p.durationMaxDays,
        provisional: p.provisional,
      })),
    };
  });
}
