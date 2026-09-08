import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { istCalendarDayMarker, isOverdue } from "@/lib/shared/business-day";
import { loadJobs } from "./jobs.read";
import { loadPortfolio } from "./portfolio.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * AUD-027 — SQL's notion of "overdue" used a raw `now() AT TIME ZONE 'UTC'`
 * compare, which flips a plan overdue at 00:00 UTC = 05:30 IST on its own due
 * date, a full working day early (business-day.ts's own doc comment). The TS
 * fix (istCalendarDayMarker/isOverdue) already ships everywhere the app
 * computes overdue-ness; this file is the cross-language regression guard
 * proving the three raw-SQL sites (the ist_day_marker() function itself,
 * v_unit_stage_status.is_overdue, jobs.read.ts's tallies, and
 * portfolio.read.ts's newly_overdue) now agree with it.
 *
 * Fixtures below deliberately avoid depending on the wall-clock time the
 * test happens to run at. `istCalendarDayMarker(now)` ("M") always satisfies
 * `M - 5.5h <= now < M + 18.5h`, and the rolling-24h window's `since` always
 * satisfies `since <= M - 5.5h` (both hold at any time of day — see the
 * comment on the "recent" fixture below) — so "M - 1 hour" is always inside
 * the rolling window and "M - 10 days" is always outside it, regardless of
 * when this suite runs.
 *
 * Run with RUN_DB_TESTS=1 and DIRECT_URL pointing at a migrated+seeded DB.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

const REF = { tenant: 1, client: 1, family: 1, templateVersion: 1, dept: 1 };
const JOB_NUMBER = "AUD027-OVERDUE-TEST";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe.skipIf(!RUN_DB)("SQL/TS overdue parity (AUD-027)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { prisma } = await import("@/lib/db");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  // Captured once so every assertion in the file reasons about the same
  // instant the fixture rows were built against.
  const now = new Date();
  const marker = istCalendarDayMarker(now); // "M" in the file-header comment
  const dueOld = new Date(marker.getTime() - 10 * DAY_MS); // overdue, outside the 24h window
  const dueRecent = new Date(marker.getTime() - HOUR_MS); // overdue, inside the 24h window
  const dueToday = new Date(marker.getTime()); // not overdue (the historical bug's exact case)

  let jobId = 0;
  let unitId = 0;

  async function teardown(): Promise<void> {
    const job = await owner.job.findUnique({
      where: { tenantId_jobNumber: { tenantId: REF.tenant, jobNumber: JOB_NUMBER } },
      select: { id: true, equipments: { select: { id: true, units: { select: { id: true } } } } },
    });
    if (!job) return;
    await owner.processPlan.deleteMany({ where: { jobProcess: { jobId: job.id } } });
    await owner.scheduleRun.deleteMany({ where: { jobId: job.id } });
    await owner.unit.deleteMany({ where: { equipment: { jobId: job.id } } });
    await owner.equipment.deleteMany({ where: { jobId: job.id } });
    await owner.jobProcess.deleteMany({ where: { jobId: job.id } });
    await owner.job.delete({ where: { id: job.id } });
  }

  beforeAll(async () => {
    await teardown(); // idempotent: clear any leftover fixture from a prior run
    const job = await owner.job.create({
      data: {
        tenantId: REF.tenant,
        publicId: "aud027-overdue-test",
        clientId: REF.client,
        familyId: REF.family,
        templateVersionId: REF.templateVersion,
        jobNumber: JOB_NUMBER,
      },
    });
    jobId = job.id;
    const eq = await owner.equipment.create({ data: { jobId, name: "AUD027-EQ" } });
    const unit = await owner.unit.create({ data: { jobId, equipmentId: eq.id, serialNo: "AUD027-01" } });
    unitId = unit.id;

    const run = await owner.scheduleRun.create({
      data: { jobId, version: 1, mode: "FORWARD", projectStartDate: now, isCurrent: true },
    });

    const mkPlan = async (seq: number, code: string, stage: number, plannedFinish: Date) => {
      const jp = await owner.jobProcess.create({
        data: { jobId, seq, code, name: `AUD027 ${code}`, departmentId: REF.dept, workOrderStages: [stage] },
      });
      return owner.processPlan.create({
        data: {
          jobId,
          scheduleRunId: run.id,
          jobProcessId: jp.id,
          unitId,
          ownerDepartmentId: REF.dept,
          status: "IN_PROGRESS",
          plannedFinish,
        },
      });
    };

    await mkPlan(1, "OLD", 1, dueOld);
    await mkPlan(2, "RECENT", 2, dueRecent);
    await mkPlan(3, "TODAY", 3, dueToday);
  });

  afterAll(async () => {
    await teardown();
    await owner.$disconnect();
  });

  function actor(): Actor {
    return {
      userId: 1, tenantId: REF.tenant, clientId: null, name: "Test", email: "t@despl.local",
      roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
      themePreference: "SYSTEM", outdoorMode: false,
    };
  }

  it("ist_day_marker() reproduces istCalendarDayMarker() exactly at the IST-midnight boundary", async () => {
    // Same literal instants as business-day.test.ts's istCalendarDayMarker suite.
    const cases: [string, Date][] = [
      ["2026-08-25T18:29:00Z", new Date("2026-08-25T18:29:00Z")], // 23:59 IST Aug 25 — still Aug 25
      ["2026-08-25T18:30:00Z", new Date("2026-08-25T18:30:00Z")], // 00:00 IST Aug 26 — already Aug 26
      ["2026-08-26T00:00:00Z", new Date("2026-08-26T00:00:00Z")], // 05:30 IST Aug 26 — the audit H1 bug's exact instant
    ];
    for (const [literal, instant] of cases) {
      const rows = await prisma.$queryRaw<{ marker: Date }[]>`SELECT ist_day_marker(${literal}::timestamptz) AS marker`;
      expect(rows[0].marker.toISOString()).toBe(istCalendarDayMarker(instant).toISOString());
    }
  });

  it("case 1/2 boundary: due=today's marker is never overdue, due=any earlier marker is overdue — TS side", () => {
    expect(isOverdue(dueToday, now)).toBe(false); // scenario 1
    expect(isOverdue(dueRecent, now)).toBe(true); // scenario 2
    expect(isOverdue(dueOld, now)).toBe(true);
  });

  it("v_unit_stage_status.is_overdue agrees with isOverdue() for all three plans (case 3)", async () => {
    async function isOverdueAt(stage: number): Promise<boolean> {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(REF.tenant)}, true)`;
        return tx.$queryRaw<{ is_overdue: boolean }[]>`
          SELECT is_overdue FROM v_unit_stage_status
          WHERE job_id = ${jobId} AND unit_id = ${unitId} AND stage_no = ${stage}
        `;
      });
      expect(rows.length).toBe(1);
      return rows[0].is_overdue;
    }

    expect(await isOverdueAt(1)).toBe(isOverdue(dueOld, now)); // true
    expect(await isOverdueAt(2)).toBe(isOverdue(dueRecent, now)); // true
    expect(await isOverdueAt(3)).toBe(isOverdue(dueToday, now)); // false — the audit H1 case
  });

  it("jobs.read.ts's overdue tally agrees with isOverdue() (case 4a)", async () => {
    const expectedOverdue = [dueOld, dueRecent, dueToday].filter((d) => isOverdue(d, now)).length;
    expect(expectedOverdue).toBe(2);

    const list = await loadJobs(actor());
    const row = list.find((j) => j.id === jobId);
    expect(row).toBeDefined();
    expect(row!.overduePlans).toBe(expectedOverdue);
  });

  it(
    "portfolio.read.ts's newly_overdue agrees with isOverdue() restricted to the rolling 24h window (case 4b)",
    async () => {
      // Only "recent" (M - 1h) falls inside [now - 24h, M) — "old" (M - 10 days)
      // is genuinely overdue but not *newly* overdue, and must NOT be counted.
      // loadPortfolio composes loadJobs across every job in the tenant (~2N+3
      // queries per its own doc comment), so the seeded DB's job count can push
      // this past vitest's default 5s timeout.
      const p = await loadPortfolio(actor());
      const row = p.rows.find((r) => r.id === jobId);
      expect(row).toBeDefined();
      expect(row!.newlyOverdueLast24h).toBe(1);
    },
    20_000,
  );
});
