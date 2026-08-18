import { withTenant, type Tx } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { HOLD_POINT_AGE_ALERT_DAYS, NUDGE_COOLDOWN_MINUTES } from "@/lib/shared/constants";
import { loadPlanNotifyContext } from "./_shared";
import { loadQcCockpit } from "./qc-cockpit.read";
import type { ProcessPlan } from "@/generated/prisma/client";

/**
 * §6 in-app notifications. Two of the five triggers fire directly inside an
 * existing mutation transaction (item submitted → QC, reject → maker — see
 * process.service.ts) via `notify()`. The other three have no natural
 * mutation moment to hang off (a plan crossing its due date, a hold point
 * aging, a digest being published) and are reconciled lazily instead of via a
 * cron (CLAUDE.md: cron only if load demands it) — digest-published fires
 * from the reports "Send now" action; the other two run from `syncNotifications`,
 * called opportunistically on every authenticated page load ((app)/layout.tsx).
 */

export interface NotifySpec {
  recipientId: number;
  type: string;
  entityType?: string;
  entityId?: number;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

/** Bulk-insert notification rows inside a caller-owned transaction. */
export async function notify(tx: Tx, tenantId: number, specs: NotifySpec[]): Promise<void> {
  if (specs.length === 0) return;
  await tx.notification.createMany({
    data: specs.map((s) => ({
      tenantId,
      recipientId: s.recipientId,
      type: s.type,
      entityType: s.entityType ?? null,
      entityId: s.entityId ?? null,
      title: s.title,
      body: s.body ?? null,
      payload: (s.payload ?? undefined) as never,
    })),
  });
}

/** Every active user holding `roleCode` — a notify() recipient list. */
export async function userIdsWithRole(tx: Tx, tenantId: number, roleCode: string): Promise<number[]> {
  const users = await tx.user.findMany({
    where: { tenantId, active: true, roles: { some: { role: { code: roleCode } } } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

export async function markNotificationRead(actor: Actor, id: number): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const n = await tx.notification.findFirst({ where: { id, recipientId: actor.userId } });
    if (!n) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Notification", id });
    if (n.readAt) return;
    await tx.notification.update({ where: { id }, data: { readAt: new Date() } });
  });
}

export async function markAllNotificationsRead(actor: Actor): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    await tx.notification.updateMany({
      where: { recipientId: actor.userId, readAt: null },
      data: { readAt: new Date() },
    });
  });
}

/**
 * ponytail: a full table scan of current plans/hold-points per call, fine at
 * demo scale (hundreds of rows) — move to a real cron once row counts make
 * this measurably slow. Idempotent either way: each condition is notified at
 * most once, keyed by (type, entityType, entityId[, unitId in payload]), so
 * repeated calls across many page loads never duplicate a row.
 */
export async function syncNotifications(actor: Actor): Promise<void> {
  // Independent transactions — run concurrently rather than paying their
  // latency twice on every page load.
  await Promise.all([syncOverdueStageNotifications(actor), syncHoldPointAgedNotifications(actor)]);
}

