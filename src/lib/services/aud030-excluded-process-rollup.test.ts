import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * AUD-030 — `v_unit_stage_status`'s `exploded` CTE joined `job_processes`
 * with no `included` predicate, so a legitimately excluded JobProcess
 * (included = false — this client's spec skips it; a real, allowed
 * exclusion, distinct from AUD-033's separate finding about whether the
 * exclusion itself should have been allowed at intake) still contributed
 * its `work_order_stages` to the per-unit rollup even though
 * `generateSchedule` (schedule.service.ts) never creates a `ProcessPlan`
 * for it. Two distinct symptoms, both fixed by
 * 20260908140000_aud030_excluded_process_stage_rollup's `AND jp.included =
 * true`:
 *
 *   - A stage_no touched ONLY by an excluded process rendered 'idle'
 *     forever (a phantom grey tile for a stage deliberately out of scope).
 *   - A stage_no SHARED with an included process could never reach
 *     'complete', even once the included process finished — the excluded
 *     process's NULL-status row kept `count(*) FILTER (WHERE status IS
 *     DISTINCT FROM 'COMPLETE') = 0` from ever being true, because SQL's
 *     `IS DISTINCT FROM` (unlike `=`) treats NULL as distinct from
 *     'COMPLETE'. This is the "excluding a process makes its stages
 *     permanently non-complete" defect named in
 *     audit/19_MASTER_ISSUE_REGISTER.md's AUD-030 row.
 *
 * Own throwaway job/unit (own `is_current` pointer), same isolation
 * rationale as spine.read.test.ts: the view filters `is_current`, so this
 * must not share DESPL-320's fixture with the six other files that
 * regenerate its schedule in parallel.
 *
 * Run with RUN_DB_TESTS=1 and DIRECT_URL pointing at a migrated+seeded DB.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

const REF = { tenant: 1, client: 1, family: 1, templateVersion: 1, dept: 1 };
const JOB_NUMBER = "AUD030-EXCLUDED-TEST";
const SHARED_STAGE = 1; // backed by both an included and an excluded process
const CONTROL_STAGE = 2; // backed only by an included process — the "zero exclusions" case
const EXCLUDED_ONLY_STAGE = 3; // backed only by an excluded process, no included sibling

describe.skipIf(!RUN_DB)("v_unit_stage_status ignores excluded JobProcess rows (AUD-030)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let jobId = 0;
  let unitId = 0;
  let planIncludedShared = 0; // backs SHARED_STAGE, included=true
  let planIncludedControl = 0; // backs CONTROL_STAGE, included=true

  async function teardown(): Promise<void> {
    const job = await owner.job.findUnique({
      where: { tenantId_jobNumber: { tenantId: REF.tenant, jobNumber: JOB_NUMBER } },
      select: { id: true, equipments: { select: { id: true, units: { select: { id: true } } } } },
    });
    if (!job) return;
    await owner.processPlan.deleteMany({ where: { jobProcess: { jobId: job.id } } });
    await owner.scheduleRun.deleteMany({ where: { jobId: job.id } });
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
        publicId: "aud030-excluded-test",
        clientId: REF.client,
        familyId: REF.family,
        templateVersionId: REF.templateVersion,
        jobNumber: JOB_NUMBER,
      },
    });
    jobId = job.id;
    const eq = await owner.equipment.create({ data: { jobId, name: "AUD030-EQ" } });
    const unit = await owner.unit.create({ data: { jobId, equipmentId: eq.id, serialNo: "AUD030-01" } });
    unitId = unit.id;

    const mkJp = (seq: number, code: string, stage: number, included: boolean) =>
      owner.jobProcess.create({
        data: { jobId, seq, code, name: `AUD030 ${code}`, departmentId: REF.dept, workOrderStages: [stage], included },
      });

    // Mirrors schedule.service.ts's generateSchedule: `included=false` processes
    // never get a ProcessPlan (line ~55, `spine.processes.filter((p) => p.included
    // !== false)`), so no plan is created for the two excluded JobProcesses below —
    // that half of the design was never the bug.
    const jpIncludedShared = await mkJp(1, "INC-SHARED", SHARED_STAGE, true);
    await mkJp(2, "EXC-SHARED", SHARED_STAGE, false); // no ProcessPlan, by design
    const jpIncludedControl = await mkJp(3, "INC-CONTROL", CONTROL_STAGE, true);
    await mkJp(4, "EXC-ONLY", EXCLUDED_ONLY_STAGE, false); // no ProcessPlan, by design

    const run = await owner.scheduleRun.create({
      data: { jobId, version: 1, mode: "FORWARD", projectStartDate: new Date(), isCurrent: true },
    });

    const mkPlan = (jobProcessId: number) =>
      owner.processPlan.create({
        data: { jobId, scheduleRunId: run.id, jobProcessId, unitId, ownerDepartmentId: REF.dept, status: "NOT_STARTED" },
      });
    planIncludedShared = (await mkPlan(jpIncludedShared.id)).id;
    planIncludedControl = (await mkPlan(jpIncludedControl.id)).id;
  });

  afterAll(async () => {
    await teardown();
    await owner.$disconnect();
  });

  // AUD-002: v_unit_stage_status joins through `jobs` on an explicit
  // app.tenant_id predicate — this owner-role client bypasses RLS but not the
  // view's own literal join condition, so it must set it too.
  async function rollup(stage: number): Promise<{ fill_status: string }[]> {
    return owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(REF.tenant)}, true)`;
      return tx.$queryRaw<{ fill_status: string }[]>`
        SELECT fill_status FROM v_unit_stage_status
        WHERE job_id = ${jobId} AND unit_id = ${unitId} AND stage_no = ${stage}
      `;
    });
  }

  async function percentComplete(planIds: number[]): Promise<number> {
    const rows = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(REF.tenant)}, true)`;
      return tx.$queryRaw<{ percent: string | number | null }[]>`
        SELECT sum(percent * weight) / sum(weight) AS percent
        FROM v_process_plan_percent
        WHERE process_plan_id = ANY(${planIds}::int[])
      `;
    });
    return Math.round(Number(rows[0]?.percent ?? 0));
  }

  it("test 1: a stage backed only by an excluded process does not appear in the rollup at all", async () => {
    const rows = await rollup(EXCLUDED_ONLY_STAGE);
    expect(rows).toHaveLength(0); // pre-fix this rendered a phantom 'idle' row forever
  });

  it("test 2: a stage shared with an excluded process still reaches 'complete' once the included process finishes", async () => {
    expect((await rollup(SHARED_STAGE))[0]?.fill_status).toBe("idle"); // NOT_STARTED baseline
    // AUD-006: process_plans_complete_has_finish CHECK requires actualFinish when status=COMPLETE.
    await owner.processPlan.update({ where: { id: planIncludedShared }, data: { status: "COMPLETE", actualFinish: new Date() } });
    // Pre-fix: the excluded sibling's NULL status kept `IS DISTINCT FROM 'COMPLETE'`
    // count above zero, so this was stuck at 'progress' forever, never 'complete'.
    expect((await rollup(SHARED_STAGE))[0]?.fill_status).toBe("complete");
  });

  it("test 3: percent-complete counts only included processes, reaching 100% once they finish", async () => {
    await owner.processPlan.update({ where: { id: planIncludedControl }, data: { status: "COMPLETE", actualFinish: new Date() } });
    // planIncludedShared was already set COMPLETE in test 2; both included plans
    // done, and the excluded siblings never had a ProcessPlan row to weigh in.
    expect(await percentComplete([planIncludedShared, planIncludedControl])).toBe(100);
  });

  it("test 4 (control — job with zero exclusions on this stage is unaffected): CONTROL_STAGE follows the normal ladder", async () => {
    // CONTROL_STAGE has no excluded sibling at all — same ladder behavior as
    // before this migration, proving the fix is a no-op for the common case.
    expect((await rollup(CONTROL_STAGE))[0]?.fill_status).toBe("complete"); // set COMPLETE in test 3
  });
});
