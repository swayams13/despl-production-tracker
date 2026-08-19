import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

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

  afterAll(async () => {
    await owner.$disconnect();
  });

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
