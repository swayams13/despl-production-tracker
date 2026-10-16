import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/authz";

/**
 * Lean Core L2.7, DB-gated: the Portfolio's bars and queue (portfolio.read.ts
 * loadPortfolioFacts / loadPortfolioBottlenecks / loadPortfolioExceptions).
 * The invariants that matter: a bar's number equals the count on the Team page
 * it links to, another tenant's work never appears, and the queue is ranked.
 */
const RUN_DB = !!process.env.RUN_DB_TESTS && !!process.env.DIRECT_URL;

describe.skipIf(!RUN_DB)("L2.7 Portfolio operations (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { loadPortfolioBottlenecks, loadPortfolioExceptions } = await import("./portfolio.read");
  const { loadTeam } = await import("./team.read");
  const { makeWorkOrg } = await import("./work.test-util");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  type Org = Awaited<ReturnType<typeof makeWorkOrg>>;
  let o: Org;
  let b: Org;
  let head: Actor;
  let bHead: Actor;
  beforeAll(async () => {
    o = await makeWorkOrg(owner, "PFOPS");
    b = await makeWorkOrg(owner, "PFOPSB");
    head = await o.user("head", ["PRODUCTION_HEAD"]);
    bHead = await b.user("bhead", ["PRODUCTION_HEAD"]);
  });
  afterAll(async () => {
    await owner.$disconnect();
  });

  async function fixture() {
    const past = new Date(Date.now() - 3 * 86_400_000);
    const future = new Date(Date.now() + 5 * 86_400_000);
    return o.job({
      processes: [
        { code: "20", plannedFinish: past },
        { code: "21", plannedFinish: past },
        { code: "22", plannedFinish: future },
      ],
    });
  }

  it("a bar's overdue number equals the overdue rows on the Team page it links to", async () => {
    const j = await fixture();
    const bar = (await loadPortfolioBottlenecks(head, j.job.id)).find((x) => x.deptId === o.fab.id)!;
    expect(bar.overdue).toBeGreaterThanOrEqual(2);
    const team = (await loadTeam(head, { id: o.fab.id, code: o.fab.code, name: o.fab.name }))!;
    const overdueHere = team.overdueBlocked.filter((r) => r.jobId === j.job.id && r.overdue).length;
    expect(bar.overdue).toBe(overdueHere);
    expect(bar.overdueHref).toBe(`/team/${o.fab.code.toLowerCase()}?status=overdue&job=${j.job.id}`);
    expect(bar.rejectedHref).toBe(`/qc?tab=ncrs&job=${j.job.id}`);
  });

  it("the queue carries the job's overdue work, grouped by process, with a link to its Team page", async () => {
    const j = await fixture();
    const q = (await loadPortfolioExceptions(head, j.job.id)).filter((e) => e.kind === "OVERDUE");
    expect(q.length).toBeGreaterThanOrEqual(2);
    expect(q.every((e) => e.jobId === j.job.id && e.href.includes(`job=${j.job.id}`))).toBe(true);
  });

  it("never shows another tenant's work", async () => {
    const j = await fixture();
    expect((await loadPortfolioExceptions(bHead)).some((e) => e.jobId === j.job.id)).toBe(false);
    expect((await loadPortfolioBottlenecks(bHead, j.job.id)).length).toBe(0);
  });

  it("the queue is ranked worst job first, then NCR, hold, late work", async () => {
    await fixture();
    const q = await loadPortfolioExceptions(head);
    const kindRank = { NCR: 0, HOLD: 1, OVERDUE: 2 } as const;
    const seen = new Set<number>();
    for (let i = 0; i < q.length; i++) {
      const prev = q[i - 1];
      if (prev && prev.jobId === q[i].jobId) {
        expect(kindRank[prev.kind]).toBeLessThanOrEqual(kindRank[q[i].kind]);
      } else {
        expect(seen.has(q[i].jobId)).toBe(false); // a job's rows are contiguous
      }
      seen.add(q[i].jobId);
    }
  });
});
