"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { STAGE_STATUS } from "./stage-status";
import { planFillStatus, computeGanttDomain, ganttPct } from "@/lib/services/gantt-layout";
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

export function JobGantt({
  data,
  onOpenStage,
}: {
  data: JobGanttData;
  onOpenStage: (unitId: number, stageNo: number) => void;
}) {
  const [selectedUnitId, setSelectedUnitId] = useState<number | null>(data.units[0]?.unitId ?? null);
  const unit = data.units.find((u) => u.unitId === selectedUnitId) ?? data.units[0] ?? null;
  const bars = useMemo(() => unit?.bars ?? [], [unit]);
  const barIndexById = useMemo(() => new Map(bars.map((b, i) => [b.jobProcessId, i])), [bars]);
  const domain = useMemo(() => computeGanttDomain(bars, data.now), [bars, data.now]);
  const months = useMemo(() => monthLabels(domain), [domain]);
  const nowPct = ganttPct(data.now, domain) ?? 0;

  const deps = useMemo(
    () =>
      data.edges
        .filter((e) => e.type === "FINISH_TO_START")
        .map((e) => ({ from: barIndexById.get(e.predecessorId), to: barIndexById.get(e.processId) }))
        .filter((d): d is { from: number; to: number } => d.from != null && d.to != null),
    [data.edges, barIndexById],
  );

  if (data.units.length === 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No current schedule for this job.</p>;
  }

  return (
    <div className="card">
      <div className="hd">
        <h3>{unit ? `Unit ${unit.serialNo} — target vs actual` : "Timeline"}</h3>
        <div className="legend">
          <span><i style={{ background: "var(--track)", height: 4 }} />Target window</span>
          <span><i style={{ background: "var(--s-complete)" }} />Done</span>
          <span><i style={{ background: "var(--s-progress)" }} />Active</span>
          <span><i style={{ background: "var(--s-overdue)" }} />Overdue</span>
        </div>
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
                  <DependencyElbow key={i} fromIndex={d.from} toIndex={d.to} bars={bars} domain={domain} />
                ))}
              </div>
              {bars.map((b) => (
                <GanttRow key={b.jobProcessId} bar={b} domain={domain} nowIso={data.now} nowPct={nowPct} onOpen={() => unit && onOpenStage(unit.unitId, b.stageNo)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
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
  nowPct: number;
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
        <div className="g-today" style={{ left: `${nowPct}%` }} />
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
  bars,
  domain,
}: {
  fromIndex: number;
  toIndex: number;
  bars: GanttBar[];
  domain: { start: number; end: number };
}) {
  const from = bars[fromIndex];
  const to = bars[toIndex];
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
