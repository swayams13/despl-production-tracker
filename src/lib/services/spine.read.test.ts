import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUnitSpinesBatch } from "./spine.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * `v_unit_stage_status` (the canonical §11.2 fill ladder) is pure SQL — its only
 * meaningful test is against real rows. Unlike the other DB tests it reads the
 * *current* schedule run (the view filters `is_current`), so it must NOT share
 * the DESPL-320 fixture: six other files regenerate that job's schedule in
 * parallel, flipping `is_current` out from under a current-run read. Instead
 * this builds its own throwaway job — its own is_current pointer, touched by
 * nobody else — so the file stays parallel-safe. Three processes back one stage
 * (multi-process aggregation); statuses are set directly and rolled up per §11.2.
 *
 * Run with RUN_DB_TESTS=1 and DIRECT_URL pointing at a migrated+seeded DB.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

// Reused seed refs (all id 1 in the seeded DB): tenant, client, family,
// template version, department, and an arbitrary QcpItem for the reject link.
const REF = { tenant: 1, client: 1, family: 1, templateVersion: 1, dept: 1, qcpItem: 1 };
const JOB_NUMBER = "VIEW-LADDER-TEST";
const STAGE = 5; // the one stage all three test processes back

describe.skipIf(!RUN_DB)("v_unit_stage_status ladder (DB-backed, isolated fixture)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let jobId = 0;
  let unitId = 0;
  let planA = 0; // seq 1
  let planB = 0; // seq 2
  let planC = 0; // seq 3

  const past = new Date(Date.now() - 30 * 864e5);
  const future = new Date(Date.now() + 90 * 864e5);

  async function teardown(): Promise<void> {
    const job = await owner.job.findUnique({
      where: { tenantId_jobNumber: { tenantId: REF.tenant, jobNumber: JOB_NUMBER } },
      select: { id: true, equipments: { select: { id: true, units: { select: { id: true } } } }, processes: { select: { id: true } } },
    });
    if (!job) return;
    const unitIds = job.equipments.flatMap((e) => e.units.map((u) => u.id));
    const jpIds = job.processes.map((p) => p.id);
    await owner.processPlan.deleteMany({ where: { jobProcess: { jobId: job.id } } });
    await owner.scheduleRun.deleteMany({ where: { jobId: job.id } });
    if (unitIds.length) await owner.qcpExecution.deleteMany({ where: { unitId: { in: unitIds } } });
    if (jpIds.length) await owner.qcpItemProcess.deleteMany({ where: { jobProcessId: { in: jpIds } } });
    await owner.unit.deleteMany({ where: { equipment: { jobId: job.id } } });
    await owner.equipment.deleteMany({ where: { jobId: job.id } });
    await owner.jobProcess.deleteMany({ where: { jobId: job.id } });
    await owner.job.delete({ where: { id: job.id } });
  }

  beforeAll(async () => {
    await teardown(); // idempotent: clear any leftover fixture from a prior run
    const job = await owner.job.create({
      data: {
        tenantId: REF.tenant,
        publicId: "view-ladder-test",
        clientId: REF.client,
        familyId: REF.family,
        templateVersionId: REF.templateVersion,
        jobNumber: JOB_NUMBER,
      },
    });
    jobId = job.id;
    const eq = await owner.equipment.create({ data: { jobId, name: "VLT-EQ" } });
    const unit = await owner.unit.create({ data: { jobId, equipmentId: eq.id, serialNo: "VLT01" } });
    unitId = unit.id;

    // Three processes all backing STAGE (§11.1 multi-process aggregation).
    const mkJp = (seq: number, code: string) =>
      owner.jobProcess.create({
        data: { jobId, seq, code, name: `VLT ${code}`, departmentId: REF.dept, workOrderStages: [STAGE] },
      });
    const jpA = await mkJp(1, "A");
    const jpB = await mkJp(2, "B");
    const jpC = await mkJp(3, "C");

    const run = await owner.scheduleRun.create({
      data: { jobId, version: 1, mode: "FORWARD", projectStartDate: past, isCurrent: true },
    });

    const mkPlan = (jobProcessId: number) =>
      owner.processPlan.create({
        data: { jobId, scheduleRunId: run.id, jobProcessId, unitId, ownerDepartmentId: REF.dept, status: "NOT_STARTED", plannedFinish: future },
      });
    planA = (await mkPlan(jpA.id)).id;
    planB = (await mkPlan(jpB.id)).id;
    planC = (await mkPlan(jpC.id)).id;

    // Link an existing QcpItem to process A so is_rejected can be exercised.
    await owner.qcpItemProcess.create({ data: { jobId, qcpItemId: REF.qcpItem, jobProcessId: jpA.id } });
  });

  afterAll(async () => {
    await teardown();
    await owner.$disconnect();
  });

  async function setPlan(id: number, patch: { status?: string; plannedFinish?: Date }): Promise<void> {
    await owner.processPlan.update({
      where: { id },
      data: {
        ...(patch.status ? { status: patch.status as never } : {}),
        ...(patch.plannedFinish ? { plannedFinish: patch.plannedFinish } : {}),
      },
    });
  }

  /** Reset all three plans to a clean NOT_STARTED / future-finish baseline. */
  async function reset(): Promise<void> {
    for (const id of [planA, planB, planC]) await setPlan(id, { status: "NOT_STARTED", plannedFinish: future });
  }

  async function fill(): Promise<{ fill_status: string; is_overdue: boolean; is_rejected: boolean; governing_plan_id: number | null }> {
    const rows = await owner.$queryRaw<{ fill_status: string; is_overdue: boolean; is_rejected: boolean; governing_plan_id: number | null }[]>`
      SELECT fill_status, is_overdue, is_rejected, governing_plan_id
      FROM v_unit_stage_status
      WHERE job_id = ${jobId} AND unit_id = ${unitId} AND stage_no = ${STAGE}
    `;
    expect(rows.length).toBe(1);
    return rows[0];
  }

  it("all NOT_STARTED, future finish → idle", async () => {
    await reset();
    expect((await fill()).fill_status).toBe("idle");
  });

  it("some IN_PROGRESS → progress; governing is the earliest not-complete plan", async () => {
    await reset();
    await setPlan(planA, { status: "IN_PROGRESS" });
    const r = await fill();
    expect(r.fill_status).toBe("progress");
    expect(r.governing_plan_id).toBe(planA); // earliest-by-seq, not complete
  });

  it("all COMPLETE → complete (checked first, before any 'in progress'); governing is the last plan", async () => {
    await reset();
    for (const id of [planA, planB, planC]) await setPlan(id, { status: "COMPLETE" });
    const r = await fill();
    expect(r.fill_status).toBe("complete");
    expect(r.governing_plan_id).toBe(planC); // all complete → last by seq
  });

  it("overdue outranks submitted", async () => {
    await reset();
    await setPlan(planA, { status: "SUBMITTED" });
    await setPlan(planB, { status: "IN_PROGRESS", plannedFinish: past });
    expect((await fill()).fill_status).toBe("overdue");
  });

  it("hold outranks overdue in the fill, and overdue survives as the pip (C26)", async () => {
    await reset();
    await setPlan(planA, { status: "ON_HOLD", plannedFinish: past }); // both hold AND overdue
    const r = await fill();
    expect(r.fill_status).toBe("hold");
    expect(r.is_overdue).toBe(true); // the secondary marker is not lost
  });

  it("a REJECTED QcpExecution on a backing process surfaces as is_rejected", async () => {
    await reset();
    expect((await fill()).is_rejected).toBe(false); // no execution yet
    await owner.qcpExecution.upsert({
      where: { qcpItemId_unitId_attemptNo: { qcpItemId: REF.qcpItem, unitId, attemptNo: 1 } },
      create: { jobId, qcpItemId: REF.qcpItem, unitId, result: "REJECTED", attemptNo: 1 },
      update: { result: "REJECTED" },
    });
    expect((await fill()).is_rejected).toBe(true);
  });
});

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadUnitSpinesBatch (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("each job's unit spines belong to that job's own units, not another job's", async () => {
    try {
      const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
      const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
      if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

      const map = await loadUnitSpinesBatch(actor({ tenantId: jobA.tenantId }), [jobA.id, jobB.id]);

      const unitsA = await owner.unit.findMany({ where: { equipment: { jobId: jobA.id } }, select: { id: true } });
      const unitsB = await owner.unit.findMany({ where: { equipment: { jobId: jobB.id } }, select: { id: true } });

      const unitIdsA = new Set(unitsA.map((u) => u.id));
      const unitIdsB = new Set(unitsB.map((u) => u.id));

      for (const spine of map.get(jobA.id) ?? []) expect(unitIdsA.has(spine.unitId)).toBe(true);
      for (const spine of map.get(jobB.id) ?? []) expect(unitIdsB.has(spine.unitId)).toBe(true);
      // Sanity: the two jobs' unit sets don't overlap, or the assertions above are vacuous.
      expect([...unitIdsA].some((id) => unitIdsB.has(id))).toBe(false);
    } finally {
      await owner.$disconnect();
    }
  });
});
