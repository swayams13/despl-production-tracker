/**
 * Project-level health — the rule behind the portfolio dashboard's tiles
 * (spec: docs/superpowers/specs/2026-08-16-portfolio-dashboard-design.md §4).
 *
 * Three-tier RAG for active projects plus three structural states. First match
 * wins, in the order written. This is the single implementation: dashboard,
 * jobs list and the daily digest all import it, so they cannot disagree
 * (DESIGN_SPEC §11.5's guarantee — one implementation, not SQL specifically).
 *
 * Pure and I/O-free on purpose. `today` is injected rather than read from the
 * clock so the date-boundary cases are testable without mocking.
 *
 * ponytail: hold-point ageing is deliberately NOT an input here — its threshold
 * would have been invented, and an uncleared hold blocks completion (invariant
 * #4) so it reaches AT_RISK through overduePlans anyway. See spec §4.1 for the
 * upgrade path if SJ asks for it.
 */
import { isOverdue } from "@/lib/shared/business-day";

export type JobHealth =
  | "ON_TRACK"
  | "AT_RISK"
  | "DELAYED"
  | "ON_HOLD"
  | "COMPLETED"
  | "NOT_PLANNED";

/** What the rule can emit. `CANCELLED` rows never reach the UI — see portfolio.read.ts. */
export type JobHealthRaw = JobHealth | "CANCELLED";

/** Exactly the fields `loadJobs()` already returns. Nothing new is queried for this. */
export interface HealthInput {
  status: string;
  committedDeliveryDate: string | null;
  forecastDispatch: string | null;
  totalPlans: number;
  overduePlans: number;
}

/** User-facing labels. Raw enums must never reach the DOM (CLAUDE.md hard ban). */
export const HEALTH_LABEL: Record<JobHealth, string> = {
  ON_TRACK: "On track",
  AT_RISK: "At risk",
  DELAYED: "Delayed",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  NOT_PLANNED: "Not planned",
};

/**
 * Worst-first. ON_HOLD sits low because a paused project is a decision already
 * taken, not a surprise to discuss.
 */
export const HEALTH_ORDER: JobHealth[] = [
  "DELAYED",
  "AT_RISK",
  "NOT_PLANNED",
  "ON_TRACK",
  "ON_HOLD",
  "COMPLETED",
];

export function classifyJobHealth(job: HealthInput, today: Date): JobHealthRaw {
  // Structural states outrank health: a cancelled, finished or deliberately
  // paused project is not "late", whatever its plans say.
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "COMPLETE") return "COMPLETED";
  if (job.status === "ON_HOLD") return "ON_HOLD";

  // An accepted order nobody has scheduled. A real management signal, not a gap.
  if (job.totalPlans === 0) return "NOT_PLANNED";

  if (job.committedDeliveryDate !== null) {
    const committedDeliveryDate = new Date(job.committedDeliveryDate);
    // Date-vs-date, never timestamp, and IN IST (lib/shared/business-day.ts,
    // audit H1): a raw `committedDeliveryDate < now()` would flip a job red
    // at 00:00 UTC = 05:30 IST on the very day it was promised — a full
    // working day early, and a number SJ would rightly dispute.
    if (isOverdue(committedDeliveryDate, today)) return "DELAYED";

    // Strictly greater: landing exactly on the promised date is on time.
    // Both sides are calendar-day markers already (forecastDispatch is a
    // scheduled date, not a real instant) — a plain Date compare, no IST
    // shift needed on either side.
    if (job.forecastDispatch !== null && new Date(job.forecastDispatch) > committedDeliveryDate) {
      return "DELAYED";
    }
  }

  // Slipping, but the forecast still fits (or there is no promise to miss).
  if (job.overduePlans > 0) return "AT_RISK";

  return "ON_TRACK";
}
