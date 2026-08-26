import { describe, expect, it } from "vitest";
import { selectTerminal } from "./terminal";
import {
  pressureVesselProcesses,
  pressureVesselEdges,
} from "./__fixtures__/pressure-vessel-v1";
import type { ScheduleEdge, ScheduleProcess } from "./types";

/**
 * Regression for audit 0.9: P33 (MDR), P34 (Packing) and P35 (Dispatch
 * Clearance) all tie with P36 (Dispatch) at envelopeFinishByMaxDays=119 in the
 * real pilot lead-time model, but only P36 has no successor. Picking any tied
 * non-sink process would read its own (wrong) envelopeFinishByMinDays for
 * feasibility — P33's is 105, P34's is 112, only P36's is the correct 119.
 */
describe("selectTerminal — real pilot fixture (P33/34/35/36 tie at 119)", () => {
  it("picks P36 (the true sink), not an earlier tied process, regardless of input order", () => {
    const terminal = selectTerminal(pressureVesselProcesses, pressureVesselEdges);
    expect(terminal.id).toBe(36);
    expect(terminal.envelopeFinishByMaxDays).toBe(119);
    expect(terminal.envelopeFinishByMinDays).toBe(119);
  });

  it("is unaffected by process array order — same result reversed or shuffled", () => {
    const reversed = [...pressureVesselProcesses].reverse();
    const terminal = selectTerminal(reversed, pressureVesselEdges);
    expect(terminal.id).toBe(36);
    expect(terminal.envelopeFinishByMinDays).toBe(119);
  });

  it("splices an excluded terminal-adjacent node before sink detection", () => {
    // Exclude P35 (Dispatch Clearance) — P36 must still be found as the sink
    // via the bridged P33->P36/P34->P36 edges bypassExcluded composes.
    const processes = pressureVesselProcesses.map((p) =>
      p.code === 35 ? { ...p, included: false } : p,
    );
    const terminal = selectTerminal(processes, pressureVesselEdges);
    expect(terminal.id).toBe(36);
  });
});

/** A minimal hand-built process — only the fields selectTerminal reads. */
function proc(id: number, finishByMax: number, finishByMin = finishByMax): ScheduleProcess {
  return {
    id,
    code: id,
    name: `P${id}`,
    durationMinDays: 1,
    durationMaxDays: 1,
    envelopeFinishByMinDays: finishByMin,
    envelopeFinishByMaxDays: finishByMax,
    envelopeStartByMinDays: 0,
    envelopeStartByMaxDays: 0,
    provisional: false,
  };
}

describe("selectTerminal — hand-built tie scenarios", () => {
  it("two processes tie on finishByMax but only one is a sink", () => {
    const processes = [proc(1, 10, 3), proc(2, 10, 10)];
    const edges: ScheduleEdge[] = [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }];
    const terminal = selectTerminal(processes, edges);
    expect(terminal.id).toBe(2);
    expect(terminal.envelopeFinishByMinDays).toBe(10);
  });

  it("falls back to max-envelope reduce when every process is a sink (disconnected graph)", () => {
    const processes = [proc(1, 5), proc(2, 8)];
    const terminal = selectTerminal(processes, []);
    expect(terminal.id).toBe(2);
  });
});
