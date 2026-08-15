import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * §6 notifications, DB-gated (needs a real seeded ProcessPlan/User/Role
 * chain — nothing here is pure). Two things pinned: the event-driven writes
 * that ride inside process.service's own transaction (submit → QC, reject →
 * maker), and syncNotifications' idempotency.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("notifications (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, rejectProcess } = await import("./process.service");
  const { syncNotifications } = await import("./notifications.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actor(tenantId: number, userId: number, roles: string[]): Actor {
    return { userId, tenantId, clientId: null, name: `U${userId}`, email: `u${userId}@x`, roles: roles as never, departmentIds: [] };
  }

  async function despl320(): Promise<{ jobId: number; tenantId: number }> {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    return { jobId: job.id, tenantId: job.tenantId };
  }

  async function procId(jobId: number, seq: number): Promise<number> {
    const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId, seq } });
    return jp.id;
  }

  const future = new Date(Date.now() + 45 * 864e5);

  it("submitting a process notifies every QC user; rejecting notifies the maker back", async () => {
    const { jobId, tenantId } = await despl320();
    const planner = actor(tenantId, 1, [ROLES.PRODUCTION_HEAD]);
    const maker = actor(tenantId, 1, [ROLES.PRODUCTION_HEAD]);
    const checker = actor(tenantId, 2, [ROLES.QC]);

    const seq1Id = await procId(jobId, 1);
    const unit = (await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } }))[4];
    const run = await generateSchedule(planner, { jobId, mode: "FORWARD", projectStartDate: future });
    const planId = run.processPlans.find((p) => p.jobProcessId === seq1Id && p.unitId === unit.id)!.id;

    const qcUserIds = (
      await owner.user.findMany({ where: { tenantId, active: true, roles: { some: { role: { code: "QC" } } } }, select: { id: true } })
    ).map((u) => u.id);
    expect(qcUserIds.length).toBeGreaterThan(0);

    await startProcess(maker, { processPlanId: planId });
    await submitProcess(maker, { processPlanId: planId });

    const submittedNotifs = await owner.notification.findMany({
      where: { type: "ITEM_SUBMITTED", entityType: "ProcessPlan", entityId: planId },
    });
    expect(submittedNotifs.map((n) => n.recipientId).sort()).toEqual([...qcUserIds].sort());

    await rejectProcess(checker, { processPlanId: planId, reason: "test rejection" });
    const rejectedNotifs = await owner.notification.findMany({
      where: { type: "ITEM_REJECTED", entityType: "ProcessPlan", entityId: planId },
    });
    expect(rejectedNotifs).toHaveLength(1);
    expect(rejectedNotifs[0].recipientId).toBe(maker.userId);
  });

  // ── idempotency: an isolated throwaway job/plan, never touched by any ──
  // other DB test file's generateSchedule() calls flipping `is_current`
  // elsewhere (same parallel-safety reasoning as spine.read.test.ts).
  describe("syncNotifications idempotency (isolated fixture)", () => {
    const REF = { tenant: 1, client: 1, family: 1, templateVersion: 1, dept: 1 };
    const JOB_NUMBER = "NOTIFY-SYNC-TEST";
    let jobId = 0;
    let planId = 0;
    const past = new Date(Date.now() - 20 * 864e5);

    async function teardown(): Promise<void> {
      const job = await owner.job.findUnique({ where: { tenantId_jobNumber: { tenantId: REF.tenant, jobNumber: JOB_NUMBER } } });
      if (!job) return;
      await owner.processPlan.deleteMany({ where: { jobProcess: { jobId: job.id } } });
      await owner.scheduleRun.deleteMany({ where: { jobId: job.id } });
      await owner.jobProcess.deleteMany({ where: { jobId: job.id } });
      await owner.job.delete({ where: { id: job.id } });
    }

    beforeAll(async () => {
      await teardown();
      const job = await owner.job.create({
        data: {
          tenantId: REF.tenant,
          publicId: "notify-sync-test",
          clientId: REF.client,
          familyId: REF.family,
          templateVersionId: REF.templateVersion,
          jobNumber: JOB_NUMBER,
        },
      });
      jobId = job.id;
      const jp = await owner.jobProcess.create({
        data: { jobId, seq: 1, code: "NST", name: "NST process", departmentId: REF.dept, workOrderStages: [1] },
      });
      const run = await owner.scheduleRun.create({
        data: { jobId, version: 1, mode: "FORWARD", projectStartDate: past, isCurrent: true },
      });
      const plan = await owner.processPlan.create({
        data: { scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: REF.dept, status: "IN_PROGRESS", plannedFinish: past },
      });
      planId = plan.id;
    });

    afterAll(teardown);

    it("never duplicates the STAGE_OVERDUE row for the same plan across repeated calls", async () => {
      const ph = actor(REF.tenant, 1, [ROLES.PRODUCTION_HEAD]);

      await syncNotifications(ph);
      const first = await owner.notification.count({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: planId } });
      expect(first).toBeGreaterThan(0);

      await syncNotifications(ph);
      const second = await owner.notification.count({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: planId } });

      expect(second).toBe(first);
    });
  });
});
