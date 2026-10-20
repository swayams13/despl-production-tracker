import { describe, expect, it } from "vitest";
import {
  ageDaysOf,
  compareHolds,
  dispositionChoices,
  evidenceMessage,
  evidenceNeeded,
  groupByJobUnit,
  holdIsReached,
  pageOf,
  parseQcQuery,
  qcHref,
  resolveHoldPointStatus,
  type LatestAttempt,
} from "./qc-queue";

const at = new Date("2026-10-10T10:00:00Z");
const att = (result: LatestAttempt["result"], waiverApprovedBy: number | null = null): LatestAttempt => ({ result, waiverApprovedBy, recordedAt: at });

describe("resolveHoldPointStatus: the gate's ladder, not the read models' old one", () => {
  it.each<[string, LatestAttempt | null, boolean, string | null]>([
    ["no attempt, no call needed", null, false, "PENDING"],
    ["no attempt, call needed", null, true, "AWAITING_TPI"],
    ["pending attempt", att("PENDING"), false, "QC_REVIEW"],
    ["rejected", att("REJECTED"), false, "REINSPECT"],
    ["accepted clears", att("ACCEPTED"), true, null],
    ["NA not yet approved is still open (the old ladders cleared it)", att("NA"), false, "WAIVER_PENDING"],
    ["NA approved clears", att("NA", 7), false, null],
  ])("%s", (_name, latest, requiresCall, expected) => {
    expect(resolveHoldPointStatus(latest, requiresCall)).toBe(expected);
  });
});

describe("compareHolds", () => {
  const h = (classCode: string, ageDays: number, serialNo = "SR01", srNo = "1.1", jobNumber = "J1") => ({ classCode, ageDays, serialNo, srNo, jobNumber });
  it("H before R&A before W regardless of age, then oldest first", () => {
    const sorted = [h("W", 30), h("H", 1), h("R&A", 9), h("H", 5), h("XX", 99)].sort(compareHolds);
    expect(sorted.map((x) => `${x.classCode}:${x.ageDays}`)).toEqual(["H:5", "H:1", "R&A:9", "W:30", "XX:99"]);
  });
  it("orders serials numerically on a tie", () => {
    const sorted = [h("H", 2, "SR10"), h("H", 2, "SR2")].sort(compareHolds);
    expect(sorted.map((x) => x.serialNo)).toEqual(["SR2", "SR10"]);
  });
});

describe("evidenceNeeded (§8.2 item 18)", () => {
  it("nothing for DESPL's own, non-test point", () => {
    expect(evidenceNeeded({ activity: "Fit-up inspection", externalBlocking: false, given: {} })).toEqual([]);
  });
  it("a third party's point needs the inspector and the report number, each separately", () => {
    expect(evidenceNeeded({ activity: "RT of nozzle weld", externalBlocking: true, given: {} })).toEqual([
      "the inspector's name",
      "the report or IRN number",
    ]);
    expect(evidenceNeeded({ activity: "RT", externalBlocking: true, given: { partyInspector: "A. Rao" } })).toEqual(["the report or IRN number"]);
    expect(evidenceNeeded({ activity: "RT", externalBlocking: true, given: { partyInspector: "A. Rao", reportRef: "IRN-4" } })).toEqual([]);
  });
  it("a hydro point needs its test record, whoever witnesses it", () => {
    expect(evidenceNeeded({ activity: "Hydrostatic test", externalBlocking: false, given: {} })).toEqual(["test pressure, hold time and gauge IDs"]);
    expect(evidenceNeeded({ activity: "Hydrostatic test", externalBlocking: false, given: { testData: true } })).toEqual([]);
  });
  it("a third-party hydro point needs all three", () => {
    expect(evidenceNeeded({ activity: "HYDRO test", externalBlocking: true, given: {} })).toHaveLength(3);
  });
});

describe("ageDaysOf", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  it.each([
    [new Date("2026-10-13T12:00:00Z"), 3],
    [new Date("2026-10-16T01:00:00Z"), 0],
    [new Date("2026-10-20T00:00:00Z"), 0],
    [null, 0],
  ])("%s -> %i", (ref, days) => {
    expect(ageDaysOf(ref, now)).toBe(days);
  });
});

