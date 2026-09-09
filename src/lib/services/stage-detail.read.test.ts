import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadStageDetail } from "./stage-detail.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Session 14 (AUD-028/AUD-059): the rejection-history query
 * (stage-detail.read.ts:282,286) used to join `pp.id = de.aggregate_id::int`
 * and filter `de.aggregate_id::int = ANY(${planIds}::int[])` — casting the
 * polymorphic `domain_events.aggregate_id` text column itself, on both a
 * join and an array membership test. Fixed to `pp.id::text = de.aggregate_id`
 * and `de.aggregate_id = ANY(${planIds.map(String)}::text[])`, matching
 * myday.read.ts:351's reference array pattern. No existing test file covers
 * loadStageDetail, so this is a new file. Fresh tenant per file
 * (delay.service.test.ts's shape), with TWO backing plans on the same stage
 * so the ANY() array branch is exercised with more than one id.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadStageDetail — rejection history from domain_events (DB, AUD-028/059)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const STAGE_NO = 10;
  let tenantId = 0;
  let jobId = 0;
  let unitId = 0;
  let planAId = 0;
  let planBId = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `STAGEDET-${Date.now()}`, name: "stage-detail.read test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-stagedet-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-STAGEDET-${Date.now()}`,
      },
    });
    jobId = job.id;
    const equipment = await owner.equipment.create({ data: { jobId: job.id, name: "Vessel A" } });
    const unit = await owner.unit.create({ data: { equipmentId: equipment.id, serialNo: "SR01", jobId: job.id } });
    unitId = unit.id;

    // Two job processes both backing the same work-order stage, so this
    // stage has TWO backing plans — the case the ANY() array fix needs.
    const jpA = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10A", name: "Rolling", departmentId: dept.id, workOrderStages: [STAGE_NO] },
    });
    const jpB = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 11, code: "10B", name: "Welding", departmentId: dept.id, workOrderStages: [STAGE_NO] },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date("2026-01-01"), isCurrent: true },
    });
    const planA = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpA.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "IN_PROGRESS" },
    });
    const planB = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jpB.id, unitId: unit.id, ownerDepartmentId: dept.id, status: "IN_PROGRESS" },
    });
    planAId = planA.id;
    planBId = planB.id;

    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planAId), type: "ProcessRejected", payload: { reason: "bad weld" }, at: new Date() },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planBId), type: "ProcessRejected", payload: { reason: "dimension out of tolerance" }, at: new Date() },
    });

    // A domain_events row for a different aggregate_type with a deliberately
    // non-numeric aggregate_id — must never throw a cast error. Proves AUD-059.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "Ncr", aggregateId: "ncr-not-numeric", type: "NcrRaised", payload: {}, at: new Date() },
    });
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function actor(): Actor {
    return {
      userId: 1, tenantId, clientId: null, name: "Test", email: "t@despl.local",
      roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
      themePreference: "SYSTEM", outdoorMode: false,
    };
  }

  it("returns both backing plans' rejections via the multi-id ANY() lookup, without throwing on the unrelated non-numeric row", async () => {
    const detail = await loadStageDetail(actor(), jobId, unitId, STAGE_NO);
    expect(detail).not.toBeNull();
    expect(detail!.backingPlans.map((p) => p.planId).sort()).toEqual([planAId, planBId].sort());
    expect(detail!.rejections.length).toBe(2);
    const reasons = detail!.rejections.map((r) => r.reason).sort();
    expect(reasons).toEqual(["bad weld", "dimension out of tolerance"].sort());
  });
});
