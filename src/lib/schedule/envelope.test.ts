import { describe, expect, it } from "vitest";
import { computeEnvelope } from "./envelope";
import { bypassExcluded } from "./exclude";
import { addWorkingDays, DEFAULT_CALENDAR } from "./calendar";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { pressureVesselProcesses, PRESSURE_VESSEL_TOTAL_DAYS } from "./__fixtures__/pressure-vessel-v1";
import type { ScheduleEdge, ScheduleProcess } from "./types";

const PROJECT_START = new Date("2026-01-05T12:00:00.000Z"); // a Monday

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("computeEnvelope — layer 1 (printed, authoritative)", () => {
  it("refuses a provisional process with SCHEDULE_DATA_MISSING rather than guessing", () => {
    const provisional: ScheduleProcess = {
      id: 901,
      code: "PS-01",
      name: "Provisional pipe-spool step",
      durationMinDays: null,
      durationMaxDays: null,
      envelopeFinishByMinDays: null,
      envelopeFinishByMaxDays: null,
      envelopeStartByMinDays: null,
      envelopeStartByMaxDays: null,
      provisional: true,
    };
    expect(() => computeEnvelope([provisional], PROJECT_START, DEFAULT_CALENDAR)).toThrow(
      AppError,
    );
    try {
      computeEnvelope([provisional], PROJECT_START, DEFAULT_CALENDAR);
      throw new Error("expected computeEnvelope to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ERROR_CODES.SCHEDULE_DATA_MISSING);
    }
  });

  it("refuses a non-provisional process with a null duration the same way (never a 0-day guess)", () => {
    const nullDuration: ScheduleProcess = {
      id: 902,
      code: "X",
      name: "Bad data",
      durationMinDays: null,
      durationMaxDays: 5,
      envelopeFinishByMinDays: 1,
      envelopeFinishByMaxDays: 5,
      envelopeStartByMinDays: 0,
      envelopeStartByMaxDays: 0,
      provisional: false,
    };
    expect(() => computeEnvelope([nullDuration], PROJECT_START, DEFAULT_CALENDAR)).toThrow(
      AppError,
    );
  });

  it("P1 (PO Receipt) starts exactly on project start — envelope.startByMinDays/MaxDays are both 0", () => {
    const [p1] = computeEnvelope(
      pressureVesselProcesses.filter((p) => p.code === 1),
      PROJECT_START,
      DEFAULT_CALENDAR,
    );
    expect(iso(p1.plannedStartMin)).toBe(iso(PROJECT_START));
    expect(iso(p1.plannedStartMax)).toBe(iso(PROJECT_START));
  });

  it("every process's planned finish matches project_start + envelope offset via the calendar module directly", () => {
    const dates = computeEnvelope(pressureVesselProcesses, PROJECT_START, DEFAULT_CALENDAR);
    for (const p of pressureVesselProcesses) {
      const expected = dates.find((d) => d.processId === p.id)!;
      expect(iso(expected.plannedFinishMax)).toBe(
        iso(addWorkingDays(PROJECT_START, p.envelopeFinishByMaxDays!, DEFAULT_CALENDAR)),
      );
    }
  });

  it("reproduces DESPL's printed ~17-week total exactly: P36 (Dispatch) finishByMin === finishByMax === 119", () => {
    const p36 = pressureVesselProcesses.find((p) => p.code === 36)!;
    expect(p36.envelopeFinishByMinDays).toBe(PRESSURE_VESSEL_TOTAL_DAYS);
    expect(p36.envelopeFinishByMaxDays).toBe(PRESSURE_VESSEL_TOTAL_DAYS);

    const [dispatch] = computeEnvelope([p36], PROJECT_START, DEFAULT_CALENDAR);
    expect(iso(dispatch.plannedFinishMin)).toBe(iso(dispatch.plannedFinishMax));
  });
});

describe("excluded-process duration requirement is intentionally asymmetric between the two layers", () => {
  function proc(id: number, overrides: Partial<ScheduleProcess> = {}): ScheduleProcess {
    return {
      id,
      code: id,
      name: `P${id}`,
      durationMinDays: 5,
      durationMaxDays: 5,
      envelopeFinishByMinDays: 5,
      envelopeFinishByMaxDays: 5,
      envelopeStartByMinDays: 0,
      envelopeStartByMaxDays: 0,
      provisional: false,
      ...overrides,
    };
  }

  it("computeEnvelope succeeds when an excluded root process has no duration — it only filters, never composes a bridge", () => {
    const excludedRoot = proc(1, { durationMaxDays: null, included: false });
    const survivor = proc(2);
    const dates = computeEnvelope([excludedRoot, survivor], PROJECT_START, DEFAULT_CALENDAR);
    expect(dates).toHaveLength(1);
    expect(dates[0].processId).toBe(2);
  });

  it("computeEnvelope succeeds when an excluded terminal process is provisional with no duration", () => {
    const survivor = proc(1);
    const excludedTerminal = proc(2, { provisional: true, durationMaxDays: null, included: false });
    const dates = computeEnvelope([survivor, excludedTerminal], PROJECT_START, DEFAULT_CALENDAR);
    expect(dates).toHaveLength(1);
    expect(dates[0].processId).toBe(1);
  });

  it("bypassExcluded (the CPM path) still refuses SCHEDULE_DATA_MISSING for a mid-chain excluded process with no duration — a bridge genuinely needs it", () => {
    const a = proc(1);
    const midChain = proc(2, { durationMaxDays: null, included: false });
    const c = proc(3);
    const edges: ScheduleEdge[] = [
      { processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 },
      { processId: 3, predecessorId: 2, type: "FINISH_TO_START", lagDays: 0 },
    ];
    expect(() => bypassExcluded([a, midChain, c], edges)).toThrow(AppError);
    try {
      bypassExcluded([a, midChain, c], edges);
      throw new Error("expected bypassExcluded to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ERROR_CODES.SCHEDULE_DATA_MISSING);
    }
  });
});
