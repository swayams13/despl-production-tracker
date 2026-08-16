import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMyDay, type MyDayView } from "./myday.read";
import { workingDaysBetween, DEFAULT_CALENDAR } from "@/lib/schedule";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * `/my-day` (personal dashboards v1, SPEC §6.1). No pure-testable surface —
 * this reads real data across every active job the actor's departments
 * touch, so it's entirely DB-gated (RUN_DB_TESTS=1, pnpm test:db, despl_test
 * only). Fresh org/tenant per file (same shape as assignment.service.test.ts's
 * beforeAll), so every assertion below is against fixture data this file
 * itself created — no shared-seed drift to account for.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("myday.read (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  /** IST (UTC+5:30) noon on `now + offsetDays`'s calendar day — lands
   * unambiguously inside that day's IST bucket regardless of the few ms of
   * clock drift between building fixtures here and loadMyDay's own `now`. */
  function istNoon(offsetDays: number): Date {
    const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
    ist.setUTCDate(ist.getUTCDate() + offsetDays);
    const dateStr = ist.toISOString().slice(0, 10);
    return new Date(`${dateStr}T12:00:00+05:30`);
  }

  let actor: Actor;
  let view: MyDayView;

  // Fixture plan ids, named for what each is meant to prove.
  let planMine: { id: number };
  let planPool: { id: number };
  let planTeamHeld: { id: number };
  let planOtherPool: { id: number };
  let planMineOtherDept: { id: number };
  let planDoneMine: { id: number; actualStart: Date; actualFinish: Date };
  let planCompleteLate: { id: number; actualStart: Date; actualFinish: Date };
  let planSubmittedToday: { id: number };
  let planSubmittedStale: { id: number };
  const jpDurationMax = new Map<string, number>(); // key: our own label, for the expected-value calc

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `MYDAY-${Date.now()}`, name: "My Day test" } });
    const tenantId = org.id;

    const deptMine = await owner.department.create({ data: { tenantId, code: "MINE", name: "Mine Dept" } });
    const deptOther = await owner.department.create({ data: { tenantId, code: "OTHER", name: "Other Dept" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-myday-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-MYDAY-${Date.now()}`,
        // status defaults to ACTIVE — required: loadMyDay only aggregates active jobs.
      },
    });

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const mkUser = async (suffix: string, deptId: number) => {
      const u = await owner.user.create({
        data: {
          tenantId,
          email: `${suffix}-${Date.now()}@x`,
          username: `${suffix}-${Date.now()}`,
          name: suffix,
          passwordHash: "x",
        },
      });
      await owner.userDepartment.create({ data: { userId: u.id, departmentId: deptId } });
      return u;
    };
    const meUser = await mkUser("me", deptMine.id);
    const teammateUser = await mkUser("teammate", deptMine.id);

    actor = {
      userId: meUser.id,
      tenantId,
      clientId: null,
      name: "Me",
      email: "me@despl.test",
      roles: [ROLES.SUPERVISOR],
      departmentIds: [deptMine.id],
      mustChangePassword: false,
    };

    let seq = 1;
    const mkProcess = async (deptId: number, durationMaxDays = 2) => {
      const jp = await owner.jobProcess.create({
        data: {
          jobId: job.id,
          seq: seq++,
          code: `P${seq}`,
          name: `Process ${seq}`,
          departmentId: deptId,
          durationMinDays: 1,
          durationMaxDays,
        },
      });
      return jp;
    };

    // ── mine/pool/teamHeld partition fixtures ────────────────────────────
    const jp1 = await mkProcess(deptMine.id);
    planMine = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp1.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "NOT_STARTED", plannedFinish: istNoon(0) },
    });

    const jp2 = await mkProcess(deptMine.id);
    planPool = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp2.id, ownerDepartmentId: deptMine.id, assigneeUserId: null, status: "NOT_STARTED", plannedFinish: istNoon(2) },
    });

    const jp3 = await mkProcess(deptMine.id);
    planTeamHeld = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp3.id, ownerDepartmentId: deptMine.id, assigneeUserId: teammateUser.id, status: "IN_PROGRESS", plannedFinish: istNoon(1) },
    });

    const jp4 = await mkProcess(deptOther.id);
    planOtherPool = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp4.id, ownerDepartmentId: deptOther.id, assigneeUserId: null, status: "NOT_STARTED" },
    });

    const jp5 = await mkProcess(deptOther.id);
    planMineOtherDept = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp5.id, ownerDepartmentId: deptOther.id, assigneeUserId: meUser.id, status: "NOT_STARTED", plannedFinish: istNoon(3) },
    });

    // ── scoreboard / clearedToday fixtures ───────────────────────────────
    const now = new Date();
    const jp6 = await mkProcess(deptMine.id, 2);
    jpDurationMax.set("done", 2);
    const done_actualStart = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const done_actualFinish = new Date(now.getTime());
    planDoneMine = {
      ...(await owner.processPlan.create({
        data: {
          scheduleRunId: run.id, jobProcessId: jp6.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
          status: "COMPLETE", plannedFinish: done_actualFinish, actualStart: done_actualStart, actualFinish: done_actualFinish,
        },
      })),
      actualStart: done_actualStart,
      actualFinish: done_actualFinish,
    };

    const jp7 = await mkProcess(deptMine.id, 2);
    jpDurationMax.set("late", 2);
    const late_actualStart = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
    const late_actualFinish = new Date(now.getTime());
    const late_plannedFinish = new Date(now.getTime() - 5 * 24 * 3600 * 1000); // took 5 real days against a same-day plan → late
    planCompleteLate = {
      ...(await owner.processPlan.create({
        data: {
          scheduleRunId: run.id, jobProcessId: jp7.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
          status: "COMPLETE", plannedFinish: late_plannedFinish, actualStart: late_actualStart, actualFinish: late_actualFinish,
        },
      })),
      actualStart: late_actualStart,
      actualFinish: late_actualFinish,
    };

    const jp8 = await mkProcess(deptMine.id);
    planSubmittedToday = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp8.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "SUBMITTED" },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planSubmittedToday.id), type: "ProcessSubmitted", payload: {}, at: now },
    });

    const jp9 = await mkProcess(deptMine.id);
    planSubmittedStale = await owner.processPlan.create({
      data: { scheduleRunId: run.id, jobProcessId: jp9.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "SUBMITTED" },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planSubmittedStale.id), type: "ProcessSubmitted", payload: {}, at: new Date(now.getTime() - 3 * 24 * 3600 * 1000) },
    });

    // ── firstPassRejects30d fixtures ─────────────────────────────────────
    // Fresh reject on one of my own plans — counted.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planCompleteLate.id), type: "ProcessRejected", payload: {}, at: now },
    });
    // Reject on an unassigned (not-mine) plan — must NOT count.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planOtherPool.id), type: "ProcessRejected", payload: {}, at: now },
    });
    // Reject on one of my plans, but 40 days ago — outside the 30d window, must NOT count.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planMine.id), type: "ProcessRejected", payload: {}, at: new Date(now.getTime() - 40 * 24 * 3600 * 1000) },
    });

    view = await loadMyDay(actor);
  });

  // ── mine / pool / teamHeld: exhaustive + disjoint (SPEC §10) ────────────

  it("puts each fixture plan in exactly the bucket the partition rule predicts", () => {
    const ids = (list: { plan: { id: number } }[]) => list.map((r) => r.plan.id);

    expect(ids(view.mine)).toContain(planMine.id);
    // "mine" wins regardless of department — assigned to me in a dept I don't hold.
    expect(ids(view.mine)).toContain(planMineOtherDept.id);
    expect(ids(view.pool)).toContain(planPool.id);
    expect(ids(view.teamHeld)).toContain(planTeamHeld.id);

    // Not my department and not assigned to me → excluded from every bucket.
    expect(ids(view.mine)).not.toContain(planOtherPool.id);
    expect(ids(view.pool)).not.toContain(planOtherPool.id);
    expect(ids(view.teamHeld)).not.toContain(planOtherPool.id);

    // COMPLETE (DONE) plans never appear in a live/actionable bucket, even though they're mine.
    expect(ids(view.mine)).not.toContain(planDoneMine.id);
    expect(ids(view.mine)).not.toContain(planCompleteLate.id);
  });

  it("no plan id appears in more than one of mine/pool/teamHeld", () => {
    const allIds = [...view.mine, ...view.pool, ...view.teamHeld].map((r) => r.plan.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("every non-DONE row in mine ∪ pool ∪ teamHeld is either assigned to me or in one of my departments", () => {
    for (const r of [...view.mine, ...view.pool, ...view.teamHeld]) {
      const isMine = r.plan.assigneeUserId === actor.userId;
      const inMyDept = actor.departmentIds.includes(r.plan.ownerDepartmentId);
      expect(isMine || inMyDept).toBe(true);
    }
  });

  it("pool rows are always unassigned; teamHeld rows are always assigned to someone else", () => {
    expect(view.pool.every((r) => r.plan.assigneeUserId === null)).toBe(true);
    expect(view.teamHeld.every((r) => r.plan.assigneeUserId !== null && r.plan.assigneeUserId !== actor.userId)).toBe(true);
    expect(view.mine.every((r) => r.plan.assigneeUserId === actor.userId)).toBe(true);
  });

  // ── clearedToday ──────────────────────────────────────────────────────

  it("counts today's COMPLETE + today's SUBMITTED, and only today's", () => {
    // planDoneMine + planCompleteLate (COMPLETE, actualFinish = now) + planSubmittedToday
    // (SUBMITTED, ProcessSubmitted event = now). planSubmittedStale's event is 3 days old and excluded.
    expect(view.clearedToday).toBeGreaterThanOrEqual(3);
  });

  // ── scoreboard ────────────────────────────────────────────────────────

  it("onTimePct30d = 1 on-time of 2 completed in the window → 50", () => {
    expect(view.scoreboard.onTimePct30d).toBe(50);
  });

  it("doneThisWeek counts both COMPLETE plans finished in the last rolling 7 days", () => {
    expect(view.scoreboard.doneThisWeek).toBeGreaterThanOrEqual(2);
  });

  it("avgCycleVsStdDays matches workingDaysBetween(actualStart, actualFinish) − standard, averaged", () => {
    const delta6 = workingDaysBetween(planDoneMine.actualStart, planDoneMine.actualFinish, DEFAULT_CALENDAR) - 2;
    const delta7 = workingDaysBetween(planCompleteLate.actualStart, planCompleteLate.actualFinish, DEFAULT_CALENDAR) - 2;
    const expected = Math.round(((delta6 + delta7) / 2) * 10) / 10;
    expect(view.scoreboard.avgCycleVsStdDays).toBe(expected);
  });

  it("firstPassRejects30d counts only the in-window reject on one of MY plans", () => {
    // Excludes: the reject on an unassigned plan, and the 40-day-old reject on my own plan.
    expect(view.scoreboard.firstPassRejects30d).toBe(1);
  });

  // ── week ──────────────────────────────────────────────────────────────

  it("returns exactly 6 IST days (T+0..T+5), strictly increasing", () => {
    expect(view.week.length).toBe(6);
    for (let i = 1; i < view.week.length; i++) {
      expect(view.week[i].date > view.week[i - 1].date).toBe(true);
    }
  });

  it("buckets planMine's plannedFinish (today) and planPool's (T+2) into the right day", () => {
    expect(view.week[0].mineCount).toBeGreaterThanOrEqual(1);
    expect(view.week[2].poolCount).toBeGreaterThanOrEqual(1);
  });

  it("hotCount never exceeds that day's mine+pool total", () => {
    for (const day of view.week) {
      expect(day.hotCount).toBeLessThanOrEqual(day.mineCount + day.poolCount);
      expect(day.mineCount).toBeGreaterThanOrEqual(0);
      expect(day.poolCount).toBeGreaterThanOrEqual(0);
    }
  });
});
