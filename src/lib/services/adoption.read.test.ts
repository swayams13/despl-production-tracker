import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";
import { ERROR_CODES, isAppError } from "@/lib/shared/errors";

/** Lean Core L3.1, DB-gated: the company-wide same-day series (adoption.read.ts). */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L3.1 adoption (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadAdoption } = await import("./adoption.read");
  const { recordWork } = await import("./work.service");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  let o: Awaited<ReturnType<typeof makeWorkOrg>>;
  let b: Awaited<ReturnType<typeof makeWorkOrg>>;
  let sup: Actor;
  let bSup: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "ADOPT");
    b = await makeWorkOrg(owner, "ADOPTB");
    sup = await o.user("sup", ["SUPERVISOR"], [o.fab.id]);
    bSup = await b.user("bsup", ["SUPERVISOR"], [b.fab.id]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  it("counts today's updates, drops one that was entered late, and never shows another tenant's", async () => {
    const j = await o.job({ processes: [{ code: "20" }], steps: [{ seq: 1, requiresQc: false }, { seq: 2, requiresQc: false }] });
    await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(1) }] });
    await recordWork(sup, { jobId: j.job.id, action: "DONE", items: [{ kind: "ASSEMBLY_STEP", id: j.step(2) }] });
    const before = await loadAdoption(sup);
    const today = before.series.at(-1)!;
    expect(today.total).toBeGreaterThanOrEqual(2);

    await owner.assemblyStep.update({ where: { id: j.step(2) }, data: { reportedFinishAt: new Date(Date.now() - 30 * 3600 * 1000) } });
    const after = (await loadAdoption(sup)).series.at(-1)!;
    expect(after.total).toBe(today.total);
    expect(after.same).toBe(today.same - 1);

    // the other tenant has recorded nothing
    expect((await loadAdoption(bSup)).series.at(-1)!.total).toBe(0);
  });

  it("refuses a client user", async () => {
    try {
      await loadAdoption({ ...sup, clientId: 1 });
      expect.unreachable();
    } catch (e) {
      expect(isAppError(e) && e.code).toBe(ERROR_CODES.FORBIDDEN);
    }
  });
});
