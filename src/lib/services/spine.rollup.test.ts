import { expect, test } from "vitest";
import { rollupJobSpine } from "./spine.read";
import type { UnitSpine } from "./spine.read";
import type { StageSegment } from "@/components/industrial/stage-status";

// One stage number per test case unless noted; `rollupJobSpine` collapses
// index-by-index, so a single-segment unit is enough to pin the §11.2-style
// cross-unit ladder without a real DB view.
function unit(unitId: number, serialNo: string, segs: Partial<StageSegment>[]): UnitSpine {
  return {
    unitId,
    serialNo,
    segments: segs.map((s, i) => ({
      stageNo: s.stageNo ?? 1,
      stageName: "Test Stage",
      status: s.status ?? "idle",
      overdue: s.overdue ?? false,
      rejected: s.rejected ?? false,
      governingPlanId: s.governingPlanId ?? unitId * 100 + i,
    })),
  };
}

test("empty unit set → empty rollup", () => {
  expect(rollupJobSpine([])).toEqual([]);
});

test("all units complete → complete, governing plan is the last unit's", () => {
  const units = [unit(1, "U1", [{ status: "complete" }]), unit(2, "U2", [{ status: "complete" }])];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("complete");
  expect(seg.unitId).toBe(2);
  expect(seg.governingPlanId).toBe(units[1].segments[0].governingPlanId);
});

test("any unit on hold outranks overdue/submitted/progress", () => {
  const units = [
    unit(1, "U1", [{ status: "overdue" }]),
    unit(2, "U2", [{ status: "hold" }]),
    unit(3, "U3", [{ status: "submitted" }]),
  ];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("hold");
  expect(seg.unitId).toBe(2);
});

test("any unit overdue outranks submitted/progress (with no hold present)", () => {
  const units = [unit(1, "U1", [{ status: "submitted" }]), unit(2, "U2", [{ status: "overdue" }])];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("overdue");
  expect(seg.unitId).toBe(2);
});

test("any unit submitted outranks progress/idle", () => {
  const units = [unit(1, "U1", [{ status: "idle" }]), unit(2, "U2", [{ status: "submitted" }])];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("submitted");
});

test("some (not all) complete, rest idle → progress, not complete", () => {
  const units = [unit(1, "U1", [{ status: "complete" }]), unit(2, "U2", [{ status: "idle" }])];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("progress");
  expect(seg.unitId).toBe(1); // the complete unit is the "winner" carrying this partial-progress fill
});

test("all idle → idle", () => {
  const units = [unit(1, "U1", [{ status: "idle" }]), unit(2, "U2", [{ status: "idle" }])];
  expect(rollupJobSpine(units)[0].status).toBe("idle");
});

test("overdue/rejected secondary markers are OR'd across units regardless of which unit wins the fill", () => {
  const units = [
    unit(1, "U1", [{ status: "hold", overdue: false, rejected: false }]),
    unit(2, "U2", [{ status: "hold", overdue: true, rejected: true }]),
  ];
  const [seg] = rollupJobSpine(units);
  expect(seg.status).toBe("hold");
  expect(seg.overdue).toBe(true);
  expect(seg.rejected).toBe(true);
});

test("collapses each stage index independently across a multi-stage spine", () => {
  const units = [
    unit(1, "U1", [{ stageNo: 1, status: "complete" }, { stageNo: 2, status: "idle" }]),
    unit(2, "U2", [{ stageNo: 1, status: "complete" }, { stageNo: 2, status: "progress" }]),
  ];
  const rolled = rollupJobSpine(units);
  expect(rolled).toHaveLength(2);
  expect(rolled[0].status).toBe("complete");
  expect(rolled[1].status).toBe("progress");
});
