import { prisma, withTenant } from "@/lib/db";
import { ROLES, type Actor } from "@/lib/authz";
import { isWorkingDay, DEFAULT_CALENDAR } from "@/lib/schedule";
import type { WorkCalendarInput } from "@/lib/schedule/types";
import { istCalendarDayMarker } from "@/lib/shared/business-day";
import { syncOverdueStageNotifications, syncHoldPointAgedNotifications } from "./notifications.service";
import { publishDigest } from "./reports.service";

/**
 * Orchestrates the two Gate 4 scheduled jobs (`/api/cron/alerts`,
 * `/api/cron/digest`) across every tenant. Both loop `Organization` directly
 * off the plain `prisma` client — `organizations` carries no RLS policy of
 * its own (it's the tenant root), unlike every table underneath it.
 *
 * Per-tenant failures are caught and reported rather than thrown: one
 * tenant's bad data (a missing default calendar, no active ADMIN user)
 * must not block every other tenant's alerts or digest.
 */

export interface TenantRunResult {
  tenantId: number;
  ok: boolean;
  error?: string;
}

export interface DigestRunResult extends TenantRunResult {
  skipped?: boolean;
  count?: number;
}

export async function runAlertReconciliation(): Promise<TenantRunResult[]> {
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results: TenantRunResult[] = [];

  for (const org of orgs) {
    try {
      await Promise.all([syncOverdueStageNotifications(org.id), syncHoldPointAgedNotifications(org.id)]);
      results.push({ tenantId: org.id, ok: true });
    } catch (e) {
      console.error("[cron] alert reconciliation failed", { tenantId: org.id, error: e });
      results.push({ tenantId: org.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}

/**
 * `asOf` defaults to now; a fixed value lets a test point "today" at a
 * specific calendar date without needing to seed a holiday for the real
 * current date.
 */
export async function runDailyDigest(asOf: Date = new Date()): Promise<DigestRunResult[]> {
  const today = istCalendarDayMarker(asOf);
  const dateStr = today.toISOString().slice(0, 10);

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results: DigestRunResult[] = [];

  for (const org of orgs) {
    try {
      const prep = await withTenant(org.id, async (tx) => {
        const cal = await tx.workCalendar.findFirst({ where: { isDefault: true }, include: { holidays: true } });
        const calendarInput: WorkCalendarInput = cal
          ? { weekOffDays: cal.weekOffDays, holidays: cal.holidays.map((h) => h.date) }
          : DEFAULT_CALENDAR;
        if (!isWorkingDay(today, calendarInput)) return { skip: true as const };

        const admin = await tx.user.findFirst({
          where: { tenantId: org.id, active: true, roles: { some: { role: { code: ROLES.ADMIN } } } },
          orderBy: { id: "asc" },
          select: { id: true, name: true, email: true },
        });
        if (!admin) throw new Error(`no active ADMIN user for tenant ${org.id}`);

        const actor: Actor = {
          userId: admin.id,
          tenantId: org.id,
          clientId: null,
          name: admin.name,
          email: admin.email,
          roles: [ROLES.ADMIN],
          departmentIds: [],
          mustChangePassword: false,
          themePreference: "SYSTEM",
          outdoorMode: false,
        };
        return { skip: false as const, actor };
      });

      if (prep.skip) {
        results.push({ tenantId: org.id, ok: true, skipped: true });
        continue;
      }

      const count = await publishDigest(prep.actor, dateStr, { auto: true });
      results.push({ tenantId: org.id, ok: true, count });
    } catch (e) {
      console.error("[cron] digest failed", { tenantId: org.id, error: e });
      results.push({ tenantId: org.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}
