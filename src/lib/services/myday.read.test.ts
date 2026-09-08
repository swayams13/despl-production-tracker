import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMyDay, type MyDayView } from "./myday.read";
import { workingDaysBetween, DEFAULT_CALENDAR } from "@/lib/schedule";
import { ROLES, type Actor } from "@/lib/authz";
import { istCalendarDayMarker } from "@/lib/shared/business-day";

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

  // Cross-job aggregation fixtures (a SECOND active job) — proves the merge
  // actually merges (push into shared arrays across jobs) rather than one
  // job's rows silently clobbering another's, and that the merged list is
  // genuinely re-sorted globally rather than left as "job1's rows, then
  // job2's rows" in creation order.
  let planMineFuture: { id: number }; // job1, mine, NOT overdue (bucket 1)
  let job2Mine: { id: number }; // job2, mine, overdue (bucket 0 — must outrank planMineFuture after merge)
  let job2Pool: { id: number };
  let job2TeamHeld: { id: number };

  // Captured for the display-label assertions (task 2.3 ruling — the
  // additive MyDayRow denormalization) — each fixture job's own jobNumber,
  // to prove a row is labeled with ITS job, not whichever job the loop
  // visited first.
  let job1Number: string;
  let job2Number: string;

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

    job1Number = job.jobNumber;

    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    // A second ACTIVE job — same tenant/client/departments/users — so the
    // cross-job aggregation tests below prove a genuine merge, not a
    // single-job coincidence.
    const job2 = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-myday2-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-MYDAY2-${Date.now()}`,
      },
    });
    job2Number = job2.jobNumber;

    const run2 = await owner.scheduleRun.create({
      data: { jobId: job2.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
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
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    let seq = 1;
    const mkProcess = async (deptId: number, jobId: number = job.id, durationMaxDays = 2) => {
      const jp = await owner.jobProcess.create({
        data: {
          jobId,
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
      data: { jobId: jp1.jobId, scheduleRunId: run.id, jobProcessId: jp1.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "NOT_STARTED", plannedFinish: istNoon(0) },
    });

    const jp2 = await mkProcess(deptMine.id);
    planPool = await owner.processPlan.create({
      data: { jobId: jp2.jobId, scheduleRunId: run.id, jobProcessId: jp2.id, ownerDepartmentId: deptMine.id, assigneeUserId: null, status: "NOT_STARTED", plannedFinish: istNoon(2) },
    });

    const jp3 = await mkProcess(deptMine.id);
    planTeamHeld = await owner.processPlan.create({
      data: { jobId: jp3.jobId, scheduleRunId: run.id, jobProcessId: jp3.id, ownerDepartmentId: deptMine.id, assigneeUserId: teammateUser.id, status: "IN_PROGRESS", plannedFinish: istNoon(1) },
    });

    const jp4 = await mkProcess(deptOther.id);
    planOtherPool = await owner.processPlan.create({
      data: { jobId: jp4.jobId, scheduleRunId: run.id, jobProcessId: jp4.id, ownerDepartmentId: deptOther.id, assigneeUserId: null, status: "NOT_STARTED" },
    });

    const jp5 = await mkProcess(deptOther.id);
    planMineOtherDept = await owner.processPlan.create({
      data: { jobId: jp5.jobId, scheduleRunId: run.id, jobProcessId: jp5.id, ownerDepartmentId: deptOther.id, assigneeUserId: meUser.id, status: "NOT_STARTED", plannedFinish: istNoon(3) },
    });

    // ── cross-job aggregation fixtures (job1 + job2) ──────────────────────
    // job1: mine, deliberately NOT overdue (plannedFinish 10 days out) → not
    // in the overdue bucket, so with no predecessor edges (READY, and
    // "critical" under this fixture's equal-duration single-node islands —
    // see prioritizer bucket()) it ranks bucket 1.
    const jpMineFuture = await mkProcess(deptMine.id);
    planMineFuture = await owner.processPlan.create({
      data: {
        jobId: jpMineFuture.jobId, scheduleRunId: run.id, jobProcessId: jpMineFuture.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
        status: "NOT_STARTED", plannedFinish: new Date(Date.now() + 10 * 24 * 3600 * 1000),
      },
    });
    // job2: mine, unambiguously OVERDUE (plannedFinish 10 days in the past)
    // → bucket 0, must outrank planMineFuture once merged+sorted. If the
    // merge just concatenated "job1's rows, then job2's rows" without a
    // global re-sort, planMineFuture (pushed first) would come first —
    // this fixture is specifically built to catch that.
    const jp2Mine = await mkProcess(deptMine.id, job2.id);
    job2Mine = await owner.processPlan.create({
      data: {
        jobId: jp2Mine.jobId, scheduleRunId: run2.id, jobProcessId: jp2Mine.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
        status: "NOT_STARTED", plannedFinish: new Date(Date.now() - 10 * 24 * 3600 * 1000),
      },
    });
    const jp2Pool = await mkProcess(deptMine.id, job2.id);
    job2Pool = await owner.processPlan.create({
      data: { jobId: jp2Pool.jobId, scheduleRunId: run2.id, jobProcessId: jp2Pool.id, ownerDepartmentId: deptMine.id, assigneeUserId: null, status: "NOT_STARTED" },
    });
    const jp2Team = await mkProcess(deptMine.id, job2.id);
    job2TeamHeld = await owner.processPlan.create({
      data: { jobId: jp2Team.jobId, scheduleRunId: run2.id, jobProcessId: jp2Team.id, ownerDepartmentId: deptMine.id, assigneeUserId: teammateUser.id, status: "IN_PROGRESS" },
    });

    // ── scoreboard / clearedToday fixtures ───────────────────────────────
    const now = new Date();
    const jp6 = await mkProcess(deptMine.id, job.id, 2);
    jpDurationMax.set("done", 2);
    const done_actualStart = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const done_actualFinish = new Date(now.getTime());
    // plannedFinish must be a truncated IST-calendar-day marker, matching how
    // every real writer (schedule.service.ts / override.service.ts, both via
    // addWorkingDays → toDateOnly) actually stores it — never a raw
    // timestamp. A raw `now` here made isOnTime's result flip on UTC
    // time-of-day (see business-day.test.ts's "UTC-evening" cases): once IST
    // had already rolled to the next calendar day relative to UTC's "today",
    // istCalendarDayMarker(actualFinish) computed tomorrow's marker while this
    // raw dueDate still carried today's date + time-of-day, so `on time`
    // spuriously evaluated false. Using the same marker for both sides make
    // this deterministically on-time regardless of wall-clock time of day.
    const done_plannedFinish = istCalendarDayMarker(done_actualFinish);
    planDoneMine = {
      ...(await owner.processPlan.create({
        data: {
          jobId: jp6.jobId, scheduleRunId: run.id, jobProcessId: jp6.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
          status: "COMPLETE", plannedFinish: done_plannedFinish, actualStart: done_actualStart, actualFinish: done_actualFinish,
        },
      })),
      actualStart: done_actualStart,
      actualFinish: done_actualFinish,
    };

    const jp7 = await mkProcess(deptMine.id, job.id, 2);
    jpDurationMax.set("late", 2);
    const late_actualStart = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
    const late_actualFinish = new Date(now.getTime());
    // Also a truncated marker for realism (5 real days late either way, so
    // this one was never time-of-day sensitive, but it should still reflect
    // the shape production actually writes).
    const late_plannedFinish = istCalendarDayMarker(new Date(now.getTime() - 5 * 24 * 3600 * 1000)); // took 5 real days against a same-day plan → late
    planCompleteLate = {
      ...(await owner.processPlan.create({
        data: {
          jobId: jp7.jobId, scheduleRunId: run.id, jobProcessId: jp7.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id,
          status: "COMPLETE", plannedFinish: late_plannedFinish, actualStart: late_actualStart, actualFinish: late_actualFinish,
        },
      })),
      actualStart: late_actualStart,
      actualFinish: late_actualFinish,
    };

    const jp8 = await mkProcess(deptMine.id);
    planSubmittedToday = await owner.processPlan.create({
      data: { jobId: jp8.jobId, scheduleRunId: run.id, jobProcessId: jp8.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "SUBMITTED" },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planSubmittedToday.id), type: "ProcessSubmitted", payload: {}, at: now },
    });

    const jp9 = await mkProcess(deptMine.id);
    planSubmittedStale = await owner.processPlan.create({
      data: { jobId: jp9.jobId, scheduleRunId: run.id, jobProcessId: jp9.id, ownerDepartmentId: deptMine.id, assigneeUserId: meUser.id, status: "SUBMITTED" },
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
    const ids = (list: { ranked: { plan: { id: number } } }[]) => list.map((r) => r.ranked.plan.id);

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

  // ── row display labels (task 2.3 ruling — additive MyDayRow denormalization) ─

  it("labels each row with its OWN job's number, dept name, and a real process name — not a shared/stale value", () => {
    const job1Row = view.mine.find((r) => r.ranked.plan.id === planMine.id);
    const job2Row = view.mine.find((r) => r.ranked.plan.id === job2Mine.id);
    expect(job1Row?.jobNumber).toBe(job1Number);
    expect(job2Row?.jobNumber).toBe(job2Number); // proves job2's rows aren't mislabeled with job1's number
    expect(job1Row?.jobId).not.toBe(job2Row?.jobId);
    expect(job1Row?.deptName).toBe("Mine Dept");
    expect(job1Row?.processName).toMatch(/^Process \d+$/);
    // No unitId on any fixture plan (job/equipment-grain) — serialNo falls back honestly.
    expect(job1Row?.serialNo).toBe("—");
  });

  it("no plan id appears in more than one of mine/pool/teamHeld", () => {
    const allIds = [...view.mine, ...view.pool, ...view.teamHeld].map((r) => r.ranked.plan.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("every non-DONE row in mine ∪ pool ∪ teamHeld is either assigned to me or in one of my departments", () => {
    for (const r of [...view.mine, ...view.pool, ...view.teamHeld]) {
      const isMine = r.ranked.plan.assigneeUserId === actor.userId;
      const inMyDept = actor.departmentIds.includes(r.ranked.plan.ownerDepartmentId);
      expect(isMine || inMyDept).toBe(true);
    }
  });

  it("pool rows are always unassigned; teamHeld rows are always assigned to someone else", () => {
    expect(view.pool.every((r) => r.ranked.plan.assigneeUserId === null)).toBe(true);
    expect(view.teamHeld.every((r) => r.ranked.plan.assigneeUserId !== null && r.ranked.plan.assigneeUserId !== actor.userId)).toBe(true);
    expect(view.mine.every((r) => r.ranked.plan.assigneeUserId === actor.userId)).toBe(true);
  });

  // ── cross-job aggregation (the thing this task was dispatched to prove) ─

  it("merges rows from BOTH active jobs into the same mine/pool/teamHeld arrays — neither job clobbers the other", () => {
    const ids = (list: { ranked: { plan: { id: number } } }[]) => list.map((r) => r.ranked.plan.id);

    expect(ids(view.mine)).toContain(planMineFuture.id); // job1
    expect(ids(view.mine)).toContain(job2Mine.id); // job2 — both present, not one overwriting the other
    expect(ids(view.pool)).toContain(planPool.id); // job1
    expect(ids(view.pool)).toContain(job2Pool.id); // job2
    expect(ids(view.teamHeld)).toContain(planTeamHeld.id); // job1
    expect(ids(view.teamHeld)).toContain(job2TeamHeld.id); // job2
  });

  it("re-sorts the merged mine list globally by compareRankedPlans — job2's overdue row outranks job1's non-overdue row", () => {
    // planMineFuture (job1, NOT overdue, bucket 1) was pushed to `mine` BEFORE
    // job2Mine (job2, overdue, bucket 0) — jobs are looped in creation order.
    // A merge that's just "job1's rows then job2's rows" (no real global
    // re-sort — e.g. a broken/omitted compareRankedPlans call) would leave
    // planMineFuture ahead of job2Mine. The prioritizer's real rank (overdue
    // beats everything, per prioritizer.ts's `bucket()`) requires the
    // opposite order.
    const mineIds = view.mine.map((r) => r.ranked.plan.id);
    const idxFuture = mineIds.indexOf(planMineFuture.id);
    const idxJob2 = mineIds.indexOf(job2Mine.id);
    expect(idxFuture).toBeGreaterThanOrEqual(0);
    expect(idxJob2).toBeGreaterThanOrEqual(0);
    expect(idxJob2).toBeLessThan(idxFuture);
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

describe.skipIf(!process.env.RUN_DB_TESTS)("loadMyDay — batched fan-out (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("rows are attributed to the correct job's own jobNumber for every active job (real seeded data)", async () => {
    const jobs = await owner.job.findMany({ where: { status: "ACTIVE" } });
    if (jobs.length < 2) throw new Error("need >=2 ACTIVE jobs seeded to exercise the batch path meaningfully");
    const tenantId = jobs[0].tenantId;

    // loadMyDay (unlike loadCommandCenter) partitions rows by the actor's OWN
    // departmentIds/assignments — a PRODUCTION_HEAD with no department
    // membership gets nothing. The seed's "reviewer@despl.local" account
    // (prisma/seed.ts §12) holds every role AND every department, so it's the
    // one seeded actor guaranteed to see pool/teamHeld rows across every
    // department + job without depending on who happens to be assigned what.
    const seededUser = await owner.user.findFirst({ where: { tenantId, active: true, clientId: null, email: "reviewer@despl.local" } });
    if (!seededUser) throw new Error("seed missing reviewer@despl.local for the seeded tenant — run pnpm db:seed");
    const memberships = await owner.userDepartment.findMany({ where: { userId: seededUser.id }, select: { departmentId: true } });

    const seededActor: Actor = {
      userId: seededUser.id,
      tenantId,
      clientId: null,
      name: seededUser.name,
      email: seededUser.email,
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: memberships.map((m) => m.departmentId),
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const view = await loadMyDay(seededActor);

    const jobNumberById = new Map(jobs.map((j) => [j.id, j.jobNumber]));
    const allRows = [...view.mine, ...view.pool, ...view.teamHeld, ...view.completed];
    expect(allRows.length).toBeGreaterThan(0);
    for (const row of allRows) {
      expect(row.jobNumber).toBe(jobNumberById.get(row.jobId));
    }
  });
});

/**
 * Regression: found by Task 2.4's real browser click-through (a supervisor
 * submitted a Planning-department plan for QC, then logging in as
 * `qc@despl.local` — whose only department is QC itself, per the seed's
 * `mkUser(..., ["QC"], ["QC"])` — showed "With QC (0)", nothing to verify).
 * `/my-day`'s "With QC" tab is client-derived from `mine ∪ pool ∪ teamHeld`
 * (`_client.tsx`'s `qcQueueRows`), and the partition loop gated pool/teamHeld
 * on `actor.departmentIds.includes(ownerDepartmentId)` with no QC bypass —
 * so a SUBMITTED plan owned by any department other than QC's own never
 * reached any of the three arrays, even though `workspace.read.ts`'s
 * `qcQueue` has always treated QC verification as cross-department ("QC
 * verifies cross-dept"). This is the exact maker-checker flow invariant #3
 * exists to protect, so it's tested directly here rather than folded into
 * the fixture above (isolated tenant, own actor — a QC role this time).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("myday.read — QC cross-department verification (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("puts a SUBMITTED plan owned by a DIFFERENT department into the QC actor's teamHeld, so the With QC filter finds it", async () => {
    const org = await owner.organization.create({ data: { code: `QCPARITY-${Date.now()}`, name: "QC parity test" } });
    const tenantId = org.id;

    const deptQc = await owner.department.create({ data: { tenantId, code: "QC", name: "QC Dept" } });
    const deptOther = await owner.department.create({ data: { tenantId, code: "OTHER", name: "Other Dept" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-qcparity-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-QCPARITY-${Date.now()}`,
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const qcUser = await owner.user.create({
      data: { tenantId, email: `qcparity-${Date.now()}@x`, username: `qcparity-${Date.now()}`, name: "QC", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: qcUser.id, departmentId: deptQc.id } });
    const makerUser = await owner.user.create({
      data: { tenantId, email: `maker-${Date.now()}@x`, username: `maker-${Date.now()}`, name: "Maker", passwordHash: "x" },
    });

    const qcActor: Actor = {
      userId: qcUser.id,
      tenantId,
      clientId: null,
      name: "QC",
      email: "qc@despl.test",
      roles: [ROLES.QC],
      departmentIds: [deptQc.id], // QC's OWN department — deliberately NOT deptOther
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const jp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "Weld NDE", departmentId: deptOther.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    const submittedElsewhere = await owner.processPlan.create({
      data: {
        jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, ownerDepartmentId: deptOther.id,
        assigneeUserId: makerUser.id, submittedBy: makerUser.id, status: "SUBMITTED",
      },
    });

    const view = await loadMyDay(qcActor);

    const allIds = [...view.mine, ...view.pool, ...view.teamHeld].map((r) => r.ranked.plan.id);
    expect(allIds).toContain(submittedElsewhere.id);
    // Specifically teamHeld — it's assigned to the maker, not unassigned, and not mine.
    expect(view.teamHeld.map((r) => r.ranked.plan.id)).toContain(submittedElsewhere.id);
  });

  /**
   * Fix 2 (final whole-branch review, 17 Aug 2026): the partition-invariant
   * assertions above (`myday.read (DB)`'s "no plan id appears in more than
   * one bucket" / "every non-DONE row is mine or in my dept" / "pool rows
   * always unassigned, teamHeld rows always assigned to someone else") only
   * ever ran against a SUPERVISOR actor. QC has its own shape — a QC actor
   * CAN be the maker on their own department's plan (QC runs its own
   * NDE/inspection process through the same submit/verify flow as any other
   * department) — and `loadMyDay` itself has no bug here: the row lands in
   * `mine` exactly like it would for any other assignee (the real bug this
   * was chasing turned out to be client-side, in `_client.tsx`'s tab
   * routing). This test re-runs the same partition invariants for a QC actor
   * whose own plan is self-submitted, so the server-side precondition the
   * client fix relies on — a self-submitted "mine" row is present, in
   * exactly one bucket, and carries `submittedBy === actor.userId` — is
   * pinned down for the actor shape the bug actually lived in.
   */
  it("puts a QC actor's own self-submitted plan in `mine` (not lost), satisfying the same partition invariants a SUPERVISOR actor's rows do", async () => {
    const org = await owner.organization.create({ data: { code: `QCSELF-${Date.now()}`, name: "QC self-submit test" } });
    const tenantId = org.id;

    const deptQc = await owner.department.create({ data: { tenantId, code: "QC", name: "QC Dept" } });

    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PV", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-qcself-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-QCSELF-${Date.now()}`,
      },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const qcUser = await owner.user.create({
      data: { tenantId, email: `qcself-${Date.now()}@x`, username: `qcself-${Date.now()}`, name: "QC Self", passwordHash: "x" },
    });
    await owner.userDepartment.create({ data: { userId: qcUser.id, departmentId: deptQc.id } });

    const qcActor: Actor = {
      userId: qcUser.id,
      tenantId,
      clientId: null,
      name: "QC Self",
      email: "qcself@despl.test",
      roles: [ROLES.QC],
      departmentIds: [deptQc.id],
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    // QC's own NDE process — maker AND submitter are the same QC actor.
    const jp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 1, code: "P1", name: "Weld NDE", departmentId: deptQc.id, durationMinDays: 1, durationMaxDays: 2 },
    });
    const selfSubmitted = await owner.processPlan.create({
      data: {
        jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, ownerDepartmentId: deptQc.id,
        assigneeUserId: qcUser.id, submittedBy: qcUser.id, status: "SUBMITTED",
      },
    });

    const view = await loadMyDay(qcActor);

    // Present, and in `mine` specifically — an assignee who is the actor
    // always wins "mine" regardless of role (the partition rule every other
    // fixture in this file already exercises for a SUPERVISOR actor).
    expect(view.mine.map((r) => r.ranked.plan.id)).toContain(selfSubmitted.id);
    expect(view.pool.map((r) => r.ranked.plan.id)).not.toContain(selfSubmitted.id);
    expect(view.teamHeld.map((r) => r.ranked.plan.id)).not.toContain(selfSubmitted.id);

    const row = view.mine.find((r) => r.ranked.plan.id === selfSubmitted.id);
    expect(row?.ranked.state).toBe("SUBMITTED");
    // The exact precondition `_client.tsx`'s Fix 2 read-only render keys on.
    expect(row?.ranked.plan.submittedBy).toBe(qcUser.id);
    expect(row?.ranked.plan.assigneeUserId).toBe(qcUser.id);

    // Same disjointness invariant as the SUPERVISOR-actor test above.
    const allIds = [...view.mine, ...view.pool, ...view.teamHeld].map((r) => r.ranked.plan.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
