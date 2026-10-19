// Lean Core L1.3: collapse a job's per-unit plans of JOB-grain processes (D5: office processes 1-11 and
// MDR 33) into ONE unit-less plan per process.
//
//   npx tsx scripts/lean-backfill-job-grain.ts                     # dry run (default): writes nothing
//   npx tsx scripts/lean-backfill-job-grain.ts --apply             # write
//   ... --job DESPL-320        only this job number (repeatable)
//   ... --force-mixed          also collapse a process whose units are SUBMITTED / ON_HOLD mixed with others
//
// Per job, when something needs doing: set JobProcess.grain = JOB for the listed codes (one audit row each),
// then write a NEW schedule run version through persistScheduleRun (the app's own reschedule path, so the
// old run stays visible: invariant 6, and persistScheduleRun carries each unit's work into the collapsed plan
// with collapseUnitPlans). Planned dates are copied from the current run, not recomputed. A second run
// changes nothing. Run it with the owner URL (DIRECT_URL), like the other backfills; rehearse on a restored
// dump first. Superseded plans keep their delay reasons and overrides as history; the dry run counts them.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { collapseUnitPlans, isRiskyMix, JOB_GRAIN_PROCESS_CODES } from "../src/lib/shared/job-grain";

export interface ProcessChange {
  code: string;
  jobProcessId: number;
  grainChange: boolean;
  unitPlans: number;
  statuses: string[];
  risky: boolean;
  skipped: boolean;
  delayReasonsOnSuperseded: number;
}
export interface JobChange {
  jobId: number;
  tenantId: number;
  jobNumber: string;
  processes: ProcessChange[];
  plansBefore: number;
  plansAfter: number;
}
export interface JobGrainReport {
  mode: "DRY_RUN" | "APPLIED";
  jobs: JobChange[];
  totals: { jobs: number; processes: number; skippedMixed: number; plansBefore: number; plansAfter: number; delayReasonsOnSuperseded: number };
}

/** Read-only: what a run would change. */
export async function planJobGrainBackfill(prisma: PrismaClient, opts: { jobNumbers?: string[]; forceMixed?: boolean } = {}): Promise<JobChange[]> {
  const jobs = await prisma.job.findMany({
    where: opts.jobNumbers?.length ? { jobNumber: { in: opts.jobNumbers } } : {},
    select: { id: true, tenantId: true, jobNumber: true },
    orderBy: { id: "asc" },
  });
  const out: JobChange[] = [];
  for (const job of jobs) {
    const run = await prisma.scheduleRun.findFirst({ where: { jobId: job.id, isCurrent: true }, include: { processPlans: true } });
    if (!run) continue;
    const jps = await prisma.jobProcess.findMany({ where: { jobId: job.id, included: true, code: { in: [...JOB_GRAIN_PROCESS_CODES] } }, orderBy: { seq: "asc" } });
    const processes: ProcessChange[] = [];
    const before = run.processPlans.length;
    let after = before;
    for (const jp of jps) {
      const unitPlans = run.processPlans.filter((p) => p.jobProcessId === jp.id && p.unitId != null);
      const grainChange = jp.grain !== "JOB";
      if (!grainChange && unitPlans.length === 0) continue;
      const risky = isRiskyMix(unitPlans);
      const skipped = risky && !opts.forceMixed;
      const delayReasonsOnSuperseded = unitPlans.length
        ? await prisma.delayReason.count({ where: { processPlanId: { in: unitPlans.map((p) => p.id) } } })
        : 0;
      processes.push({ code: jp.code, jobProcessId: jp.id, grainChange, unitPlans: unitPlans.length, statuses: [...new Set(unitPlans.map((p) => p.status))].sort(), risky, skipped, delayReasonsOnSuperseded });
      if (!skipped && unitPlans.length > 1) after -= unitPlans.length - 1;
    }
    if (processes.length) out.push({ jobId: job.id, tenantId: job.tenantId, jobNumber: job.jobNumber, processes, plansBefore: before, plansAfter: after });
  }
  return out;
}

function totalsOf(jobs: JobChange[]): JobGrainReport["totals"] {
  const ps = jobs.flatMap((j) => j.processes);
  return {
    jobs: jobs.length,
    processes: ps.filter((p) => !p.skipped).length,
    skippedMixed: ps.filter((p) => p.skipped).length,
    plansBefore: jobs.reduce((n, j) => n + j.plansBefore, 0),
    plansAfter: jobs.reduce((n, j) => n + j.plansAfter, 0),
    delayReasonsOnSuperseded: ps.filter((p) => !p.skipped).reduce((n, p) => n + p.delayReasonsOnSuperseded, 0),
  };
}

