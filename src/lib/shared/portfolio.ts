/**
 * Lean Core L2.7: the pure parts of the Portfolio (`/dashboard`). Tile counts,
 * the health filter slugs and links, the department bottleneck bars, the
 * needs-attention queue and its ranking, the top blocker per job, and the
 * "N of M forecast past committed date" line. No React, no database.
 *
 * Every number on the page is a count of the same facts the linked screen
 * lists (/team/[dept] for blocked and overdue, /qc for holds and NCRs), so a
 * tile never disagrees with where it takes you.
 */
import { qcHref } from "./qc-queue";
import type { JobHealth } from "@/lib/services/job-health";

// ── Health filter (the URL is the state: `?health=&job=`) ───────────────────

/** URL slug per health, so a tile click survives refresh and the back button. */
export const HEALTH_SLUG: Record<JobHealth, string> = {
  ON_TRACK: "on-track",
  AT_RISK: "at-risk",
  DELAYED: "delayed",
  ON_HOLD: "on-hold",
  COMPLETED: "completed",
  NOT_PLANNED: "not-planned",
};

export function healthFromSlug(slug: string | undefined): JobHealth | null {
  if (!slug) return null;
  const hit = (Object.keys(HEALTH_SLUG) as JobHealth[]).find((h) => HEALTH_SLUG[h] === slug);
  return hit ?? null;
}

