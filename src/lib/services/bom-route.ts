/**
 * Pure component-route projection — deliberately split out of `bom.read.ts`
 * (server-only: pulls in `@/lib/db`/`@/lib/authz`) so `<BomPanel>`, a client
 * component, can reuse the same collapse logic for rendering. Same pattern
 * as `gantt-layout.ts` / `job-gantt.tsx`. No DB/auth imports belong here.
 */
import type { StageDisplayStatus } from "@/components/industrial/stage-status";

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
  // Queue per operationId, not a single map slot — a route can legitimately
  // use the same canonical operation twice (e.g. DISHED_END's "Pressing/
  // Spinning" and "Trimming" both ride FORMING, same physical 36-process
  // stage tracked as two floor steps). actualOps arrives seq-ordered, so
  // shifting off the front pairs each route-step occurrence with its own
  // distinct ComponentOperation row instead of collapsing them onto one.
  const queueByOpId = new Map<number, ActualOp[]>();
  for (const o of actualOps) {
    const queue = queueByOpId.get(o.operationId);
    if (queue) queue.push(o);
    else queueByOpId.set(o.operationId, [o]);
  }
  const matchedIds = new Set<number>();

  const projected: ProjectedOp[] = [...routeSteps]
    .sort((a, b) => a.seq - b.seq)
    .map((s) => {
      const actual = queueByOpId.get(s.operationId)?.shift();
      if (actual) matchedIds.add(actual.id);
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
    .filter((o) => !matchedIds.has(o.id))
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

export function opDisplayStatus(status: string): StageDisplayStatus {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

/**
 * A component's overall display status from its route's op statuses. A
 * route is often mid-way — some steps COMPLETE, the rest still NOT_STARTED,
 * nothing currently active between them — and that must read as "in
 * progress", never as "complete" (reusing a finished step's own status) or
 * as "idle"/not-started (the route has, in fact, started).
 */
export function computeComponentDisplayStatus(ops: { status: string }[]): StageDisplayStatus {
  if (ops.length === 0) return "idle";
  if (ops.every((o) => o.status === "COMPLETE")) return "complete";
  const active = ops.find((o) => o.status !== "COMPLETE" && o.status !== "NOT_STARTED");
  if (active) return opDisplayStatus(active.status);
  const started = ops.some((o) => o.status !== "NOT_STARTED");
  return started ? "progress" : "idle";
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
