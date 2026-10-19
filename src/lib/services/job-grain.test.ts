import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import type { RecordWorkInput } from "@/lib/shared/schemas";
import type { WorkOrg } from "./work.test-util";

/**
 * Lean Core L1.3 (D5): processes 1-11 and 33 are planned once per job (a unit-less ProcessPlan). The pure rules are in
 * shared/job-grain.test.ts; here, against the database: the scheduler's output and what a reschedule carries into the
 * collapsed plan, the derived roll-up across units, the dispatch gate, and scripts/lean-backfill-job-grain.ts.
 * // ponytail: no cleanup of fixtures: disposable test DB, per-run org codes.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;
const day = (d: string) => new Date(`${d}T00:00:00Z`);

describe.skipIf(!RUN_DB)("JOB-grain processes (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { makeWorkOrg } = await import("./work.test-util");
  const { generateSchedule } = await import("./schedule.service");
  const { recordWork } = await import("./work.service");
  const { withTenant } = await import("@/lib/db");
  const { assertUnitProductionComplete } = await import("./_shared");
  const { backfillJobGrain, planJobGrainBackfill } = await import("../../../scripts/lean-backfill-job-grain");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let head: Actor;
  let sup: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "JG");
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    await o.user("admin", ["ADMIN"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const current = (jobId: number) => owner.scheduleRun.findFirstOrThrow({ where: { jobId, isCurrent: true }, include: { processPlans: true } });
  const setGrain = (jobProcessId: number, grain: "JOB" | "UNIT") => owner.jobProcess.update({ where: { id: jobProcessId }, data: { grain } });
  // The scheduler needs each process's envelope days (the fixture only gives durations).
  const reschedule = async (jobId: number) => {
    await owner.jobProcess.updateMany({
      where: { jobId },
      data: { envelopeStartByMinDays: 0, envelopeStartByMaxDays: 0, envelopeFinishByMinDays: 5, envelopeFinishByMaxDays: 5 },
    });
    return generateSchedule(head, { jobId, mode: "FORWARD", projectStartDate: day("2026-11-02") });
  };

  describe("generateSchedule", () => {
    it("plans a JOB-grain process once, without a unit, and a UNIT-grain one per unit", async () => {
      const j = await o.job({ units: 3, processes: [{ code: "5" }, { code: "20" }] });
      await setGrain(j.processes.get("5")!, "JOB");
      await reschedule(j.job.id);
      const plans = (await current(j.job.id)).processPlans;
      expect(plans.filter((p) => p.jobProcessId === j.processes.get("5")!).map((p) => p.unitId)).toEqual([null]);
      expect(plans.filter((p) => p.jobProcessId === j.processes.get("20")!)).toHaveLength(3);
    });

    it("a process still marked UNIT (every job until the backfill) schedules per unit, as before", async () => {
      const j = await o.job({ units: 3, processes: [{ code: "5" }] });
      await reschedule(j.job.id);
      expect((await current(j.job.id)).processPlans).toHaveLength(3);
    });
  });

  // What the new unit-less plan inherits from the per-unit plans a reschedule replaces.
  describe("reschedule collapse: unit plans -> one job plan", () => {
    type Unit = { status: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "COMPLETE"; start?: string; finish?: string; by?: number };
    const cases: Array<[string, [Unit, Unit], { status: string; start?: string; finish?: string }]> = [
      ["all complete: COMPLETE, earliest start, latest finish", [{ status: "COMPLETE", start: "2026-10-05", finish: "2026-10-09" }, { status: "COMPLETE", start: "2026-10-03", finish: "2026-10-12" }], { status: "COMPLETE", start: "2026-10-03", finish: "2026-10-12" }],
      ["one unit still open: IN_PROGRESS, no finish", [{ status: "COMPLETE", start: "2026-10-05", finish: "2026-10-09" }, { status: "NOT_STARTED" }], { status: "IN_PROGRESS", start: "2026-10-05" }],
      ["nothing started: NOT_STARTED", [{ status: "NOT_STARTED" }, { status: "NOT_STARTED" }], { status: "NOT_STARTED" }],
      ["both submitted: SUBMITTED (the maker survives)", [{ status: "SUBMITTED", start: "2026-10-05", by: -1 }, { status: "SUBMITTED", start: "2026-10-06", by: -1 }], { status: "SUBMITTED", start: "2026-10-05" }],
    ];
    it.each(cases)("%s", async (_name, [u0, u1], want) => {
      const j = await o.job({ units: 2, processes: [{ code: "5" }] });
      const maker = await o.user("maker", ["SUPERVISOR"], [o.fab.id]);
      for (const [i, u] of [u0, u1].entries()) {
        await owner.processPlan.update({
          where: { id: j.plan("5", i) },
          data: {
            status: u.status,
            actualStart: u.start ? day(u.start) : null,
            actualFinish: u.finish ? day(u.finish) : null,
            submittedBy: u.by === -1 ? maker.userId : null,
          },
        });
      }
      await setGrain(j.processes.get("5")!, "JOB");
      await reschedule(j.job.id);

      const plans = (await current(j.job.id)).processPlans.filter((p) => p.jobProcessId === j.processes.get("5")!);
      expect(plans).toHaveLength(1);
      const [plan] = plans;
      expect(plan.unitId).toBeNull();
      expect(plan.status).toBe(want.status);
      expect(plan.actualStart).toEqual(want.start ? day(want.start) : null);
      expect(plan.actualFinish).toEqual(want.finish ? day(want.finish) : null);
      if (want.status === "SUBMITTED") expect(plan.submittedBy).toBe(maker.userId);
    });

    it("units submitted by DIFFERENT people never collapse into a SUBMITTED plan (a maker could then verify their own work)", async () => {
      const j = await o.job({ units: 2, processes: [{ code: "5" }] });
      const alice = await o.user("alice", ["SUPERVISOR"], [o.fab.id]);
      const bob = await o.user("bob", ["SUPERVISOR"], [o.fab.id]);
      await owner.processPlan.update({ where: { id: j.plan("5", 0) }, data: { status: "SUBMITTED", submittedBy: alice.userId } });
      await owner.processPlan.update({ where: { id: j.plan("5", 1) }, data: { status: "SUBMITTED", submittedBy: bob.userId } });

      // the backfill reports it as risky and skips it unless forced...
      const planned = await planJobGrainBackfill(owner, { jobNumbers: [j.job.jobNumber] });
      expect(planned[0].processes[0]).toMatchObject({ code: "5", risky: true, skipped: true });

      // ...and a reschedule that does collapse it returns the work to IN_PROGRESS with no maker on record.
      await setGrain(j.processes.get("5")!, "JOB");
      await reschedule(j.job.id);
      const [plan] = (await current(j.job.id)).processPlans.filter((p) => p.jobProcessId === j.processes.get("5")!);
      expect(plan).toMatchObject({ unitId: null, status: "IN_PROGRESS", submittedBy: null });
    });

    it("the previous run stays, with its per-unit plans (nothing is deleted)", async () => {
      const j = await o.job({ units: 2, processes: [{ code: "5" }] });
      await setGrain(j.processes.get("5")!, "JOB");
      await reschedule(j.job.id);
      const old = await owner.scheduleRun.findFirstOrThrow({ where: { jobId: j.job.id, isCurrent: false }, include: { processPlans: true } });
      expect(old.processPlans.map((p) => p.unitId).sort()).toEqual(j.units.map((u) => u.id).sort());
    });
  });

  it("a reschedule keeps an assignment and the reported times of a per-unit plan", async () => {
    const j = await o.job({ units: 2, processes: [{ code: "20" }] });
    const reported = new Date(Date.now() - 3_600_000);
    await owner.processPlan.update({ where: { id: j.plan("20", 0) }, data: { assigneeUserId: sup.userId, status: "IN_PROGRESS", actualStart: day("2026-10-05"), reportedStartAt: reported } });
    await reschedule(j.job.id);
    const plan = (await current(j.job.id)).processPlans.find((p) => p.jobProcessId === j.processes.get("20")! && p.unitId === j.units[0].id)!;
    expect(plan).toMatchObject({ assigneeUserId: sup.userId, status: "IN_PROGRESS" });
    expect(plan.reportedStartAt).toEqual(reported);
  });

  describe("derived roll-up across units", () => {
    const start = (j: Awaited<ReturnType<WorkOrg["job"]>>, unit: number, action: "START" | "DONE") =>
      recordWork(sup, { jobId: j.job.id, action, items: [{ kind: "ASSEMBLY_STEP", id: j.step(1, unit) }] } as RecordWorkInput);
    const jobPlan = async (j: Awaited<ReturnType<WorkOrg["job"]>>) => (await owner.processPlan.findUniqueOrThrow({ where: { id: j.plan("20") } })).status;

    it("a job-level plan is IN_PROGRESS once any unit starts and COMPLETE only when every unit's items are", async () => {
      const j = await o.job({ units: 2, processes: [{ code: "20", grain: "JOB" }], steps: [{ seq: 1, processSeq: 20, requiresQc: false }] });
      expect(await jobPlan(j)).toBe("NOT_STARTED");

      expect((await start(j, 0, "START")).rolledUp).toMatchObject([{ processPlanId: j.plan("20"), to: "IN_PROGRESS" }]);
      await start(j, 0, "DONE");
      expect(await jobPlan(j)).toBe("IN_PROGRESS"); // unit 1 has not started

      await start(j, 1, "START");
      const last = await start(j, 1, "DONE");
      expect(last.rolledUp).toMatchObject([{ processPlanId: j.plan("20"), from: "IN_PROGRESS", to: "COMPLETE" }]);
      expect(await jobPlan(j)).toBe("COMPLETE");
    });
  });

  describe("dispatch", () => {
    it("refuses a unit while a job-level plan (documentation, MDR) is incomplete, and lets it through once complete", async () => {
      const j = await o.job({ units: 2, processes: [{ code: "33", grain: "JOB" }, { code: "20", status: "COMPLETE" }] });
      const gate = () => withTenant(o.tenantId, (tx) => assertUnitProductionComplete(tx, j.units[0].id, j.job.id));
      await expect(gate()).rejects.toMatchObject({ code: "UNIT_NOT_COMPLETE", detail: { incompleteProcessPlanIds: [j.plan("33")] } });

      await owner.processPlan.update({ where: { id: j.plan("33") }, data: { status: "COMPLETE", actualFinish: new Date() } });
      await gate();
    });
  });

  describe("scripts/lean-backfill-job-grain.ts", () => {
    const build = async () => {
      const j = await o.job({ units: 3, processes: [{ code: "5" }, { code: "6" }, { code: "20" }] });
      return j;
    };

    it("a dry run reports and writes nothing", async () => {
      const j = await build();
      const before = await current(j.job.id);
      const report = await backfillJobGrain(owner, { apply: false, jobNumbers: [j.job.jobNumber] });
      expect(report.mode).toBe("DRY_RUN");
      expect(report.jobs[0].processes.map((p) => p.code)).toEqual(["5", "6"]);
      expect(report).toMatchObject({ totals: { processes: 2, plansBefore: 9, plansAfter: 5 } });
      const after = await current(j.job.id);
      expect(after.id).toBe(before.id);
      expect((await owner.jobProcess.findMany({ where: { jobId: j.job.id, grain: "JOB" } })).length).toBe(0);
    });

    it("--apply collapses the listed processes into new run version, leaves the others, audits each, and a second run changes nothing", async () => {
      const j = await build();
      const oldRun = await current(j.job.id);
      const report = await backfillJobGrain(owner, { apply: true, jobNumbers: [j.job.jobNumber] });
      expect(report.mode).toBe("APPLIED");

      const now = await current(j.job.id);
      expect(now.id).not.toBe(oldRun.id);
      expect(now.version).toBe(oldRun.version + 1);
      expect(now.processPlans).toHaveLength(5);
      expect(now.processPlans.filter((p) => p.unitId == null).map((p) => p.jobProcessId).sort()).toEqual([j.processes.get("5")!, j.processes.get("6")!].sort());
      expect(now.processPlans.filter((p) => p.jobProcessId === j.processes.get("20")!)).toHaveLength(3);
      expect((await owner.jobProcess.findMany({ where: { jobId: j.job.id, grain: "JOB" } })).map((p) => p.code).sort()).toEqual(["5", "6"]);
      // the superseded run is intact
      expect((await owner.processPlan.count({ where: { scheduleRunId: oldRun.id } }))).toBe(9);
      // one grain audit row and one collapse audit row per process
      expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "backfill.jobGrain", entityType: "JobProcess", entityId: { in: [j.processes.get("5")!, j.processes.get("6")!].map(String) } } })).toBe(2);
      expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, action: "schedule.collapseJobGrain", entityId: { in: now.processPlans.filter((p) => p.unitId == null).map((p) => String(p.id)) } } })).toBe(2);

      const again = await backfillJobGrain(owner, { apply: true, jobNumbers: [j.job.jobNumber] });
      expect(again.jobs).toEqual([]);
      expect((await current(j.job.id)).id).toBe(now.id);
    });

    it("skips a process whose units are SUBMITTED beside others unless --force-mixed", async () => {
      const j = await build();
      await owner.processPlan.update({ where: { id: j.plan("5", 0) }, data: { status: "SUBMITTED", submittedBy: head.userId } });
      const plan = await planJobGrainBackfill(owner, { jobNumbers: [j.job.jobNumber] });
      expect(plan[0].processes.find((p) => p.code === "5")).toMatchObject({ risky: true, skipped: true });
      expect(plan[0].processes.find((p) => p.code === "6")).toMatchObject({ risky: false, skipped: false });

      await backfillJobGrain(owner, { apply: true, jobNumbers: [j.job.jobNumber] });
      const left = (await current(j.job.id)).processPlans.filter((p) => p.jobProcessId === j.processes.get("5")!);
      expect(left).toHaveLength(3); // the mixed process kept its per-unit plans

      await backfillJobGrain(owner, { apply: true, forceMixed: true, jobNumbers: [j.job.jobNumber] });
      const forced = (await current(j.job.id)).processPlans.filter((p) => p.jobProcessId === j.processes.get("5")!);
      expect(forced).toHaveLength(1);
      expect(forced[0].status).toBe("IN_PROGRESS");
    });

    it("never touches another tenant's job", async () => {
      const other = await makeWorkOrg(owner, "JGB");
      await other.user("admin", ["ADMIN"]);
      const theirs = await other.job({ units: 2, processes: [{ code: "5" }] });
      const mine = await build();
      await backfillJobGrain(owner, { apply: true, jobNumbers: [mine.job.jobNumber] });
      expect((await current(theirs.job.id)).processPlans).toHaveLength(2);
      expect((await owner.jobProcess.findUniqueOrThrow({ where: { id: theirs.processes.get("5")! } })).grain).toBe("UNIT");
    });
  });
});