/** `/dashboard` with an optional health filter and job focus, plus an optional in-page anchor. */
export function portfolioHref(q: { health?: JobHealth | null; jobId?: number | null }, hash?: string): string {
  const p = new URLSearchParams();
  if (q.health) p.set("health", HEALTH_SLUG[q.health]);
  if (q.jobId) p.set("job", String(q.jobId));
  const s = p.toString();
  return `/dashboard${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}

/** `?job=` as a positive integer, else null. */
export function parseJobParam(v: string | string[] | undefined): number | null {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Tiles ────────────────────────────────────────────────────────────────────

export interface PortfolioTile {
  id: "active" | "delayed" | "at-risk" | "on-hold" | "actions";
  label: string;
  value: number;
  href: string;
  /** Delayed and Actions due are the ones that ask for a decision. */
  alert: boolean;
  selected: boolean;
}

export function buildTiles(args: {
  counts: { active: number; DELAYED: number; AT_RISK: number; ON_HOLD: number };
  actionsDue: number;
  health: JobHealth | null;
  jobId: number | null;
}): PortfolioTile[] {
  const { counts, actionsDue, health, jobId } = args;
  const filter = (h: JobHealth): PortfolioTile["href"] => portfolioHref({ health: health === h ? null : h, jobId }, "projects");
  return [
    { id: "active", label: "Active", value: counts.active, href: portfolioHref({ jobId }, "projects"), alert: false, selected: false },
    { id: "delayed", label: "Delayed", value: counts.DELAYED, href: filter("DELAYED"), alert: counts.DELAYED > 0, selected: health === "DELAYED" },
    { id: "at-risk", label: "At risk", value: counts.AT_RISK, href: filter("AT_RISK"), alert: false, selected: health === "AT_RISK" },
    { id: "on-hold", label: "On hold", value: counts.ON_HOLD, href: filter("ON_HOLD"), alert: false, selected: health === "ON_HOLD" },
    { id: "actions", label: "Actions due", value: actionsDue, href: portfolioHref({ health, jobId }, "needs-attention"), alert: actionsDue > 0, selected: false },
  ];
}

// ── Forecast line ────────────────────────────────────────────────────────────

export interface ForecastInput {
  health: JobHealth;
  committedDeliveryDate: string | null;
  forecastDispatch: string | null;
  forecastVarianceDays: number | null;
}

/**
 * "N of M jobs forecast past committed date". M = the jobs that can be
 * judged: not completed, with both a promise and a forecast (a job nobody has
 * scheduled has no forecast to be late). Slip = days past promise, late jobs only.
 */
export function forecastPastCommitted(rows: ForecastInput[]): { late: number; known: number; slipDays: number } {
  let late = 0;
  let known = 0;
  let slipDays = 0;
  for (const r of rows) {
    if (r.health === "COMPLETED" || r.committedDeliveryDate === null || r.forecastDispatch === null || r.forecastVarianceDays === null) continue;
    known += 1;
    if (r.forecastVarianceDays > 0) {
      late += 1;
      slipDays += r.forecastVarianceDays;
    }
  }
  return { late, known, slipDays };
}

// ── Facts (what the service hands over) ──────────────────────────────────────

export interface DeptRef {
  id: number;
  code: string;
  name: string;
}

/** One open plan (a process on a unit) of an active job. DONE plans are not facts. */
export interface PlanFact {
  planId: number;
  jobId: number;
  jobNumber: string;
  deptId: number;
  processName: string;
  /** Null for a job-grain plan (one per job, not per unit). */
  serialNo: string | null;
  state: "BLOCKED" | "READY" | "IN_PROGRESS" | "SUBMITTED" | "ON_HOLD";
  overdue: boolean;
  daysLate: number | null;
  assigneeName: string | null;
}

export interface NcrFact {
  ncrId: number;
  jobId: number;
  jobNumber: string;
  /** The department that did the rejected work; null when it cannot be resolved. */
  deptId: number | null;
  serialNo: string | null;
  label: string;
  ageDays: number;
}

export interface HoldFact {
  key: string;
  jobId: number;
  jobNumber: string;
  serialNo: string | null;
  label: string;
  classCode: string;
  statusLabel: string;
  ageDays: number;
}

export interface PortfolioFacts {
  depts: DeptRef[];
  plans: PlanFact[];
  ncrs: NcrFact[];
  holds: HoldFact[];
}

const inJob = <T extends { jobId: number }>(rows: T[], jobId: number | null): T[] => (jobId ? rows.filter((r) => r.jobId === jobId) : rows);

// ── Bottlenecks ──────────────────────────────────────────────────────────────

export interface DeptBottleneck {
  deptId: number;
  code: string;
  name: string;
  blocked: number;
  overdue: number;
  rejected: number;
  total: number;
  blockedHref: string;
  overdueHref: string;
  rejectedHref: string;
}

/** `/team/<dept>?status=&job=`: the page reads `status` overdue | blocked and `job` as a job id. */
export function teamHref(deptCode: string, status: "overdue" | "blocked" | null, jobId: number | null): string {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (jobId) p.set("job", String(jobId));
  const s = p.toString();
  return `/team/${deptCode.toLowerCase()}${s ? `?${s}` : ""}`;
}

/**
 * Worst-first stacked bars, actionable segments only. A plan can be both
 * blocked and overdue and counts in each segment, as it does on its Team page.
 * A department with nothing to show is left out.
 */
export function bottlenecks(facts: Pick<PortfolioFacts, "depts" | "plans" | "ncrs">, jobId: number | null): DeptBottleneck[] {
  const by = new Map<number, { blocked: number; overdue: number; rejected: number }>();
  const bucket = (id: number) => {
    let b = by.get(id);
    if (!b) by.set(id, (b = { blocked: 0, overdue: 0, rejected: 0 }));
    return b;
  };
  for (const p of inJob(facts.plans, jobId)) {
    if (p.state === "BLOCKED") bucket(p.deptId).blocked++;
    if (p.overdue) bucket(p.deptId).overdue++;
  }
  for (const n of inJob(facts.ncrs, jobId)) if (n.deptId !== null) bucket(n.deptId).rejected++;

  const out: DeptBottleneck[] = [];
  for (const d of facts.depts) {
    const b = by.get(d.id);
    if (!b) continue;
    const total = b.blocked + b.overdue + b.rejected;
    if (total === 0) continue;
    out.push({
      deptId: d.id,
      code: d.code,
      name: d.name,
      ...b,
      total,
      blockedHref: teamHref(d.code, "blocked", jobId),
      overdueHref: teamHref(d.code, "overdue", jobId),
      rejectedHref: qcHref({ tab: "ncrs", jobId }),
    });
  }
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

// ── Needs attention ──────────────────────────────────────────────────────────

export type ExceptionKind = "NCR" | "HOLD" | "OVERDUE";
const KIND_RANK: Record<ExceptionKind, number> = { NCR: 0, HOLD: 1, OVERDUE: 2 };

export interface PortfolioException {
  key: string;
  kind: ExceptionKind;
  jobId: number;
  jobNumber: string;
  what: string;
  deptName: string;
  owner: string | null;
  ageDays: number;
  href: string;
  /** The verb on the row's link, plain words. */
  action: string;
}

export const ATTENTION_LIMIT = 15;

/** "SR05, SR06" for up to three serials, else "SR05 and 6 more". */
function serialList(serials: string[]): string {
  const uniq = [...new Set(serials)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return uniq.length <= 3 ? uniq.join(", ") : `${uniq.slice(0, 2).join(", ")} and ${uniq.length - 2} more`;
}

/**
 * Everything that needs a person, unranked: each open NCR, each open hold
 * point (QC owns it), and overdue plans grouped by job, department and
 * process (nine units late on one process is one line, not nine).
 */
export function buildExceptions(facts: PortfolioFacts, jobId: number | null, qcDeptName = "Quality Control"): PortfolioException[] {
  const deptById = new Map(facts.depts.map((d) => [d.id, d]));
  const out: PortfolioException[] = [];

  for (const n of inJob(facts.ncrs, jobId)) {
    out.push({
      key: `ncr-${n.ncrId}`,
      kind: "NCR",
      jobId: n.jobId,
      jobNumber: n.jobNumber,
      what: `${n.serialNo ? `${n.serialNo} · ` : ""}${n.label}: open NCR`,
      deptName: (n.deptId !== null && deptById.get(n.deptId)?.name) || qcDeptName,
      owner: null,
      ageDays: n.ageDays,
      href: qcHref({ tab: "ncrs", jobId: n.jobId }),
      action: "Open in QC",
    });
  }

  for (const h of inJob(facts.holds, jobId)) {
    out.push({
      key: `hold-${h.key}`,
      kind: "HOLD",
      jobId: h.jobId,
      jobNumber: h.jobNumber,
      what: `${h.serialNo ? `${h.serialNo} · ` : ""}${h.label}: ${h.classCode} point, ${h.statusLabel.toLowerCase()}`,
      deptName: qcDeptName,
      owner: null,
      ageDays: h.ageDays,
      href: qcHref({ tab: "holds", jobId: h.jobId }),
      action: "Open in QC",
    });
  }

  const groups = new Map<string, PlanFact[]>();
  for (const p of inJob(facts.plans, jobId)) {
    if (!p.overdue) continue;
    const k = `${p.jobId}:${p.deptId}:${p.processName}`;
    const g = groups.get(k);
    if (g) g.push(p);
    else groups.set(k, [p]);
  }
  for (const [k, g] of groups) {
    const first = g[0];
    const dept = deptById.get(first.deptId);
    const owners = [...new Set(g.map((p) => p.assigneeName))];
    const serials = g.flatMap((p) => (p.serialNo ? [p.serialNo] : []));
    out.push({
      key: `late-${k}`,
      kind: "OVERDUE",
      jobId: first.jobId,
      jobNumber: first.jobNumber,
      what: `${first.processName} overdue${serials.length ? ` on ${serialList(serials)}` : ""}${g.length > 1 ? ` (${g.length})` : ""}`,
      deptName: dept?.name ?? "—",
      owner: owners.length === 1 ? owners[0] : owners.length > 1 ? "Several people" : null,
      ageDays: Math.max(...g.map((p) => p.daysLate ?? 0)),
      href: teamHref(dept?.code ?? "", "overdue", first.jobId),
      action: "Open in Team",
    });
  }
  return out;
}

/**
 * Worst job first (`jobOrder` is the health table's order), then NCR before
 * hold before late work, then oldest, then key for a stable page.
 */
export function rankExceptions(items: PortfolioException[], jobOrder: number[]): PortfolioException[] {
  const rank = new Map(jobOrder.map((id, i) => [id, i]));
  const at = (id: number) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort(
    (a, b) => at(a.jobId) - at(b.jobId) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.ageDays - a.ageDays || a.key.localeCompare(b.key),
  );
}

/** First (worst) exception per job, from a ranked list. */
export function topBlockerByJob(ranked: PortfolioException[]): Map<number, PortfolioException> {
  const out = new Map<number, PortfolioException>();
  for (const e of ranked) if (!out.has(e.jobId)) out.set(e.jobId, e);
  return out;
}

/** Overdue plans, open holds and open NCRs, in the scope shown: the "Actions due" tile. */
export function actionsDue(facts: PortfolioFacts, jobId: number | null): number {
  return inJob(facts.plans, jobId).filter((p) => p.overdue).length + inJob(facts.holds, jobId).length + inJob(facts.ncrs, jobId).length;
}
