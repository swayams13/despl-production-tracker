import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * §6 notifications, DB-gated (needs a real seeded ProcessPlan/User/Role
 * chain — nothing here is pure). Two things pinned: the event-driven writes
 * that ride inside process.service's own transaction (submit → QC, reject →
 * maker), and syncOverdueStageNotifications' idempotency.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("notifications (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, rejectProcess } = await import("./process.service");
  const { syncOverdueStageNotifications, nudgeQc } = await import("./notifications.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actor(tenantId: number, userId: number, roles: string[]): Actor {
    return { userId, tenantId, clientId: null, name: `U${userId}`, email: `u${userId}@x`, roles: roles as never, departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
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

    // Reset this test's own target plan on whatever run is currently current,
    // so a rerun against this no-cleanup seed DB starts from NOT_STARTED again
    // — persistScheduleRun now carries real work forward across a reschedule
    // (audit C1 fix) instead of resetting it.
    await owner.processPlan.updateMany({
      where: { scheduleRun: { jobId, isCurrent: true }, jobProcessId: seq1Id, unitId: unit.id },
      data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
    });

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
  describe("syncOverdueStageNotifications idempotency (isolated fixture)", () => {
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
        data: { jobId, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: REF.dept, status: "IN_PROGRESS", plannedFinish: past },
      });
      planId = plan.id;
    });

    afterAll(teardown);

    it("never duplicates the STAGE_OVERDUE row for the same plan across repeated calls", async () => {
      await syncOverdueStageNotifications(REF.tenant);
      const first = await owner.notification.count({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: planId } });
      expect(first).toBeGreaterThan(0);

      await syncOverdueStageNotifications(REF.tenant);
      const second = await owner.notification.count({ where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: planId } });

      expect(second).toBe(first);
    });
  });

  // ── Task 4.3: assignee-first recipient resolution ──────────────────────
  // Own throwaway tenant (not seed tenant 1), so productionHeadIds/dept-member
  // scans can't pick up unrelated seed users — deterministic recipient sets.
  describe("syncOverdueStageNotifications — assignee-first recipient resolution", () => {
    let tenantId = 0;
    let deptId = 0;
    let phUserId = 0;
    let memberAId = 0;
    let memberBId = 0;
    let inactiveMemberId = 0;
    let assignedPlanId = 0;
    let unassignedPlanId = 0;
    let inactiveAssigneePlanId = 0;
    const past = new Date(Date.now() - 20 * 864e5);

    beforeAll(async () => {
      const org = await owner.organization.create({ data: { code: `NOTIFY-ASSIGNEE-${Date.now()}`, name: "Notify assignee test" } });
      tenantId = org.id;
      const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
      deptId = dept.id;

      // Role rows are per-tenant (@@unique([tenantId, code])) — this fresh
      // org has none yet, unlike the seed tenant the other fixtures reuse.
      const phRole = await owner.role.create({ data: { tenantId, code: "PRODUCTION_HEAD", name: "Production Head" } });

      const mkUser = async (suffix: string) => {
        const u = await owner.user.create({
          data: { tenantId, email: `${suffix}-${Date.now()}@x`, username: `${suffix}-${Date.now()}`, name: suffix, passwordHash: "x" },
        });
        await owner.userDepartment.create({ data: { userId: u.id, departmentId: deptId } });
        return u;
      };
      const ph = await owner.user.create({
        data: { tenantId, email: `ph-${Date.now()}@x`, username: `ph-${Date.now()}`, name: "PH", passwordHash: "x" },
      });
      await owner.userRole.create({ data: { userId: ph.id, roleId: phRole.id } });
      phUserId = ph.id;

      const memberA = await mkUser("membera");
      const memberB = await mkUser("memberb");
      memberAId = memberA.id;
      memberBId = memberB.id;

      // Deactivated but still on the plan — setUserActive (by design, C29)
      // never releases a deactivated user's assigned plans, so this row
      // stays assignee-first without the fix in Finding 2.
      const inactiveMember = await mkUser("inactivemember");
      await owner.user.update({ where: { id: inactiveMember.id }, data: { active: false } });
      inactiveMemberId = inactiveMember.id;

      const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
      const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
      const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
      const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
      const job = await owner.job.create({
        data: { tenantId, publicId: `pub-notify-assignee-${Date.now()}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `NOTIFY-ASSIGNEE-${Date.now()}` },
      });
      const run = await owner.scheduleRun.create({ data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: past, isCurrent: true } });

      const jpAssigned = await owner.jobProcess.create({ data: { jobId: job.id, seq: 1, code: "A1", name: "Assigned process", departmentId: deptId, workOrderStages: [1] } });
      const assignedPlan = await owner.processPlan.create({
        data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpAssigned.id, unitId: null, ownerDepartmentId: deptId, status: "IN_PROGRESS", plannedFinish: past, assigneeUserId: memberAId },
      });
      assignedPlanId = assignedPlan.id;

      const jpUnassigned = await owner.jobProcess.create({ data: { jobId: job.id, seq: 2, code: "A2", name: "Unassigned process", departmentId: deptId, workOrderStages: [1] } });
      const unassignedPlan = await owner.processPlan.create({
        data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpUnassigned.id, unitId: null, ownerDepartmentId: deptId, status: "IN_PROGRESS", plannedFinish: past },
      });
      unassignedPlanId = unassignedPlan.id;

      const jpInactiveAssignee = await owner.jobProcess.create({ data: { jobId: job.id, seq: 3, code: "A3", name: "Inactive-assignee process", departmentId: deptId, workOrderStages: [1] } });
      const inactiveAssigneePlan = await owner.processPlan.create({
        data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpInactiveAssignee.id, unitId: null, ownerDepartmentId: deptId, status: "IN_PROGRESS", plannedFinish: past, assigneeUserId: inactiveMemberId },
      });
      inactiveAssigneePlanId = inactiveAssigneePlan.id;
    });

    it("an assigned overdue plan notifies the assignee + PH only, not other dept members", async () => {
      await syncOverdueStageNotifications(tenantId);

      const notifs = await owner.notification.findMany({
        where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: assignedPlanId },
      });
      expect(notifs.map((n) => n.recipientId).sort()).toEqual([memberAId, phUserId].sort());
    });

    it("an unassigned overdue plan falls back to all dept members + PH (unchanged behavior)", async () => {
      await syncOverdueStageNotifications(tenantId);

      const notifs = await owner.notification.findMany({
        where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: unassignedPlanId },
      });
      expect(notifs.map((n) => n.recipientId).sort()).toEqual([memberAId, memberBId, phUserId].sort());
    });

    // Final whole-branch review, Finding 2: the assignee-first branch had no
    // `active` filter, unlike the dept-supervisor fallback it partially
    // replaced. A deactivated assignee can't log in, so notifying only them
    // (+ PH) leaves dept supervisors — who COULD act on it — never notified.
    it("an overdue plan assigned to an INACTIVE user falls back to active dept members + PH, not just PH", async () => {
      await syncOverdueStageNotifications(tenantId);

      const notifs = await owner.notification.findMany({
        where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: inactiveAssigneePlanId },
      });
      // The inactive assignee themselves must NOT be a recipient (they can't
      // log in to act on it) — the fallback set is active dept members + PH,
      // same as the unassigned case above.
      expect(notifs.map((n) => n.recipientId).sort()).toEqual([memberAId, memberBId, phUserId].sort());
    });
  });

  // ── D32: nudgeQc — recipients (QC + PH, not an unrelated dept member) and
  // the per-(plan, actor) cooldown. Own throwaway tenant/plan, same pattern
  // as the assignee-first fixture above. ────────────────────────────────
  describe("nudgeQc", () => {
    let tenantId = 0;
    let qcUserId = 0;
    let phUserId = 0;
    let otherSupervisorId = 0;
    let planId = 0;

    beforeAll(async () => {
      const org = await owner.organization.create({ data: { code: `NUDGE-${Date.now()}`, name: "Nudge test" } });
      tenantId = org.id;
      const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });

      const qcRole = await owner.role.create({ data: { tenantId, code: "QC", name: "QC" } });
      const phRole = await owner.role.create({ data: { tenantId, code: "PRODUCTION_HEAD", name: "Production Head" } });
      const supRole = await owner.role.create({ data: { tenantId, code: "SUPERVISOR", name: "Supervisor" } });

      const mkUser = async (suffix: string, roleId: number) => {
        const u = await owner.user.create({
          data: { tenantId, email: `${suffix}-${Date.now()}@x`, username: `${suffix}-${Date.now()}`, name: suffix, passwordHash: "x" },
        });
        await owner.userRole.create({ data: { userId: u.id, roleId } });
        return u;
      };
      qcUserId = (await mkUser("nudgeqc", qcRole.id)).id;
      phUserId = (await mkUser("nudgeph", phRole.id)).id;
      otherSupervisorId = (await mkUser("nudgesup-other", supRole.id)).id;

      const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-NUDGE-${Date.now()}` } });
      const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
      const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
      const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
      const job = await owner.job.create({
        data: { tenantId, publicId: `pub-nudge-${Date.now()}`, clientId: client.id, familyId: family.id, templateVersionId: tv.id, jobNumber: `NUDGE-TEST-${Date.now()}` },
      });
      const run = await owner.scheduleRun.create({ data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true } });
      const jp = await owner.jobProcess.create({ data: { jobId: job.id, seq: 1, code: "N1", name: "Held process", departmentId: dept.id, workOrderStages: [1] } });
      const plan = await owner.processPlan.create({
        data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status: "ON_HOLD" },
      });
      planId = plan.id;
    });

    it("notifies exactly QC + Production Head, not an unrelated supervisor", async () => {
      const sup = actor(tenantId, otherSupervisorId, [ROLES.SUPERVISOR]);
      await nudgeQc(sup, planId, 3);
      const notifs = await owner.notification.findMany({ where: { type: "NUDGE", entityType: "ProcessPlan", entityId: planId } });
      expect(notifs.map((n) => n.recipientId).sort()).toEqual([qcUserId, phUserId].sort());
      expect(notifs[0].body).toContain("held 3d");
    });

    it("refuses a second nudge from the SAME actor within the cooldown window", async () => {
      const sup = actor(tenantId, otherSupervisorId, [ROLES.SUPERVISOR]);
      await expect(nudgeQc(sup, planId, 3)).rejects.toMatchObject({ code: "NUDGE_COOLDOWN" });
    });

    it("does NOT block a DIFFERENT actor nudging the same plan", async () => {
      const otherActor = actor(tenantId, qcUserId, [ROLES.QC]); // any other user id, cooldown is per-(plan,actor)
      await nudgeQc(otherActor, planId, 3);
      const notifs = await owner.notification.findMany({ where: { type: "NUDGE", entityType: "ProcessPlan", entityId: planId } });
      // 2 recipients from the first nudge + 2 more from this second, different-actor nudge.
      expect(notifs).toHaveLength(4);
    });
  });
});
