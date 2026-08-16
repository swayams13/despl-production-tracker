import { afterAll, describe, expect, it } from "vitest";
import { ROLES, type Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/**
 * `recordQcpExecution` (Task 7) has no pure logic worth unit-testing in
 * isolation — it's a role gate + an attemptNo aggregate + a create, all of
 * which only mean something against real gating (assertNoOpenHoldPoint in
 * _shared.ts) and a real seeded QcpItem/QcpExecution chain. So this file is
 * DB-gated only, following process.service.test.ts's DESPL-320 block.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("recordQcpExecution (DB-backed, clears a real hold point)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { generateSchedule } = await import("./schedule.service");
  const { startProcess, submitProcess, verifyProcess } = await import("./process.service");
  const { recordQcpExecution } = await import("./qcp.service");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  function planner(tenantId: number): Actor {
    return {
      userId: 1,
      tenantId,
      clientId: null,
      name: "PH",
      email: "ph@x",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
      mustChangePassword: false,
    };
  }

  async function despl320(): Promise<{ jobId: number; tenantId: number }> {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    return { jobId: job.id, tenantId: job.tenantId };
  }

  /** Look up a DESPL-320 job process by its stable template seq (1..36), not
   * its DB primary key — the seed's insertion order can shift across reseeds. */
  async function procId(jobId: number, seq: number): Promise<number> {
    const jp = await owner.jobProcess.findFirstOrThrow({ where: { jobId, seq } });
    return jp.id;
  }

  /** Every currently-linked blocking (blocksCompletion=true) QCP checkpoint on
   * a job process — looked up live, never hardcoded (matches
   * process.service.test.ts's per-unit hold-point block). */
  async function blockingQcpItemIds(jobProcessId: number): Promise<number[]> {
    const items = await owner.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcessId } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true },
    });
    return items.map((i) => i.id);
  }

  async function expectCode(p: Promise<unknown>, expected: string): Promise<void> {
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(isAppError(thrown) && thrown.code).toBe(expected);
  }

  const future = new Date(Date.now() + 30 * 864e5);

  it("recording ACCEPTED clears a genuinely open hold point so verify succeeds (#4)", async () => {
    const { jobId, tenantId } = await despl320();
    const a = planner(tenantId);

    // seq 1 (PO Receipt & Order Review) is a root process — no predecessors of
    // its own — and carries a real blocking checkpoint (seeded QcpItem 4), so
    // start→submit succeeds cleanly and the only thing standing between
    // SUBMITTED and COMPLETE is the uncleared hold point.
    const seq1Id = await procId(jobId, 1);
    const blocking = await blockingQcpItemIds(seq1Id);
    expect(blocking.length).toBeGreaterThan(0); // sanity: a real blocking checkpoint IS linked here

    // Use a unit process.service.test.ts's DB block never touches (it clears
    // QcpItem 4 for the FIRST unit only) — pick the third instead, so this
    // test's own hold point is genuinely open, not already cleared by a
    // sibling suite sharing this no-cleanup seed DB.
    const unit = (
      await owner.unit.findMany({ where: { equipment: { jobId } }, orderBy: { id: "asc" } })
    )[2];

    // Reset: QcpExecution is unit-scoped state with no end-of-suite cleanup
    // (matches this file's "no cleanup, disposable test DB" convention) — but
    // THIS test asserts a genuine before/after (HOLD_POINT_OPEN → cleared), so
    // it resets its own precondition at the start to stay rerun-safe.
    await owner.qcpExecution.deleteMany({ where: { unitId: unit.id, qcpItemId: { in: blocking } } });

    const run = await generateSchedule(a, { jobId, mode: "FORWARD", projectStartDate: future });
    const planId = run.processPlans.find((p) => p.jobProcessId === seq1Id && p.unitId === unit.id)!.id;

    const maker: Actor = a;
    const checker: Actor = { ...a, userId: 2, roles: [ROLES.QC] };

    await startProcess(maker, { processPlanId: planId });
    await submitProcess(maker, { processPlanId: planId });

    // RED: no QcpExecution recorded yet for this unit → verify refuses.
    await expectCode(verifyProcess(checker, { processPlanId: planId }), ERROR_CODES.HOLD_POINT_OPEN);

    const qcActor: Actor = { ...a, userId: 3, roles: [ROLES.QC] };
    for (const qcpItemId of blocking) {
      const exec = await recordQcpExecution(qcActor, {
        qcpItemId,
        unitId: unit.id,
        result: "ACCEPTED",
      });
      expect(exec.result).toBe("ACCEPTED");
      expect(exec.attemptNo).toBe(1);
      expect(exec.clearedBy).toBe(qcActor.userId);
    }

    // GREEN: every blocking checkpoint is now ACCEPTED for this unit → verify succeeds.
    const verified = await verifyProcess(checker, { processPlanId: planId });
    expect(verified.status).toBe("COMPLETE");
  });

  it("client user is rejected — read-only, no exceptions (#1 access rule)", async () => {
    const { tenantId } = await despl320();
    // roles: [QC] so the ONLY thing that can throw FORBIDDEN here is
    // assertNotClientUser — if it were ever deleted, requireRole would still
    // pass and this test would catch the regression instead of masking it.
    const clientActor: Actor = { ...planner(tenantId), clientId: 1, roles: [ROLES.QC] };
    await expectCode(
      recordQcpExecution(clientActor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });

  it("non-QC actor (e.g. SUPERVISOR) is rejected — recording an inspection result is a QC act", async () => {
    const { tenantId } = await despl320();
    const supervisor: Actor = { ...planner(tenantId), roles: [ROLES.SUPERVISOR] };
    await expectCode(
      recordQcpExecution(supervisor, { qcpItemId: 1, unitId: 1, result: "ACCEPTED" }),
      ERROR_CODES.FORBIDDEN,
    );
  });
});
