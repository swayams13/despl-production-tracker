import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { bottlenecks, buildExceptions, rankExceptions, topBlockerByJob } from "@/lib/shared/portfolio";
import { sameDayRate, type UpdateEvent } from "@/lib/shared/team";
import type { DigestPayload } from "@/lib/shared/digest-email";
import { loadPortfolio, loadPortfolioFacts } from "./portfolio.read";
import { milestoneLabel } from "@/lib/shared/milestones";
import { staleAcksByJob } from "@/lib/shared/override-review";
import { resolveCalendarsForJobs } from "./_shared";

/**
 * Lean Core L2.11: everything the 08:30 IST digest email says, as one JSON
 * payload (rendered by `lib/shared/digest-email.ts`). Built from the same reads
 * as Portfolio and Team, so the email and the screens cannot disagree; only the
 * per-department reasons, the override list and the per-department same-day rate
 * are queried here.
 *
 * `workDay` is the IST calendar day the "yesterday" sections cover (the last
 * working day, so a Monday morning reports Saturday, not an empty Sunday).
 */

export const DIGEST_OVERRIDES_SHOWN = 10;

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" in IST -> the [start, end) instants of that IST day. */
export function istDayWindow(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export async function loadDigestPayload(
  actor: Actor,
  opts: { date: string; workDay: string; appUrl: string | null; now?: Date },
): Promise<DigestPayload> {
  const now = opts.now ?? new Date();
  const { start, end } = istDayWindow(opts.workDay);

  const portfolio = await loadPortfolio(actor);
  const facts = await loadPortfolioFacts(actor, portfolio.rows);
  const topBlocker = topBlockerByJob(rankExceptions(buildExceptions(facts, null), portfolio.rows.map((r) => r.id)));

  const jobsAtRisk: DigestPayload["jobsAtRisk"] = portfolio.rows
    .filter((r) => r.health === "DELAYED" || r.health === "AT_RISK")
    .map((r) => ({
      jobNumber: r.jobNumber,
      health: r.health as "DELAYED" | "AT_RISK",
      forecast: r.forecastDispatch,
      committed: r.committedDeliveryDate,
      slipDays: r.forecastVarianceDays != null && r.forecastVarianceDays > 0 ? r.forecastVarianceDays : null,
      percentComplete: r.percentComplete,
      topBlocker: topBlocker.get(r.id)?.what ?? null,
      milestone: r.currentMilestone
        ? { label: milestoneLabel(r.currentMilestone), plannedFinish: r.currentMilestone.plannedFinish, late: r.currentMilestone.late }
        : null,
    }));

  const overduePlans = facts.plans.filter((p) => p.overdue);
  const deptName = new Map(facts.depts.map((d) => [d.id, d.name]));

  const data = await withTenant(actor.tenantId, async (tx) => {
    const [reasons, overrides, steps, ops, plans, departments] = await Promise.all([
      overduePlans.length
        ? tx.delayReason.findMany({
            where: { processPlanId: { in: overduePlans.map((p) => p.planId) } },
            select: { processPlanId: true, category: { select: { name: true } } },
          })
        : Promise.resolve([]),
      tx.sequenceOverride.findMany({
        where: { createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: "asc" },
        select: {
          targetKind: true,
          targetId: true,
          category: true,
          note: true,
          createdAt: true,
          creator: { select: { name: true } },
          unit: { select: { serialNo: true } },
          job: { select: { jobNumber: true } },
        },
      }),
      // j5c: history (events recorded in the window)
      tx.assemblyStep.findMany({
        where: { OR: [{ startedAt: { gte: start, lt: end } }, { finishedAt: { gte: start, lt: end } }] },
        select: { startedAt: true, reportedStartAt: true, finishedAt: true, reportedFinishAt: true, templateStep: { select: { defaultDepartmentId: true } } },
      }),
      // j5c: history (events recorded in the window)
      tx.componentOperation.findMany({
        where: { OR: [{ startedAt: { gte: start, lt: end } }, { finishedAt: { gte: start, lt: end } }] },
        select: { startedAt: true, reportedStartAt: true, finishedAt: true, reportedFinishAt: true, operation: { select: { defaultDepartmentId: true } } },
      }),
      tx.processPlan.findMany({
        where: { OR: [{ actualStart: { gte: start, lt: end } }, { actualFinish: { gte: start, lt: end } }] },
        select: { actualStart: true, reportedStartAt: true, actualFinish: true, reportedFinishAt: true, jobProcess: { select: { departmentId: true } } },
      }),
      tx.department.findMany({ where: { tenantId: actor.tenantId }, select: { id: true, name: true } }),
    ]);

    // Titles of the overridden items, by kind.
    const ids = (k: string) => overrides.filter((o) => o.targetKind === k).map((o) => o.targetId);
    const [stepRows, opRows, planRows] = await Promise.all([
      ids("ASSEMBLY_STEP").length
        // j5c: history (overridden items)
        ? tx.assemblyStep.findMany({ where: { id: { in: ids("ASSEMBLY_STEP") } }, select: { id: true, templateStep: { select: { activity: true } } } })
        : Promise.resolve([]),
      ids("COMPONENT_OP").length
        // j5c: history (overridden items)
        ? tx.componentOperation.findMany({ where: { id: { in: ids("COMPONENT_OP") } }, select: { id: true, operation: { select: { name: true } } } })
        : Promise.resolve([]),
      ids("PROCESS_PLAN").length
        ? tx.processPlan.findMany({ where: { id: { in: ids("PROCESS_PLAN") } }, select: { id: true, jobProcess: { select: { name: true } } } })
        : Promise.resolve([]),
    ]);
    const title = new Map<string, string>([
      ...stepRows.map((s) => [`ASSEMBLY_STEP:${s.id}`, s.templateStep.activity] as const),
      ...opRows.map((o) => [`COMPONENT_OP:${o.id}`, o.operation.name] as const),
      ...planRows.map((p) => [`PROCESS_PLAN:${p.id}`, p.jobProcess.name] as const),
    ]);
    return { reasons, overrides, steps, ops, plans, departments, title };
  });

  // ── D2: early starts nobody acknowledged for 2 working days, one line per job ──
  const unreviewedEarlyStarts = await withTenant(actor.tenantId, async (tx) => {
    const open = await tx.sequenceOverride.findMany({
      where: { tenantId: actor.tenantId, ack: null, createdAt: { lt: new Date(now.getTime() - 2 * DAY_MS) } },
      select: { jobId: true, createdAt: true, job: { select: { jobNumber: true, calendarId: true } } },
    });
    const calendars = await resolveCalendarsForJobs(tx, [...new Map(open.map((o) => [o.jobId, { id: o.jobId, calendarId: o.job.calendarId }])).values()]);
    return staleAcksByJob(open.map((o) => ({ jobId: o.jobId, jobNumber: o.job.jobNumber, createdAt: o.createdAt })), now, calendars);
  });

  // ── overdue by department, top reason = most filed (ties: alphabetical) ──
  const reasonsByPlan = new Map<number, Set<string>>();
  for (const r of data.reasons) {
    const s = reasonsByPlan.get(r.processPlanId) ?? new Set<string>();
    s.add(r.category.name);
    reasonsByPlan.set(r.processPlanId, s);
  }
  const overdueByDept = bottlenecks(facts, null)
    .filter((b) => b.overdue > 0)
    .map((b) => {
      const tally = new Map<string, number>();
      for (const p of overduePlans) {
        if (p.deptId !== b.deptId) continue;
        for (const name of reasonsByPlan.get(p.planId) ?? []) tally.set(name, (tally.get(name) ?? 0) + 1);
      }
      const top = [...tally.entries()].sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))[0];
      return { dept: b.name, overdue: b.overdue, topReason: top?.[0] ?? null, topReasonCount: top?.[1] ?? 0 };
    })
    .sort((a, c) => c.overdue - a.overdue || a.dept.localeCompare(c.dept));

  // ── same-day updates by department (each start / finish stamp is one event) ──
  const byDept = new Map<number, UpdateEvent[]>();
  const push = (deptId: number | null | undefined, recordedAt: Date | null, reportedAt: Date | null) => {
    if (deptId == null || !recordedAt || recordedAt < start || recordedAt >= end) return;
    const list = byDept.get(deptId) ?? [];
    list.push({ recordedAt, reportedAt });
    byDept.set(deptId, list);
  };
  for (const s of data.steps) {
    const d = s.templateStep.defaultDepartmentId;
    push(d, s.startedAt, s.reportedStartAt);
    push(d, s.finishedAt, s.reportedFinishAt);
  }
  for (const o of data.ops) {
    const d = o.operation.defaultDepartmentId;
    push(d, o.startedAt, o.reportedStartAt);
    push(d, o.finishedAt, o.reportedFinishAt);
  }
  for (const p of data.plans) {
    const d = p.jobProcess.departmentId;
    push(d, p.actualStart, p.reportedStartAt);
    push(d, p.actualFinish, p.reportedFinishAt);
  }
  const names = new Map([...data.departments.map((d) => [d.id, d.name] as const), ...deptName]);
  const all: UpdateEvent[] = [...byDept.values()].flat();
  const deptRates = [...byDept.entries()]
    .map(([id, events]) => ({ dept: names.get(id) ?? "Other", ...sameDayRate(events) }))
    .sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || b.total - a.total || a.dept.localeCompare(b.dept));

  const overrides = data.overrides.map((o) => ({
    jobNumber: o.job.jobNumber,
    serialNo: o.unit?.serialNo ?? "—",
    title: data.title.get(`${o.targetKind}:${o.targetId}`) ?? "A step",
    by: o.creator.name,
    at: o.createdAt.toISOString(),
    category: o.category,
    note: o.note,
  }));

  return {
    date: opts.date,
    workDay: opts.workDay,
    asOf: now.toISOString(),
    jobsAtRisk,
    overdueTotal: overduePlans.length,
    overdueByDept,
    overrides: overrides.slice(0, DIGEST_OVERRIDES_SHOWN),
    overridesTotal: overrides.length,
    unreviewedEarlyStarts,
    sameDay: { overall: sameDayRate(all), byDept: deptRates },
    appUrl: opts.appUrl,
  };
}
