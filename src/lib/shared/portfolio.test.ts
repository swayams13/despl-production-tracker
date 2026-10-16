import { describe, expect, test } from "vitest";
import {
  HEALTH_SLUG,
  actionsDue,
  bottlenecks,
  buildExceptions,
  buildTiles,
  forecastPastCommitted,
  healthFromSlug,
  parseJobParam,
  portfolioHref,
  rankExceptions,
  teamHref,
  topBlockerByJob,
  type HoldFact,
  type NcrFact,
  type PlanFact,
  type PortfolioFacts,
} from "./portfolio";
import type { JobHealth } from "@/lib/services/job-health";

const HEALTHS = Object.keys(HEALTH_SLUG) as JobHealth[];

const depts = [
  { id: 1, code: "FABRICATION", name: "Fabrication" },
  { id: 2, code: "QC", name: "Quality Control" },
  { id: 3, code: "STORES", name: "Stores" },
];

let seq = 0;
const plan = (o: Partial<PlanFact> = {}): PlanFact => ({
  planId: ++seq,
  jobId: 10,
  jobNumber: "DESPL-320",
  deptId: 1,
  processName: "Shell rolling",
  serialNo: "SR01",
  state: "IN_PROGRESS",
  overdue: false,
  daysLate: null,
  assigneeName: null,
  ...o,
});
const ncr = (o: Partial<NcrFact> = {}): NcrFact => ({ ncrId: ++seq, jobId: 10, jobNumber: "DESPL-320", deptId: 1, serialNo: "SR04", label: "Nozzle N3 weld", ageDays: 4, ...o });
const hold = (o: Partial<HoldFact> = {}): HoldFact => ({
  key: `h${++seq}`,
  jobId: 10,
  jobNumber: "DESPL-320",
  serialNo: "SR04",
  label: "RT of LS-1",
  classCode: "H",
  statusLabel: "Awaiting inspector",
  ageDays: 1,
  ...o,
});
const facts = (o: Partial<PortfolioFacts> = {}): PortfolioFacts => ({ depts, plans: [], ncrs: [], holds: [], ...o });

describe("health slug round-trip", () => {
  test.each(HEALTHS)("%s survives HEALTH_SLUG -> healthFromSlug", (h) => {
    expect(healthFromSlug(HEALTH_SLUG[h])).toBe(h);
  });
  test("an unknown or absent slug means no filter", () => {
    expect(healthFromSlug("nonsense")).toBeNull();
    expect(healthFromSlug(undefined)).toBeNull();
  });
});

describe("portfolioHref / parseJobParam", () => {
  test.each([
    [{}, undefined, "/dashboard"],
    [{ health: "DELAYED" as const }, undefined, "/dashboard?health=delayed"],
    [{ jobId: 7 }, "projects", "/dashboard?job=7#projects"],
    [{ health: "AT_RISK" as const, jobId: 7 }, "needs-attention", "/dashboard?health=at-risk&job=7#needs-attention"],
  ])("%j %s", (q, hash, want) => {
    expect(portfolioHref(q, hash)).toBe(want);
  });
  test.each([
    ["12", 12],
    [["3", "4"], 3],
    ["0", null],
    ["-2", null],
    ["x", null],
    ["1.5", null],
    [undefined, null],
  ])("parseJobParam(%j)", (v, want) => {
    expect(parseJobParam(v as string | string[] | undefined)).toBe(want);
  });
});

describe("buildTiles", () => {
  const counts = { active: 5, DELAYED: 1, AT_RISK: 2, ON_HOLD: 0 };
  test("five tiles in the spec's order, each with a link", () => {
    const t = buildTiles({ counts, actionsDue: 9, health: null, jobId: null });
    expect(t.map((x) => [x.label, x.value])).toEqual([["Active", 5], ["Delayed", 1], ["At risk", 2], ["On hold", 0], ["Actions due", 9]]);
    expect(t.map((x) => x.href)).toEqual([
      "/dashboard",
      "/dashboard?health=delayed",
      "/dashboard?health=at-risk",
      "/dashboard?health=on-hold",
      "/dashboard#needs-attention",
    ]);
  });
  test("the selected health tile links back to unfiltered, and job= is kept everywhere", () => {
    const t = buildTiles({ counts, actionsDue: 0, health: "AT_RISK", jobId: 3 });
    const atRisk = t.find((x) => x.id === "at-risk")!;
    expect(atRisk.selected).toBe(true);
    expect(atRisk.href).toBe("/dashboard?job=3");
    expect(t.every((x) => x.href.includes("job=3"))).toBe(true);
    expect(t.filter((x) => x.selected)).toHaveLength(1);
  });
  test("alert marks only a non-zero Delayed or Actions due", () => {
    expect(buildTiles({ counts, actionsDue: 0, health: null, jobId: null }).filter((x) => x.alert).map((x) => x.id)).toEqual(["delayed"]);
    expect(buildTiles({ counts: { ...counts, DELAYED: 0 }, actionsDue: 4, health: null, jobId: null }).filter((x) => x.alert).map((x) => x.id)).toEqual(["actions"]);
  });
});

