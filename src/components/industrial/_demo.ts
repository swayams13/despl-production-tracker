/**
 * THROWAWAY session-1 demo data for the shell mini-spine and the /kit preview.
 * Delete once StageSpine renders from real rolled-up plan data (v_unit_stage_status).
 */
import type { StageDisplayStatus, StageSegment } from "./stage-status";

// "hold!" = hold fill + overdue pip (the resolved C26 dual signal).
const PATTERN =
  "complete complete complete complete overdue complete overdue progress hold! submitted idle idle idle idle idle idle idle idle idle idle idle idle idle idle idle".split(
    " ",
  );

export const DEMO_SPINE: StageSegment[] = PATTERN.map((code, i) => {
  const overdue = code.endsWith("!");
  const status = (overdue ? code.slice(0, -1) : code) as StageDisplayStatus;
  return { stageNo: i + 1, stageName: `Stage ${i + 1}`, status, overdue };
});

export const DEMO_WAYPOINTS = [
  { no: 1, label: "PO receipt" },
  { no: 9, label: "Material inspection" },
  { no: 17, label: "Circ seam welding" },
  { no: 22, label: "Hydro test" },
  { no: 25, label: "Dispatch" },
];
