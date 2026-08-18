import { afterAll, describe, expect, it } from "vitest";
import { loadDepartmentCards, loadDepartmentDetail } from "./departments.read";
import { ROLES, type Actor } from "@/lib/authz";

describe.skipIf(!process.env.RUN_DB_TESTS)("departments.read (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function actorFor(job: { tenantId: number }): Promise<Actor> {
    return {
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
  }

  it("loads all 13 seeded departments with in-range on-time percentages", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const actor = await actorFor(job);

    const cards = await loadDepartmentCards(actor);

    expect(cards.length).toBe(13);
    const qc = cards.find((c) => c.code === "QC");
    expect(qc).toBeDefined();
    expect(qc!.name).toBe("Quality Control / QA");
    for (const c of cards) {
      expect(c.openCount).toBeGreaterThanOrEqual(0);
      expect(c.overdueCount).toBeGreaterThanOrEqual(0);
      expect(c.overdueCount).toBeLessThanOrEqual(c.openCount);
      if (c.onTimePct != null) {
        expect(c.onTimePct).toBeGreaterThanOrEqual(0);
        expect(c.onTimePct).toBeLessThanOrEqual(100);
      }
    }
  });

  it("loads a department's detail: open items, cycle time, reason breakdown", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const actor = await actorFor(job);

    const qcDept = await owner.department.findFirst({ where: { code: "QC", tenantId: job.tenantId } });
    if (!qcDept) throw new Error("seed missing QC department");

    const detail = await loadDepartmentDetail(actor, qcDept.id);

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(qcDept.id);
    for (const it of detail!.openItems) {
      expect(typeof it.jobNumber).toBe("string");
      expect(it.stageNo).toBeGreaterThan(0);
      expect(typeof it.overdue).toBe("boolean");
    }
    // Open items are sorted by due date ascending (nulls first).
    const dated = detail!.openItems.map((i) => i.plannedFinish).filter((d): d is string => d != null);
    for (let i = 1; i < dated.length; i++) {
      expect(dated[i] >= dated[i - 1]).toBe(true);
    }
    for (const c of detail!.cycleTime) {
      expect(c.standardDays).toBeGreaterThan(0);
    }
    // Cycle time is sorted worst-delta-first.
    for (let i = 1; i < detail!.cycleTime.length; i++) {
      expect(detail!.cycleTime[i].deltaDays).toBeLessThanOrEqual(detail!.cycleTime[i - 1].deltaDays);
    }
    for (const r of detail!.reasonBreakdown) {
      expect(r.count).toBeGreaterThan(0);
    }
  });

  it("returns null for a non-existent department id", async () => {
    const job = await owner.job.findFirst({ where: { jobNumber: "DESPL-320" } });
    if (!job) throw new Error("seed missing DESPL-320 — run pnpm db:seed");
    const actor = await actorFor(job);

    const detail = await loadDepartmentDetail(actor, 999999);
    expect(detail).toBeNull();
  });
});
