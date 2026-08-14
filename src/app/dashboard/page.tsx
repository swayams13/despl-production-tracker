import { redirect } from "next/navigation";
import { getActor, ROLES, hasRole } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadJobKpis } from "@/lib/services/workspace.read";
import { KpiTile, ProgressRing, MatrixHeatmap, SCurve } from "@/components/viz";
import type { HeatmapCell } from "@/components/viz";

/**
 * Management KPI dashboard (Task 13) — MD/CEO/SJ's cross-department view of
 * DESPL-320, reading the same real ProcessPlan data the workspace (Task 10)
 * drives. Retires the component gallery's sample numbers for this audience.
 */

const STATUS_COLS = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE", "ON_HOLD"] as const;
const STATUS_LABELS: Record<(typeof STATUS_COLS)[number], string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Submitted",
  COMPLETE: "Complete",
  ON_HOLD: "On hold",
};
const HEATMAP_STATUS: Record<(typeof STATUS_COLS)[number], NonNullable<HeatmapCell["status"]>> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "accent",
  SUBMITTED: "warning",
  COMPLETE: "good",
  ON_HOLD: "serious",
};

async function pilotJobId(tenantId: number): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    return j?.id ?? null;
  });
}

export default async function Dashboard() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect("/workspace");

  const jobId = await pilotJobId(actor.tenantId);
  const kpis = jobId ? await loadJobKpis(actor, jobId) : null;
  if (!kpis) {
    return (
      <main className="mx-auto max-w-5xl px-5 py-8">
        <p className="text-sm text-[var(--muted-fg)]">No current schedule. Run <code>pnpm db:bootstrap</code>.</p>
      </main>
    );
  }

  const onTrack = kpis.totalPlans - kpis.overdue;

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <h1 className="text-lg font-semibold tracking-tight">Dashboard · DESPL-320</h1>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label="% complete" value={kpis.percentComplete} suffix="%" />
        <KpiTile label="On track" value={onTrack} />
        <KpiTile label="At-risk / overdue" value={kpis.overdue} />
        <KpiTile label="Open hold points" value={kpis.openHoldPoints} />
      </section>

      <section className="mt-8 flex flex-wrap items-center gap-6 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4">
        <div className="flex flex-col items-center gap-2">
          <ProgressRing value={kpis.percentComplete} tone="accent" label="DESPL-320 overall completion" size={96} />
          <span className="text-xs text-[var(--muted-fg)]">Overall completion · {kpis.totalPlans} plans</span>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Department × status</h2>
        <div className="mt-2">
          <MatrixHeatmap
            mode="status"
            rowHeaderLabel="Department"
            colHeaderLabel="Status"
            rows={kpis.deptMatrix.map((d) => d.department)}
            cols={STATUS_COLS.map((s) => STATUS_LABELS[s])}
            cells={kpis.deptMatrix.map((d) =>
              STATUS_COLS.map((s) => {
                const count = d.counts[s] ?? 0;
                return {
                  status: HEATMAP_STATUS[s],
                  content: count > 0 ? count : "",
                  detail: `${d.department} · ${STATUS_LABELS[s]} — ${count}`,
                };
              }),
            )}
          />
        </div>
      </section>

      {kpis.sCurve.length > 1 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Planned vs actual — plans complete by week</h2>
          <div className="mt-2 max-w-xl">
            <SCurve data={kpis.sCurve} valueSuffix="" />
          </div>
        </section>
      )}

      {kpis.delaysByCategory.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Delay reasons filed</h2>
          <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
            <table className="w-full text-sm">
              <tbody>
                {kpis.delaysByCategory.map((d) => (
                  <tr key={d.category} className="border-b border-[var(--hairline)] last:border-0">
                    <td className="px-4 py-2">{d.category}</td>
                    <td className="px-4 py-2 text-right tabular">{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
