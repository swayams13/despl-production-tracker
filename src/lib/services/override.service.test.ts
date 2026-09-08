import { afterAll, describe, expect, it } from "vitest";
import { applyDurationOverride } from "./override.service";
import { generateSchedule } from "./schedule.service";
import { loadJobSpine, getCurrentScheduleRun } from "./_shared";
import { computeEnvelope } from "@/lib/schedule";
import { isAppError, ERROR_CODES } from "@/lib/shared/errors";
import { ROLES, type Actor } from "@/lib/authz";
import { withTenant } from "@/lib/db";

/**
 * Pure tests cover the refusals that fire BEFORE any transaction opens: RBAC,
 * the client-user block, and the mandatory-reason gate (invariant #6 —
 * OVERRIDE_REASON_REQUIRED). No DB needed. The versioning + baseline-preserve +
 * Layer-1↔Layer-2 agreement path needs a seeded spine, so it lives in the
 * RUN_DB_TESTS block against the DESPL-320 pilot the seed builds.
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

describe("applyDurationOverride refusals (pre-transaction, no DB)", () => {
  it("throws OVERRIDE_REASON_REQUIRED for an empty reason before touching the DB", async () => {
    const err = await applyDurationOverride(actor(), {
      jobId: 1,
      jobProcessId: 2,
      durationOverrideDays: 5,
      reason: "   ", // whitespace-only — invariant #6
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.OVERRIDE_REASON_REQUIRED);
  });

  it("rejects a client (read-only) user with FORBIDDEN", async () => {
    const err = await applyDurationOverride(actor({ clientId: 7 }), {
      jobId: 1,
      jobProcessId: 2,
      durationOverrideDays: 5,
      reason: "revised lead time",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it("rejects a role without planning rights (SUPERVISOR) with FORBIDDEN", async () => {
    const err = await applyDurationOverride(actor({ roles: [ROLES.SUPERVISOR] }), {
      jobId: 1,
      jobProcessId: 2,
      durationOverrideDays: 5,
      reason: "revised lead time",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe(ERROR_CODES.FORBIDDEN);
  });
});

/**
 * DB-backed path. Off by default; RUN_DB_TESTS=1 (against a `pnpm db:seed`ed
 * database) turns it on. Establishes a baseline run via generateSchedule, then
 * overrides one process and asserts: a NEW version is current, the OLD run's
 * baseline is untouched (invariant #6), the new run's baseline carries the old
 * one forward, and Layer 1 (computeEnvelope from the restamped offsets) now
 * agrees with Layer 2 (the persisted CPM planned dates) — the desync fix.
 *
 * Runs against DE0467 — a real seed job with order+delivery dates and a full
 * non-provisional spine, so a baseline schedule actually persists. Uses DE0467
 * (not DE0463) so this file is the sole writer to that job's version sequence:
 * schedule.service.test schedules DE0463 in parallel, and persistScheduleRun's
 * per-job version counter would otherwise race. (The pilot DESPL-320 has NULL
 * dates by design and is unschedulable — see schedule.service.test.)
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("applyDurationOverride refuses jobs with units (DB)", async () => {
  it("throws OVERRIDE_NOT_SUPPORTED_WITH_UNITS for a job with units (audit H7)", async () => {
    const { PrismaClient } = await import("@/generated/prisma/client");
    const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
    try {
      const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
      if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
      const proc = await owner.jobProcess.findFirst({ where: { jobId: job.id }, orderBy: { seq: "asc" } });
      if (!proc) throw new Error("seed job has no process");
      const a = actor({ tenantId: job.tenantId, clientId: null });

      const err = await applyDurationOverride(a, {
        jobId: job.id,
        jobProcessId: proc.id,
        durationOverrideDays: 5,
        reason: "should be refused before any CPM work",
      }).catch((e) => e);
      expect(isAppError(err) && err.code).toBe(ERROR_CODES.OVERRIDE_NOT_SUPPORTED_WITH_UNITS);
    } finally {
      await owner.$disconnect();
    }
  });
});

describe.skipIf(!process.env.RUN_DB_TESTS)("applyDurationOverride versioning + desync fix (DB)", async () => {
  // Owner (DIRECT_URL) client for direct verification reads — bypasses RLS so a
  // bare read finds the seed row. Service calls scope themselves via withTenant.
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("versions up, preserves the old baseline, and reconciles Layer 1 with Layer 2", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!job) throw new Error("seed missing DE0467 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    // Baseline run.
    const run1 = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });

    const proc = await owner.jobProcess.findFirst({
      where: { jobId: job.id, included: true, provisional: false, durationMaxDays: { not: null } },
      orderBy: { seq: "asc" },
    });
    if (!proc) throw new Error("seed job has no schedulable process");

    // Snapshot every process's MIN envelope offsets before the override, so we
    // can assert they're untouched after — the corrupting min-space CPM restamp
    // audit C2 flagged (terminal ≈36 days instead of ≈119, defeating
    // checkFeasibility's INFEASIBLE path forever after one override) must stay
    // removed, not just the plans.
    const minBefore = new Map(
      (await owner.jobProcess.findMany({ where: { jobId: job.id } })).map((p) => [
        p.id,
        { min: p.envelopeStartByMinDays, minFinish: p.envelopeFinishByMinDays },
      ]),
    );

    const run2 = await applyDurationOverride(a, {
      jobId: job.id,
      jobProcessId: proc.id,
      durationOverrideDays: (proc.durationMaxDays ?? 5) + 5,
      reason: "supplier confirmed a longer forging lead time",
    });

    // New version is current; old run demoted but NOT mutated (invariant #6).
    expect(run2.version).toBe(run1.version + 1);
    expect(run2.mode).toBe("OVERRIDE");
    expect(run2.isCurrent).toBe(true);
    const prior = await owner.scheduleRun.findUnique({
      where: { id: run1.id },
      include: { processPlans: true },
    });
    expect(prior?.isCurrent).toBe(false);

    // Old baseline rows are exactly what run1 wrote.
    const run1Base = new Map(run1.processPlans.map((p) => [p.jobProcessId, p]));
    for (const pp of prior?.processPlans ?? []) {
      expect(pp.baselineFinish?.getTime()).toBe(run1Base.get(pp.jobProcessId)?.baselineFinish?.getTime());
    }

    // New run carries the prior baseline forward (never the recomputed planned).
    for (const pp of run2.processPlans) {
      const src = run1Base.get(pp.jobProcessId);
      if (!src) continue;
      expect(pp.baselineFinish?.getTime()).toBe(src.baselineFinish?.getTime());
      expect(pp.baselineStart?.getTime()).toBe(src.baselineStart?.getTime());
    }

    // MIN envelope offsets are byte-for-byte unchanged (audit C2 fix): the
    // override must not run a min-space CPM pass over lags fitted for MAX only.
    const afterProcesses = await owner.jobProcess.findMany({ where: { jobId: job.id } });
    for (const p of afterProcesses) {
      const before = minBefore.get(p.id);
      expect(p.envelopeStartByMinDays).toBe(before?.min);
      expect(p.envelopeFinishByMinDays).toBe(before?.minFinish);
    }

    // Layer 1 (envelope from the restamped offsets) == Layer 2 (CPM planned).
    const spineAfter = await withTenant(a.tenantId, (tx) => loadJobSpine(tx, job.id));
    const env = computeEnvelope(spineAfter.processes, run2.projectStartDate, spineAfter.calendar);
    const envByPid = new Map(env.map((e) => [e.processId, e]));
    for (const pp of run2.processPlans) {
      const e = envByPid.get(pp.jobProcessId);
      if (!e) continue; // excluded process — no envelope row
      expect(pp.plannedStart?.getTime()).toBe(e.plannedStartMax.getTime());
      expect(pp.plannedFinish?.getTime()).toBe(e.plannedFinishMax.getTime());
    }
  });
});

/**
 * AUD-034 — a job could hold two `isCurrent` ScheduleRun rows at once:
 * persistScheduleRun's demotion was scoped to (jobId, equipmentId), so a
 * job-grain generateSchedule (equipmentId null) followed by an equipment-
 * grain applyDurationOverride (a real equipmentId) left BOTH current —
 * proven live. Fixed by broadening every ScheduleRun lookup/demote in
 * _shared.ts to job-grain only, backed by a DB-level partial unique index
 * (schedule_runs_one_current_per_job) as the constraint of last resort.
 *
 * Reuses DE0467 (this file's owned job for scheduling writes — see the
 * versioning test above) so this file stays the sole writer to its version
 * sequence.
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("AUD-034 — one current ScheduleRun per job (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  // The actual regression guard: before the fix, this sequence left two
  // current rows for the job (one per grain) and every stage-status reader
  // that assumes exactly one would double-count.
  it("an equipment-grain override after a job-grain generateSchedule demotes the job-grain run too", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!job) throw new Error("seed missing DE0467 — run pnpm db:seed");
    const equipment = await owner.equipment.findFirst({ where: { jobId: job.id } });
    if (!equipment) throw new Error("seed job DE0467 has no equipment row");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    // Job-grain run — equipmentId null — becomes current.
    const jobGrainRun = await generateSchedule(a, { jobId: job.id, mode: "FORWARD" });
    expect(jobGrainRun.equipmentId).toBeNull();
    expect(jobGrainRun.isCurrent).toBe(true);

    const proc = await owner.jobProcess.findFirst({
      where: { jobId: job.id, included: true, provisional: false, durationMaxDays: { not: null } },
      orderBy: { seq: "asc" },
    });
    if (!proc) throw new Error("seed job has no schedulable process");

    // Equipment-grain override. Before the fix, persistScheduleRun's demotion
    // was scoped to (jobId, equipmentId) and would only have touched other
    // equipment-grain runs at this equipmentId — jobGrainRun would have
    // stayed isCurrent = true alongside this one.
    const equipGrainRun = await applyDurationOverride(a, {
      jobId: job.id,
      equipmentId: equipment.id,
      jobProcessId: proc.id,
      durationOverrideDays: (proc.durationMaxDays ?? 5) + 3,
      reason: "AUD-034 regression: equipment-grain override must demote the job-grain run too",
    });
    expect(equipGrainRun.equipmentId).toBe(equipment.id);

    const currentRuns = await owner.scheduleRun.findMany({ where: { jobId: job.id, isCurrent: true } });
    expect(currentRuns).toHaveLength(1);
    expect(currentRuns[0]?.id).toBe(equipGrainRun.id);

    const staleJobGrainRun = await owner.scheduleRun.findUnique({ where: { id: jobGrainRun.id } });
    expect(staleJobGrainRun?.isCurrent).toBe(false);
  });

  // Genuine two-transaction race (same pattern as template.service.test.ts's
  // "serializes concurrent saves"): persistScheduleRun's `SELECT ... FOR
  // UPDATE` on the job row forces the second call's transaction to block
  // until the first commits, so both fulfill — no unique-constraint
  // violation surfaces to either caller — and only one ends up current.
  it("serializes two concurrent generateSchedule calls for the same job — exactly one ends up current", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!job) throw new Error("seed missing DE0467 — run pnpm db:seed");
    const a = actor({ tenantId: job.tenantId, clientId: null });

    const results = await Promise.allSettled([
      generateSchedule(a, { jobId: job.id, mode: "FORWARD" }),
      generateSchedule(a, { jobId: job.id, mode: "FORWARD" }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const currentRuns = await owner.scheduleRun.findMany({ where: { jobId: job.id, isCurrent: true } });
    expect(currentRuns).toHaveLength(1);
  });

  // DB-level backstop, not just the app-level row lock: a write that bypasses
  // the service layer entirely (direct SQL, no FOR UPDATE) is still rejected.
  it("the DB unique index rejects a second is_current row inserted outside the service layer", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!job) throw new Error("seed missing DE0467 — run pnpm db:seed");
    const current = await owner.scheduleRun.findFirst({ where: { jobId: job.id, isCurrent: true } });
    if (!current) throw new Error("DE0467 has no current run — run the earlier tests in this file first");

    // Postgres's raised error (code 23505, unique_violation) surfaces through
    // Prisma's $executeRaw with the DETAIL text but not the constraint name
    // itself — assert on the code + key detail, not the index name string.
    await expect(
      owner.$executeRaw`
        INSERT INTO schedule_runs (job_id, version, mode, project_start_date, is_current)
        VALUES (${job.id}, ${current.version + 1000}, 'FORWARD'::"ScheduleMode", now(), true)
      `,
    ).rejects.toThrow(/23505/);

    const currentRuns = await owner.scheduleRun.findMany({ where: { jobId: job.id, isCurrent: true } });
    expect(currentRuns).toHaveLength(1);
    expect(currentRuns[0]?.id).toBe(current.id);
  });

  // getCurrentScheduleRun's own signature: no equipmentId argument any more,
  // and it returns the job's one current run regardless of what equipmentId
  // that run happens to carry.
  it("getCurrentScheduleRun(tx, jobId) returns the job's one current run without an equipmentId argument", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!job) throw new Error("seed missing DE0467 — run pnpm db:seed");
    const expected = await owner.scheduleRun.findFirst({ where: { jobId: job.id, isCurrent: true } });
    if (!expected) throw new Error("DE0467 has no current run — run the earlier tests in this file first");

    const found = await withTenant(job.tenantId, (tx) => getCurrentScheduleRun(tx, job.id));
    expect(found?.id).toBe(expected.id);
  });
});
