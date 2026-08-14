import { prisma } from "@/lib/db";

/**
 * Boot-time guard for invariant #5 and tenant RLS (CLAUDE.md).
 *
 * Both protections are enforced by Postgres grants/policies that a table
 * owner or superuser silently bypasses. If DATABASE_URL is ever pointed at
 * `postgres` instead of the non-owner `despl_web` role, the app keeps working
 * but the guarantees become no-ops with no visible symptom — this project has
 * already suffered that exact regression once. This module turns the
 * assertion from a code comment into something that crashes the server at
 * startup instead.
 */

export interface DbRoleInfo {
  currentUser: string;
  isSuperuser: boolean;
  canUpdateAuditLog: boolean;
  canDeleteAuditLog: boolean;
  canUpdateDomainEvents: boolean;
  canDeleteDomainEvents: boolean;
}

/** Throws a clear, actionable Error if the connected role is unsafe. */
export function assertDbRoleSafe(info: DbRoleInfo): void {
  const causes: string[] = [];
  if (info.isSuperuser) causes.push("is a superuser");
  if (info.canUpdateAuditLog) causes.push("can UPDATE audit_log");
  if (info.canDeleteAuditLog) causes.push("can DELETE audit_log");
  if (info.canUpdateDomainEvents) causes.push("can UPDATE domain_events");
  if (info.canDeleteDomainEvents) causes.push("can DELETE domain_events");

  if (causes.length === 0) return;

  throw new Error(
    `DATABASE_URL is connected as "${info.currentUser}", which ${causes.join(" and ")} — ` +
      "a superuser or a role that can modify audit_log/domain_events silently bypasses " +
      "tenant RLS and the append-only audit invariant. Point DATABASE_URL at the non-owner " +
      "`despl_web` role; see scripts/provision-db-role.sql.",
  );
}

/**
 * Gathers DbRoleInfo via non-destructive catalog queries (never a real
 * UPDATE/DELETE) and asserts it's safe. Call once at server startup via
 * src/instrumentation.ts — NOT at module import time.
 */
export async function assertDbRole(client = prisma): Promise<void> {
  const rows = await client.$queryRaw<
    {
      current_user: string;
      is_superuser: string;
      can_update_audit_log: boolean;
      can_delete_audit_log: boolean;
      can_update_domain_events: boolean;
      can_delete_domain_events: boolean;
    }[]
  >`
    SELECT
      current_user,
      current_setting('is_superuser') AS is_superuser,
      has_table_privilege(current_user, 'audit_log', 'UPDATE') AS can_update_audit_log,
      has_table_privilege(current_user, 'audit_log', 'DELETE') AS can_delete_audit_log,
      has_table_privilege(current_user, 'domain_events', 'UPDATE') AS can_update_domain_events,
      has_table_privilege(current_user, 'domain_events', 'DELETE') AS can_delete_domain_events
  `;
  const row = rows[0];

  assertDbRoleSafe({
    currentUser: row.current_user,
    isSuperuser: row.is_superuser === "on",
    canUpdateAuditLog: row.can_update_audit_log,
    canDeleteAuditLog: row.can_delete_audit_log,
    canUpdateDomainEvents: row.can_update_domain_events,
    canDeleteDomainEvents: row.can_delete_domain_events,
  });
}
