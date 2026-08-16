"use client";

import Link from "next/link";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import { CountUp } from "@/components/industrial/count-up";
import type { CommandCenterView, CommandCenterRow } from "@/lib/services/command-center.read";
import type { PlanState } from "@/lib/services/prioritizer";

// Fixed UTC+5:30 offset — same convention myday.read.ts's istDay() /
// my-day/_client.tsx's istEpochDay() use, so server and client renders of
// "today" never disagree (Phase 2's final review caught and fixed exactly
// this hydration bug once already — see /my-day's _client.tsx).
function istEpochDay(d: Date): number {
  return Math.floor((d.getTime() + 5.5 * 3600 * 1000) / 864e5);
}

function fmtDue(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

function fmtDay(dateStr: string): { dy: string; dn: string } {
  const d = new Date(`${dateStr}T00:00:00+05:30`);
  return {
    dy: d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "Asia/Kolkata" }),
    dn: d.toLocaleDateString("en-IN", { day: "2-digit", timeZone: "Asia/Kolkata" }),
  };
}

const PLAN_STATE_LABEL: Record<PlanState, string> = {
  BLOCKED: "Blocked",
  READY: "Ready",
  IN_PROGRESS: "In progress",
  SUBMITTED: "Awaiting QC",
  ON_HOLD: "On hold",
  DONE: "Complete",
};

/** RankedPlan -> the 6-value display-status vocabulary StatusChip renders
 * (overdue always wins; BLOCKED/READY both read as "idle" — not started —
 * distinguished by the label override, not a 7th color). */
function displayStatus(r: CommandCenterRow["ranked"]): StageDisplayStatus {
  if (r.overdue) return "overdue";
  switch (r.state) {
    case "DONE": return "complete";
    case "IN_PROGRESS": return "progress";
    case "SUBMITTED": return "submitted";
    case "ON_HOLD": return "hold";
    default: return "idle"; // READY or BLOCKED
  }
}

function onTimeColor(pct: number | null): string {
  if (pct == null) return "var(--muted)";
  if (pct >= 85) return "var(--s-complete)";
  if (pct >= 75) return "var(--s-hold)";
  return "var(--s-overdue)";
}

/**
 * One ProcessPlan row, reused across Decide today / pipeline columns /
 * You're blocking / Waiting on others — same 4-column shape everywhere so
 * the eye doesn't have to re-learn a layout per section. Clickable only when
 * BOTH this actor may act (`canAct`) AND the row is unit-grain (`unitId`
 * set) — job-grain office-department rows (Engineering/Procurement/Planning
 * routinely have these) have no StageSheet to open, and MANAGEMENT's
 * read-only rule (task 3.1 ruling 3) means their click never opens a sheet
 * that could show action buttons. Same guard shape as /my-day's
 * `clickable = row.ranked.plan.unitId != null` (Phase 2 final review fixed a
 * dead-click bug there for exactly the job-grain case), `canAct` added on
 * top for the MANAGEMENT read-only rule.
 */
function CommandRow({
  row,
  canAct,
  onOpen,
  showDept,
  label,
}: {
  row: CommandCenterRow;
  canAct: boolean;
  onOpen: () => void;
  /** Show the owning department name in the subtitle — used by "You're
   * blocking" rows, whose plan belongs to a DIFFERENT department than the
   * page's own. */
  showDept?: boolean;
  /** Override the chip label (pipeline columns use the dept-vocabulary
   * label instead of the generic PlanState label). */
  label?: string;
}) {
  const clickable = canAct && row.ranked.plan.unitId != null;
  // Pipeline columns (label set) always show the dept-vocabulary label for
  // their bucket. Everywhere else, an overdue row shows the generic
  // "Overdue" chip (StatusChip's own default for that status) — the more
  // urgent signal — otherwise the generic PlanState label.
  const chipLabel = label ?? (row.ranked.overdue ? undefined : PLAN_STATE_LABEL[row.ranked.state]);
  return (
    <tr className="row" onClick={clickable ? onOpen : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)", width: 90 }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>
          {row.stageLabel}
          {showDept ? ` · ${row.deptName}` : ""}
          {row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}
        </div>
      </td>
      <td className="mono" style={{ width: 70 }}>{fmtDue(row.ranked.plan.plannedFinish)}</td>
      <td className="num" style={{ width: 140 }}>
        <StatusChip status={displayStatus(row.ranked)} label={chipLabel} />
      </td>
    </tr>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan}>
        <p className="note" style={{ margin: "12px 0" }}>{text}</p>
      </td>
    </tr>
  );
}

