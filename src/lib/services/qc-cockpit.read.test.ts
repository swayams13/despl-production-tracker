import { afterAll, describe, expect, it } from "vitest";
import { loadQcCockpit } from "./qc-cockpit.read";
import { ROLES, type Actor } from "@/lib/authz";

/**
 * `/qc`'s first cross-job aggregate — no job filter at all, unlike every
 * prior read service. Skip-gated on RUN_DB_TESTS=1 like the rest of the
 * suite; the shared no-cleanup fixture means other DB test files may have
 * mutated DESPL-320's plans by the time this runs, so these pin shape and
 * invariants, not exact counts (same style as workspace.read.test.ts).
 */
describe.skipIf(!process.env.RUN_DB_TESTS)("loadQcCockpit (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it("aggregates the QC cockpit across every job in the tenant", async () => {
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
    };

    const cockpit = await loadQcCockpit(actor);

    // Queue: every row carries a real job/unit/stage triple a StageSheet can open.
    for (const row of cockpit.queue) {
      expect(typeof row.jobId).toBe("number");
      expect(typeof row.jobNumber).toBe("string");
      expect(typeof row.unitId).toBe("number");
      expect(row.stageNo).toBeGreaterThan(0);
    }
    // Oldest-submission-first: non-null submittedAt values are non-decreasing.
    const dated = cockpit.queue.map((r) => r.submittedAt).filter((s): s is string => s != null);
    for (let i = 1; i < dated.length; i++) {
      expect(new Date(dated[i]).getTime()).toBeGreaterThanOrEqual(new Date(dated[i - 1]).getTime());
    }

    // Hold points: every row resolves to a real (job, unit, stage) and never
    // includes a cleared (ACCEPTED/NA) checkpoint.
    for (const h of cockpit.holdPoints) {
      expect(h.status).not.toBe("Cleared");
      expect(h.stageNo).toBeGreaterThan(0);
      expect(typeof h.jobNumber).toBe("string");
    }

    // Yield trend: exactly 6 weeks, oldest to newest, yieldPct always 0–100 or null.
    expect(cockpit.yieldTrend).toHaveLength(6);
    for (let i = 1; i < cockpit.yieldTrend.length; i++) {
      expect(new Date(cockpit.yieldTrend[i].weekStart).getTime()).toBeGreaterThan(new Date(cockpit.yieldTrend[i - 1].weekStart).getTime());
    }
    for (const w of cockpit.yieldTrend) {
      if (w.yieldPct != null) {
        expect(w.yieldPct).toBeGreaterThanOrEqual(0);
        expect(w.yieldPct).toBeLessThanOrEqual(100);
      }
      expect(w.rejected).toBeLessThanOrEqual(w.submitted);
    }

    // Rejects-by-checkpoint: capped at 8, sorted worst-first, never negative.
    expect(cockpit.rejectsByCheckpoint.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < cockpit.rejectsByCheckpoint.length; i++) {
      expect(cockpit.rejectsByCheckpoint[i].count).toBeLessThanOrEqual(cockpit.rejectsByCheckpoint[i - 1].count);
    }
  });
});
