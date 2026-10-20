import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core L1.4: the cron half of "delay reasons without blocking". An unfiled late plan is nagged
 * (10:00 IST, working days, once per IST day), then escalated to the Production Head 24 h after its
 * first reminder; filing the reason or finishing the plan ends it. Fixed instants: 20 Oct 2026 is a
 * Tuesday, 18 Oct the Sunday before; 04:30 UTC is 10:00 IST.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const LATE = new Date("2026-10-16T00:00:00Z"); // a Friday, late on every run below
const at = (iso: string) => new Date(`${iso}Z`);

describe.skipIf(!RUN_DB)("late-reason reminders and escalation (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { syncLateReasonReminders } = await import("./notifications.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let b: WorkOrg;
  let sup: number;
  let ph: number;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "LRR");
    b = await makeWorkOrg(owner, "LRB");
    sup = (await o.user("sup", ["SUPERVISOR"], [o.fab.id])).userId;
    ph = (await o.user("ph", ["PRODUCTION_HEAD"])).userId;
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  async function plan(opts: { plannedFinish?: Date; status?: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE"; org?: WorkOrg } = {}) {
    const org = opts.org ?? o;
    const j = await org.job({ processes: [{ code: "20", plannedFinish: opts.plannedFinish ?? LATE, status: opts.status ?? "IN_PROGRESS" }] });
    return j.plan("20", 0);
  }
  const sent = (planId: number, type: string) => owner.notification.findMany({ where: { entityId: planId, type }, orderBy: { id: "asc" } });

  // Violations first: every case where nothing may be sent.
  const QUIET: Array<[string, string, (p: number) => Promise<void>]> = [
    ["09:59 IST, before the reminder hour", "2026-10-20T04:29:00", async () => {}],
    ["a Sunday, not a working day", "2026-10-18T06:00:00", async () => {}],
    ["a reason is already filed", "2026-10-20T06:00:00", async (p) => {
      const cat = await owner.delayCategoryRef.create({ data: { tenantId: o.tenantId, code: `C${p}`, name: "x" } });
      await owner.delayReason.create({ data: { processPlanId: p, categoryId: cat.id, filedBy: sup, jobId: (await owner.processPlan.findUniqueOrThrow({ where: { id: p } })).jobId } });
    }],
    ["the plan is complete", "2026-10-20T06:00:00", async (p) => {
      await owner.processPlan.update({ where: { id: p }, data: { status: "COMPLETE", actualFinish: new Date() } });
    }],
    ["the plan is due today, not late", "2026-10-20T06:00:00", async (p) => {
      await owner.processPlan.update({ where: { id: p }, data: { plannedFinish: new Date("2026-10-20T00:00:00Z") } });
    }],
    ["the schedule run is not current", "2026-10-20T06:00:00", async (p) => {
      await owner.scheduleRun.update({ where: { id: (await owner.processPlan.findUniqueOrThrow({ where: { id: p } })).scheduleRunId }, data: { isCurrent: false } });
    }],
  ];
  it.each(QUIET)("sends nothing: %s", async (_name, when, arrange) => {
    const p = await plan();
    await arrange(p);
    await syncLateReasonReminders(o.tenantId, at(when));
    expect(await sent(p, "LATE_REASON_REMINDER")).toHaveLength(0);
    expect(await sent(p, "LATE_REASON_ESCALATED")).toHaveLength(0);
  });

  it("another tenant's late plan is not touched by this tenant's run", async () => {
    const mine = await plan();
    const theirs = await plan({ org: b });
    await syncLateReasonReminders(o.tenantId, at("2026-10-20T06:00:00"));
    expect(await sent(mine, "LATE_REASON_REMINDER")).toHaveLength(1);
    expect(await sent(theirs, "LATE_REASON_REMINDER")).toHaveLength(0);
  });

  it("at 10:00 IST the department hears (not the Production Head), once a day however often the cron runs", async () => {
    const p = await plan();
    await syncLateReasonReminders(o.tenantId, at("2026-10-20T04:30:00"));
    await syncLateReasonReminders(o.tenantId, at("2026-10-20T04:30:00"));
    await syncLateReasonReminders(o.tenantId, at("2026-10-20T11:00:00"));
    const rows = await sent(p, "LATE_REASON_REMINDER");
    expect(rows.map((r) => r.recipientId)).toEqual([sup]);
    expect(rows[0].payload).toMatchObject({ day: "2026-10-20" });
    expect(await sent(p, "LATE_REASON_ESCALATED")).toHaveLength(0);
  });

  it("two overlapping runs still send one reminder (advisory lock)", async () => {
    const p = await plan();
    await Promise.all([1, 2, 3].map(() => syncLateReasonReminders(o.tenantId, at("2026-10-20T06:00:00"))));
    expect(await sent(p, "LATE_REASON_REMINDER")).toHaveLength(1);
  });

  it("the next working day reminds again, and escalates to the Production Head once, 24 h after the first reminder", async () => {
    const p = await plan();
    await syncLateReasonReminders(o.tenantId, at("2026-10-20T06:00:00"));
    // 23 h 59 min later: reminded for the new day, not yet escalated.
    await syncLateReasonReminders(o.tenantId, at("2026-10-21T05:59:00"));
    expect(await sent(p, "LATE_REASON_REMINDER")).toHaveLength(2);
    expect(await sent(p, "LATE_REASON_ESCALATED")).toHaveLength(0);
    // 24 h: escalated, and a rerun does not repeat it.
    await syncLateReasonReminders(o.tenantId, at("2026-10-21T06:00:00"));
    await syncLateReasonReminders(o.tenantId, at("2026-10-21T09:00:00"));
    const esc = await sent(p, "LATE_REASON_ESCALATED");
    expect(esc.map((r) => r.recipientId)).toEqual([ph]);
    expect(await sent(p, "LATE_REASON_REMINDER")).toHaveLength(2);
  });

  it("an assigned plan reminds its assignee only; an inactive assignee falls back to the department", async () => {
    const assignee = await o.user("assignee", ["OPERATOR"], [o.fab.id]);
    const p1 = await plan();
    await owner.processPlan.update({ where: { id: p1 }, data: { assigneeUserId: assignee.userId } });
    const p2 = await plan();
    const gone = await o.user("gone", ["OPERATOR"]);
    await owner.processPlan.update({ where: { id: p2 }, data: { assigneeUserId: gone.userId } });
    await owner.user.update({ where: { id: gone.userId }, data: { active: false } });

    await syncLateReasonReminders(o.tenantId, at("2026-10-20T06:00:00"));
    expect((await sent(p1, "LATE_REASON_REMINDER")).map((r) => r.recipientId)).toEqual([assignee.userId]);
    expect((await sent(p2, "LATE_REASON_REMINDER")).map((r) => r.recipientId).sort()).toEqual([sup, assignee.userId].sort());
  });
});
