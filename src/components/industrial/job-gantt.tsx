"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { STAGE_STATUS } from "./stage-status";
import { planFillStatus, computeGanttDomain, computeDepartmentDeadlines, ganttPct } from "@/lib/services/gantt-layout";
import type { JobGanttData, GanttBar } from "@/lib/services/gantt-layout";

const ROW_H = 32;
const NAME_W = 190;

function monthLabels(domain: { start: number; end: number }): { label: string; pct: number }[] {
  const out: { label: string; pct: number }[] = [];
  const start = new Date(domain.start);
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor.getTime() <= domain.end) {
    out.push({
      label: cursor.toLocaleDateString("en-IN", { month: "short" }),
      pct: ((cursor.getTime() - domain.start) / (domain.end - domain.start)) * 100,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return out;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** The reference workbook's "Department Deadlines" sheet, live from the DB. */
function DepartmentDeadlines({ units }: { units: JobGanttData["units"] }) {
  const rows = useMemo(() => computeDepartmentDeadlines(units), [units]);
  if (rows.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="hd"><h3>Department deadlines</h3></div>
      <table>
        <thead>
          <tr>
            <th>Department</th>
            <th>First activity starts by</th>
            <th>Department&apos;s own work done by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr className="row" key={r.deptName}>
              <td>{r.deptName}</td>
              <td className="mono">{fmtDate(r.firstStartsBy)}</td>
              <td className="mono">{fmtDate(r.ownWorkDoneBy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type GanttRowItem = { kind: "header"; label: string } | { kind: "bar"; bar: GanttBar };

/** Groups bars by department, preserving each department's internal seq order, and orders the groups by each group's earliest seq (its first appearance in the process list). */
function groupBarsByDept(bars: GanttBar[]): GanttRowItem[] {
  const byDept = new Map<string, GanttBar[]>();
  for (const b of bars) {
    const list = byDept.get(b.deptName) ?? [];
    list.push(b);
    byDept.set(b.deptName, list);
  }
  const groups = [...byDept.entries()].sort(([, a], [, b]) => a[0].seq - b[0].seq);
  return groups.flatMap(([deptName, deptBars]) => [
    { kind: "header" as const, label: deptName },
    ...deptBars.map((bar) => ({ kind: "bar" as const, bar })),
  ]);
}

export function JobGantt({
  data,
  onOpenStage,
}: {
  data: JobGanttData;
  onOpenStage: (unitId: number, stageNo: number) => void;
}) {
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(data.units[0]?.unitId ?? null);
  const [groupByDept, setGroupByDept] = useState(false);
  const unit = data.units.find((u) => u.unitId === selectedUnitId) ?? data.units[0] ?? null;
  const bars = useMemo(() => unit?.bars ?? [], [unit]);
  const rows = useMemo<GanttRowItem[]>(
    () => (groupByDept ? groupBarsByDept(bars) : bars.map((bar) => ({ kind: "bar" as const, bar }))),
    [bars, groupByDept],
  );
  const barRowIndexById = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((r, i) => { if (r.kind === "bar") m.set(r.bar.jobProcessId, i); });
    return m;
  }, [rows]);
  const domain = useMemo(() => computeGanttDomain(bars, data.now), [bars, data.now]);
  const months = useMemo(() => monthLabels(domain), [domain]);
  const nowPct = ganttPct(data.now, domain);

  const deps = useMemo(
    () =>
      data.edges
        .filter((e) => e.type === "FINISH_TO_START")
        .map((e) => ({ from: barRowIndexById.get(e.predecessorId), to: barRowIndexById.get(e.processId) }))
        .filter((d): d is { from: number; to: number } => d.from != null && d.to != null),
    [data.edges, barRowIndexById],
  );

  if (data.units.length === 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No current schedule for this job.</p>;
  }

  return (
    <>
      <DepartmentDeadlines units={data.units} />
      <div className="card">
        <div className="hd">
          <h3>{unit ? `Unit ${unit.serialNo} — target vs actual` : "Timeline"}</h3>
          <div className="legend">
            <span><i style={{ background: "var(--track)", height: 4 }} />Target window</span>
            <span><i style={{ background: "var(--s-complete)" }} />Done</span>
            <span><i style={{ background: "var(--s-progress)" }} />Active</span>
            <span><i style={{ background: "var(--s-overdue)" }} />Overdue</span>
          </div>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 8 }}
            aria-pressed={groupByDept}
            onClick={() => setGroupByDept((g) => !g)}
          >
            {groupByDept ? "Ungroup" : "Group by department"}
          </button>
          <select
            className="btn"
            style={{ marginLeft: 8 }}
            value={selectedUnitId ?? ""}
            onChange={(e) => setSelectedUnitId(Number(e.target.value))}
            aria-label="Unit"
          >
            {data.units.map((u) => (
              <option key={u.unitId} value={u.unitId}>Unit {u.serialNo}</option>
            ))}
          </select>
        </div>
        <div className="gantt">
          {bars.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No processes scheduled for this unit.</p>
          ) : (
            <>
              <div className="g-months">
                {months.map((m, i) => (
                  <span key={i} style={{ position: "absolute", left: `${m.pct}%` }}>
                    {m.label}
                  </span>
                ))}
              </div>
              <div className="g-wrap" style={{ position: "relative" }}>
                <div
                  aria-hidden
                  style={{ position: "absolute", left: NAME_W, right: 0, top: 0, bottom: 0, pointerEvents: "none" }}
                >
                  {deps.map((d, i) => (
                    <DependencyElbow key={i} fromIndex={d.from} toIndex={d.to} rows={rows} domain={domain} />
                  ))}
                </div>
                {rows.map((r, i) =>
                  r.kind === "header" ? (
                    <div key={`h-${r.label}-${i}`} className="g-dept-header">{r.label}</div>
                  ) : (
                    <GanttRow
                      key={r.bar.jobProcessId}
                      bar={r.bar}
                      domain={domain}
                      nowIso={data.now}
                      nowPct={nowPct}
                      onOpen={() => unit && onOpenStage(unit.unitId, r.bar.stageNo)}
                    />
                  ),
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function GanttRow({
  bar,
  domain,
  nowIso,
  nowPct,
  onOpen,
}: {
  bar: GanttBar;
  domain: { start: number; end: number };
  nowIso: string;
  nowPct: number | null;
  onOpen: () => void;
}) {
  const ts = ganttPct(bar.plannedStart, domain);
  const tf = ganttPct(bar.plannedFinish, domain);
  const as = ganttPct(bar.actualStart, domain);
  const af = bar.actualFinish ? ganttPct(bar.actualFinish, domain) : nowPct;
  const fill = planFillStatus(bar.status, bar.overdue);
  const overdueDays = bar.overdue && bar.plannedFinish
    ? Math.floor((new Date(bar.actualFinish ?? nowIso).getTime() - new Date(bar.plannedFinish).getTime()) / 86400000)
    : 0;

  return (
    <div className="g-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div className="g-name" title={bar.name}>{bar.seq} · {bar.name}</div>
      <div className="g-track">
        {nowPct != null && nowPct >= 0 && nowPct <= 100 && <div className="g-today" style={{ left: `${nowPct}%` }} />}
        {ts != null && tf != null && (
          <div className="g-target" style={{ left: `${ts}%`, width: `${Math.max(0.5, tf - ts)}%` }} />
        )}
        {as != null && af != null && bar.status !== "NOT_STARTED" && (
          <div className="g-actual" style={{ left: `${as}%`, width: `${Math.max(1.5, af - as)}%`, background: STAGE_STATUS[fill].colorVar }}>
            {fill === "overdue" && overdueDays > 0 && <b>+{overdueDays}d</b>}
          </div>
        )}
      </div>
    </div>
  );
}

function DependencyElbow({
  fromIndex,
  toIndex,
  rows,
  domain,
}: {
  fromIndex: number;
  toIndex: number;
  rows: GanttRowItem[];
  domain: { start: number; end: number };
}) {
  const fromRow = rows[fromIndex];
  const toRow = rows[toIndex];
  if (fromRow.kind !== "bar" || toRow.kind !== "bar") return null;
  const from = fromRow.bar;
  const to = toRow.bar;
  const fromEnd = ganttPct(from.actualFinish ?? from.plannedFinish, domain);
  const toStart = ganttPct(to.actualStart ?? to.plannedStart, domain);
  if (fromEnd == null || toStart == null) return null;
  const fromY = fromIndex * ROW_H + ROW_H / 2;
  const toY = toIndex * ROW_H + ROW_H / 2;
  const midX = Math.max(fromEnd, toStart - 1);
  const line = (style: CSSProperties, key: string) => (
    <div key={key} style={{ position: "absolute", background: "var(--track)", opacity: 0.6, ...style }} />
  );
  return (
    <>
      {line({ left: `${fromEnd}%`, width: `calc(${midX - fromEnd}% + 1px)`, top: fromY, height: 1 }, "h1")}
      {line({ left: `${midX}%`, top: Math.min(fromY, toY), height: Math.abs(toY - fromY) || 1, width: 1 }, "v")}
      {line({ left: `${midX}%`, width: `calc(${toStart - midX}% + 1px)`, top: toY, height: 1 }, "h2")}
    </>
  );
}
