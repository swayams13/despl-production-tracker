import leadTimeModel from "../../../../seed/lead-time-model.json";
import type { EdgeType, ScheduleEdge, ScheduleProcess } from "../types";

/**
 * The real PRESSURE_VESSEL v1 spine (36 processes), parsed straight from
 * seed/lead-time-model.json — the same source of truth prisma/seed.ts loads
 * into TemplateProcess/TemplateEdge. Used by the regression tests so they
 * exercise the actual seeded numbers, not a hand-typed stand-in that could
 * drift from them.
 */

interface LeadTimeProcessJson {
  code: number;
  name: string;
  durationDays: { minDays: number; maxDays: number };
  envelope: {
    finishByMinDays: number;
    finishByMaxDays: number;
    startByMinDays: number;
    startByMaxDays: number;
  };
  edges: { predecessor: number; type: EdgeType; lagDays: number }[];
}

const processesJson = leadTimeModel.processes as unknown as LeadTimeProcessJson[];

export const pressureVesselProcesses: ScheduleProcess[] = processesJson.map((p) => ({
  id: p.code,
  code: p.code,
  name: p.name,
  durationMinDays: p.durationDays.minDays,
  durationMaxDays: p.durationDays.maxDays,
  envelopeFinishByMinDays: p.envelope.finishByMinDays,
  envelopeFinishByMaxDays: p.envelope.finishByMaxDays,
  envelopeStartByMinDays: p.envelope.startByMinDays,
  envelopeStartByMaxDays: p.envelope.startByMaxDays,
  provisional: false,
}));

export const pressureVesselEdges: ScheduleEdge[] = processesJson.flatMap((p) =>
  p.edges.map((e) => ({
    processId: p.code,
    predecessorId: e.predecessor,
    type: e.type,
    lagDays: e.lagDays,
  })),
);

/** DESPL's own printed total: process 36 (Dispatch), min == max == 119 days. */
export const PRESSURE_VESSEL_TOTAL_DAYS = 119;
