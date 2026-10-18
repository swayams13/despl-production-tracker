import { describe, expect, it } from "vitest";
import { planRequiresQc, type OpRow } from "./backfill-op-requires-qc";

const row = (id: number, opCode: string, status: string, requiresQc = true, pressure = true): OpRow => ({ id, opCode, status, requiresQc, pressure });

describe("backfill-op-requires-qc plan", () => {
  it("lowers RECEIPT and MTC_VERIFICATION that have not been submitted, pressure part or not", () => {
    const p = planRequiresQc([row(1, "RECEIPT", "NOT_STARTED"), row(2, "MTC_VERIFICATION", "IN_PROGRESS"), row(3, "RECEIPT", "NOT_STARTED", true, false)]);
    expect(p.change.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("never rewrites history: a submitted or complete operation is reported, not changed", () => {
    const p = planRequiresQc([row(1, "RECEIPT", "SUBMITTED"), row(2, "RECEIPT", "COMPLETE"), row(3, "MTC_VERIFICATION", "SUBMITTED")]);
    expect(p.change).toEqual([]);
    expect(p.history.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("is idempotent: rows already false are counted, not changed", () => {
    const p = planRequiresQc([row(1, "RECEIPT", "NOT_STARTED", false)]);
    expect(p).toMatchObject({ change: [], history: [], already: 1 });
  });

  it("touches only the named operations; cutting, fit-up and welding keep their flag", () => {
    const p = planRequiresQc(["CUTTING", "FIT_UP", "WELDING", "EDGE_PREP", "FORMING", "INSPECTION"].map((c, i) => row(i, c, "NOT_STARTED")));
    expect(p.change).toEqual([]);
    expect(p.already).toBe(0);
  });

  it("an operation the rule keeps at true is never lowered, even when named", () => {
    const p = planRequiresQc([row(1, "CUTTING", "NOT_STARTED"), row(2, "RECEIPT", "NOT_STARTED")], ["CUTTING", "RECEIPT"]);
    expect(p.change.map((r) => r.id)).toEqual([2]);
    expect(p.ruleSaysTrue.map((r) => r.id)).toEqual([1]);
  });
});
