"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { StageSheet } from "@/components/industrial/stage-sheet";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import {
  ActionSheet,
  FloorOutcomes,
  FloorUndoStack,
  NotifyBlockerButton,
  useFloorWrites,
} from "@/components/industrial/floor-actions";
import { inspectAction } from "@/app/actions/work";
import { boardFilterQuery, fmtDay, type BoardFilter } from "@/lib/shared/board";
import type { BoardView } from "@/lib/services/board.read";
import type { JobMilestones } from "@/lib/shared/milestones";
import { MilestoneStrip } from "@/components/industrial/milestone-strip";
import type { BoardCellDetail, BoardItem } from "@/lib/services/board.cell.read";

/**
 * Lean Core L2.4: the Job board. Units are rows, stages are columns, and every
 * cell prints its value. A cell is a button that opens the Stage Sheet; arrow
 * keys move between cells. Stages 1-9 fold into one column on a 25-stage job.
 * Filters are links (the URL is the state).
 */

const LEGEND: Array<[string, string, StageDisplayStatus | "oos" | "ncr"]> = [
  ["Done · date", "12 Feb", "complete"],
  ["In progress · steps done", "3/7", "progress"],
  ["Waiting for QC", "QC", "submitted"],
  ["On hold · H point open", "H", "hold"],
  ["Overdue · days late", "+2d", "overdue"],
  ["Rejected · NCR", "!", "ncr"],
  ["Out of sequence · outlined", "", "oos"],
  ["Not started · planned date", "20 Feb", "idle"],
];

