import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { KpiTile, ProgressRing, MatrixHeatmap, SCurve, MilestoneTimeline } from "@/components/viz";
import type { HeatmapCell, SCurvePoint, MilestoneItem } from "@/components/viz";

/**
 * Component gallery — a preview of the visual component set built for Day 2
 * (progress ring, KPI tile, matrix heatmap, S-curve, milestone timeline),
 * ahead of `lib/services/` existing to feed them real ProcessPlan/QcpExecution
 * data. Every number on this page is illustrative sample data, not a live
 * query — labeled as such throughout, the same discipline the original demo
 * prototype used ("DEMO PROTOTYPE · sample data").
 *
 * Delete or replace this page once the real department workspaces and
 * dashboards (BUILD-SPEC-v2 §3, §13) exist and use these components against
 * real data instead.
 */

const UNITS = ["320SR01", "320SR02", "320SR03", "320SR04", "320SR05", "320SR06", "320SR07", "320SR08", "320SR09"];

// A representative slice of the real 36-process spine (seed/lead-time-model.json),
// not the full list — enough to show the matrix/timeline forms.
const PROCESSES = [
  "PO Receipt",
  "Design Calc",
  "Mfg Drawings",
  "Plate Procurement",
  "Cutting",
  "Shell Welding",
  "Weld NDE",
  "Nozzle Welding",
  "PWHT",
  "Hydro Test",
  "Final Inspection",
  "Dispatch",
];

type CellState = { status: HeatmapCell["status"]; label: string };

// Deterministic sample matrix: each unit's frontier (how far it's progressed)
// plus one hand-placed hold/overdue case to show every status color at least
// once, matching the pattern SR03/SR06 played in design-master-prompt.md.
const FRONTIER: Record<string, number> = {
  "320SR01": 9,
  "320SR02": 8,
  "320SR03": 6,
  "320SR04": 6,
  "320SR05": 5,
  "320SR06": 4,
  "320SR07": 3,
  "320SR08": 2,
  "320SR09": 1,
};

function cellFor(unit: string, processIndex: number): CellState {
  const frontier = FRONTIER[unit];
  if (unit === "320SR06" && processIndex === frontier - 1) {
    return { status: "critical", label: "Overdue 3d — reason pending" };
  }
  if (unit === "320SR03" && processIndex === frontier - 1) {
    return { status: "serious", label: "Open TPI hold — PAUT/TOFD witness" };
  }
  if (processIndex < frontier - 1) return { status: "good", label: "Complete" };
  if (processIndex === frontier - 1) return { status: "accent", label: "In progress" };
  return { status: "neutral", label: "Not started" };
}

const SCURVE_DATA: SCurvePoint[] = [
  { label: "W1", planned: 6, actual: 5 },
  { label: "W2", planned: 14, actual: 12 },
  { label: "W3", planned: 24, actual: 20 },
  { label: "W4", planned: 35, actual: 29 },
  { label: "W5", planned: 47, actual: 38 },
  { label: "W6", planned: 58, actual: 44 },
  { label: "W7", planned: 68, actual: null },
  { label: "W8", planned: 78, actual: null },
  { label: "W9", planned: 90, actual: null },
  { label: "W10", planned: 100, actual: null },
];

const TIMELINE_ITEMS: MilestoneItem[] = PROCESSES.map((label, i) => {
  const frontier = FRONTIER["320SR03"];
  if (i < frontier - 1) return { label, status: "good" as const, date: "done" };
  if (i === frontier - 1) return { label, status: "serious" as const, date: "hold open" };
  return { label, status: "neutral" as const };
});

export default async function ComponentGalleryPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/account/password");
  if (actor.clientId !== null) redirect("/portal");

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="border-b border-[var(--hairline)] pb-5">
        <div className="inline-flex items-center gap-2 rounded-full border border-[var(--hairline)] bg-[var(--surface-sunken)] px-2.5 py-1 text-xs font-medium text-[var(--muted-fg)]">
          COMPONENT GALLERY · sample data, not live
        </div>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">Visual component set</h1>
        <p className="mt-1 text-sm text-[var(--muted-fg)]">
          KPI tile, progress ring, matrix heatmap, S-curve, milestone timeline — built against the
          data-viz skill&rsquo;s validated status/sequential palette, which happens to match{" "}
          <code className="rounded bg-[var(--surface-sunken)] px-1">docs/design-master-prompt.md</code>{" "}
          exactly. Every number below is illustrative (DESPL-320 shaped, not queried) —{" "}
          <code className="rounded bg-[var(--surface-sunken)] px-1">lib/services/</code> doesn&rsquo;t
          exist yet to populate real{" "}
          <code className="rounded bg-[var(--surface-sunken)] px-1">ProcessPlan</code> rows.
        </p>
      </header>

      <section className="mt-6">
        <h2 className="text-sm font-semibold">KPI tile</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Active jobs" value={3} />
          <KpiTile label="Units in WIP" value={9} delta={{ value: 2, period: "vs last week", upIsGood: true }} sparkline={[3, 4, 4, 5, 6, 6, 7, 9]} />
          <KpiTile label="At-risk / overdue" value={2} delta={{ value: 1, period: "vs last week", upIsGood: false }} />
          <KpiTile label="First-pass yield" value={92} suffix="%" delta={{ value: -3, period: "vs plan", upIsGood: true, suffix: "%" }} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Progress ring</h2>
        <div className="mt-2 flex flex-wrap items-center gap-6 rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-4">
          <div className="flex flex-col items-center gap-2">
            <ProgressRing value={78} tone="accent" label="320SR01 overall" />
            <span className="text-xs text-[var(--muted-fg)]">320SR01 · on plan</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <ProgressRing value={44} tone="serious" label="320SR03 overall" />
            <span className="text-xs text-[var(--muted-fg)]">320SR03 · hold open</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <ProgressRing value={30} tone="critical" label="320SR06 overall" />
            <span className="text-xs text-[var(--muted-fg)]">320SR06 · overdue</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <ProgressRing value={100} tone="good" label="320SR01 done" size={48} strokeWidth={5} />
            <span className="text-xs text-[var(--muted-fg)]">smaller size, complete</span>
          </div>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Matrix heatmap — unit × process</h2>
        <div className="mt-2">
          <MatrixHeatmap
            mode="status"
            rowHeaderLabel="Unit"
            colHeaderLabel="Process"
            rows={UNITS}
            cols={PROCESSES}
            cells={UNITS.map((unit) =>
              PROCESSES.map((process, i) => {
                const { status, label } = cellFor(unit, i);
                return { status, detail: `${unit} · ${process} — ${label}` };
              }),
            )}
          />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">S-curve — planned vs actual</h2>
        <div className="mt-2 max-w-xl">
          <SCurve data={SCURVE_DATA} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Milestone timeline — 320SR03</h2>
        <div className="mt-2">
          <MilestoneTimeline items={TIMELINE_ITEMS} />
        </div>
      </section>
    </main>
  );
}
