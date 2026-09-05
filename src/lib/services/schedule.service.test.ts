import { afterAll, describe, expect, it } from "vitest";
import { generateSchedule, getSchedule } from "./schedule.service";
import { startProcess, submitProcess } from "./process.service";
import { fileDelayReason } from "./delay.service";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Pure tests cover the refusals that fire BEFORE any transaction opens (RBAC +
 * client-user block + schema validation) — no DB needed. The persist +
 * feasibility-stamping path (versioning, isCurrent flip, one audit row) needs a
 * seeded spine, so it lives in the RUN_DB_TESTS block against the DESPL-320
 * pilot the seed builds.
 */

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1,
    tenantId: 1,
    clientId: null,
    name: "SJ",
    email: "sj@despl.test",
    roles: [ROLES.PRODUCTION_HEAD],
    departmentIds: [],
    mustChangePassword: false,
    themePreference: "SYSTEM",
    outdoorMode: false,
    ...over,
  };
}

describe("generateSchedule refusals (pre-transaction, no DB)", () => {
  it("rejects a client (read-only) user with FORBIDDEN before touching the DB", async () => {
    const err = await generateSchedule(actor({ clientId: 7, roles: [ROLES.PRODUCTION_HEAD] }), {
      jobId: 1,
      mode: "FORWARD",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("rejects a role without planning rights (SUPERVISOR) with FORBIDDEN", async () => {
    const err = await generateSchedule(actor({ roles: [ROLES.SUPERVISOR] }), {
      jobId: 1,
      mode: "FORWARD",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("rejects an invalid mode via the schema (before RBAC/DB)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = await generateSchedule(actor(), { jobId: 1, mode: "SIDEWAYS" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(Error); // ZodError
  });
});

/**
 * DB-backed path. Off by default; RUN_DB_TESTS=1 (against a `pnpm db:seed`ed
 * database) turns it on. Exercises persistScheduleRun through generateSchedule:
 * two generations must version up, flip isCurrent, stamp feasibility, and leave
 * exactly one fresh audit row.
 *
 * Runs against DE0463 — a real seed job with order+delivery dates and a full
 * non-provisional PRESSURE_VESSEL spine, so FORWARD scheduling actually persists.
 * The pilot DESPL-320 has NULL order/delivery dates by design (pending DESPL), so
 * it is unschedulable — pinned as a passing negative case below.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("generateSchedule persist + feasibility (DB)", async () => {
  // Direct verification reads use the owner (DIRECT_URL) connection — it bypasses
  // RLS, so a bare read finds the seed row without app.tenant_id set. The service
  // calls stay untouched: they scope themselves via withTenant.
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("versions up, flips isCurrent, stamps feasibility, writes one audit row", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    if (!job) throw new Error("seed missing DE0463 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    const run1 = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });
    const run2 = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });

    // Versioning + isCurrent flip (invariant #6: new version, old preserved).
    expect(run2.version).toBe(run1.version + 1);
    expect(run2.isCurrent).toBe(true);
    const prior = await owner.scheduleRun.findUnique({ where: { id: run1.id } });
    expect(prior?.isCurrent).toBe(false);

    // Feasibility stamped (seed job has both order + delivery dates).
    expect(["FEASIBLE", "TIGHT", "INFEASIBLE"]).toContain(run2.feasibility);
    expect(run2.processPlans.length).toBeGreaterThan(0);
    // baseline == planned on a fresh generation.
    for (const p of run2.processPlans) {
      expect(p.baselineFinish?.getTime()).toBe(p.plannedFinish?.getTime());
    }

    // DE0463 has no seeded units (only DESPL-320 does — prisma/seed.ts's one
    // `tx.unit.createMany` call), so this run exercises the 0-unit fallback
    // (`unitIds = [null]` in generateSchedule): one plan per included process,
    // all job-grain (unitId null), not ×N units.
    const includedProcessCount = await owner.jobProcess.count({
      where: { jobId: job.id, included: { not: false } },
    });
    expect(run2.processPlans.length).toBe(includedProcessCount);
    for (const p of run2.processPlans) {
      expect(p.unitId).toBeNull();
      // H1: persistScheduleRun populates jobId on every created ProcessPlan.
      expect(p.jobId).toBe(job.id);
    }

    // Exactly one audit row per generateSchedule call. Scoped to these two run
    // ids — a tenant-wide count is inflated by any parallel writer in the shared
    // seed tenant (the override test file schedules in the same tenant).
    const auditRows = await owner.auditLog.count({
      where: { entityType: "ScheduleRun", entityId: { in: [String(run1.id), String(run2.id)] } },
    });
    expect(auditRows).toBe(2);

    // getSchedule returns the current (latest) run.
    const current = await getSchedule(a, job.id);
    expect(current?.id).toBe(run2.id);
  });

  // The pilot DESPL-320 has NULL order/delivery dates by design (pending DESPL,
  // per prisma/seed.ts). A FORWARD schedule with no order date is correctly
  // unschedulable — this pins that refusal as a passing test, not a red one.
  it("refuses DESPL-320 with SCHEDULE_DATA_MISSING — no order date (pending DESPL)", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const err = await generateSchedule(actor({ tenantId: job.tenantId, clientId: null }), {
      jobId: job.id,
      mode: "FORWARD",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.SCHEDULE_DATA_MISSING);
  });

  // Per-unit grain (grain P0.2): one plan per (included process × unit).
  // DESPL-320 seeds 9 units (320SR01–09) on its one equipment. Its order date
  // is NULL by design (test above), so pass projectStartDate explicitly to
  // clear the SCHEDULE_DATA_MISSING refusal and actually exercise persistence.
  it("expands DESPL-320 into 36 processes × 9 units, one plan per unit", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    const run = await generateSchedule(a, {
      jobId: job.id,
      mode: "FORWARD",
      projectStartDate: new Date("2026-01-01"),
    });

    const includedProcessCount = await owner.jobProcess.count({
      where: { jobId: job.id, included: { not: false } },
    });
    const unitCount = await owner.unit.count({ where: { equipment: { jobId: job.id } } });
    expect(unitCount).toBe(9);
    expect(includedProcessCount).toBe(36);

    expect(run.processPlans.length).toBe(includedProcessCount * unitCount);
    expect(run.processPlans.length).toBe(36 * 9);
    // Status is NOT asserted NOT_STARTED here: this file shares DESPL-320 with
    // other DB-gated test files, and persistScheduleRun now correctly carries
    // real work forward across a reschedule (audit C1 fix) instead of silently
    // resetting it — asserting a blanket clean slate would just be re-relying
    // on the bug this phase fixes. The per-unit expansion grain (P0.2) this
    // test exists to pin is the plan count and unitId assignment below.
    for (const p of run.processPlans) {
      expect(p.unitId).not.toBeNull();
    }
    const distinctUnitIds = new Set(run.processPlans.map((p) => p.unitId));
    expect(distinctUnitIds.size).toBe(9);
  });

  // The 0-unit fallback (unitIds = [null] in generateSchedule) IS covered: per
  // prisma/seed.ts, DESPL-320 is the only seeded job with units (its one
  // `tx.unit.createMany` call) — DE0463 is a schedulable, non-provisional
  // PRESSURE_VESSEL job with no units, so the "versions up, flips isCurrent…"
  // test above already exercises the fallback branch and now asserts on it
  // (unitId null, plan count == included process count).

  // Regression for audit C1: the only pre-existing reschedule test (above)
  // runs on a job with no actuals, so it could not have caught the bug —
  // rescheduling silently reset every in-flight plan to NOT_STARTED with its
  // signature detached. This one records real actuals first.
  it("carries actualStart/status/submittedBy forward across a reschedule", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    if (!job) throw new Error("seed missing DE0463 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    // The process with no incoming edge is the only one startable from
    // NOT_STARTED with an empty predecessor state — pick it rather than
    // assuming seq order matches the dependency graph. Job-level property
    // (independent of any particular ScheduleRun), so it's found before run1.
    const edges = await owner.jobProcessEdge.findMany({
      where: { process: { jobId: job.id } },
      select: { processId: true },
    });
    const hasPredecessor = new Set(edges.map((e) => e.processId));
    const startableJobProcess = await owner.jobProcess.findFirst({
      where: { jobId: job.id, id: { notIn: [...hasPredecessor] } },
    });
    if (!startableJobProcess) throw new Error("no predecessor-free process on DE0463's spine");

    // Reset this test's own target plan on whatever run is currently current,
    // so a rerun against this no-cleanup seed DB starts from NOT_STARTED again
    // — persistScheduleRun now carries real work forward across a reschedule
    // (audit C1 fix, the very thing under test) instead of resetting it.
    await owner.processPlan.updateMany({
      where: { scheduleRun: { jobId: job.id, isCurrent: true }, jobProcessId: startableJobProcess.id, unitId: null },
      data: { status: "NOT_STARTED", actualStart: null, actualFinish: null, submittedBy: null, verifiedBy: null },
    });

    const run1 = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });
    const startable = run1.processPlans.find((p) => p.jobProcessId === startableJobProcess.id);
    if (!startable) throw new Error("startable process missing from run1's plans");

    // DE0463 is a real seed job — its FORWARD envelope can land plannedFinish
    // dates in the past relative to "now", tripping invariant #7's department
    // block on unrelated overdue plans in the same department/unit. Clear it
    // the real way (file a reason) rather than picking around it, since that's
    // the actual unblock path a supervisor would use.
    const category = await owner.delayCategoryRef.findFirst({ where: { tenantId: job.tenantId } });
    if (!category) throw new Error("seed missing delay categories");
    const overdueSiblings = await owner.processPlan.findMany({
      where: {
        scheduleRunId: run1.id,
        ownerDepartmentId: startable.ownerDepartmentId,
        unitId: startable.unitId,
        status: { not: "COMPLETE" },
        plannedFinish: { lt: new Date() },
      },
      select: { id: true },
    });
    for (const p of overdueSiblings) {
      await fileDelayReason(a, { processPlanId: p.id, categoryId: category.id });
    }

    await startProcess(a, { processPlanId: startable.id });
    await submitProcess(a, { processPlanId: startable.id });

    const run2 = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });
    expect(run2.version).toBe(run1.version + 1);

    const carried = run2.processPlans.find((p) => p.jobProcessId === startable.jobProcessId && p.unitId === startable.unitId);
    expect(carried?.status).toBe("SUBMITTED");
    expect(carried?.actualStart).not.toBeNull();
    expect(carried?.submittedBy).toBe(a.userId);

    // Every other plan (never touched) still starts clean.
    const untouched = run2.processPlans.find((p) => p.jobProcessId !== startable.jobProcessId);
    expect(untouched?.status).toBe("NOT_STARTED");
    expect(untouched?.actualStart).toBeNull();
  });

  // Aggravator half of C1: a stale tab holding a plan id from a run that has
  // since been superseded must not be able to write against it.
  it("refuses a write against a plan whose run has been superseded", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    if (!job) throw new Error("seed missing DE0463 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    const staleRun = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });
    await generateSchedule(a, { jobId: job.id, mode: "FORWARD" }); // supersedes staleRun

    const err = await startProcess(a, { processPlanId: staleRun.processPlans[0].id }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.STALE_WRITE);
  });
});