describe("groupByJobUnit", () => {
  const r = (jobId: number, unitId: number, n: number) => ({ jobId, jobNumber: `J${jobId}`, unitId, serialNo: `S${unitId}`, n });
  it("keeps the incoming (oldest-first) order for groups and rows, and counts per job", () => {
    const g = groupByJobUnit([r(2, 20, 1), r(1, 10, 2), r(2, 21, 3), r(2, 20, 4)]);
    expect(g.map((j) => [j.jobId, j.count])).toEqual([[2, 3], [1, 1]]);
    expect(g[0]!.units.map((u) => [u.unitId, u.rows.map((x) => x.n)])).toEqual([[20, [1, 4]], [21, [3]]]);
  });
  it("no rows, no groups", () => {
    expect(groupByJobUnit([])).toEqual([]);
  });
});

describe("pageOf", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i);
  it("pages of 25, last page short, page clamped", () => {
    expect(pageOf(rows, 1).rows).toHaveLength(25);
    expect(pageOf(rows, 3).rows).toEqual(rows.slice(50));
    expect(pageOf(rows, 99)).toMatchObject({ page: 3, pages: 3, total: 60 });
    expect(pageOf(rows, -4).page).toBe(1);
  });
  it("an empty list is one empty page", () => {
    expect(pageOf([], 1)).toEqual({ rows: [], page: 1, pages: 1, total: 0 });
  });
});

describe("parseQcQuery / qcHref", () => {
  it("defaults to the first tab, and ignores junk", () => {
    expect(parseQcQuery({})).toEqual({ tab: "ready", jobId: null, unitId: null, page: 1 });
    expect(parseQcQuery({ tab: "nope", job: "-3", unit: "abc", page: "0" })).toEqual({ tab: "ready", jobId: null, unitId: null, page: 1 });
  });
  it("round-trips a filtered view", () => {
    const q = { tab: "holds" as const, jobId: 4, unitId: 9, page: 2 };
    expect(parseQcQuery(Object.fromEntries(new URLSearchParams(qcHref(q).split("?")[1])))).toEqual(q);
    expect(qcHref({ tab: "ready" })).toBe("/qc");
  });
});

describe("holdIsReached: when a blocking point stops being upcoming", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const past = new Date("2026-10-01T00:00:00Z");
  const future = new Date("2026-11-01T00:00:00Z");
  it.each<[string, LatestAttempt | null, { status: string; plannedStart: Date | null } | undefined, boolean]>([
    ["an attempt exists, whatever the plan", att("PENDING"), { status: "NOT_STARTED", plannedStart: future }, true],
    ["its unit's plan has started", null, { status: "IN_PROGRESS", plannedStart: future }, true],
    ["its planned start has passed", null, { status: "NOT_STARTED", plannedStart: past }, true],
    ["planned for later and not started", null, { status: "NOT_STARTED", plannedStart: future }, false],
    ["no plan and no attempt", null, undefined, false],
    ["unscheduled and not started", null, { status: "NOT_STARTED", plannedStart: null }, false],
  ])("%s", (_name, attempt, plan, expected) => {
    expect(holdIsReached(attempt, plan, now)).toBe(expected);
  });
});

describe("evidenceMessage", () => {
  it("names what is missing, from the refusal's detail", () => {
    expect(evidenceMessage(["the inspector's name", "the report or IRN number"])).toBe(
      "Before this can be cleared, record: the inspector's name, the report or IRN number.",
    );
  });
  it.each([[undefined], [null], [[]], ["x"], [[1, 2]]])("is null for %j (not an evidence refusal)", (v) => {
    expect(evidenceMessage(v)).toBeNull();
  });
});

describe("dispositionChoices: who may disposition which NCR (mirrors ncr.service, which still refuses)", () => {
  const QC = { disposition: true, concede: false };
  const HEAD = { disposition: false, concede: true };
  const BOTH = { disposition: true, concede: true };
  const NEITHER = { disposition: false, concede: false };
  const ordinary = { ruleNcr: false };
  const rule = { ruleNcr: true };

  it("an ordinary NCR: QC chooses any way; the Production Head gets no button (the rehearsal's FORBIDDEN)", () => {
    expect(dispositionChoices(ordinary, QC)).toEqual(["REWORK", "REPAIR", "USE_AS_IS", "CONCESSION", "SCRAP"]);
    expect(dispositionChoices(ordinary, HEAD)).toEqual([]);
    expect(dispositionChoices(ordinary, NEITHER)).toEqual([]);
  });
  it("an H5 / H6 rule NCR: QC repairs, the Production Head accepts a concession, nobody else gets a button", () => {
    expect(dispositionChoices(rule, QC)).toEqual(["REPAIR"]);
    expect(dispositionChoices(rule, HEAD)).toEqual(["CONCESSION"]);
    expect(dispositionChoices(rule, BOTH)).toEqual(["REPAIR", "CONCESSION"]);
    expect(dispositionChoices(rule, NEITHER)).toEqual([]);
  });
});
