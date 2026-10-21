/**
 * Lean Core L2.6: the pure parts of the QC queue. One hold-point status ladder
 * (AUD-041: the three read-side copies disagreed with the gate about NA), the
 * evidence a clearing needs (§8.2 item 18), ordering, grouping and paging.
 * No React, no database.
 */

export const QC_PAGE_SIZE = 25;

/**
 * Who may open the QC queue (`resolveQcAccess().view`) and who may record a hold-point
 * result (`recordQcpExecution`). One list each, read by the server rule, the nav and the
 * job QC tab's Record button, so a control never shows for a role the server refuses.
 */
export const QC_VIEW_ROLES = ["QC", "PRODUCTION_HEAD", "MANAGEMENT", "ADMIN"] as const;
export const QC_RECORD_ROLES = ["QC"] as const;

export type QcTab = "ready" | "holds" | "ncrs";
export const QC_TABS: readonly QcTab[] = ["ready", "holds", "ncrs"];

export interface QcCounts {
  ready: number;
  holds: number;
  ncrs: number;
}

// ── Hold-point status ladder ─────────────────────────────────────────────────

export type HoldStatus = "AWAITING_TPI" | "PENDING" | "QC_REVIEW" | "REINSPECT" | "WAIVER_PENDING";

export const HOLD_STATUS_LABEL: Record<HoldStatus, string> = {
  AWAITING_TPI: "Awaiting inspector",
  PENDING: "Pending",
  QC_REVIEW: "QC review",
  REINSPECT: "Reinspect",
  WAIVER_PENDING: "Waiver pending",
};

export interface LatestAttempt {
  result: "PENDING" | "ACCEPTED" | "REJECTED" | "NA";
  waiverApprovedBy: number | null;
  recordedAt: Date;
}

/**
 * The status of one blocking point on one unit from its latest attempt, or
 * null when it is cleared. Mirrors `openQcpItemIdsForUnit` (_shared.ts), the
 * gate the floor actually enforces: ACCEPTED clears; NA clears only once
 * `approveQcpWaiver` has stamped it; PENDING and REJECTED block.
 */
export function resolveHoldPointStatus(latest: LatestAttempt | null, requiresCall: boolean): HoldStatus | null {
  if (!latest) return requiresCall ? "AWAITING_TPI" : "PENDING";
  switch (latest.result) {
    case "ACCEPTED":
      return null;
    case "NA":
      return latest.waiverApprovedBy == null ? "WAIVER_PENDING" : null;
    case "REJECTED":
      return "REINSPECT";
    default:
      return "QC_REVIEW";
  }
}

/**
 * A blocking point is one QC can act on once it has an attempt, its unit's plan
 * has started, or its planned start has passed; a point nobody has reached is
 * upcoming. One predicate for /qc and every count that links to it.
 */
export function holdIsReached(
  attempt: LatestAttempt | null,
  plan: { status: string; plannedStart: Date | null } | undefined,
  now: Date,
): boolean {
  return attempt != null || (plan != null && plan.status !== "NOT_STARTED") || (plan?.plannedStart != null && plan.plannedStart <= now);
}

const CLASS_RANK: Record<string, number> = { H: 0, "R&A": 1, RW: 2, W: 3 };
export const classRank = (code: string): number => CLASS_RANK[code] ?? 4;

/** Whole days between a reference instant and now; 0 when unknown or in the future. */
export function ageDaysOf(ref: Date | null, now: Date): number {
  return ref ? Math.max(0, Math.floor((now.getTime() - ref.getTime()) / 864e5)) : 0;
}

/** Blocking class first (H, then R&A, RW, W), then oldest; ties by job, unit, point for a stable page. */
export function compareHolds(
  a: { classCode: string; ageDays: number; jobNumber: string; serialNo: string | null; srNo: string },
  b: { classCode: string; ageDays: number; jobNumber: string; serialNo: string | null; srNo: string },
): number {
  return (
    classRank(a.classCode) - classRank(b.classCode) ||
    b.ageDays - a.ageDays ||
    a.jobNumber.localeCompare(b.jobNumber) ||
    (a.serialNo ?? "").localeCompare(b.serialNo ?? "", undefined, { numeric: true }) ||
    a.srNo.localeCompare(b.srNo, undefined, { numeric: true })
  );
}

// ── Evidence (§8.2 item 18) ──────────────────────────────────────────────────

/**
 * A test point is recognised by its activity name. ponytail: name match, since the QCP item has no
 * test-kind column; add one with the QCP template editor and switch this to it.
 */
export const isTestPoint = (activity: string): boolean => /hydro/i.test(activity);

/**
 * What QC must record before clearing a point (empty = nothing). A point a third party also
 * blocks needs their inspector and report / IRN number; a hydro point needs its test record.
 */
export function evidenceNeeded(args: {
  activity: string;
  externalBlocking: boolean;
  given: { partyInspector?: string; reportRef?: string; testData?: boolean };
}): string[] {
  const missing: string[] = [];
  if (args.externalBlocking) {
    if (!args.given.partyInspector) missing.push("the inspector's name");
    if (!args.given.reportRef) missing.push("the report or IRN number");
  }
  if (isTestPoint(args.activity) && !args.given.testData) missing.push("test pressure, hold time and gauge IDs");
  return missing;
}

/**
 * The refusal text for missing evidence. Server Actions return the code's generic message, not the
 * service's own, so the UI rebuilds it from the refusal's `detail.missing`. null = not an evidence refusal.
 */
