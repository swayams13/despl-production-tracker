import { workingDaysBetween } from "./calendar";
import type { WorkCalendarInput } from "./types";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";

/**
 * Feasibility check (BUILD-SPEC-v2 §1.5), run at tender stage before an order
 * is committed:
 *
 *   available = working_days(po_date -> required_delivery)
 *   if available >= envelope.finishByMaxDays[36]  -> FEASIBLE
 *   elif available >= envelope.finishByMinDays[36] -> TIGHT
 *   else -> INFEASIBLE (short by N days; must be escalated before acceptance)
 *
 * For PRESSURE_VESSEL v1, finishByMinDays and finishByMaxDays are equal
 * (119) at the terminal process — "17 weeks is both the minimum and the
 * maximum" (rows 35-36 of the printed table). TIGHT is only reachable for a
 * family whose envelope has a real min/max spread at its terminal process.
 */

export type ScheduleFeasibility = "FEASIBLE" | "TIGHT" | "INFEASIBLE";

export interface FeasibilityResult {
  feasibility: ScheduleFeasibility;
  availableWorkingDays: number;
  requiredMinDays: number;
  requiredMaxDays: number;
  /** Only set when INFEASIBLE — days short against the standard (max) envelope. */
  shortfallDays: number | null;
}

export function checkFeasibility(
  poDate: Date,
  requiredDeliveryDate: Date,
  requiredMinDays: number,
  requiredMaxDays: number,
  calendar: WorkCalendarInput,
): FeasibilityResult {
  if (requiredMinDays > requiredMaxDays) {
    throw new AppError(
      ERROR_CODES.SCHEDULE_ENVELOPE_INVALID,
      { requiredMinDays, requiredMaxDays },
      "Envelope data is inconsistent: minimum duration exceeds maximum.",
    );
  }
  const available = workingDaysBetween(poDate, requiredDeliveryDate, calendar);

  if (available >= requiredMaxDays) {
    return { feasibility: "FEASIBLE", availableWorkingDays: available, requiredMinDays, requiredMaxDays, shortfallDays: null };
  }
  if (available >= requiredMinDays) {
    return { feasibility: "TIGHT", availableWorkingDays: available, requiredMinDays, requiredMaxDays, shortfallDays: null };
  }
  return {
    feasibility: "INFEASIBLE",
    availableWorkingDays: available,
    requiredMinDays,
    requiredMaxDays,
    shortfallDays: requiredMaxDays - available,
  };
}