export async function backfillJobGrain(
  prisma: PrismaClient,
  opts: { apply: boolean; jobNumbers?: string[]; forceMixed?: boolean },
): Promise<JobGrainReport> {
  const jobs = await planJobGrainBackfill(prisma, opts);
  if (opts.apply) {
    // The app's own services: loaded after DATABASE_URL is known (the CLI points it at the owner URL first).
    const { withTenant } = await import("../src/lib/db");
    const { persistScheduleRun } = await import("../src/lib/services/_shared");
    const { recordAudit } = await import("../src/lib/audit");
    for (const job of jobs) {
      const todo = job.processes.filter((p) => !p.skipped);
      if (!todo.length) continue;
      const admin = await prisma.user.findFirst({
        where: { tenantId: job.tenantId, active: true, roles: { some: { role: { code: "ADMIN" } } } },
        orderBy: { id: "asc" },
        select: { id: true, name: true, email: true },
      });
      if (!admin) throw new Error(`no active ADMIN user for tenant ${job.tenantId} (the audit actor)`);
      const actor = {
        userId: admin.id, tenantId: job.tenantId, clientId: null, name: admin.name, email: admin.email,
        roles: ["ADMIN"], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
      } as never;

      await withTenant(
        job.tenantId,
        async (tx) => {
          const run = await tx.scheduleRun.findFirstOrThrow({ where: { jobId: job.jobId, isCurrent: true }, include: { processPlans: { orderBy: { id: "asc" } } } });
          const collapsing = new Set(todo.filter((p) => p.unitPlans > 0).map((p) => p.jobProcessId));

          for (const p of todo.filter((x) => x.grainChange)) {
            await tx.jobProcess.update({ where: { id: p.jobProcessId }, data: { grain: "JOB" } });
            await recordAudit(tx, actor, {
              action: "backfill.jobGrain", entityType: "JobProcess", entityId: p.jobProcessId,
              before: { grain: "UNIT" }, after: { grain: "JOB", code: p.code }, userAgent: "scripts/lean-backfill-job-grain.ts",
            });
          }

          if (collapsing.size) {
            const seen = new Set<number>();
            const plans = run.processPlans.flatMap((pl) => {
              const copy = {
                jobProcessId: pl.jobProcessId, ownerDepartmentId: pl.ownerDepartmentId, unitId: pl.unitId,
                baselineStart: pl.baselineStart, baselineFinish: pl.baselineFinish, plannedStart: pl.plannedStart, plannedFinish: pl.plannedFinish,
              };
              if (!collapsing.has(pl.jobProcessId)) return [copy];
              if (seen.has(pl.jobProcessId)) return [];
              seen.add(pl.jobProcessId);
              return [{ ...copy, unitId: null }];
            });
            const next = await persistScheduleRun(tx, actor, {
              jobId: job.jobId, equipmentId: run.equipmentId, mode: run.mode, projectStartDate: run.projectStartDate,
              requiredDeliveryDate: run.requiredDeliveryDate, feasibility: run.feasibility, shortfallDays: run.shortfallDays,
              overrideReason: "L1.3 backfill: JOB-grain processes collapsed to one plan per job", plans,
            });
            for (const p of todo.filter((x) => x.unitPlans > 0)) {
              const old = run.processPlans.filter((pl) => pl.jobProcessId === p.jobProcessId);
              const now = next.processPlans.find((pl) => pl.jobProcessId === p.jobProcessId);
              await recordAudit(tx, actor, {
                action: "schedule.collapseJobGrain", entityType: "ProcessPlan", entityId: now?.id ?? 0,
                before: { supersededPlanIds: old.map((pl) => pl.id), statuses: old.map((pl) => pl.status), run: run.id },
                after: { status: collapseUnitPlans(old).status, run: next.id, code: p.code }, userAgent: "scripts/lean-backfill-job-grain.ts",
              });
            }
          }
        },
        { timeoutMs: 120_000 },
      );
    }
  }
  return { mode: opts.apply ? "APPLIED" : "DRY_RUN", jobs, totals: totalsOf(jobs) };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const jobNumbers = argv.flatMap((a, i) => (a === "--job" && argv[i + 1] ? [argv[i + 1]] : []));
  // Owner URL for both the reads here and the app services imported on --apply (like the other backfills).
  if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
  if (!process.env.DATABASE_URL) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(process.env.DATABASE_URL);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const report = await backfillJobGrain(prisma, { apply, jobNumbers, forceMixed: argv.includes("--force-mixed") });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `\n${report.mode}: ${report.totals.jobs} job(s), ${report.totals.processes} process(es) to collapse, ${report.totals.skippedMixed} skipped as mixed, ` +
        `plans ${report.totals.plansBefore} -> ${report.totals.plansAfter}, ${report.totals.delayReasonsOnSuperseded} delay reason(s) stay on superseded plans.` +
        (apply ? "" : " Nothing was written. Pass --apply to write."),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("lean-backfill-job-grain.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
