import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";
import type { WorkJob, WorkOrg } from "./work.test-util";

/**
 * D2 Acknowledge, DB-gated. Violations first: every role but the Production
 * Head, another tenant, a second acknowledgement; then the happy path, which
 * must leave the work item and the override row untouched. Then the two reads
 * (early-starts list, master-data review pairs) and the append-only grants.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("D2 acknowledge early starts (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { withTenant } = await import("@/lib/db");
  const { acknowledgeOverride } = await import("./override-ack.service");
  const { loadEarlyStarts, loadReviewPairs } = await import("./override-review.read");
  const { loadDigestPayload } = await import("./digest-email.read");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  const OTHER_ROLES = ["ADMIN", "MANAGEMENT", "SUPERVISOR", "QC", "OPERATOR", "PLANNER", "STORES", "ENGINEERING"] as const;
  let a: WorkOrg;
  let b: WorkOrg;
  let head: Actor;
  let head2: Actor;
  let bHead: Actor;
  const others = new Map<string, Actor>();
  let j: WorkJob;

  beforeAll(async () => {
    a = await makeWorkOrg(owner, "ACK-A");
    b = await makeWorkOrg(owner, "ACK-B");
    head = await a.user("head", ["PRODUCTION_HEAD"]);
    head2 = await a.user("head2", ["PRODUCTION_HEAD"]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
    for (const r of OTHER_ROLES) others.set(r, await a.user(r.toLowerCase(), [r]));
    j = await a.job({ units: 3, steps: [{ seq: 1 }, { seq: 2 }] });
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return isAppError(e) ? e.code : `NON_APP_ERROR: ${String(e)}`;
    }
    return null;
  };
  /** An early start of step 2 over step 1 on unit `i`, made by `by`. */
  const override = (i: number, by: Actor = head, createdAt?: Date, job: WorkJob = j) =>
    owner.sequenceOverride.create({
      data: {
        jobId: job.job.id,
        targetKind: "ASSEMBLY_STEP",
        targetId: job.step(2, i),
        unitId: job.units[i].id,
        predecessorTargetId: job.step(1, i),
        category: "CREW_OR_MACHINE_FREE",
        createdBy: by.userId,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  const acks = (overrideId: number) => owner.sequenceOverrideAck.findMany({ where: { overrideId } });
  const audits = (overrideId: number) => owner.auditLog.findMany({ where: { action: "override.acknowledge", entityId: String(overrideId) } });

  describe("refusals", () => {
    it.each(OTHER_ROLES)("%s cannot acknowledge, and nothing is written", async (role) => {
      const o = await override(0);
      expect(await code(acknowledgeOverride(others.get(role)!, { overrideId: o.id }))).toBe(ERROR_CODES.FORBIDDEN);
      expect(await acks(o.id)).toHaveLength(0);
      expect(await audits(o.id)).toHaveLength(0);
    });

    it("another tenant's Production Head cannot see it: NOT_FOUND, nothing written", async () => {
      const o = await override(0);
      expect(await code(acknowledgeOverride(bHead, { overrideId: o.id }))).toBe(ERROR_CODES.NOT_FOUND);
      expect(await acks(o.id)).toHaveLength(0);
    });

    it("an id that does not exist is NOT_FOUND; a malformed one fails validation", async () => {
      expect(await code(acknowledgeOverride(head, { overrideId: 2_000_000_000 }))).toBe(ERROR_CODES.NOT_FOUND);
      // A zod refusal; the Server Action turns it into VALIDATION_FAILED.
      await expect(acknowledgeOverride(head, { overrideId: -1 })).rejects.toThrow(/too small/i);
    });

    it("a second acknowledgement is refused, by the same or another Production Head, and adds nothing", async () => {
      const o = await override(1);
      await acknowledgeOverride(head, { overrideId: o.id });
      expect(await code(acknowledgeOverride(head, { overrideId: o.id }))).toBe(ERROR_CODES.OVERRIDE_ALREADY_ACKNOWLEDGED);
      expect(await code(acknowledgeOverride(head2, { overrideId: o.id }))).toBe(ERROR_CODES.OVERRIDE_ALREADY_ACKNOWLEDGED);
      expect(await acks(o.id)).toHaveLength(1);
      expect(await audits(o.id)).toHaveLength(1);
    });

    it("two taps at once: exactly one wins", async () => {
      const o = await override(2);
      const r = await Promise.all([acknowledgeOverride(head, { overrideId: o.id }), acknowledgeOverride(head2, { overrideId: o.id })].map(code));
      expect(r.filter((x) => x === null)).toHaveLength(1);
      expect(r.filter((x) => x === ERROR_CODES.OVERRIDE_ALREADY_ACKNOWLEDGED)).toHaveLength(1);
      expect(await acks(o.id)).toHaveLength(1);
      expect(await audits(o.id)).toHaveLength(1);
    });
  });

  describe("acknowledging", () => {
    it("records who and when, audits before/after, and leaves the work item and the override untouched", async () => {
      const o = await override(0, head); // the acknowledger may be the person who made the override
      const stepBefore = await owner.assemblyStep.findUniqueOrThrow({ where: { id: o.targetId } });
      const res = await acknowledgeOverride(head, { overrideId: o.id });
      expect(res.overrideId).toBe(o.id);

      const [ack] = await acks(o.id);
      expect(ack).toMatchObject({ acknowledgedBy: head.userId, jobId: j.job.id, tenantId: a.tenantId });
      expect(ack.acknowledgedAt).toEqual(res.acknowledgedAt);

      const [audit] = await audits(o.id);
      expect(audit).toMatchObject({ tenantId: a.tenantId, actorId: head.userId, entityType: "SequenceOverride" });
      expect(audit.before).toEqual({ acknowledged: false });
      expect(audit.after).toMatchObject({ acknowledged: true, acknowledgedBy: head.userId, jobId: j.job.id, targetId: o.targetId });

      expect(await owner.assemblyStep.findUniqueOrThrow({ where: { id: o.targetId } })).toEqual(stepBefore);
      expect(await owner.sequenceOverride.findUniqueOrThrow({ where: { id: o.id } })).toEqual(o);
    });
  });

  describe("append-only and tenant isolation", () => {
    it("despl_web cannot UPDATE, DELETE or TRUNCATE an acknowledgement", async () => {
      const o = await override(0);
      await acknowledgeOverride(head, { overrideId: o.id });
      const upd = withTenant(a.tenantId, (tx) => tx.$executeRaw`UPDATE sequence_override_acks SET acknowledged_by = ${head2.userId} WHERE override_id = ${o.id}`);
      await expect(upd).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM sequence_override_acks WHERE override_id = ${o.id}`)).rejects.toThrow(/permission denied/i);
      await expect(withTenant(a.tenantId, (tx) => tx.$executeRaw`TRUNCATE sequence_override_acks`)).rejects.toThrow(/permission denied/i);
    });

    it("tenant B reads none of tenant A's acknowledgements and cannot insert one on A's job", async () => {
      const o = await override(0);
      await acknowledgeOverride(head, { overrideId: o.id });
      expect(await withTenant(b.tenantId, (tx) => tx.sequenceOverrideAck.findMany({ where: { overrideId: o.id } }))).toHaveLength(0);
      const o2 = await override(1);
      await expect(
        withTenant(b.tenantId, (tx) => tx.sequenceOverrideAck.create({ data: { jobId: j.job.id, overrideId: o2.id, acknowledgedBy: bHead.userId } })),
      ).rejects.toThrow();
    });

    it("an override can carry only one acknowledgement (unique override_id)", async () => {
      const o = await override(0);
      await owner.sequenceOverrideAck.create({ data: { jobId: j.job.id, overrideId: o.id, acknowledgedBy: head.userId } });
      await expect(owner.sequenceOverrideAck.create({ data: { jobId: j.job.id, overrideId: o.id, acknowledgedBy: head2.userId } })).rejects.toThrow(/unique constraint/i);
    });
  });

  describe("loadEarlyStarts", () => {
    it("is for the Production Head only", async () => {
      for (const r of OTHER_ROLES) expect(await code(loadEarlyStarts(others.get(r)!))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("lists this tenant's unacknowledged overrides, flags the stale ones, and drops one once acknowledged", async () => {
      const own = await a.job({ units: 1, steps: [{ seq: 1 }, { seq: 2 }] });
      const fresh = await override(0, head, undefined, own);
      const old = await override(0, head, new Date(Date.now() - 6 * 86_400_000), own);
      await override(0, bHead, undefined, await b.job({ units: 1, steps: [{ seq: 1 }, { seq: 2 }] }));

      const v = await loadEarlyStarts(head);
      const mine = v.pending.filter((p) => p.jobNumber === own.job.jobNumber);
      expect(mine.map((p) => [p.id, p.stale]).sort()).toEqual([[fresh.id, false], [old.id, true]].sort());
      expect(v.pending.every((p) => p.jobNumber !== undefined)).toBe(true);
      expect(v.pendingTotal).toBe(await owner.sequenceOverride.count({ where: { tenantId: a.tenantId, ack: null } }));
      expect(v.staleTotal).toBeGreaterThanOrEqual(1);

      await acknowledgeOverride(head2, { overrideId: old.id });
      const after = await loadEarlyStarts(head);
      expect(after.pending.map((p) => p.id)).not.toContain(old.id);
      expect(after.pending.map((p) => p.id)).toContain(fresh.id);
      expect(after.pendingTotal).toBe(v.pendingTotal - 1);
    });
  });

  describe("loadReviewPairs", () => {
    it("is for master-data readers only", async () => {
      for (const r of ["QC", "OPERATOR", "SUPERVISOR", "STORES", "MANAGEMENT"]) expect(await code(loadReviewPairs(others.get(r)!))).toBe(ERROR_CODES.FORBIDDEN);
    });

    it("flags a pair overridden on all 3 of 3 units, not on 2 of 3, and shows no other tenant's", async () => {
      const full = await a.job({ units: 3, steps: [{ seq: 1 }, { seq: 2 }] });
      const partial = await a.job({ units: 3, steps: [{ seq: 1 }, { seq: 2 }] });
      for (const i of [0, 1, 2]) await override(i, head, undefined, full);
      for (const i of [0, 1]) await override(i, head, undefined, partial);
      const bj = await b.job({ units: 3, steps: [{ seq: 1 }, { seq: 2 }] });
      for (const i of [0, 1, 2]) await override(i, bHead, undefined, bj);

      const rows = await loadReviewPairs(head);
      const nums = rows.map((r) => r.jobNumber);
      expect(nums).toContain(full.job.jobNumber);
      expect(nums).not.toContain(partial.job.jobNumber);
      expect(nums).not.toContain(bj.job.jobNumber);
      expect(rows.find((r) => r.jobNumber === full.job.jobNumber)).toMatchObject({ units: 3, totalUnits: 3 });
      expect(await loadReviewPairs(others.get("ENGINEERING")!)).toEqual(rows);
    });
  });
  describe("digest: unacknowledged early starts", () => {
    const DAY = 86_400_000;
    const digestFor = async (actor: Actor, now: Date) =>
      (await loadDigestPayload(actor, { date: "2027-02-11", workDay: "2027-02-10", appUrl: null, now })).unreviewedEarlyStarts;

    it("one line per job for early starts older than 2 working days; fresh and acknowledged ones add nothing", async () => {
      const dj = await a.job({ units: 3, steps: [{ seq: 1 }, { seq: 2 }] });
      const admin = await a.user("digestadmin", ["ADMIN"]);
      // Pin "now" to a Thursday noon IST so 'two working days ago' is unambiguous on the 6-day week.
      const now = new Date("2027-02-11T06:30:00Z");
      const old1 = await override(0, head, new Date(now.getTime() - 4 * DAY), dj); // a Sunday: does not count toward the two working days
      const old2 = await override(1, head, new Date(now.getTime() - 3 * DAY), dj);
      const fresh = await override(2, head, new Date(now.getTime() - 0.5 * DAY), dj);

      const lines = await digestFor(admin, now);
      const mine = lines.find((l) => l.jobNumber === dj.job.jobNumber);
      expect(mine).toMatchObject({ count: 2, oldestAt: old1.createdAt.toISOString() });
      expect(lines.filter((l) => l.jobNumber === dj.job.jobNumber)).toHaveLength(1);

      await acknowledgeOverride(head, { overrideId: old1.id });
      expect((await digestFor(admin, now)).find((l) => l.jobNumber === dj.job.jobNumber)).toMatchObject({ count: 1, oldestAt: old2.createdAt.toISOString() });

      await acknowledgeOverride(head, { overrideId: old2.id });
      expect((await digestFor(admin, now)).find((l) => l.jobNumber === dj.job.jobNumber)).toBeUndefined();
      expect(fresh.id).toBeGreaterThan(0);
    });

    it("another tenant's early starts never appear", async () => {
      const bj = await b.job({ units: 1, steps: [{ seq: 1 }, { seq: 2 }] });
      await override(0, bHead, new Date(Date.now() - 10 * DAY), bj);
      const admin = await a.user("digestadmin2", ["ADMIN"]);
      expect((await digestFor(admin, new Date())).map((l) => l.jobNumber)).not.toContain(bj.job.jobNumber);
    });
  });
});
