import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES, isAppError } from "@/lib/shared/errors";
import { claimPlan } from "./assignment.service";
import { loadMyDay } from "./myday.read";

/**
 * Lean Core L2.3: an OPERATOR's one "Claim next" on Today. Takes the top
 * unassigned plan in the operator's own departments (loadMyDay's pool, ranked
 * by the prioritizer, ready ones before schedule-blocked ones) through the
 * ordinary claimPlan, so its department check, audit row and ALREADY_ASSIGNED
 * race handling are the existing ones. A planner claims too, from a pool loadMyDay
 * already narrows to processes 1–11. Supervisors do not claim from Today
 * (errata 15): they assign.
 */
const TRIES = 5;

export async function claimNext(actor: Actor): Promise<{ processPlanId: number }> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.OPERATOR, ROLES.PLANNER);
  const { pool } = await loadMyDay(actor);
  const open = pool.filter((p) => p.ranked.state !== "DONE");
  const ranked = [...open.filter((p) => p.ranked.state !== "BLOCKED"), ...open.filter((p) => p.ranked.state === "BLOCKED")];
  for (const candidate of ranked.slice(0, TRIES)) {
    const processPlanId = candidate.ranked.plan.id;
    try {
      await claimPlan(actor, { processPlanId });
      return { processPlanId };
    } catch (e) {
      // Someone else took it between the read and the claim: try the next one.
      if (isAppError(e) && e.code === ERROR_CODES.ALREADY_ASSIGNED) continue;
      throw e;
    }
  }
  throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "ProcessPlan" }, "Nothing is waiting to be claimed in your department.");
}
