/**
 * The scheduling engine — the two-layer model from BUILD-SPEC-v2 §1.
 *
 * - **Envelope layer** (`envelope.ts`) is authoritative. It reads DESPL's
 *   printed cumulative lead times and reproduces the quoted ~17 weeks exactly.
 *   Drives tender quoting and the feasibility check.
 * - **CPM layer** (`cpm.ts`) replays the same schedule over a fitted-lag DAG.
 *   Drives live replanning, forward/backward/override modes, and critical path.
 *
 * Never sum per-process durations to build a schedule (invariant #10): the
 * table encodes concurrent fabrication, and summing gives 11.6–24 weeks against
 * DESPL's stated ~17.
 *
 * Everything here is pure — no Prisma, no dates read from a clock, no writes.
 * `lib/services/` loads the rows, calls in, and persists the result with its
 * audit row inside one transaction.
 */

export { envelopePlan, checkFeasibility } from "./envelope";
export { forwardPass, backwardPass, type SchedulePin } from "./cpm";
export { topoOrder, bypassExcluded } from "./graph";
export { resolveDurationDays, assertDurationsKnown, assertEnvelopeKnown } from "./duration";
export type {
  FeasibilityResult,
  PlannedProcess,
  ProcessEdgeType,
  ProcessOffsets,
  ScheduleEdge,
  ScheduleFeasibility,
  ScheduleProcess,
} from "./types";
