import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authz";
import type { WorkOrg } from "./work.test-util";

/**
 * Invariant 5 for recordWork: if any audit insert fails, the whole batch rolls
 * back — the items already applied earlier in the batch, their override rows
 * and the rollup included. The audit module is wrapped so one call can be
 * made to fail on demand; every other call is the real recordAudit.
 */
const audit = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...real,
    recordAudit: async (...args: Parameters<typeof real.recordAudit>) => {
      if (audit.failOnCall && ++audit.calls === audit.failOnCall) throw new Error("forced audit insert failure");
      return real.recordAudit(...args);
    },
  };
});

const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L1.2d recordWork: forced audit failure (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { recordWork } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: WorkOrg;
  let sup: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "AUD");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  it("the second item's audit insert fails: nothing of the batch is saved", async () => {
    const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, processSeq: 20 }, { seq: 2, processSeq: 20 }] });
    const ids = [j.step(1), j.step(2)];
    audit.calls = 0;
    audit.failOnCall = 2;
    await expect(
      recordWork(sup, {
        jobId: j.job.id,
        action: "START",
        requestId: crypto.randomUUID(),
        override: { category: "CLIENT_PRIORITY" },
        items: ids.map((id) => ({ kind: "ASSEMBLY_STEP" as const, id })),
      }),
    ).rejects.toThrow("forced audit insert failure");
    audit.failOnCall = 0;

    const steps = await owner.assemblyStep.findMany({ where: { id: { in: ids } } });
    expect(steps.map((s) => [s.status, s.startedAt])).toEqual([
      ["NOT_STARTED", null],
      ["NOT_STARTED", null],
    ]);
    expect(await owner.auditLog.count({ where: { tenantId: o.tenantId, entityId: { in: ids.map(String) } } })).toBe(0);
    expect(await owner.sequenceOverride.count({ where: { jobId: j.job.id } })).toBe(0);
    expect(await owner.workRequest.count({ where: { jobId: j.job.id } })).toBe(0);
    expect((await owner.processPlan.findUniqueOrThrow({ where: { id: j.plan("20", 0) } })).status).toBe("NOT_STARTED");

    // Mutation check of the harness itself: with the audit working, the same batch applies.
    const ok = await recordWork(sup, {
      jobId: j.job.id,
      action: "START",
      override: { category: "CLIENT_PRIORITY" },
      items: ids.map((id) => ({ kind: "ASSEMBLY_STEP" as const, id })),
    });
    expect(ok.applied).toHaveLength(2);
  });
});
