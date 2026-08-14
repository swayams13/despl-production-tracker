import { afterAll, describe, expect, it } from "vitest";
import { loadPrioritizedJob, loadOpenHoldPoints } from "./workspace.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * Read-only wiring: spine + CPM + prioritizer against real bootstrapped data.
 * No pure-testable surface without the DB, so this is skip-gated on
 * RUN_DB_TESTS=1 against a `pnpm db:seed`ed + bootstrapped database (DESPL-320
 * has a current run with 324 plans per the P4.0 bootstrap).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadPrioritizedJob (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("loads DESPL-320's current run, ranked per department", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    const actor: Actor = {
      userId: 1,
      tenantId: job.tenantId,
      clientId: null,
      name: "SJ",
      email: "sj@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
    };

    const result = await loadPrioritizedJob(actor, job.id);

    expect(result).not.toBeNull();
    expect(result!.rankedByDept.size).toBeGreaterThan(0);
    expect(result!.departments.length).toBeGreaterThan(0);
    expect(result!.processNameById.size).toBeGreaterThan(0);
  });

  it("lists open blocking hold points (QcpItem 8/9 on seq 10, per Task 3/7)", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    const actor: Actor = {
      userId: 1,
      tenantId: job.tenantId,
      clientId: null,
      name: "QC",
      email: "qc@despl.test",
      roles: [ROLES.QC],
      departmentIds: [],
    };

    const open = await loadOpenHoldPoints(actor, job.id);

    expect(open.length).toBeGreaterThan(0);
    for (const row of open) {
      expect(typeof row.qcpItemId).toBe("number");
      expect(typeof row.activity).toBe("string");
      expect(typeof row.unitId).toBe("number");
      expect(typeof row.serialNo).toBe("string");
    }
    expect(open.some((r) => r.qcpItemId === 8 || r.qcpItemId === 9)).toBe(true);
  });

  it("closes on ACCEPTED, reopens on a later REJECTED — proves latest-attempt read, not \"any ACCEPTED exists\"", async () => {
    const { recordQcpExecution } = await import("./qcp.service");

    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");

    // Looked up live (not hardcoded to 8/9), matching qcp.service.test.ts's /
    // process.service.test.ts's blockingQcpItemIds convention.
    const seq10 = await owner.jobProcess.findFirstOrThrow({ where: { jobId: job.id, seq: 10 } });
    const blocking = await owner.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcessId: seq10.id } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: { id: true },
    });
    expect(blocking.length).toBeGreaterThan(0); // sanity: seq 10 really has a blocking checkpoint
    const qcpItemId = blocking[0].id;

    const units = await owner.unit.findMany({ where: { equipment: { jobId: job.id } }, orderBy: { id: "asc" } });
    // process.service.test.ts touches units[0]/units[1] and
    // qcp.service.test.ts touches units[2] for QcpItem 4 on seq 1 — this
    // shared no-cleanup seed DB has no other writer to seq 10's checkpoints on
    // units[3], so it's safe ground for this test's own before/after.
    const unit = units[3];

    const qcActor: Actor = {
      userId: 9,
      tenantId: job.tenantId,
      clientId: null,
      name: "QC2",
      email: "qc2@despl.test",
      roles: [ROLES.QC],
      departmentIds: [],
    };

    // Reset own precondition so reruns stay green (same convention as
    // process.service.test.ts's clearHold / qcp.service.test.ts's deleteMany).
    await owner.qcpExecution.deleteMany({ where: { unitId: unit.id, qcpItemId } });

    const isOpen = async () => {
      const open = await loadOpenHoldPoints(qcActor, job.id);
      return open.some((r) => r.qcpItemId === qcpItemId && r.unitId === unit.id);
    };

    // RED: no execution recorded yet → the pair is open.
    expect(await isOpen()).toBe(true);

    // GREEN: ACCEPTED (attemptNo 1) closes it.
    const accepted = await recordQcpExecution(qcActor, { qcpItemId, unitId: unit.id, result: "ACCEPTED" });
    expect(accepted.attemptNo).toBe(1);
    expect(await isOpen()).toBe(false);

    // RED again: a LATER attempt (attemptNo 2, REJECTED) reopens it. This is
    // the case a naive "an ACCEPTED execution exists" check — or a reversed
    // sort order — would get wrong: it proves loadOpenHoldPoints reads the
    // LATEST attempt per (item, unit), exactly like assertNoOpenHoldPoint.
    const rejected = await recordQcpExecution(qcActor, { qcpItemId, unitId: unit.id, result: "REJECTED" });
    expect(rejected.attemptNo).toBe(2);
    expect(await isOpen()).toBe(true);
  });
});
