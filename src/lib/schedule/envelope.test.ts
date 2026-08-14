import { describe, expect, it } from "vitest";
import { computeEnvelope } from "./envelope";
import { addWorkingDays, DEFAULT_CALENDAR } from "./calendar";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { pressureVesselProcesses, PRESSURE_VESSEL_TOTAL_DAYS } from "./__fixtures__/pressure-vessel-v1";
import type { ScheduleProcess } from "./types";

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
