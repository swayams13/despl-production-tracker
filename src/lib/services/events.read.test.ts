import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEvents } from "./events.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Session 14 (AUD-028/AUD-059): both branches of loadEvents' UNION ALL
 * (events.read.ts:67 ProcessPlan, :82 DelayReason) used to join
 * `pp.id = de.aggregate_id::int` / `dr.id = de.aggregate_id::int` — casting
 * the polymorphic `domain_events.aggregate_id` text column itself instead of
 * casting the int column to text. Fixed to `pp.id::text = de.aggregate_id` /
 * `dr.id::text = de.aggregate_id`, matching reports.read.ts/myday.read.ts's
 * reference pattern (no other file previously tested loadEvents against
 * domain_events, so this is a new file, not an addition to an existing one).
 * Fresh tenant per file (delay.service.test.ts's shape).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadEvents (DB, AUD-028/059)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
  let planId = 0;
  let delayReasonId = 0;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `EVENTS-${Date.now()}`, name: "events.read test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const user = await owner.user.create({ data: { tenantId, email: `events-${Date.now()}@x`, username: `events-${Date.now()}`, name: "Filer", passwordHash: "x" } });
    const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "MATERIAL", name: "Material shortage" } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-events-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-EVENTS-${Date.now()}`,
      },
    });
    jobId = job.id;
    const jp = await owner.jobProcess.create({
      data: { jobId: job.id, seq: 10, code: "10", name: "Rolling", departmentId: dept.id },
    });
    const run = await owner.scheduleRun.create({
      data: { jobId: job.id, version: 1, mode: "FORWARD", projectStartDate: new Date("2026-01-01"), isCurrent: true },
    });
    const plan = await owner.processPlan.create({
      data: { jobId: job.id, scheduleRunId: run.id, jobProcessId: jp.id, unitId: null, ownerDepartmentId: dept.id, status: "IN_PROGRESS" },
    });
    planId = plan.id;
    const delayReason = await owner.delayReason.create({
      data: { processPlanId: plan.id, categoryId: category.id, filedBy: user.id, jobId: job.id },
    });
    delayReasonId = delayReason.id;

    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planId), type: "ProcessStarted", payload: {}, at: new Date() },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "DelayReason", aggregateId: String(delayReasonId), type: "DelayReasonFiled", payload: {}, at: new Date() },
    });

    // Different aggregate_type, deliberately non-numeric aggregate_id — must
    // never cause a cast error even though it lives in the same table both
    // UNION branches read from. Proves AUD-059.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "DispatchBatch", aggregateId: "not-a-number-xyz", type: "DispatchPacked", payload: {}, at: new Date() },
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

  it("resolves the ProcessPlan branch's process context without throwing on the unrelated non-numeric row", async () => {
    const events = await loadEvents(actor(), { jobId, limit: 50 });
    const processEvent = events.find((e) => e.type === "ProcessStarted");
    expect(processEvent).toBeDefined();
    expect(processEvent!.processName).toBe("Rolling");
  });

  it("resolves the DelayReason branch's category label", async () => {
    const events = await loadEvents(actor(), { jobId, limit: 50 });
    const delayEvent = events.find((e) => e.type === "DelayReasonFiled");
    expect(delayEvent).toBeDefined();
    expect(delayEvent!.label).toBe("filed a delay reason — Material shortage");
  });
});