export function CommandCenterClient({ view, canAct }: { view: CommandCenterView; canAct: boolean }) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();
  const open = (r: CommandCenterRow) => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo);
  const todayEpoch = istEpochDay(new Date());

  return (
    <>
      <div className="grid-h">
        <div className="card ws-card">
          <div className="hd">
            <b>Decide today</b>
            <span className="meta">System-triaged · capped at 5 — the rest can wait</span>
          </div>
          {view.decideToday.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>Nothing needs a decision today — the department is caught up.</p>
          ) : (
            <table>
              <tbody>
                {view.decideToday.map((r) => (
                  <CommandRow key={r.ranked.plan.id} row={r} canAct={canAct} onOpen={() => open(r)} />
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card ws-card">
          <div className="hd">
            <b>This week</b>
            <span className="meta">Load before it lands</span>
          </div>
          <div style={{ padding: 16 }}>
            <div className="week-strip">
              {view.week.map((w) => {
                const { dy, dn } = fmtDay(w.date);
                const isToday = istEpochDay(new Date(`${w.date}T00:00:00+05:30`)) === todayEpoch;
                return (
                  <div key={w.date} className={`week-cell${isToday ? " today" : ""}`}>
                    <div className="dy">{dy}</div>
                    <div className="dn">{dn}</div>
                    <div className="ld">
                      <b>{w.loadCount}</b> due
                      {w.hotCount > 0 && <div style={{ color: "var(--s-overdue)" }}>{w.hotCount} hot</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="dept-grid">
        {view.pipeline.map((col) => (
          <div className="card ws-card" key={col.state}>
            <div className="hd">
              <b>{col.label}</b>
              <span className="chip c-idle" style={{ marginLeft: "auto" }}><i />{col.rows.length}</span>
            </div>
            {col.rows.length === 0 ? (
              <p className="note" style={{ margin: "12px 0" }}>Nothing here.</p>
            ) : (
              <table>
                <tbody>
                  {col.rows.slice(0, 6).map((r) => (
                    <CommandRow key={r.ranked.plan.id} row={r} canAct={canAct} onOpen={() => open(r)} label={col.label} />
                  ))}
                  {col.rows.length > 6 && <EmptyRow colSpan={4} text={`+${col.rows.length - 6} more`} />}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      <div className="grid-h">
        <div className="card ws-card">
          <div className="hd">
            <b style={{ color: "var(--s-overdue)" }}>You&apos;re blocking</b>
            <span className="meta">What waits on this department</span>
          </div>
          <table>
            <tbody>
              {view.blocking.length === 0 ? (
                <EmptyRow colSpan={4} text="Nothing else is waiting on this department right now." />
              ) : (
                <>
                  {view.blocking.slice(0, 6).map((r) => (
                    <CommandRow key={r.ranked.plan.id} row={r} canAct={canAct} onOpen={() => open(r)} showDept />
                  ))}
                  {view.blocking.length > 6 && <EmptyRow colSpan={4} text={`+${view.blocking.length - 6} more`} />}
                </>
              )}
            </tbody>
          </table>
        </div>

        <div className="card ws-card">
          <div className="hd">
            <b>Waiting on others</b>
            <span className="meta">Your dependencies — chase from here</span>
          </div>
          <table>
            <tbody>
              {view.waitingOnOthers.length === 0 ? (
                <EmptyRow colSpan={4} text="This department isn't waiting on anyone right now." />
              ) : (
                <>
                  {view.waitingOnOthers.slice(0, 6).map((r) => (
                    <CommandRow key={r.ranked.plan.id} row={r} canAct={canAct} onOpen={() => open(r)} />
                  ))}
                  {view.waitingOnOthers.length > 6 && <EmptyRow colSpan={4} text={`+${view.waitingOnOthers.length - 6} more`} />}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="kpis" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <Link href={`/workspace?dept=${view.kpi.id}`} className="kpi clicky" style={{ textDecoration: "none", color: "inherit" }}>
          <h6>Open items</h6>
          <div className="v mono"><CountUp value={view.kpi.openCount} /></div>
          <div className="sub">across all live jobs</div>
        </Link>
        <Link href={`/departments/${view.kpi.id}`} className="kpi clicky" style={{ textDecoration: "none", color: "inherit" }}>
          <h6>On-time</h6>
          <div className="v mono" style={{ color: onTimeColor(view.kpi.onTimePct) }}>
            {view.kpi.onTimePct == null ? "—" : <><CountUp value={view.kpi.onTimePct} /><small>%</small></>}
          </div>
          <div className="sub">of completed stages</div>
        </Link>
        <Link
          href={`/workspace?dept=${view.kpi.id}&status=overdue`}
          className={`kpi clicky${view.kpi.overdueCount > 0 ? " alert" : ""}`}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <h6>Overdue</h6>
          <div className="v mono" style={{ color: view.kpi.overdueCount > 0 ? "var(--s-overdue)" : undefined }}>
            <CountUp value={view.kpi.overdueCount} />
          </div>
          <div className="sub">needs a delay reason</div>
        </Link>
      </div>

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}
