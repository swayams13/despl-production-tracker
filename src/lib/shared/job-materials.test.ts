import { describe, expect, test } from "vitest";
import { derivePipeline, isShortThisWeek, materialStatus, type MaterialFacts } from "./job-materials";

const NOW = new Date("2026-02-09T06:00:00Z"); // a Monday
const day = (n: number) => new Date(NOW.getTime() + n * 864e5).toISOString();
const base: MaterialFacts = { requiredQty: 54, indent: null, poPlaced: false, anyReceipt: false, receivedQty: null, heats: [], issuedQty: 0, neededBy: null };
const f = (o: Partial<MaterialFacts>): MaterialFacts => ({ ...base, ...o });
const states = (x: MaterialFacts) => derivePipeline(x, NOW).map((c) => c.state[0]).join(""); // d / c / t

describe("chip state", () => {
  test.each([
    ["nothing logged: Indent is current", f({}), "ctttt"],
    ["indent raised", f({ indent: "raised" }), "dcttt"],
    ["PO placed", f({ indent: "approved", poPlaced: true }), "ddctt"],
    ["partly received (20 of 54): Received stays current", f({ indent: "raised", poPlaced: true, anyReceipt: true, receivedQty: 20 }), "ddctt"],
    ["fully received", f({ indent: "raised", poPlaced: true, anyReceipt: true, receivedQty: 54 }), "dddct"],
    ["received, qty unknown: counts as received", f({ anyReceipt: true }), "dddct"],
    ["free-text quantity: any receipt is full", f({ requiredQty: null, anyReceipt: true, receivedQty: 3 }), "dddct"],
    ["identified", f({ anyReceipt: true, receivedQty: 54, heats: ["H-1"] }), "ddddc"],
    ["partly issued stays on Issued", f({ anyReceipt: true, receivedQty: 54, heats: ["H-1"], issuedQty: 10 }), "ddddc"],
    ["fully issued: all done, none current", f({ anyReceipt: true, receivedQty: 54, heats: ["H-1"], issuedQty: 54 }), "ddddd"],
    ["issued from old stock with nothing else logged: earlier steps done", f({ issuedQty: 54 }), "ddddd"],
  ])("%s", (_n, facts, want) => {
    expect(states(facts)).toBe(want);
  });

  test("details: partial quantities, heat numbers, indent stage", () => {
    const c = derivePipeline(f({ indent: "approved", poPlaced: true, anyReceipt: true, receivedQty: 20, heats: ["H-1", "H-2", "H-3"] }), NOW);
    expect(c.map((x) => x.detail)).toEqual(["approved", "placed", "20 of 54", "H-1 +2", null]);
  });
});

describe("short this week", () => {
  test.each([
    ["needed in 3 days, nothing received", f({ neededBy: day(3) }), true],
    ["needed in exactly 7 days", f({ neededBy: day(7) }), true],
    ["needed in 8 days", f({ neededBy: day(8) }), false],
    ["needed date already passed, not received", f({ neededBy: day(-2) }), true],
    ["needed in 3 days but fully received", f({ neededBy: day(3), anyReceipt: true, receivedQty: 54 }), false],
    ["needed in 3 days, only partly received", f({ neededBy: day(3), anyReceipt: true, receivedQty: 20 }), true],
    ["needed in 3 days, already issued", f({ neededBy: day(3), issuedQty: 54 }), false],
    ["no needed-by date: never short", f({}), false],
  ])("%s", (_n, facts, want) => {
    expect(isShortThisWeek(facts, NOW)).toBe(want);
  });

  test("the current chip turns late only when short", () => {
    const short = derivePipeline(f({ neededBy: day(2), indent: "raised", poPlaced: true }), NOW);
    expect(short.filter((c) => c.late).map((c) => c.key)).toEqual(["received"]);
    expect(derivePipeline(f({ neededBy: day(30), indent: "raised", poPlaced: true }), NOW).some((c) => c.late)).toBe(false);
  });
});

describe("status", () => {
  test.each([
    ["issued", f({ issuedQty: 54 }), "issued", "Issued"],
    ["identified, not issued", f({ anyReceipt: true, receivedQty: 54, heats: ["H-1"] }), "ready_to_issue", "Ready to issue"],
    ["short, still to come", f({ neededBy: day(2), indent: "raised", poPlaced: true }), "short", "Short for work starting this week"],
    ["short, date passed", f({ neededBy: day(-1) }), "short", "Short, needed date has passed"],
    ["indent raised, needed later", f({ indent: "raised", neededBy: day(40) }), "on_track", "On track"],
    ["nothing at all", f({}), "not_started", "Not started"],
    ["partial receipt only", f({ anyReceipt: true, receivedQty: 5 }), "on_track", "On track"],
    ["issued wins over short", f({ neededBy: day(-5), issuedQty: 54 }), "issued", "Issued"],
  ])("%s", (_n, facts, status, label) => {
    expect(materialStatus(facts, NOW)).toEqual({ status, label });
  });
});
