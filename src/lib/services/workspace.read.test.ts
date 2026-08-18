import { afterAll, describe, expect, it } from "vitest";
import { loadPrioritizedJob, loadOpenHoldPoints, loadJobKpis } from "./workspace.read";
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
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const result = await loadPrioritizedJob(actor, job.id);

    expect(result).not.toBeNull();
    expect(result!.rankedByDept.size).toBeGreaterThan(0);
    expect(result!.departments.length).toBeGreaterThan(0);
    expect(result!.processNameById.size).toBeGreaterThan(0);
    expect(result!.delayCategories.length).toBeGreaterThan(0);
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
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
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

  it("aggregates JobKpis from real plan data (Task 13)", async () => {
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
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
    };

    const kpis = await loadJobKpis(actor, job.id);

    expect(kpis).not.toBeNull();
    expect(kpis!.totalPlans).toBe(324); // P4.0 bootstrap plan count
    expect(kpis!.percentComplete).toBeGreaterThanOrEqual(0);
    expect(kpis!.percentComplete).toBeLessThanOrEqual(100);
    expect(kpis!.deptMatrix.length).toBeGreaterThan(0);
    // byState buckets every plan exactly once — no double-counting, none dropped.
    expect(Object.values(kpis!.byState).reduce((a, b) => a + b, 0)).toBe(324);

    // §4.2 dashboard fields — structural + directional checks (the shared
    // no-cleanup fixture makes exact values test-order-dependent; these pin
    // shape and invariants, not specific numbers).
    expect(kpis!.jobNumber).toBe("DESPL-320");
    expect(kpis!.unitCount).toBe(9);
    expect(kpis!.deliveryDate).toBeNull(); // DESPL-320's contractual date is deliberately unset (pending DESPL)
    expect(kpis!.forecastVarianceDays).toBeNull(); // no contractual date → no variance to compute
    // deptMatrix rows now carry a departmentId + onTimePct alongside the counts.
    for (const row of kpis!.deptMatrix) {
      expect(typeof row.departmentId).toBe("number");
      if (row.onTimePct !== null) {
        expect(row.onTimePct).toBeGreaterThanOrEqual(0);
        expect(row.onTimePct).toBeLessThanOrEqual(100);
      }
    }
    // first-pass yield is a percentage (or null if nothing's ever been submitted).
    if (kpis!.stats.firstPassYieldPct !== null) {
      expect(kpis!.stats.firstPassYieldPct).toBeGreaterThanOrEqual(0);
      expect(kpis!.stats.firstPassYieldPct).toBeLessThanOrEqual(100);
    }
    expect(kpis!.stats.reasonsPending).toBeGreaterThanOrEqual(0);
    expect(kpis!.stats.activeUsersToday).toBeGreaterThanOrEqual(0);
    expect(kpis!.stats.activeUsersToday).toBeLessThanOrEqual(kpis!.stats.activeUsersTotal);
    // throughput is always exactly 7 weekly buckets, oldest → newest.
    expect(kpis!.throughputByWeek.length).toBe(7);
    expect(kpis!.throughputByWeek.every((w) => w.count >= 0)).toBe(true);
    // cycle-time offenders only ever list processes running LONG (never negative/zero delta).
    expect(kpis!.cycleTimeOffenders.every((o) => o.deltaDays > 0)).toBe(true);
    expect(kpis!.cycleTimeOffenders.length).toBeLessThanOrEqual(5);
    // critical-path panel is always overdue+critical, top 5, sorted worst-first.
    expect(kpis!.criticalPathBlocking.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < kpis!.criticalPathBlocking.length; i++) {
      expect(kpis!.criticalPathBlocking[i].daysOverdue).toBeLessThanOrEqual(kpis!.criticalPathBlocking[i - 1].daysOverdue);
    }
    // hold points top-5 is a subset of, and no larger than, the full open list.
    expect(kpis!.holdPointsTop.length).toBeLessThanOrEqual(5);
    expect(kpis!.holdPointsTop.length).toBeLessThanOrEqual(kpis!.openHoldPoints);
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
      mustChangePassword: false,
      themePreference: "SYSTEM",
      outdoorMode: false,
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
