import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

// Arbitrary shared lock key for DESPL-320's ProgressSnapshot rows,
// coordinated with client-snapshot.read.test.ts — the only two files that
// touch this job's same-day rows. Must match that file's LOCK_KEY exactly.
const LOCK_KEY = 987654321;

/**
 * publishSnapshot/verifySnapshot/rejectSnapshot have no pure logic worth
 * isolating — they're a role gate + a self-check + a batch write, meaningful
 * only against DESPL-320's real seeded units. DB-gated only, following
 * welding.service.test.ts's fixture pattern.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("client-snapshot.service (DB-backed)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { publishSnapshot, verifySnapshot, rejectSnapshot } = await import("./client-snapshot.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  // Serialize this whole file's DB-backed tests against
  // client-snapshot.read.test.ts, which races on the same DESPL-320 same-day
  // ProgressSnapshot rows when vitest runs both files in parallel workers
  // (see task-10 race-fix report). Held for the entire describe block, not
  // per-test: client-snapshot.read.test.ts has a test that depends on state
  // left behind by the PRECEDING test in the same file, so a per-test lock
  // still lets this file's cleanup()/deleteMany calls interleave BETWEEN
  // those two tests in the other worker and wipe the row out from under it.
  // 60s, not the 10s vitest default: under full-suite pool contention (8
  // workers sharing .env.test's connection_limit=10, plus the known
  // unrelated contention in files like portfolio.read.test.ts), the other
  // file's 13 sequential DB-gated tests can legitimately take longer than
  // 10s to finish and release this lock — that's real queueing, not a
  // deadlock. Applied to afterAll too for symmetry, though unlock+disconnect
  // shouldn't need it in practice.
  beforeAll(async () => {
    await owner.$executeRaw`SELECT pg_advisory_lock(${LOCK_KEY})`;
  }, 60000);
  afterAll(async () => {
    await owner.$executeRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    await owner.$disconnect();
  }, 60000);

  function actorBase(tenantId: number): Actor {
    return { userId: 1, tenantId, clientId: null, name: "Test", email: "t@x", roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM" as const, outdoorMode: false };
  }

  async function fixture() {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const unitCount = await owner.unit.count({ where: { equipment: { jobId: job.id } } });
    return { job, unitCount };
  }

  // Distinct user ids so publish/verify/reject are attributable to different
  // real people — the self-check compares actor.userId, not role.
  const ph = (tenantId: number): Actor => ({ ...actorBase(tenantId), userId: 4, roles: [ROLES.PRODUCTION_HEAD] });
  const md = (tenantId: number): Actor => ({ ...actorBase(tenantId), userId: 2, roles: [ROLES.MANAGEMENT] });
  const supervisor = (tenantId: number): Actor => ({ ...actorBase(tenantId), userId: 14, roles: [ROLES.SUPERVISOR] });

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  async function cleanup(jobId: number) {
    await owner.progressSnapshot.deleteMany({ where: { jobId } });
  }

  it("publishSnapshot refuses a Supervisor (role gate)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await expectCode(publishSnapshot(supervisor(job.tenantId), { jobId: job.id }), ERROR_CODES.FORBIDDEN);
  });

  it("verifySnapshot refuses a Supervisor (role gate)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    await expectCode(verifySnapshot(supervisor(job.tenantId), { jobId: job.id }), ERROR_CODES.FORBIDDEN);
  });

  it("rejectSnapshot refuses a Supervisor (role gate)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    await expectCode(
      rejectSnapshot(supervisor(job.tenantId), { jobId: job.id, reason: "needs a second look" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("rejectSnapshot by the same user who published is refused (maker–checker self-check)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const selfCheckActor: Actor = { ...md(job.tenantId), userId: 4 }; // same id as the PH actor above
    await expectCode(
      rejectSnapshot(selfCheckActor, { jobId: job.id, reason: "needs a second look" }),
      ERROR_CODES.MAKER_CHECKER_VIOLATION,
    );
  });

  it("publishSnapshot refuses with NOT_FOUND when the job has zero units", async () => {
    // A job with no equipment/units at all — loadJobSpines returns an empty
    // array, which publishSnapshot treats the same as "not found" (nothing to
    // publish). Reuses DESPL-320's own tenant/client/family/templateVersion
    // FKs rather than hardcoded seed ids, so this doesn't assume a particular
    // seed id layout.
    const { job: seedJob } = await fixture();
    const stamp = Date.now();
    const noUnitJob = await owner.job.create({
      data: {
        tenantId: seedJob.tenantId,
        publicId: `test-no-units-${stamp}`,
        clientId: seedJob.clientId,
        familyId: seedJob.familyId,
        templateVersionId: seedJob.templateVersionId,
        jobNumber: `TEST-NO-UNITS-${stamp}`,
      },
    });
    try {
      await expectCode(publishSnapshot(ph(noUnitJob.tenantId), { jobId: noUnitJob.id }), ERROR_CODES.NOT_FOUND);
    } finally {
      await owner.job.delete({ where: { id: noUnitJob.id } });
    }
  });

  it("publishSnapshot refuses with SNAPSHOT_PRIOR_DAY_PENDING when an earlier day's batch is still PUBLISHED", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    const priorAsOf = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
    // Simulate an un-reviewed earlier day's batch by inserting it directly
    // (no need to make real time pass) — one row is enough to trip the guard.
    const unit = await owner.unit.findFirst({ where: { equipment: { jobId: job.id } } });
    if (!unit) throw new Error("seed missing units for DESPL-320");
    await owner.progressSnapshot.create({
      data: {
        tenantId: job.tenantId,
        jobId: job.id,
        unitId: unit.id,
        asOf: priorAsOf,
        overallPct: 10,
        status: "PUBLISHED",
        publishedBy: 4,
        publishedAt: priorAsOf,
      },
    });
    await expectCode(publishSnapshot(ph(job.tenantId), { jobId: job.id }), ERROR_CODES.SNAPSHOT_PRIOR_DAY_PENDING);
  });

  it("publishSnapshot creates one PUBLISHED row per real unit", async () => {
    const { job, unitCount } = await fixture();
    await cleanup(job.id);
    const result = await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    expect(result.unitCount).toBe(unitCount);
    const rows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: result.asOf } });
    expect(rows).toHaveLength(unitCount);
    expect(rows.every((r) => r.status === "PUBLISHED")).toBe(true);
    expect(rows.every((r) => r.publishedBy === 4)).toBe(true);
  });

  it("publishSnapshot again the same day overwrites in place (same row ids)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    const first = await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const firstRows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: first.asOf } });
    const second = await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const secondRows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: second.asOf } });
    expect(secondRows.map((r) => r.id).sort()).toEqual(firstRows.map((r) => r.id).sort());
  });

  it("verifySnapshot refuses when nothing is PUBLISHED", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await expectCode(verifySnapshot(md(job.tenantId), { jobId: job.id }), ERROR_CODES.SNAPSHOT_NOT_PUBLISHED);
  });

  it("verifySnapshot by the same user who published is refused (maker–checker self-check)", async () => {
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const selfCheckActor: Actor = { ...md(job.tenantId), userId: 4 }; // same id as the PH actor above
    await expectCode(verifySnapshot(selfCheckActor, { jobId: job.id }), ERROR_CODES.MAKER_CHECKER_VIOLATION);
  });

  it("verifySnapshot self-check catches an orphaned row with a different publishedBy, not just row[0]", async () => {
    // Final-review fix: the self-check used to read only pending[0].publishedBy,
    // which only caught self-verification if every row in the batch shared one
    // publisher. Simulate the scenario the reviewer named — a stale row left
    // behind with a different publishedBy than the rest of today's batch
    // (e.g. a unit that dropped out of a later republish) — and confirm the
    // self-check still refuses when the ACTOR matches that one orphaned row,
    // even though it isn't necessarily the first row returned.
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id }); // all rows publishedBy: 4
    const rows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, status: "PUBLISHED" } });
    // Give exactly one row a different publisher (id 99), simulating the orphan.
    await owner.progressSnapshot.update({ where: { id: rows[0].id }, data: { publishedBy: 99 } });

    const orphanPublisher: Actor = { ...md(job.tenantId), userId: 99 };
    await expectCode(verifySnapshot(orphanPublisher, { jobId: job.id }), ERROR_CODES.MAKER_CHECKER_VIOLATION);
  });

  it("verifySnapshot moves every row to VERIFIED and locks it", async () => {
    const { job, unitCount } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const result = await verifySnapshot(md(job.tenantId), { jobId: job.id });
    const rows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: result.asOf } });
    expect(rows).toHaveLength(unitCount);
    expect(rows.every((r) => r.status === "VERIFIED")).toBe(true);
    expect(rows.every((r) => r.verifiedBy === 2)).toBe(true);

    // publishing again the same day is now refused — VERIFIED is frozen (invariant #6)
    await expectCode(publishSnapshot(ph(job.tenantId), { jobId: job.id }), ERROR_CODES.SNAPSHOT_ALREADY_VERIFIED);
  });

  it("rejectSnapshot requires a reason", async () => {
    // zod's own .strict()/.min() validation throws a raw ZodError here, not
    // an AppError — matches every other service in this codebase (grep
    // confirms ERROR_CODES.VALIDATION_FAILED is only ever thrown explicitly
    // for business checks like "already exists", never wrapped around a
    // schema .parse() failure). Assert the rejection generically, not a code.
    const { job } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    await expect(rejectSnapshot(md(job.tenantId), { jobId: job.id, reason: "" })).rejects.toThrow();
  });

  it("rejectSnapshot moves every row to REJECTED, and a fresh publish flips it back to PUBLISHED", async () => {
    const { job, unitCount } = await fixture();
    await cleanup(job.id);
    await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const rejected = await rejectSnapshot(md(job.tenantId), { jobId: job.id, reason: "Unit 320SR03's stage looks wrong, please recheck" });
    const rejectedRows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: rejected.asOf } });
    expect(rejectedRows.every((r) => r.status === "REJECTED")).toBe(true);
    expect(rejectedRows.every((r) => r.rejectionReason?.includes("320SR03"))).toBe(true);

    const republished = await publishSnapshot(ph(job.tenantId), { jobId: job.id });
    const republishedRows = await owner.progressSnapshot.findMany({ where: { jobId: job.id, asOf: republished.asOf } });
    expect(republishedRows).toHaveLength(unitCount);
    expect(republishedRows.every((r) => r.status === "PUBLISHED")).toBe(true);
    // same rows, flipped back — not a duplicate set
    expect(republishedRows.map((r) => r.id).sort()).toEqual(rejectedRows.map((r) => r.id).sort());
  });
});
