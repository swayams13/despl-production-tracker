import { describe, expect, it } from "vitest";
import { computeCpm, scheduleBackward, scheduleForward } from "./cpm";
import { addWorkingDays, DEFAULT_CALENDAR } from "./calendar";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import {
  pressureVesselEdges,
  pressureVesselProcesses,
  PRESSURE_VESSEL_TOTAL_DAYS,
} from "./__fixtures__/pressure-vessel-v1";
import type { ScheduleEdge, ScheduleProcess } from "./types";

describe("computeCpm — fitted lags reproduce the printed max envelope exactly", () => {
  const cpm = computeCpm(pressureVesselProcesses, pressureVesselEdges);
  const byId = new Map(cpm.map((n) => [n.processId, n]));

  it.each(
    pressureVesselProcesses.map((p) => ({
      id: p.id,
      code: p.code,
      expected: p.envelopeFinishByMaxDays!,
    })),
  )("P$code earlyFinish matches envelope.finishByMaxDays ($expected)", ({ id, expected }) => {
    expect(byId.get(id)!.earlyFinish).toBe(expected);
  });

  it(`the terminal process (P36, Dispatch) reproduces DESPL's printed ~17-week total (${PRESSURE_VESSEL_TOTAL_DAYS} days)`, () => {
    expect(byId.get(36)!.earlyFinish).toBe(PRESSURE_VESSEL_TOTAL_DAYS);
  });

  it("P1 and P36 are both on the critical path (zero float) — start and end of any chain always are", () => {
    expect(byId.get(1)!.isCritical).toBe(true);
    expect(byId.get(36)!.isCritical).toBe(true);
  });

  it("no process has negative float — the table was fitted, not approximated", () => {
    for (const n of cpm) expect(n.totalFloat).toBeGreaterThanOrEqual(0);
  });
});

describe("computeCpm — duration resolution", () => {
  const linear: ScheduleProcess[] = [
    {
      id: 1,
      code: 1,
      name: "A",
      durationMinDays: 2,
      durationMaxDays: 3,
      envelopeFinishByMinDays: 2,
      envelopeFinishByMaxDays: 3,
      envelopeStartByMinDays: 0,
      envelopeStartByMaxDays: 0,
      provisional: false,
    },
    {
      id: 2,
      code: 2,
      name: "B (provisional)",
      durationMinDays: null,
      durationMaxDays: null,
      envelopeFinishByMinDays: null,
      envelopeFinishByMaxDays: null,
      envelopeStartByMinDays: null,
      envelopeStartByMaxDays: null,
      provisional: true,
    },
  ];
  const edges: ScheduleEdge[] = [
    { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
  ];

  it("refuses a provisional process with SCHEDULE_DATA_MISSING when no override is supplied", () => {
    expect(() => computeCpm(linear, edges)).toThrow(AppError);
    try {
      computeCpm(linear, edges);
    } catch (e) {
      expect((e as AppError).code).toBe(ERROR_CODES.SCHEDULE_DATA_MISSING);
    }
  });

  it("accepts an explicit duration override for a provisional process (planner-entered estimate)", () => {
    const cpm = computeCpm(linear, edges, { durationDaysByProcessId: new Map([[2, 5]]) });
    const b = cpm.find((n) => n.processId === 2)!;
    expect(b.earlyStart).toBe(3); // EF(A) = 3
    expect(b.earlyFinish).toBe(8); // + duration override 5
  });

  it("detects a cycle rather than looping forever", () => {
    const cyclic: ScheduleEdge[] = [
      { processId: 1, predecessorId: 2, type: "FINISH_TO_START", lagDays: 0 },
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
    ];
    expect(() =>
      computeCpm(linear, cyclic, { durationDaysByProcessId: new Map([[2, 5]]) }),
    ).toThrow(/cycle/);
  });
});

describe("scheduleForward / scheduleBackward — date mapping round-trips", () => {
  const start = new Date("2026-06-24T12:00:00.000Z");

  it(`scheduleForward's projectFinishDate is exactly ${PRESSURE_VESSEL_TOTAL_DAYS} working days after start`, () => {
    const result = scheduleForward(pressureVesselProcesses, pressureVesselEdges, start, DEFAULT_CALENDAR);
    const expected = addWorkingDays(start, PRESSURE_VESSEL_TOTAL_DAYS, DEFAULT_CALENDAR);
    expect(result.projectFinishDate.toISOString().slice(0, 10)).toBe(
      expected.toISOString().slice(0, 10),
    );
  });

  it("scheduleBackward anchored to the forward result's own finish date recovers the same start date", () => {
    const forward = scheduleForward(pressureVesselProcesses, pressureVesselEdges, start, DEFAULT_CALENDAR);
    const backward = scheduleBackward(
      pressureVesselProcesses,
      pressureVesselEdges,
      forward.projectFinishDate,
      DEFAULT_CALENDAR,
    );
    expect(backward.requiredProjectStartDate.toISOString().slice(0, 10)).toBe(
      start.toISOString().slice(0, 10),
    );
  });

  it("scheduleBackward's per-process late-finish dates match the forward pass's early-finish dates on the (zero-float) critical path", () => {
    const forward = scheduleForward(pressureVesselProcesses, pressureVesselEdges, start, DEFAULT_CALENDAR);
    const backward = scheduleBackward(
      pressureVesselProcesses,
      pressureVesselEdges,
      forward.projectFinishDate,
      DEFAULT_CALENDAR,
    );
    const fwdP1 = forward.perProcess.find((p) => p.processId === 1)!;
    const bwdP1 = backward.perProcess.find((p) => p.processId === 1)!;
    expect(fwdP1.isCritical).toBe(true);
    expect(bwdP1.lateFinishDate.toISOString().slice(0, 10)).toBe(
      fwdP1.earlyFinishDate.toISOString().slice(0, 10),
    );
  });
});
