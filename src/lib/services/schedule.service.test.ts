import { afterAll, describe, expect, it } from "vitest";
import { generateSchedule, getSchedule } from "./schedule.service";
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
  it("expands DESPL-320 into 36 processes × 9 units, all NOT_STARTED", async () => {
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
    for (const p of run.processPlans) {
      expect(p.status).toBe("NOT_STARTED");
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
});
