/**
 * Pure component-route projection — deliberately split out of `bom.read.ts`
 * (server-only: pulls in `@/lib/db`/`@/lib/authz`) so `<BomPanel>`, a client
 * component, can reuse the same collapse logic for rendering. Same pattern
 * as `gantt-layout.ts` / `job-gantt.tsx`. No DB/auth imports belong here.
 */
export interface RouteStepDef {
  seq: number;
  operationId: number;
  operationName: string;
  leadTimeProcessSeq: number | null;
}

/** F5's latest rejection, for display alongside a step returned to IN_PROGRESS. */
export interface RejectionSummary {
  categoryName: string;
  detail: string | null;
}

export interface ActualOp {
  /** ComponentOperation.id — the row a Start/Submit/Verify action must reference. */
  id: number;
  operationId: number;
  operationName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  leadTimeProcessSeq: number | null;
  /** F3 — who performed the work, not who clicked Submit. */
  performedByWelderName: string | null;
  performedByUserName: string | null;
  remarks: string | null;
  /** F4 — all nullable; "done/not done" alone remains valid for v1 (F-c open). */
  qtyPlanned: number | null;
  qtyGood: number | null;
  qtyRejected: number | null;
  /** F5 — the most recent rejection, if any. */
  rejection: RejectionSummary | null;
}

export interface ProjectedOp {
  seq: number;
  operationName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  leadTimeProcessSeq: number | null;
  /** Null for a canonical route step with no matching ComponentOperation row yet — no action is possible on it. */
  id: number | null;
  performedByWelderName: string | null;
  performedByUserName: string | null;
  remarks: string | null;
  qtyPlanned: number | null;
  qtyGood: number | null;
  qtyRejected: number | null;
  rejection: RejectionSummary | null;
}

/**
 * Merges the canonical planned route (`RouteStep`, ordered, may be empty if
 * the component has no `routeVersionId`) with what's actually been tracked
 * (`ComponentOperation`, matched by operationId — NOT by seq, since the live
 * CSV's recorded ops can skip steps the canonical route includes). A route
 * step with no matching actual op renders as NOT_STARTED rather than being
 * omitted, so the full planned sequence is always visible. An actual op that
 * doesn't match any route step (e.g. a synthesized MTC-verification entry)
 * is appended rather than dropped.
 */
export function projectComponentRoute(routeSteps: RouteStepDef[], actualOps: ActualOp[]): ProjectedOp[] {
  const actualByOpId = new Map(actualOps.map((o) => [o.operationId, o]));
  const matchedIds = new Set<number>();

  const projected: ProjectedOp[] = [...routeSteps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const actual = actualByOpId.get(s.operationId);
      if (actual) matchedIds.add(s.operationId);
      return {
        seq: s.seq,
        operationName: s.operationName,
        status: actual?.status ?? "NOT_STARTED",
        startedAt: actual?.startedAt ?? null,
        finishedAt: actual?.finishedAt ?? null,
        leadTimeProcessSeq: s.leadTimeProcessSeq,
        id: actual?.id ?? null,
        performedByWelderName: actual?.performedByWelderName ?? null,
        performedByUserName: actual?.performedByUserName ?? null,
        remarks: actual?.remarks ?? null,
        qtyPlanned: actual?.qtyPlanned ?? null,
        qtyGood: actual?.qtyGood ?? null,
        qtyRejected: actual?.qtyRejected ?? null,
        rejection: actual?.rejection ?? null,
      };
    });

  const extras: ProjectedOp[] = actualOps
    .filter((o) => !matchedIds.has(o.operationId))
    .map((o, i) => ({
      seq: routeSteps.length + i + 1,
      operationName: o.operationName,
      status: o.status,
      startedAt: o.startedAt,
      finishedAt: o.finishedAt,
      leadTimeProcessSeq: o.leadTimeProcessSeq,
      id: o.id,
      performedByWelderName: o.performedByWelderName,
      performedByUserName: o.performedByUserName,
      remarks: o.remarks,
      qtyPlanned: o.qtyPlanned,
      qtyGood: o.qtyGood,
      qtyRejected: o.qtyRejected,
      rejection: o.rejection,
    }));

  return [...projected, ...extras];
}

export interface ProjectedRouteView<T extends ProjectedOp> {
  collapsedDoneCount: number;
  visible: T[];
}

/** Collapses only a LEADING contiguous run of COMPLETE steps — a completed step after a gap stays visible in context. */
export function groupProjectedRoute<T extends ProjectedOp>(steps: T[]): ProjectedRouteView<T> {
  let i = 0;
  while (i < steps.length && steps[i].status === "COMPLETE") i++;
  return { collapsedDoneCount: i, visible: steps.slice(i) };
}
