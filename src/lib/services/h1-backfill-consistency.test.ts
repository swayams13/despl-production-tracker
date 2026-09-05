// H1 job-level RLS backstop (Task 2): permanent regression test guarding the
// two known dual-path divergence risks named in
// docs/superpowers/plans/2026-09-05-h1-job-level-rls-backstop.md — a future
// write must never let ProcessPlan/QcpExecution's two independent paths to
// Job disagree, not just at backfill time.
import { afterAll, describe, expect, it } from "vitest";

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("H1 dual-path job_id consistency (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("process_plans.job_id always agrees with its schedule_run's job_id", async () => {
    const mismatches = await prisma.$queryRaw<{ id: number }[]>`
      SELECT p.id FROM process_plans p
      JOIN schedule_runs sr ON p.schedule_run_id = sr.id
      WHERE p.job_id IS DISTINCT FROM sr.job_id`;
    expect(mismatches).toEqual([]);
  });

  it("qcp_executions.job_id always agrees with its qcp_item's job_id (when the item is job-scoped)", async () => {
    const mismatches = await prisma.$queryRaw<{ id: number }[]>`
      SELECT q.id FROM qcp_executions q
      JOIN qcp_items i ON q.qcp_item_id = i.id
      WHERE i.job_id IS NOT NULL AND q.job_id IS DISTINCT FROM i.job_id`;
    expect(mismatches).toEqual([]);
  });
});