export function evidenceMessage(missing: unknown): string | null {
  if (!Array.isArray(missing) || missing.length === 0 || !missing.every((m) => typeof m === "string")) return null;
  return `Before this can be cleared, record: ${missing.join(", ")}.`;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface QcWhere {
  jobId: number;
  jobNumber: string;
  unitId: number | null;
  serialNo: string | null;
}

export type ReadyKind = "ASSEMBLY_STEP" | "COMPONENT_OP" | "PROCESS_PLAN";

export interface ReadyRow extends QcWhere {
  key: string;
  kind: ReadyKind;
  id: number;
  title: string;
  /** Component tag or template group, for the second line. */
  group: string;
  deptName: string | null;
  /** The maker: who submitted the work (null for an inspection step nobody submits). */
  makerName: string | null;
  /** An INSPECTION step: QC records it directly, no one submitted it. */
  inspection: boolean;
  /** ISO of when it started waiting for QC; null = unknown. */
  waitingSince: string | null;
  ageDays: number;
}

export interface HoldRow extends QcWhere {
  key: string;
  qcpItemId: number;
  srNo: string;
  activity: string;
  classCode: string;
  /** The inspecting parties that block, by name or code ("Client TPI, DESPL"). */
  parties: string;
  /** A third party also blocks this point (needs their inspector and report to clear). */
  external: boolean;
  testPoint: boolean;
  status: HoldStatus;
  ageDays: number;
  /** An NA awaiting the Production Head's approval (invariant 4). */
  waiverPending: boolean;
}

export interface NcrQueueRow extends QcWhere {
  ncrId: number;
  status: "OPEN" | "DISPOSITIONED" | "REWORK_IN_PROGRESS";
  entityLabel: string;
  categoryName: string;
  detail: string | null;
  raisedByName: string;
  raisedAt: string;
  ageDays: number;
  /** A concession accepted by the Production Head that QC has not yet ratified. */
  awaitingRatification: boolean;
  /** The user who accepted it, so the UI can hide Ratify from them (the service refuses anyway). */
  concessionBy: number | null;
  /** An H5 / H6 rule NCR (welding after the final PWHT or after hydro): resolved by repair, or by a concession. */
  ruleNcr: boolean;
}

export type NcrDisposition = "REWORK" | "REPAIR" | "USE_AS_IS" | "CONCESSION" | "SCRAP";

/**
 * Which dispositions a viewer may choose for an NCR (the screen's mirror of ncr.service's rules, which still refuse):
 * QC dispositions an ordinary NCR any way, and a rule NCR only by repair; the Production Head's one disposition is
 * accepting a rule NCR as a concession. An empty list means no Disposition button.
 */
export function dispositionChoices(row: Pick<NcrQueueRow, "ruleNcr">, access: { disposition: boolean; concede: boolean }): NcrDisposition[] {
  if (row.ruleNcr) return [...(access.disposition ? (["REPAIR"] as const) : []), ...(access.concede ? (["CONCESSION"] as const) : [])];
  return access.disposition ? ["REWORK", "REPAIR", "USE_AS_IS", "CONCESSION", "SCRAP"] : [];
}

// ── Grouping and paging ──────────────────────────────────────────────────────

export interface UnitGroup<T> {
  unitId: number | null;
  serialNo: string | null;
  rows: T[];
}
export interface JobGroup<T> {
  jobId: number;
  jobNumber: string;
  units: UnitGroup<T>[];
  count: number;
}

/** job → unit, groups in the order their first row appears (so oldest-first rows keep oldest-first groups). */
export function groupByJobUnit<T extends QcWhere>(rows: T[]): JobGroup<T>[] {
  const jobs: JobGroup<T>[] = [];
  for (const r of rows) {
    let job = jobs.find((j) => j.jobId === r.jobId);
    if (!job) jobs.push((job = { jobId: r.jobId, jobNumber: r.jobNumber, units: [], count: 0 }));
    let unit = job.units.find((u) => u.unitId === r.unitId);
    if (!unit) job.units.push((unit = { unitId: r.unitId, serialNo: r.serialNo, rows: [] }));
    unit.rows.push(r);
    job.count++;
  }
  return jobs;
}

export function pageOf<T>(rows: T[], page: number, size = QC_PAGE_SIZE): { rows: T[]; page: number; pages: number; total: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, total: rows.length };
}

export interface QcQuery {
  tab: QcTab;
  jobId: number | null;
  unitId: number | null;
  page: number;
}

/** The URL is the state: `?tab=&job=&unit=&page=`. Anything unparsable falls back to the default. */
export function parseQcQuery(sp: Record<string, string | string[] | undefined>): QcQuery {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const posInt = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const tab = QC_TABS.find((t) => t === one("tab")) ?? "ready";
  return { tab, jobId: posInt(one("job")), unitId: posInt(one("unit")), page: posInt(one("page")) ?? 1 };
}

export function qcHref(q: Partial<QcQuery>): string {
  const p = new URLSearchParams();
  if (q.tab && q.tab !== "ready") p.set("tab", q.tab);
  if (q.jobId) p.set("job", String(q.jobId));
  if (q.unitId) p.set("unit", String(q.unitId));
  if (q.page && q.page > 1) p.set("page", String(q.page));
  const s = p.toString();
  return s ? `/qc?${s}` : "/qc";
}