async function syncOverdueStageNotifications(actor: Actor): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    // ProcessPlan carries no tenant_id of its own (child-table reachability
    // pattern, see the RLS migration's ponytail note) — an unscoped scan here
    // would span every tenant in a shared DB (caught by a DB-test failure:
    // loadPlanNotifyContext blew up on a plan belonging to a sibling test's
    // throwaway tenant). Filter explicitly through the job's own tenantId
    // rather than relying on RLS alone, since none of process_plans/
    // schedule_runs are RLS-protected tables.
    const overduePlans = await tx.processPlan.findMany({
      where: {
        status: { not: "COMPLETE" },
        plannedFinish: { lt: new Date() },
        scheduleRun: { isCurrent: true },
        jobProcess: { job: { tenantId: actor.tenantId } },
      },
      select: { id: true, jobProcessId: true, unitId: true, ownerDepartmentId: true, assigneeUserId: true, scheduleRunId: true, status: true, baselineStart: true, baselineFinish: true, plannedStart: true, plannedFinish: true, submittedBy: true, verifiedBy: true, actualStart: true, actualFinish: true },
    });
    if (overduePlans.length === 0) return;

    const already = await tx.notification.findMany({
      where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: { in: overduePlans.map((p) => p.id) } },
      select: { entityId: true },
    });
    const notifiedIds = new Set(already.map((n) => n.entityId));
    const pending = overduePlans.filter((p) => !notifiedIds.has(p.id));
    if (pending.length === 0) return;

    const productionHeadIds = await userIdsWithRole(tx, actor.tenantId, "PRODUCTION_HEAD");

    // One batched lookup for every distinct owning department instead of one
    // query per plan.
    const deptIds = [...new Set(pending.map((p) => p.ownerDepartmentId))];
    const supervisorRows = await tx.user.findMany({
      where: { tenantId: actor.tenantId, active: true, departments: { some: { departmentId: { in: deptIds } } } },
      select: { id: true, departments: { select: { departmentId: true } } },
    });
    const supervisorsByDept = new Map<number, number[]>();
    for (const u of supervisorRows) {
      for (const d of u.departments) {
        if (!deptIds.includes(d.departmentId)) continue;
        const list = supervisorsByDept.get(d.departmentId) ?? [];
        list.push(u.id);
        supervisorsByDept.set(d.departmentId, list);
      }
    }

    // One batched lookup for every distinct assignee, same pattern as
    // supervisorsByDept above — `setUserActive` deactivation does NOT release
    // a user's assigned plans (by design, C29), so an assignee referenced
    // here can be inactive and unable to log in at all.
    const assigneeIds = [...new Set(pending.map((p) => p.assigneeUserId).filter((id): id is number => id != null))];
    const activeAssigneeIds = new Set(
      assigneeIds.length === 0
        ? []
        : (
            await tx.user.findMany({
              where: { tenantId: actor.tenantId, id: { in: assigneeIds }, active: true },
              select: { id: true },
            })
          ).map((u) => u.id),
    );

    for (const plan of pending) {
      // Assignee-first (SPEC §8): an assigned plan notifies the assignee +
      // PH only, PROVIDED the assignee is still active — an inactive
      // assignee can't act on it, so fall back to dept-supervisors + PH
      // instead of notifying only an account nobody can log into.
      const recipients =
        plan.assigneeUserId != null && activeAssigneeIds.has(plan.assigneeUserId)
          ? [...new Set([plan.assigneeUserId, ...productionHeadIds])]
          : [...new Set([...(supervisorsByDept.get(plan.ownerDepartmentId) ?? []), ...productionHeadIds])];
      if (recipients.length === 0) continue;

      const ctx = await loadPlanNotifyContext(tx, plan as ProcessPlan);
      await notify(
        tx,
        actor.tenantId,
        recipients.map((recipientId) => ({
          recipientId,
          type: "STAGE_OVERDUE",
          entityType: "ProcessPlan",
          entityId: plan.id,
          title: `${ctx.processName} crossed its due date${ctx.serialNo ? ` — Unit ${ctx.serialNo}` : ""}`,
          body: `${ctx.jobNumber} · ${ctx.deptName}`,
          payload: { jobId: ctx.jobId, unitId: ctx.unitId, stageNo: ctx.stageNo },
        })),
      );
    }
  });
}

/**
 * D32 (SPEC-supervisor-ui-v3.md §6(a)): notifies QC + Production Head that a
 * held plan needs attention, from the execution sheet's "Nudge QC" action.
 * The 30-min cooldown is derived server-side from the last NUDGE-type
 * Notification row for this exact (plan, actor) pair — stored via `payload.
 * actorId` since `recipientId` is the notified QC/PH user, not the nudging
 * supervisor. Never client state: a client-held timer resets on refresh/
 * device-switch and would let a supervisor spam by reloading.
 *
 * `ageDays` is caller-supplied display copy (the execution sheet already
 * computed and rendered it from the same server-side hold-point data a
 * moment earlier via stage-detail.read.ts) — not an authoritative
 * `actual_*`/`*_at` field, so invariant #1 doesn't apply; it only shapes the
 * notification's title text.
 */
