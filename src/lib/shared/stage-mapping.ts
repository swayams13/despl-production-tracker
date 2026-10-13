/**
 * Lean Core M1 (PR B): which lead-time process a component operation rolls up
 * into, for one product family.
 *
 * Two layers, step first (workbook: an Inspection step counts toward process
 * 11, 12, 18 or 25 depending on the part, which one process per operation
 * cannot say):
 *   1. `RouteStepFamilySeq` — keyed by the route version's step (routeVersionId
 *      + seq). A ComponentOperation carries neither a step id nor a route
 *      version, but its component has `routeVersionId` and its own `seq` is
 *      copied 1:1 from `RouteStep.seq` at materialisation.
 *   2. `OperationRefFamilySeq` — the operation-level default (today's rule).
 *
 * With no step-level rows every operation resolves exactly as before. A
 * family with no row at either level resolves to null (SEAM: no rollup, no
 * borrowed number from another family).
 */
export interface MappableOp {
  operationId: number;
  /** ComponentOperation.seq (= RouteStep.seq of the route version it came from). */
  seq: number;
  /** Component.routeVersionId; null for a component with no canonical route. */
  routeVersionId: number | null;
}

export function stepKey(routeVersionId: number, seq: number): string {
  return `${routeVersionId}:${seq}`;
}

export function resolveProcessSeq(
  op: MappableOp,
  /** stepKey(routeVersionId, seq) -> leadTimeProcessSeq, this family only. */
  stepSeq: ReadonlyMap<string, number>,
  /** operationId -> leadTimeProcessSeq, this family only. */
  operationSeq: ReadonlyMap<number, number>,
): number | null {
  if (op.routeVersionId != null) {
    const bySeq = stepSeq.get(stepKey(op.routeVersionId, op.seq));
    if (bySeq != null) return bySeq;
  }
  return operationSeq.get(op.operationId) ?? null;
}

/**
 * Effective QC for a materialised component operation: either level can waive
 * it, and the default (true / true) is today's behaviour.
 */
export function effectiveRequiresQc(stepRequiresQc: boolean, operationRequiresQc: boolean): boolean {
  return stepRequiresQc && operationRequiresQc;
}

/**
 * Which route template wins when several candidates exist for one component
 * type. Order: a family-specific route beats the generic (familyId null) one
 * — the rule `materialiseComponents` always had, kept even when the
 * family-specific route has nothing published; then, among equals, a variant
 * with a published version beats one without; then the lowest variant letter.
 * Deterministic until the BOM-release step chooses a variant (J5).
 */
export function pickRouteTemplate<T extends { familyId: number | null; variant: string; versions: readonly unknown[] }>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  for (const t of candidates) {
    if (best == null || beats(t, best)) best = t;
  }
  return best;
}

function beats(
  a: { familyId: number | null; variant: string; versions: readonly unknown[] },
  b: { familyId: number | null; variant: string; versions: readonly unknown[] },
): boolean {
  const aSpecific = a.familyId != null;
  const bSpecific = b.familyId != null;
  if (aSpecific !== bSpecific) return aSpecific;
  const aHas = a.versions.length > 0;
  const bHas = b.versions.length > 0;
  if (aHas !== bHas) return aHas;
  return a.variant < b.variant;
}
