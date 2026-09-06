/**
 * One shared shape for every "X out of Y, as a %" KPI (on-time %, first-pass
 * yield %, QC checkpoint yield %) — previously re-implemented independently
 * in `departments.read.ts`, `myday.read.ts`, `workspace.read.ts` (×2), and
 * `qc-cockpit.read.ts`, kept aligned only by convention (docs/mos-blueprint/
 * reference/14_DESPL_MOS_MANAGEMENT_KPI_ALERT_MODEL.md §3).
 *
 * `null` (not 0) when `total` is 0 — 0% reads as "always late"/"always
 * rejected," which is wrong when there's simply no data yet.
 */
export function pctOf(count: number, total: number): number | null {
  return total > 0 ? Math.round((count / total) * 100) : null;
}
