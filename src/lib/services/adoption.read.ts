import { withTenant } from "@/lib/db";
import { assertNotClientUser, type Actor } from "@/lib/authz";
import { adoptionStreak, sameDayByDay, type AdoptionDay } from "@/lib/shared/team";

/**
 * Lean Core L3.1: the pilot gate in one read. Every recorded start / finish
 * stamp on a floor item is one update; it is same-day when its reported time
 * falls on the day it was recorded (D4 refinement 3, same rule as Team).
 * Company-wide, last 7 IST days, plus the run of working days at or above the
 * target (pilot: 90 % for 5 working days).
 */
export const ADOPTION_TARGET = 90;
export const ADOPTION_RUN = 5;
const DAYS = 7;

export interface AdoptionView {
  series: AdoptionDay[];
  streak: number;
  target: number;
  run: number;
}

export async function loadAdoption(actor: Actor): Promise<AdoptionView> {
  assertNotClientUser(actor);
  const now = new Date();
  const since = new Date(now.getTime() - (DAYS + 1) * 24 * 3600 * 1000);
  const where = { tenantId: actor.tenantId, OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }] };
  const select = { startedAt: true, reportedStartAt: true, finishedAt: true, reportedFinishAt: true } as const;
  const [steps, ops] = await withTenant(actor.tenantId, (tx) =>
    // j5c: history (events recorded, whether or not the row was since retired)
    Promise.all([tx.assemblyStep.findMany({ where, select }), tx.componentOperation.findMany({ where, select })]),
  );
  const events = [...steps, ...ops].flatMap((e) => [
    ...(e.startedAt && e.startedAt >= since ? [{ recordedAt: e.startedAt, reportedAt: e.reportedStartAt }] : []),
    ...(e.finishedAt && e.finishedAt >= since ? [{ recordedAt: e.finishedAt, reportedAt: e.reportedFinishAt }] : []),
  ]);
  const series = sameDayByDay(events, now, DAYS);
  return { series, streak: adoptionStreak(series, ADOPTION_TARGET), target: ADOPTION_TARGET, run: ADOPTION_RUN };
}