describe("forecastPastCommitted", () => {
  const row = (o: Partial<Parameters<typeof forecastPastCommitted>[0][number]>) => ({
    health: "ON_TRACK" as JobHealth,
    committedDeliveryDate: "2026-12-01",
    forecastDispatch: "2026-12-01",
    forecastVarianceDays: 0,
    ...o,
  });
  test.each([
    ["no rows", [], { late: 0, known: 0, slipDays: 0 }],
    ["on date is not late", [row({})], { late: 0, known: 1, slipDays: 0 }],
    ["early is not late and adds no slip", [row({ forecastVarianceDays: -2 })], { late: 0, known: 1, slipDays: 0 }],
    ["late jobs add their slip", [row({ health: "DELAYED", forecastVarianceDays: 12 }), row({ health: "AT_RISK", forecastVarianceDays: 7 }), row({})], { late: 2, known: 3, slipDays: 19 }],
    ["completed, unscheduled and unpromised jobs cannot be judged", [row({ health: "COMPLETED", forecastVarianceDays: 9 }), row({ forecastDispatch: null, forecastVarianceDays: null }), row({ committedDeliveryDate: null, forecastVarianceDays: null })], { late: 0, known: 0, slipDays: 0 }],
  ])("%s", (_n, rows, want) => {
    expect(forecastPastCommitted(rows)).toEqual(want);
  });
});

describe("teamHref", () => {
  test.each([
    ["FABRICATION", "blocked", null, "/team/fabrication?status=blocked"],
    ["QC", "overdue", 7, "/team/qc?status=overdue&job=7"],
    ["STORES", null, 7, "/team/stores?job=7"],
  ] as const)("%s %s %s", (code, status, job, want) => {
    expect(teamHref(code, status, job)).toBe(want);
  });
});

describe("bottlenecks", () => {
  const plans = [
    plan({ state: "BLOCKED" }),
    plan({ state: "BLOCKED", overdue: true, daysLate: 2 }),
    plan({ overdue: true, daysLate: 1 }),
    plan({ deptId: 3, state: "BLOCKED" }),
    plan({ deptId: 3, jobId: 11, jobNumber: "DESPL-324", state: "BLOCKED" }),
    plan({ deptId: 2 }), // nothing wrong: contributes nothing
  ];
  const ncrs = [ncr({ deptId: 1 }), ncr({ deptId: 3, jobId: 11, jobNumber: "DESPL-324" }), ncr({ deptId: null })];

  test("counts each segment per department and sorts worst first", () => {
    const b = bottlenecks({ depts, plans, ncrs }, null);
    expect(b.map((x) => [x.code, x.blocked, x.overdue, x.rejected, x.total])).toEqual([
      ["FABRICATION", 2, 2, 1, 5],
      ["STORES", 2, 0, 1, 3],
    ]);
  });
  test("a department with nothing to show is left out; an NCR with no department is not on a bar", () => {
    const b = bottlenecks({ depts, plans, ncrs }, null);
    expect(b.find((x) => x.code === "QC")).toBeUndefined();
    expect(b.reduce((n, x) => n + x.rejected, 0)).toBe(2);
  });
  test("a job focus narrows every segment and is carried in every link", () => {
    const b = bottlenecks({ depts, plans, ncrs }, 11);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ code: "STORES", blocked: 1, overdue: 0, rejected: 1 });
    expect(b[0].blockedHref).toBe("/team/stores?status=blocked&job=11");
    expect(b[0].overdueHref).toBe("/team/stores?status=overdue&job=11");
    expect(b[0].rejectedHref).toBe("/qc?tab=ncrs&job=11");
  });
  test("links with no job focus carry no job=", () => {
    const [first] = bottlenecks({ depts, plans, ncrs }, null);
    expect(first.blockedHref).toBe("/team/fabrication?status=blocked");
    expect(first.rejectedHref).toBe("/qc?tab=ncrs");
  });
  test("ties break by name", () => {
    const b = bottlenecks({ depts, plans: [plan({ deptId: 3, state: "BLOCKED" }), plan({ deptId: 1, state: "BLOCKED" })], ncrs: [] }, null);
    expect(b.map((x) => x.name)).toEqual(["Fabrication", "Stores"]);
  });
});

