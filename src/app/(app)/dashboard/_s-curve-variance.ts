export interface SCurvePoint {
  planned: number;
  actual: number | null;
}

/**
 * Actual against planned at the latest week with actuals, in percent (one decimal), for the S-curve legend.
 * Null when it would mean nothing: no baseline (planned 0), no actual weeks yet, or nothing completed so
 * far (that read "-100%" on a job that simply had not started; the chart still shows the flat line).
 */
export function sCurveVariancePct(sCurve: readonly SCurvePoint[]): number | null {
  const last = [...sCurve].reverse().find((p) => p.actual !== null);
  if (!last || last.actual === null || last.planned <= 0 || last.actual <= 0) return null;
  return Math.round(((last.actual - last.planned) / last.planned) * 1000) / 10;
}

/** The legend suffix: " · +12.5%", or nothing when there is no variance to report. */
export function sCurveVarianceLabel(pct: number | null): string {
  return pct === null ? "" : ` · ${pct > 0 ? "+" : ""}${pct}%`;
}
