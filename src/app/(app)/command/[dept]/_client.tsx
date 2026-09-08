"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import { CountUp } from "@/components/industrial/count-up";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { assignPlanAction } from "@/app/actions/assignment";
import { clickableRowProps } from "@/components/industrial/data-table";
import type { ActionResult } from "@/app/actions/_action";
import type { CommandCenterView, CommandCenterRow, TeamMemberRow } from "@/lib/services/command-center.read";
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
  // Pipeline columns (label set) are already grouped by that exact bucket —
  // the column header (e.g. "Ready for QCP checkpoint") says it once, so a
  // per-row chip repeating the same dept-vocabulary text is redundant and,
  // in the narrow dept-grid cards, doesn't have room to render without
  // overflowing into the neighboring column. Show it there only when the row
  // is overdue (the one per-row signal the column header can't carry), using
  // the short generic "Overdue" chip. Everywhere else (wide cards), keep the
  // full per-row label as before.
  const inPipeline = label !== undefined;
  const showChip = !inPipeline || row.ranked.overdue;
  const chipLabel = inPipeline ? undefined : row.ranked.overdue ? undefined : PLAN_STATE_LABEL[row.ranked.state];
  return (
    <tr className="row" {...clickableRowProps(clickable ? onOpen : undefined)}>
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
      <td className="num" style={{ width: 140, maxWidth: 140 }}>
        {showChip && <StatusChip status={displayStatus(row.ranked)} label={chipLabel} />}
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

/**
 * Reassign — 2-step modal (COMPONENT_INVENTORY.md's canonical shape for any
 * multi-step confirmation): step 1 picks the new owner, step 2 confirms
 * "previous → new" before calling `assignPlanAction`. Full-screen on tablet
 * via the `.admin-dialog` breakpoint rule in globals.css, not a separate
 * layout here.
 */
function ReassignModal({
  row,
  fromName,
  members,
  onClose,
  onDone,
}: {
  row: CommandCenterRow;
  fromName: string;
  members: { userId: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<1 | 2>(1);
  const [targetId, setTargetId] = useState<number | "">("");
  const target = members.find((m) => m.userId === targetId);

  const confirm = () => {
    if (targetId === "") return;
    start(async () => {
      const r: ActionResult = await assignPlanAction(row.ranked.plan.id, targetId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Reassigned.");
      onDone();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Reassign ${row.processName}`}
      footer={
        step === 1 ? (
          <button className="btn btn-accent" disabled={targetId === ""} onClick={() => setStep(2)}>Continue</button>
        ) : (
          <ModalConfirmFooter onCancel={() => setStep(1)} onConfirm={confirm} confirmLabel="Confirm reassign" disabled={pending} cancelLabel="Back" />
        )
      }
    >
      {step === 1 ? (
        <>
          <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>{row.jobNumber} · {row.stageLabel}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</p>
          <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>New owner</label>
          <select className="btn" style={{ width: "100%" }} value={targetId} onChange={(e) => setTargetId(e.target.value ? Number(e.target.value) : "")} aria-label="New owner">
            <option value="">Choose a member…</option>
            {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        </>
      ) : (
        <p style={{ fontSize: 13, margin: 0 }}>
          Reassign <b>{row.processName}</b> from <b>{fromName}</b> to <b>{target?.name}</b>?
        </p>
      )}
    </Modal>
  );
}

/** Supervisor Team's roster (Phase 4, Round 1 mockup `03`/Round 2 `05`):
 * "whose work needs a decision", grouped by employee rather than by
 * state-bucket like the sections above. Desktop/laptop: full roster with a
 * per-employee item disclosure. Tablet: same markup, but each employee's
 * load already reads as a compact stat line (openCount/overdueCount) rather
 * than a table row — no separate tablet-only component needed here since
 * this section was never a `<table>` to begin with. */
function TeamSection({ team, canAct }: { team: TeamMemberRow[]; canAct: boolean }) {
  const [reassignRow, setReassignRow] = useState<{ row: CommandCenterRow; fromName: string } | null>(null);
  const members = team.map((t) => ({ userId: t.userId, name: t.name }));

  return (
    <div className="card ws-card" style={{ marginTop: 14 }}>
      <div className="hd">
        <b>Team</b>
        <span className="meta">Whose work needs a decision</span>
      </div>
      {team.length === 0 ? (
        <p className="note" style={{ margin: "16px 0" }}>No active members in this department yet.</p>
      ) : (
        <div style={{ padding: 16, display: "grid", gap: 10 }}>
          {team.map((member) => (
            <details key={member.userId} open={member.overdueCount > 0}>
              <summary style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", listStyle: "none" }}>
                <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>
                  {member.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
                </div>
                <b style={{ fontSize: 13 }}>{member.name}</b>
                <span className="mono" style={{ color: "var(--muted)", fontSize: 11.5 }}>{member.openCount} open</span>
                {member.overdueCount > 0 && (
                  <span className="chip c-overdue"><i />{member.overdueCount} overdue</span>
                )}
              </summary>
              <div style={{ marginTop: 8, paddingLeft: 34 }}>
                {member.items.length === 0 ? (
                  <p className="note" style={{ margin: "8px 0", textAlign: "left" }}>No open items.</p>
                ) : (
                  member.items.map((item) => (
                    <div key={item.ranked.plan.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                      <span>
                        {item.processName}
                        <span style={{ color: "var(--muted)" }}> · {item.jobNumber} · {item.stageLabel}</span>
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <StatusChip status={displayStatus(item.ranked)} />
                        {canAct && (
                          <button className="btn" onClick={() => setReassignRow({ row: item, fromName: member.name })}>
                            Reassign…
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </details>
          ))}
        </div>
      )}

      {reassignRow && (
        <ReassignModal
          row={reassignRow.row}
          fromName={reassignRow.fromName}
          members={members}
          onClose={() => setReassignRow(null)}
          onDone={() => setReassignRow(null)}
        />
      )}
    </div>
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

      <TeamSection team={view.team} canAct={canAct} />

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
