"use client";

import Link from "next/link";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { DeptDetail } from "@/lib/services/departments.read";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Raw ProcessPlanStatus + the derived overdue flag → the display vocabulary (never raw enums in the UI). */
function toDisplayStatus(status: string, overdue: boolean): StageDisplayStatus {
  if (overdue && status !== "COMPLETE") return "overdue";
  switch (status) {
    case "COMPLETE":
      return "complete";
    case "SUBMITTED":
      return "submitted";
    case "ON_HOLD":
      return "hold";
    case "IN_PROGRESS":
      return "progress";
    default:
      return "idle";
  }
}

export function DepartmentDetailClient({ dept, commandCenterCode }: { dept: DeptDetail; commandCenterCode: string | null }) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();
  const maxCycle = Math.max(1, ...dept.cycleTime.flatMap((c) => [c.standardDays, c.avgActualDays]));
  const maxReasons = Math.max(1, ...dept.reasonBreakdown.map((r) => r.count));

  return (
    <>
      <div className="page-h">
        <h1>{dept.name}</h1>
        <span className="sub">{dept.representative ?? "No supervisor assigned"} · representative</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14, alignItems: "center" }}>
          {commandCenterCode && (
            <Link href={`/command/${commandCenterCode}`} className="sub">
              Command Center →
            </Link>
          )}
          <Link href="/departments" className="btn btn-ghost">← All departments</Link>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Open items</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{dept.openItems.length} · click a row to open the stage panel</span>
        </div>
        {dept.openItems.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing open for this department.</p>
        ) : (
          <table>
            <thead><tr><th>Job</th><th>Unit</th><th>Process</th><th>Status</th><th className="num">Due</th></tr></thead>
            <tbody>
              {dept.openItems.map((it) => (
                <tr
                  key={it.planId}
                  className="row"
                  style={{ cursor: "pointer" }}
                  onClick={() => openStage(it.jobId, it.unitId, it.stageNo)}
                >
                  <td className="mono">{it.jobNumber}</td>
                  <td className="mono" style={{ color: "var(--muted)" }}>{it.serialNo}</td>
                  <td>{it.processName}</td>
                  <td><StatusChip status={toDisplayStatus(it.status, it.overdue)} /></td>
                  <td className="num mono" style={{ color: it.overdue ? "var(--s-overdue)" : "var(--muted)" }}>{fmtDate(it.plannedFinish)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid-h">
        <div className="card">
          <div className="hd">
            <h3>Cycle time vs standard</h3>
            <div className="legend">
              <span><i style={{ background: "var(--track)", height: 4 }} />Standard</span>
              <span><i style={{ background: "var(--s-progress)" }} />Actual</span>
            </div>
          </div>
          {dept.cycleTime.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No completed processes for this department yet.</p>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {dept.cycleTime.map((c) => (
                <div className="gbar-row" key={c.processName}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.processName}</span>
                  <div className="gbar">
                    <i className="std" style={{ width: `${(c.standardDays / maxCycle) * 100}%` }} />
                    <i style={{ width: `${(c.avgActualDays / maxCycle) * 100}%`, background: c.deltaDays > 0 ? "var(--s-overdue)" : "var(--s-progress)", opacity: 0.6 }} />
                  </div>
                  <span className="mono num" style={{ color: c.deltaDays > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
                    {c.deltaDays > 0 ? `+${c.deltaDays}d` : c.deltaDays < 0 ? `${c.deltaDays}d` : "on std"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="hd"><h3>Filed delay reasons</h3></div>
          {dept.reasonBreakdown.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No delay reasons filed for this department.</p>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {dept.reasonBreakdown.map((r) => (
                <div className="gbar-row" key={r.category}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.category}</span>
                  <div className="gbar">
                    <i style={{ width: `${(r.count / maxReasons) * 100}%`, background: "var(--s-hold)", opacity: 0.7 }} />
                  </div>
                  <span className="mono num">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}
