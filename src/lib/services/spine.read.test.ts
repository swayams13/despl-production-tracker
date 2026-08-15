import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * `v_unit_stage_status` (the canonical §11.2 fill ladder) is pure SQL — its only
 * meaningful test is against real seeded plans. This drives one DESPL-320 unit's
 * plans into each ladder state directly (owner client, like the other DB tests
 * insert rows directly) and asserts the view rolls them up per §11.2, including
 * multi-process aggregation (stage 5 ← processes 7,8,9) and the resolved C26
 * hold-fill + overdue-pip dual signal.
 *
 * Run with RUN_DB_TESTS=1 and DIRECT_URL pointing at a migrated+seeded DB.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("v_unit_stage_status ladder (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let jobId = 0;
  let runId = 0;
  let unitId = 0;

  const past = new Date(Date.now() - 30 * 864e5);
  const future = new Date(Date.now() + 90 * 864e5);

  function planner(tenantId: number): Actor {
    return { userId: 1, tenantId, clientId: null, name: "PH", email: "ph@x", roles: [ROLES.PRODUCTION_HEAD], departmentIds: [] };
  }

  beforeAll(async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    jobId = job.id;
    // Future start → nothing overdue by default; we set overdue explicitly per case.
    const run = await generateSchedule(planner(job.tenantId), { jobId, mode: "FORWARD", projectStartDate: future });
    runId = run.id;
    const unit = await owner.unit.findFirstOrThrow({ where: { equipment: { jobId } }, orderBy: { id: "asc" } });
    unitId = unit.id;
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  /** Backing plan ids for one (unit, stage) in the current run — the exact set
   * the view aggregates: plans whose job_process carries `stageNo` in its
   * work_order_stages array. */
  async function backingPlanIds(stageNo: number): Promise<number[]> {
    const rows = await owner.$queryRaw<{ id: number }[]>`
      SELECT pp.id
      FROM process_plans pp
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE pp.unit_id = ${unitId} AND pp.schedule_run_id = ${runId}
        AND jp.work_order_stages @> ARRAY[${stageNo}]::int[]
      ORDER BY jp.seq
    `;
    return rows.map((r) => r.id);
  }

  async function fillOf(stageNo: number): Promise<{ fill_status: string; is_overdue: boolean; is_rejected: boolean; governing_plan_id: number | null }> {
    const rows = await owner.$queryRaw<{ fill_status: string; is_overdue: boolean; is_rejected: boolean; governing_plan_id: number | null }[]>`
      SELECT fill_status, is_overdue, is_rejected, governing_plan_id
      FROM v_unit_stage_status
      WHERE job_id = ${jobId} AND unit_id = ${unitId} AND stage_no = ${stageNo}
    `;
    expect(rows.length).toBe(1);
    return rows[0];
  }

  async function setPlans(ids: number[], patch: { status?: string; plannedFinish?: Date }): Promise<void> {
    await owner.processPlan.updateMany({
      where: { id: { in: ids } },
      data: {
        ...(patch.status ? { status: patch.status as never } : {}),
        ...(patch.plannedFinish ? { plannedFinish: patch.plannedFinish } : {}),
      },
    });
  }

  const STAGE_MULTI = 5; // Material Procurement ← processes 7,8,9 (§11.1)

  it("stage 5 is backed by ≥2 processes (multi-process aggregation is under test)", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("all NOT_STARTED, future finish → idle", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "NOT_STARTED", plannedFinish: future });
    expect((await fillOf(STAGE_MULTI)).fill_status).toBe("idle");
  });

  it("some IN_PROGRESS → progress; governing is the earliest not-complete plan", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "NOT_STARTED", plannedFinish: future });
    await setPlans([ids[0]], { status: "IN_PROGRESS" });
    const r = await fillOf(STAGE_MULTI);
    expect(r.fill_status).toBe("progress");
    expect(r.governing_plan_id).toBe(ids[0]); // earliest-by-seq, not complete
  });

  it("all COMPLETE → complete (checked first, before any 'in progress')", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "COMPLETE" });
    expect((await fillOf(STAGE_MULTI)).fill_status).toBe("complete");
  });

  it("overdue outranks submitted", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "NOT_STARTED", plannedFinish: future });
    await setPlans([ids[0]], { status: "SUBMITTED" });
    await setPlans([ids[1]], { status: "IN_PROGRESS", plannedFinish: past });
    expect((await fillOf(STAGE_MULTI)).fill_status).toBe("overdue");
  });

  it("hold outranks overdue in the fill, and overdue survives as the pip (C26)", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "NOT_STARTED", plannedFinish: future });
    // one plan both on hold AND overdue → amber fill + red overdue pip
    await setPlans([ids[0]], { status: "ON_HOLD", plannedFinish: past });
    const r = await fillOf(STAGE_MULTI);
    expect(r.fill_status).toBe("hold");
    expect(r.is_overdue).toBe(true); // the secondary marker is not lost
  });

  it("a REJECTED QcpExecution on a backing process surfaces as is_rejected", async () => {
    const ids = await backingPlanIds(STAGE_MULTI);
    await setPlans(ids, { status: "NOT_STARTED", plannedFinish: future });

    // Find a QcpItem linked to any backing process; inject a rejected attempt.
    const link = await owner.qcpItemProcess.findFirst({
      where: { jobProcess: { jobId, workOrderStages: { has: STAGE_MULTI } } },
      select: { qcpItemId: true },
    });
    if (!link) {
      // No QCP checkpoint on this stage in the seed — is_rejected can't be exercised here.
      expect((await fillOf(STAGE_MULTI)).is_rejected).toBe(false);
      return;
    }
    await owner.qcpExecution.upsert({
      where: { qcpItemId_unitId_attemptNo: { qcpItemId: link.qcpItemId, unitId, attemptNo: 99 } },
      create: { qcpItemId: link.qcpItemId, unitId, result: "REJECTED", attemptNo: 99 },
      update: { result: "REJECTED" },
    });
    expect((await fillOf(STAGE_MULTI)).is_rejected).toBe(true);
  });
});
