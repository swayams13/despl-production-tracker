import { withTenant, type Tx } from "@/lib/db";
import { assertNotClientUser, requireRole, ROLES, type Actor } from "@/lib/authz";
import { MASTER_DATA_READ_ROLES } from "./master-data.service";
import { isAckStale, reviewPairs, type PairOverride, type ReviewPair } from "@/lib/shared/override-review";
import { resolveCalendarsForJobs } from "./_shared";

/**
 * D2: the two reads behind Acknowledge. `loadEarlyStarts` is the Production
 * Head's list of out-of-sequence starts nobody has acknowledged yet;
 * `loadReviewPairs` is the master-data list of step pairs the floor keeps
 * starting out of order (>= half of a job's units, minimum 3).
 */

type Ref = { kind: string; id: number };

/** Display title and pair identity (stable across a job's units) of each overridden item or skipped predecessor. */
async function describeTargets(tx: Tx, refs: Ref[]): Promise<Map<string, { title: string; pair: string }>> {
  const ids = (k: string) => [...new Set(refs.filter((r) => r.kind === k).map((r) => r.id))];
  const [steps, ops, plans] = await Promise.all([
    ids("ASSEMBLY_STEP").length
      // j5c: history (overridden items keep their titles after a re-release)
      ? tx.assemblyStep.findMany({ where: { id: { in: ids("ASSEMBLY_STEP") } }, select: { id: true, templateStepId: true, templateStep: { select: { activity: true } } } })
      : [],
    ids("COMPONENT_OP").length
      // j5c: history (overridden items keep their titles after a re-release)
      ? tx.componentOperation.findMany({ where: { id: { in: ids("COMPONENT_OP") } }, select: { id: true, operationId: true, operation: { select: { name: true } }, component: { select: { tag: true } } } })
      : [],
    ids("PROCESS_PLAN").length
      ? tx.processPlan.findMany({ where: { id: { in: ids("PROCESS_PLAN") } }, select: { id: true, jobProcessId: true, jobProcess: { select: { name: true } } } })
      : [],
  ]);
  return new Map<string, { title: string; pair: string }>([
    ...steps.map((s) => [`ASSEMBLY_STEP:${s.id}`, { title: s.templateStep.activity, pair: `AS${s.templateStepId}` }] as [string, { title: string; pair: string }]),
    ...ops.map((o) => [`COMPONENT_OP:${o.id}`, { title: `${o.component.tag} · ${o.operation.name}`, pair: `CO${o.component.tag}/${o.operationId}` }] as [string, { title: string; pair: string }]),
    ...plans.map((p) => [`PROCESS_PLAN:${p.id}`, { title: p.jobProcess.name, pair: `PP${p.jobProcessId}` }] as [string, { title: string; pair: string }]),
  ]);
}

export interface EarlyStart {
  id: number;
  jobNumber: string;
  serialNo: string;
  title: string;
  category: string;
  note: string | null;
  by: string;
  /** ISO instant the override was written. */
  at: string;
  /** Waiting more than 2 working days: it goes into the digest. */
  stale: boolean;
}

export interface EarlyStartsView {
  /** Newest first, capped at EARLY_STARTS_SHOWN. */
  pending: EarlyStart[];
  pendingTotal: number;
  staleTotal: number;
}

export const EARLY_STARTS_SHOWN = 100;

export async function loadEarlyStarts(actor: Actor, now = new Date()): Promise<EarlyStartsView> {
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD);
  return withTenant(actor.tenantId, async (tx) => {
    const where = { tenantId: actor.tenantId, ack: null };
    const [pendingTotal, rows] = await Promise.all([
      tx.sequenceOverride.count({ where }),
      tx.sequenceOverride.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: EARLY_STARTS_SHOWN,
        select: {
          id: true,
          jobId: true,
          targetKind: true,
          targetId: true,
          category: true,
          note: true,
          createdAt: true,
          creator: { select: { name: true } },
          unit: { select: { serialNo: true } },
          job: { select: { jobNumber: true, calendarId: true } },
        },
      }),
    ]);
    const [titles, calendars] = await Promise.all([
      describeTargets(tx, rows.map((r) => ({ kind: r.targetKind, id: r.targetId }))),
      resolveCalendarsForJobs(tx, [...new Map(rows.map((r) => [r.jobId, { id: r.jobId, calendarId: r.job.calendarId }])).values()]),
    ]);
    const pending = rows.map((r) => ({
      id: r.id,
      jobNumber: r.job.jobNumber,
      serialNo: r.unit?.serialNo ?? "—",
      title: titles.get(`${r.targetKind}:${r.targetId}`)?.title ?? "A step",
      category: r.category,
      note: r.note,
      by: r.creator.name,
      at: r.createdAt.toISOString(),
      stale: isAckStale(r.createdAt, now, calendars.get(r.jobId)),
    }));
    // The unacknowledged count beyond the cap is not scanned for staleness; the digest query is uncapped.
    return { pending, pendingTotal, staleTotal: pending.filter((p) => p.stale).length };
  });
}

export interface ReviewPairRow extends ReviewPair {
  jobNumber: string;
  stepTitle: string;
  skippedTitle: string;
}

/** Master-data readers: step pairs the floor keeps starting out of order, to review in the assembly sequence. */
export async function loadReviewPairs(actor: Actor): Promise<ReviewPairRow[]> {
  assertNotClientUser(actor);
  requireRole(actor, ...MASTER_DATA_READ_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const rows = await tx.sequenceOverride.findMany({
      where: { tenantId: actor.tenantId, predecessorTargetId: { not: null } },
      select: { jobId: true, unitId: true, targetKind: true, targetId: true, predecessorTargetId: true, job: { select: { jobNumber: true } } },
    });
    if (!rows.length) return [];
    const titles = await describeTargets(tx, rows.flatMap((r) => [{ kind: r.targetKind, id: r.targetId }, { kind: r.targetKind, id: r.predecessorTargetId! }]));
    const pairs: PairOverride[] = rows.flatMap((r) => {
      const a = titles.get(`${r.targetKind}:${r.targetId}`);
      const b = titles.get(`${r.targetKind}:${r.predecessorTargetId}`);
      return a && b ? [{ jobId: r.jobId, unitId: r.unitId, step: a.pair, skipped: b.pair }] : [];
    });
    const jobIds = [...new Set(pairs.map((p) => p.jobId))];
    const unitCounts = await tx.unit.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds } }, _count: { _all: true } });
    const flagged = reviewPairs(pairs, new Map(unitCounts.map((u) => [u.jobId, u._count._all])));
    // One example override per pair, to show human titles.
    const example = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const a = titles.get(`${r.targetKind}:${r.targetId}`);
      const b = titles.get(`${r.targetKind}:${r.predecessorTargetId}`);
      if (a && b && !example.has(`${r.jobId}|${a.pair}|${b.pair}`)) example.set(`${r.jobId}|${a.pair}|${b.pair}`, r);
    }
    return flagged.flatMap((f) => {
      const r = example.get(`${f.jobId}|${f.step}|${f.skipped}`);
      if (!r) return [];
      return [{ ...f, jobNumber: r.job.jobNumber, stepTitle: titles.get(`${r.targetKind}:${r.targetId}`)!.title, skippedTitle: titles.get(`${r.targetKind}:${r.predecessorTargetId}`)!.title }];
    });
  });
}