export function BoardClient({
  jobId,
  view,
  filter,
  stageNos,
  unitIds,
  leanFloor,
  milestones = null,
}: {
  jobId: number;
  view: BoardView;
  filter: BoardFilter;
  stageNos: number[];
  unitIds: number[];
  leanFloor: boolean;
  /** J8: only loaded when the job has no stage list. */
  milestones?: JobMilestones | null;
}) {
  const router = useRouter();
  const grid = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<{ unitId: number; stageNo: number } | null>(null);
  const [cell, setCell] = useState<{ loading: boolean; error: string | null; data: BoardCellDetail | null }>({
    loading: false,
    error: null,
    data: null,
  });
  const [act, setAct] = useState<{ item: BoardItem; action: "DONE" | "START" } | null>(null);

  const titles = new Map<string, string>();
  const { pending, outcomes, queue, undo, dismiss } = useFloorWrites(titles);

  const collapsible = view.stages.length >= 20 && !expanded;
  const early = view.stages.filter((s) => s.stageNo <= 9).map((s) => s.stageNo);
  const shown = view.stages.filter((s) => stageNos.includes(s.stageNo));
  const cols = collapsible ? shown.filter((s) => s.stageNo > 9) : shown;
  const showEarly = collapsible && shown.some((s) => s.stageNo <= 9);
  const units = view.units.filter((u) => unitIds.includes(u.unitId));
  const q = (f: Partial<BoardFilter>) => `/jobs/${jobId}/board${boardFilterQuery({ ...filter, ...f })}`;

  const openCell = useCallback(
    async (unitId: number, stageNo: number) => {
      setOpen({ unitId, stageNo });
      setCell({ loading: true, error: null, data: null });
      try {
        const r = await fetch(`/api/jobs/${jobId}/board/cell?unit=${unitId}&stage=${stageNo}`);
        const body = await r.json();
        if (!r.ok) setCell({ loading: false, error: body?.error?.message ?? "Could not load this cell.", data: null });
        else setCell({ loading: false, error: null, data: body });
      } catch {
        setCell({ loading: false, error: "No connection. Try again.", data: null });
      }
    },
    [jobId],
  );

  // Arrow keys move between cells (roving over the rendered buttons).
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const dir = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[e.key];
    if (!dir) return;
    const el = e.currentTarget;
    const r = Number(el.dataset.row) + dir[0];
    const c = Number(el.dataset.col) + dir[1];
    const next = grid.current?.querySelector<HTMLButtonElement>(`[data-row="${r}"][data-col="${c}"]`);
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const h = view.header;
  const sel = open ? view.units.find((u) => u.unitId === open.unitId) : null;
  const selCell = open && sel ? sel.cells[open.stageNo] : null;

  return (
    <>
      <div className="page-h">
        <h1>
          <Link href={`/jobs/${jobId}`}>{h.jobNumber}</Link> · Board
        </h1>
        <span className="sub">
          {h.projectName ?? h.familyName} · {view.units.length} unit{view.units.length === 1 ? "" : "s"}
          {h.committedDeliveryDate ? ` · committed ${fmtDay(h.committedDeliveryDate)}` : ""}
          {h.forecastVarianceDays != null && h.forecastVarianceDays !== 0
            ? ` · forecast ${h.forecastVarianceDays > 0 ? "+" : "−"}${Math.abs(h.forecastVarianceDays)} d`
            : ""}
        </span>
        {/* L2.8: Assembly is not on the job tab strip; it is reached from here. */}
        <Link className="btn" style={{ marginLeft: "auto" }} href={`/jobs/${jobId}?tab=assembly`}>
          Assembly
        </Link>
      </div>

      <div className="bd-filters">
        <div className="bd-counts">
          <Link className={`chip bd-chip${filter.status === "hold" ? " on" : ""}`} href={q({ status: filter.status === "hold" ? null : "hold" })}>
            Open holds <b>{view.counts.openHolds}</b>
          </Link>
          <Link className={`chip bd-chip${filter.status === "overdue" ? " on" : ""}`} href={q({ status: filter.status === "overdue" ? null : "overdue" })}>
            Overdue <b>{view.counts.overdue}</b>
          </Link>
          <Link className={`chip bd-chip${filter.oos ? " on" : ""}`} href={q({ oos: !filter.oos })}>
            Out of sequence <b>{view.counts.outOfSequence}</b>
          </Link>
        </div>
        <div className="bd-counts">
          <Link className={`chip bd-chip${filter.dept == null ? " on" : ""}`} href={q({ dept: null })}>
            All departments
          </Link>
          {view.departments.map((d) => (
            <Link key={d.id} className={`chip bd-chip${filter.dept === d.id ? " on" : ""}`} href={q({ dept: filter.dept === d.id ? null : d.id })}>
              {d.name}
            </Link>
          ))}
          <Link className={`chip bd-chip${filter.hideDone ? " on" : ""}`} href={q({ hideDone: !filter.hideDone })}>
            Hide finished stages
          </Link>
          <a className="btn" href={`/api/jobs/${jobId}/board/export`} download>
            Export to Excel
          </a>
        </div>
      </div>

      <FloorOutcomes outcomes={outcomes} dismiss={dismiss} />

      {view.stages.length === 0 ? (
        <div className="fl-empty">
          <b>No stage list for this type of equipment yet; milestones shown instead.</b>
          {milestones && <MilestoneStrip milestones={milestones} />}
        </div>
      ) : units.length === 0 || (cols.length === 0 && !showEarly) ? (
        <div className="fl-empty">
          <b>Nothing matches these filters.</b>
          <Link className="btn" href={`/jobs/${jobId}/board`}>
            Clear filters
          </Link>
        </div>
      ) : (
        <div className="bd-scroll" ref={grid}>
          <table className="bd-grid">
            <caption className="sr-only">Units by stage. Each cell opens its stage sheet.</caption>
            <thead>
              <tr className="bd-bands">
                <th className="bd-unit" />
                {showEarly && <th className="bd-band">Stages 1–{Math.max(...early)}</th>}
                {cols.map((s) => (
                  <th key={s.stageNo} className="bd-band">
                    {s.departmentName ?? ""}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="bd-unit">Unit · current stage</th>
                {showEarly && (
                  <th className="bd-stage">
                    <button className="bd-expand" onClick={() => setExpanded(true)} aria-label="Show stages 1 to 9">
                      1–{Math.max(...early)} ›
                    </button>
                  </th>
                )}
                {cols.map((s) => (
                  <th key={s.stageNo} className="bd-stage" title={s.name}>
                    <span className="mono">{s.stageNo}</span>
                    <small>{s.name}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {units.map((u, r) => {
                const earlyDone = early.filter((n) => u.cells[n]?.status === "complete").length;
                return (
                  <tr key={u.unitId}>
                    <th className="bd-unit" scope="row">
                      <span className="mono">{u.serialNo}</span>
                      <small>{u.currentStage ? `${u.currentStage.stageNo} · ${u.currentStage.name}` : "All stages done"}</small>
                    </th>
                    {showEarly && (
                      <td>
                        <button
                          className={`bd-cell bd-s-${earlyDone === early.length ? "complete" : "progress"}`}
                          data-row={r}
                          data-col={0}
                          onKeyDown={onKey}
                          onClick={() => setExpanded(true)}
                          aria-label={`${u.serialNo}, stages 1 to ${Math.max(...early)}, ${earlyDone} of ${early.length} complete. Expand.`}
                        >
                          {earlyDone}/{early.length}
                        </button>
                      </td>
                    )}
                    {cols.map((s, c) => {
                      const cellView = u.cells[s.stageNo];
                      if (!cellView) return <td key={s.stageNo} />;
                      return (
                        <td key={s.stageNo}>
                          <button
                            className={`bd-cell bd-s-${cellView.status}${cellView.outOfSequence ? " bd-oos" : ""}${cellView.rejected ? " bd-rej" : ""}`}
                            data-row={r}
                            data-col={c + (showEarly ? 1 : 0)}
                            onKeyDown={onKey}
                            onClick={() => openCell(u.unitId, s.stageNo)}
                            aria-label={`${u.serialNo}, stage ${s.stageNo} ${s.name}: ${cellView.label}`}
                          >
                            {cellView.value}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th className="bd-unit">Units done</th>
                {showEarly && <td className="mono bd-total">—</td>}
                {cols.map((s) => (
                  <td key={s.stageNo} className="mono bd-total">
                    {s.done}/{s.total}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <ul className="bd-legend" aria-label="Legend">
        {LEGEND.map(([label, sample, kind]) => (
          <li key={label}>
            <span className={`bd-cell bd-key bd-s-${kind === "oos" || kind === "ncr" ? "idle" : kind}${kind === "oos" ? " bd-oos" : ""}${kind === "ncr" ? " bd-rej" : ""}`}>
              {sample || "·"}
            </span>
            {label}
          </li>
        ))}
      </ul>

      <FloorUndoStack pending={pending} undo={undo} />

      {open && (
        <CellSheet
          open
          onClose={() => setOpen(null)}
          unitSerial={sel?.serialNo ?? ""}
          status={(selCell?.status ?? "idle") as StageDisplayStatus}
          stageTitle={`Stage ${open.stageNo} · ${view.stages.find((s) => s.stageNo === open.stageNo)?.name ?? ""}`}
          cell={cell}
          leanFloor={leanFloor}
          onAct={(item, action) => {
            setOpen(null);
            setAct({ item, action });
          }}
          onChanged={() => {
            router.refresh();
            void openCell(open.unitId, open.stageNo);
          }}
        />
      )}

      {act && cell.data?.floorContext && act.item.floor && (
        <ActionSheet
          key={`${act.item.key}:${act.action}`}
          ctx={cell.data.floorContext}
          row={act.item.floor}
          action={act.action}
          onClose={() => setAct(null)}
          onConfirm={(label, send) => {
            setAct(null);
            queue(label, send);
          }}
        />
      )}
    </>
  );
}

function CellSheet({
  onClose,
  unitSerial,
  status,
  stageTitle,
  cell,
  leanFloor,
  onAct,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  unitSerial: string;
  status: StageDisplayStatus;
  stageTitle: string;
  cell: { loading: boolean; error: string | null; data: BoardCellDetail | null };
  leanFloor: boolean;
  onAct: (item: BoardItem, action: "DONE" | "START") => void;
  onChanged: () => void;
}) {
  const d = cell.data?.detail;
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
  return (
    <StageSheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${unitSerial} · ${stageTitle}`}
      status={status}
      meta={
        d
          ? [
              { label: "Department", value: d.deptName },
              { label: "Planned", value: `${d.plannedStart ? fmtDay(d.plannedStart) : "—"} → ${d.plannedFinish ? fmtDay(d.plannedFinish) : "—"}` },
              { label: "Started", value: d.actualStart ? when(d.actualStart) : "—" },
              { label: "Finished", value: d.actualFinish ? when(d.actualFinish) : "—" },
              ...(d.varianceDays != null ? [{ label: "Variance", value: `${d.varianceDays > 0 ? "+" : ""}${d.varianceDays} d` }] : []),
            ]
          : undefined
      }
      body={
        <>
          {cell.loading && <p className="sub">Loading…</p>}
          {cell.error && (
            <p role="alert" className="note">
              {cell.error}
            </p>
          )}
          {cell.data && (
            <>
              <h3 className="bd-h">Steps in this stage</h3>
              {cell.data.items.length === 0 ? (
                <p className="sub">No steps or operations roll up into this stage on this unit.</p>
              ) : (
                <ul className="bd-items">
                  {cell.data.items.map((it) => (
                    <ItemRow
                      key={it.key}
                      item={it}
                      unitPublicId={cell.data!.unit.publicId}
                      canAct={leanFloor && cell.data!.canRecord}
                      leanFloor={leanFloor}
                      when={when}
                      onAct={onAct}
                      onChanged={onChanged}
                    />
                  ))}
                </ul>
              )}
              {d && d.holdPoints.length > 0 && (
                <>
                  <h3 className="bd-h">Linked QCP points</h3>
                  <ul className="bd-items">
                    {d.holdPoints.map((h) => (
                      <li key={h.qcpItemId} className="bd-item">
                        <b>
                          {h.srNo} · {h.activity}
                        </b>
                        <span className="sub">
                          {h.classCode} · {h.status}
                          {h.status !== "Cleared" ? ` · ${h.ageDays} d` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {d && d.delayReasons.length > 0 && (
                <>
                  <h3 className="bd-h">Delay reasons</h3>
                  <ul className="bd-items">
                    {d.delayReasons.map((r) => (
                      <li key={r.id} className="bd-item">
                        <b>{r.category}</b>
                        <span className="sub">
                          {r.detail ? `${r.detail} · ` : ""}
                          {r.filedByName} · {when(r.filedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      }
    />
  );
}

function ItemRow({
  item,
  unitPublicId,
  canAct,
  leanFloor,
  when,
  onAct,
  onChanged,
}: {
  item: BoardItem;
  unitPublicId: string;
  canAct: boolean;
  leanFloor: boolean;
  when: (iso: string | null) => string;
  onAct: (item: BoardItem, action: "DONE" | "START") => void;
  onChanged: () => void;
}) {
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, start] = useTransition();
  const f = item.floor;
  const reported = item.reportedFinishAt ?? item.reportedStartAt;
  const recorded = item.finishedAt ?? item.startedAt;
  const lateEntry = reported && recorded && Math.abs(new Date(recorded).getTime() - new Date(reported).getTime()) > 60_000;

  const inspect = (result: "ACCEPT" | "REJECT") =>
    start(async () => {
      const r = await inspectAction({ kind: item.kind, targetId: item.id, result, ...(result === "REJECT" ? { reason: reason.trim() } : {}) });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(result === "ACCEPT" ? `${item.title} accepted.` : `${item.title} rejected. Sent back for rework.`);
        setReject(false);
        onChanged();
      }
    });

  return (
    <li className="bd-item">
      <div className="bd-item-head">
        <b>{item.title}</b>
        <span className={`chip c-${item.status === "COMPLETE" ? "complete" : item.status === "SUBMITTED" ? "submitted" : item.status === "IN_PROGRESS" ? "progress" : "idle"}`}>
          <i />
          {item.status === "COMPLETE" ? "Done" : item.status === "SUBMITTED" ? "With QC" : item.status === "IN_PROGRESS" ? "In progress" : "Not started"}
        </span>
      </div>
      <span className="sub">{item.group}</span>
      {(item.who || recorded) && (
        <span className="sub">
          {item.who ? `${item.who} · ` : ""}
          {reported ? `done ${when(reported)}` : recorded ? when(recorded) : ""}
          {lateEntry ? ` · recorded ${when(recorded)}` : ""}
        </span>
      )}
      {item.qc && (
        <span className="sub">
          {item.qc.state === "ACCEPTED" && `QC accepted${item.qc.by ? ` · ${item.qc.by}` : ""}`}
          {item.qc.state === "WAITING" && "Waiting for QC"}
          {item.qc.state === "REJECTED" && `QC rejected${item.qc.reason ? ` · ${item.qc.reason}` : ""}`}
        </span>
      )}
      {item.overrides.map((o, i) => (
        <span key={i} className="sub bd-oos-note">
          Started out of order · {o.category.replace(/_/g, " ").toLowerCase()}
          {o.note ? ` · ${o.note}` : ""} · {o.by}
        </span>
      ))}
      {f?.refusal && (f.state === "BLOCKED" || (f.state === "NEEDS_OVERRIDE" && !f.canOverride)) && (
        <div className="fl-refusal" role="note">
          <b>{f.refusal.message}</b>
          {f.refusal.clearedBy && <span>Can clear it: {f.refusal.clearedBy.label}</span>}
          {canAct && <NotifyBlockerButton unitPublicId={unitPublicId} row={{ kind: item.kind, id: item.id, refusal: f.refusal }} />}
        </div>
      )}
      {!leanFloor && (f || item.canInspect) && <span className="sub">Actions turn on with the lean floor.</span>}
      {leanFloor && (
        <div className="fl-actions">
          {canAct && f && (f.state === "READY" || f.state === "IN_PROGRESS") && (
            <>
              {f.state === "READY" && (
                <button className="btn" onClick={() => onAct(item, "START")}>
                  Start
                </button>
              )}
              <button className="btn btn-accent" onClick={() => onAct(item, "DONE")}>
                Mark done
              </button>
            </>
          )}
          {canAct && f && f.state === "NEEDS_OVERRIDE" && f.canOverride && (
            <button className="btn" onClick={() => onAct(item, "START")}>
              Start early…
            </button>
          )}
          {item.canInspect && !reject && (
            <>
              <button className="btn btn-accent" disabled={busy} onClick={() => inspect("ACCEPT")}>
                Accept
              </button>
              <button className="btn" disabled={busy} onClick={() => setReject(true)}>
                Reject…
              </button>
            </>
          )}
        </div>
      )}
      {reject && (
        <div className="bd-reject">
          <input className="ws-detail" placeholder="Why is it rejected? (required)" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
          <div className="fl-actions">
            <button className="btn" onClick={() => setReject(false)}>
              Cancel
            </button>
            <button className="btn btn-accent" disabled={busy || !reason.trim()} onClick={() => inspect("REJECT")}>
              Reject
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