describe("buildExceptions", () => {
  test("overdue plans of one process on one job are one line, with serials, count and oldest age", () => {
    const e = buildExceptions(
      facts({
        plans: [
          plan({ overdue: true, daysLate: 2, serialNo: "SR06", assigneeName: "Vikram" }),
          plan({ overdue: true, daysLate: 5, serialNo: "SR05", assigneeName: "Vikram" }),
          plan({ overdue: true, daysLate: 1, serialNo: "SR07", assigneeName: "Vikram" }),
          plan({ overdue: true, daysLate: 1, serialNo: "SR08", assigneeName: "Vikram" }),
          plan({ overdue: false }),
          plan({ overdue: true, daysLate: 3, processName: "Nozzle fit-up", serialNo: null, assigneeName: null }),
        ],
      }),
      null,
    );
    expect(e).toHaveLength(2);
    const shell = e.find((x) => x.what.startsWith("Shell rolling"))!;
    expect(shell).toMatchObject({ kind: "OVERDUE", deptName: "Fabrication", owner: "Vikram", ageDays: 5, href: "/team/fabrication?status=overdue&job=10" });
    expect(shell.what).toBe("Shell rolling overdue on SR05, SR06 and 2 more (4)");
    const job = e.find((x) => x.what.startsWith("Nozzle"))!;
    expect(job.what).toBe("Nozzle fit-up overdue"); // job-grain: no serial list
    expect(job.owner).toBeNull();
  });
  test("different people on a group show as several", () => {
    const [e] = buildExceptions(facts({ plans: [plan({ overdue: true, daysLate: 1, assigneeName: "A" }), plan({ overdue: true, daysLate: 1, assigneeName: "B", serialNo: "SR02" })] }), null);
    expect(e.owner).toBe("Several people");
  });
  test("holds and NCRs link to the QC tab with the job, and name the owning department", () => {
    const e = buildExceptions(facts({ ncrs: [ncr({ deptId: 3 }), ncr({ deptId: null })], holds: [hold()] }), null);
    const n = e.filter((x) => x.kind === "NCR");
    expect(n.map((x) => x.deptName)).toEqual(["Stores", "Quality Control"]);
    expect(n[0].href).toBe("/qc?tab=ncrs&job=10");
    const h = e.find((x) => x.kind === "HOLD")!;
    expect(h.href).toBe("/qc?tab=holds&job=10");
    expect(h.what).toBe("SR04 · RT of LS-1: H point, awaiting inspector");
  });
  test("a job focus drops other jobs", () => {
    const f = facts({ ncrs: [ncr(), ncr({ jobId: 11, jobNumber: "DESPL-324" })], holds: [hold({ jobId: 11, jobNumber: "DESPL-324" })] });
    expect(buildExceptions(f, 11).every((x) => x.jobId === 11)).toBe(true);
    expect(buildExceptions(f, 11)).toHaveLength(2);
  });
});

describe("rankExceptions / topBlockerByJob", () => {
  const f = facts({
    plans: [plan({ jobId: 11, jobNumber: "J-B", overdue: true, daysLate: 9 })],
    ncrs: [ncr({ jobId: 10, ageDays: 2 }), ncr({ jobId: 10, ageDays: 6 })],
    holds: [hold({ jobId: 10, ageDays: 30 }), hold({ jobId: 12, jobNumber: "J-C", ageDays: 1 })],
  });
  const items = buildExceptions(f, null);

  test("worst job first, then NCR before hold before late work, then oldest", () => {
    const r = rankExceptions(items, [11, 10, 12]);
    expect(r.map((x) => [x.jobId, x.kind, x.ageDays])).toEqual([
      [11, "OVERDUE", 9],
      [10, "NCR", 6],
      [10, "NCR", 2],
      [10, "HOLD", 30],
      [12, "HOLD", 1],
    ]);
  });
  test("a job missing from the order sorts last", () => {
    expect(rankExceptions(items, [10]).at(-1)!.jobId).not.toBe(10);
  });
  test("input is not mutated", () => {
    const copy = [...items];
    rankExceptions(items, [12, 11, 10]);
    expect(items).toEqual(copy);
  });
  test("the top blocker of a job is its first ranked exception; a job with none is absent", () => {
    const top = topBlockerByJob(rankExceptions(items, [11, 10, 12]));
    expect(top.get(10)).toMatchObject({ kind: "NCR", ageDays: 6 });
    expect(top.get(11)!.kind).toBe("OVERDUE");
    expect(top.get(99)).toBeUndefined();
  });
});

describe("actionsDue", () => {
  const f = facts({
    plans: [plan({ overdue: true, daysLate: 1 }), plan({ overdue: true, daysLate: 1, jobId: 11 }), plan()],
    ncrs: [ncr(), ncr({ jobId: 11 })],
    holds: [hold()],
  });
  test("overdue plans plus holds plus NCRs", () => expect(actionsDue(f, null)).toBe(5));
  test("scoped to one job", () => expect(actionsDue(f, 11)).toBe(2));
  test("nothing to do", () => expect(actionsDue(facts(), null)).toBe(0));
});