export async function nudgeQc(actor: Actor, planId: number, ageDays: number): Promise<void> {
  await withTenant(actor.tenantId, async (tx) => {
    const plan = await tx.processPlan.findFirst({
      where: { id: planId, jobProcess: { job: { tenantId: actor.tenantId } } },
    });
    if (!plan) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessPlan", id: planId });

    const last = await tx.notification.findFirst({
      where: { type: "NUDGE", entityType: "ProcessPlan", entityId: planId, payload: { path: ["actorId"], equals: actor.userId } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < NUDGE_COOLDOWN_MINUTES * 60_000) {
      throw new AppError(ERROR_CODES.NUDGE_COOLDOWN, { planId, cooldownMinutes: NUDGE_COOLDOWN_MINUTES });
    }

    const ctx = await loadPlanNotifyContext(tx, plan);
    const recipients = [
      ...new Set([...(await userIdsWithRole(tx, actor.tenantId, "QC")), ...(await userIdsWithRole(tx, actor.tenantId, "PRODUCTION_HEAD"))]),
    ];
    if (recipients.length === 0) return;

    await notify(
      tx,
      actor.tenantId,
      recipients.map((recipientId) => ({
        recipientId,
        type: "NUDGE",
        entityType: "ProcessPlan",
        entityId: planId,
        title: `Nudge: ${ctx.processName} on hold${ctx.serialNo ? ` — Unit ${ctx.serialNo}` : ""}`,
        body: `${ctx.jobNumber} · ${ctx.deptName} · held ${ageDays}d`,
        payload: { jobId: ctx.jobId, unitId: ctx.unitId, stageNo: ctx.stageNo, actorId: actor.userId },
      })),
    );
  });
}

async function syncHoldPointAgedNotifications(actor: Actor): Promise<void> {
  // Its own withTenant transaction (loadQcCockpit) — never nested inside another.
  const cockpit = await loadQcCockpit(actor);
  const aged = cockpit.holdPoints.filter((h) => h.ageDays > HOLD_POINT_AGE_ALERT_DAYS);
  if (aged.length === 0) return;

  await withTenant(actor.tenantId, async (tx) => {
    const recipients = [
      ...new Set([...(await userIdsWithRole(tx, actor.tenantId, "QC")), ...(await userIdsWithRole(tx, actor.tenantId, "PRODUCTION_HEAD"))]),
    ];
    if (recipients.length === 0) return;

    const existing = await tx.notification.findMany({
      where: { type: "HOLD_POINT_AGED", entityType: "QcpItem", entityId: { in: aged.map((h) => h.qcpItemId) } },
      select: { entityId: true, payload: true },
    });
    const notifiedKeys = new Set(
      existing.map((n) => `${n.entityId}:${(n.payload as { unitId?: number } | null)?.unitId}`),
    );

    for (const h of aged) {
      if (notifiedKeys.has(`${h.qcpItemId}:${h.unitId}`)) continue;
      await notify(
        tx,
        actor.tenantId,
        recipients.map((recipientId) => ({
          recipientId,
          type: "HOLD_POINT_AGED",
          entityType: "QcpItem",
          entityId: h.qcpItemId,
          title: `${h.srNo} open ${h.ageDays} days — ${h.activity}`,
          body: `${h.jobNumber} · Unit ${h.serialNo} · Stage ${h.stageNo}`,
          payload: { jobId: h.jobId, unitId: h.unitId, stageNo: h.stageNo },
        })),
      );
    }
  });
}
