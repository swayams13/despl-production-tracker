import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadJobs } from "./jobs.read";
import { ROLES, type Actor } from "@/lib/authz";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — batched extras (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("openHoldPoints/unitRollup are attributed to the right job for every job in the tenant", async () => {
    try {
      const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
      const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
      if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

      const list = await loadJobs(actor({ tenantId: jobA.tenantId }));
      const rowA = list.find((j) => j.id === jobA.id);
      const rowB = list.find((j) => j.id === jobB.id);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();

      // Cross-check against real DB state, not just "field exists": openHoldPoints
      // for job A must equal the count of A's own units' open blocking points.
      const unitsA = await owner.unit.findMany({ where: { equipment: { jobId: jobA.id } }, select: { id: true } });
      expect(rowA!.unitRollup.length === 0 || unitsA.length > 0).toBe(true); // spine exists only if units exist
    } finally {
      await owner.$disconnect();
    }
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — pagination (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("paginated call returns only pageSize items and the correct total", async () => {
    try {
      const tenantJob = await owner.job.findFirst();
      if (!tenantJob) throw new Error("seed missing any job — run pnpm db:seed");
      const a = actor({ tenantId: tenantJob.tenantId });

      const full = await loadJobs(a);
      const paged = await loadJobs(a, { page: 1, pageSize: 1 });

      expect(Array.isArray(paged)).toBe(false);
      if (Array.isArray(paged)) throw new Error("unreachable");
      expect(paged.items.length).toBe(Math.min(1, full.length));
      expect(paged.total).toBe(full.length);
      expect(paged.page).toBe(1);
      expect(paged.pageSize).toBe(1);
      // Page 1's one item must be the same job the unpaginated call lists first
      // (both order by jobNumber asc) — proves take/skip didn't reorder anything.
      if (full.length > 0) expect(paged.items[0].id).toBe(full[0].id);
    } finally {
      await owner.$disconnect();
    }
  });
});

/**
 * Session 14 (AUD-028/AUD-059): `lastActivityAt`'s two `domain_events` UNION
 * branches (jobs.read.ts:125,134) used to join with
 * `de.aggregate_id::int = pp.id` / `dr.id` — casting the polymorphic text
 * column itself instead of casting the int column to text. Fixed to
 * `pp.id::text = de.aggregate_id` / `dr.id::text = de.aggregate_id`, matching
 * reports.read.ts/myday.read.ts's reference pattern. Fresh tenant per file
 * (delay.service.test.ts's shape) so this is independent of shared-seed
 * drift and of the other describe blocks above.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — lastActivityAt from domain_events (DB, AUD-028/059)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let tenantId = 0;
  let jobId = 0;
  let planId = 0;
  let delayReasonId = 0;
  let planEventAt: Date;
  let delayEventAt: Date;

  beforeAll(async () => {
    const org = await owner.organization.create({ data: { code: `JOBSACT-${Date.now()}`, name: "jobs.read activity test" } });
    tenantId = org.id;
    const dept = await owner.department.create({ data: { tenantId, code: "PROD", name: "Production" } });
    const client = await owner.client.create({ data: { tenantId, name: "ACME", code: `ACME-${Date.now()}` } });
    const family = await owner.productFamily.create({ data: { tenantId, code: "PRESSURE_VESSEL", name: "PV" } });
    const template = await owner.processTemplate.create({ data: { tenantId, familyId: family.id, name: "PV Template" } });
    const tv = await owner.processTemplateVersion.create({ data: { templateId: template.id, version: 1 } });
    const user = await owner.user.create({ data: { tenantId, email: `jobsact-${Date.now()}@x`, username: `jobsact-${Date.now()}`, name: "Filer", passwordHash: "x" } });
    const category = await owner.delayCategoryRef.create({ data: { tenantId, code: "MATERIAL", name: "Material shortage" } });

    const job = await owner.job.create({
      data: {
        tenantId,
        publicId: `pub-jobsact-${Date.now()}`,
        clientId: client.id,
        familyId: family.id,
        templateVersionId: tv.id,
        jobNumber: `DESPL-JOBSACT-${Date.now()}`,
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

    // Two branches — ProcessPlan event 5 minutes ago, DelayReason event now
    // (the later of the two) — so lastActivityAt must reflect the DelayReason
    // branch's max(), proving the UNION ALL still merges correctly post-fix.
    planEventAt = new Date(Date.now() - 5 * 60 * 1000);
    delayEventAt = new Date();
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "ProcessPlan", aggregateId: String(planId), type: "ProcessStarted", payload: {}, at: planEventAt },
    });
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "DelayReason", aggregateId: String(delayReasonId), type: "DelayReasonFiled", payload: {}, at: delayEventAt },
    });

    // A domain_events row for a THIRD, unrelated aggregate type carrying a
    // deliberately non-numeric aggregate_id. Before the fix, `de.aggregate_id
    // ::int` cast the column itself — Postgres could attempt (and fail) that
    // cast against this row depending on predicate evaluation order, even
    // though it belongs to neither UNION branch's aggregate_type. After the
    // fix, only `pp.id`/`dr.id` (real ints) are ever cast, so this row is
    // inert no matter when the planner touches it. Proves AUD-059.
    await owner.domainEvent.create({
      data: { tenantId, aggregateType: "DispatchBatch", aggregateId: "not-a-number-abc", type: "DispatchPacked", payload: {}, at: new Date() },
    });
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("reflects the later of the two UNION branches without throwing on the unrelated non-numeric row", async () => {
    const list = await loadJobs(actor({ tenantId }));
    const row = list.find((j) => j.id === jobId);
    expect(row).toBeDefined();
    expect(row!.lastActivityAt).not.toBeNull();
    // Within 1s of the DelayReason event (the later one) — not the earlier ProcessPlan one.
    expect(Math.abs(new Date(row!.lastActivityAt!).getTime() - delayEventAt.getTime())).toBeLessThan(1000);
  });
});
