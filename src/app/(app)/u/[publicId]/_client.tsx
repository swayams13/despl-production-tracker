"use client";

import { useMemo, useState } from "react";
import { StageSpine } from "@/components/industrial/stage-spine";
import {
  ActionSheet,
  FloorOutcomes,
  HeatPickButton,
  NotifyBlockerButton,
  RaiseRuleNcrButton,
  stateLabel,
  useFloorWrites,
} from "@/components/industrial/floor-actions";
import type { FloorRow, FloorUnitView } from "@/lib/services/floor.read";
import { useDict } from "@/lib/i18n/provider";

/**
 * Lean Core L2.2: the Floor screen. One decision per row: Done (or Start), a
 * sheet only when something must be asked (done-at time, a late reason, a
 * welder, other units). Success is a 10 s Undo bar, never a confirm dialog.
 *
 * Undo is a delayed send: the write goes out when the bar expires, or at once
 * if the page is hidden. Closing the tab inside the 10 s can drop a write; the
 * row is then simply still not done when the page is reopened (never silent
 * wrong state). Each write carries a requestId, so a retry or a double flush
 * is idempotent (recordWork replays a request it has already recorded).
 */

const VISIBLE = 5;

export function FloorClient({ view }: { view: FloorUnitView }) {
  const [sheet, setSheet] = useState<{ row: FloorRow; action: "DONE" | "START" } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const d = useDict();

  const titleOf = useMemo(
    () =>
      new Map<string, string>(
        view.rows.flatMap((r) => [
          [`${r.kind}:${r.id}`, r.title] as const,
          ...r.siblings.map((s) => [`${r.kind}:${s.id}`, `${s.serialNo} · ${r.title}`] as const),
        ]),
      ),
    [view.rows],
  );
  const { outcomes, commit, dismiss, busy } = useFloorWrites(titleOf);

  const rows = showAll ? view.rows : view.rows.slice(0, VISIBLE);
  const hidden = view.rows.length - rows.length;
  const groups: Array<{ title: string; rows: FloorRow[] }> = [];
  for (const r of rows) {
    const g = groups.find((x) => x.title === r.group);
    if (g) g.rows.push(r);
    else groups.push({ title: r.group, rows: [r] });
  }

  return (
    <div className="fl-wrap">
      <header className="fl-head">
        <h1 className="mono">{view.unit.serialNo}</h1>
        <p>
          {view.unit.jobNumber}
          {view.unit.projectName ? ` · ${view.unit.projectName}` : ""} · {view.unit.equipmentName}
        </p>
        {view.spine.length > 0 && <StageSpine variant="mini" segments={view.spine} />}
        <p className="fl-dept">
          {view.departments.length ? d.floor.nextFor(view.departments.join(" / ")) : d.floor.nextAll}
          {view.doneCount > 0 ? d.floor.doneCount(view.doneCount) : ""}
        </p>
      </header>

      <FloorOutcomes outcomes={outcomes} dismiss={dismiss} />

      {view.rows.length === 0 ? (
        <div className="fl-empty">
          <b>{d.floor.nothingWaiting}</b>
          <span>{view.doneCount > 0 ? d.floor.allDone : d.floor.noneAssigned}</span>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.title} className="fl-group">
            <h2>{g.title}</h2>
            <ul>
              {g.rows.map((r) => (
                <FloorRowView
                  key={r.key}
                  row={r}
                  canRecord={view.canRecord}
                  unitPublicId={view.unit.publicId}
                  bomRevisionNo={view.bomRevisionNo}
                  busy={busy(r.key)}
                  onAct={(action) => setSheet({ row: r, action })}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {hidden > 0 && (
        <button className="btn fl-more" onClick={() => setShowAll(true)}>
          {d.floor.showMore(hidden)}
        </button>
      )}

      {sheet && (
        <ActionSheet
          key={`${sheet.row.key}:${sheet.action}`}
          ctx={{
            jobId: view.unit.jobId,
            serialNo: view.unit.serialNo,
            overrideCategories: view.overrideCategories,
            welders: view.welders,
            lateCategories: view.lateCategories,
          }}
          row={sheet.row}
          action={sheet.action}
          onClose={() => setSheet(null)}
          onConfirm={(label, send, keys) => {
            setSheet(null);
            commit(label, send, keys);
          }}
        />
      )}
    </div>
  );
}

function FloorRowView({
  row,
  canRecord,
  unitPublicId,
  bomRevisionNo,
  busy,
  onAct,
}: {
  row: FloorRow;
  canRecord: boolean;
  unitPublicId: string;
  /** J5c: the BOM revision a flagged row changed in. */
  bomRevisionNo: number | null;
  /** A write for this row is sending or refreshing: its buttons are off. */
  busy: boolean;
  onAct: (action: "DONE" | "START") => void;
}) {
  const d = useDict();
  const others = row.siblings.length;
  // An out-of-order row is a normal choice, not a stop: one line, no card (a card is for HARD stops).
  const openEarlier = row.refusal ? row.refusal.missing.length + row.refusal.moreMissing : 0;
  const refusal = row.state === "NEEDS_OVERRIDE" ? null : row.refusal;

  return (
    <li className={`fl-row fl-s-${row.state.toLowerCase()}`}>
      <div className="fl-line">
        <div className="fl-main">
          <b>{row.title}</b>
          <span>
            {stateLabel(d, row.state)}
            {row.state === "NEEDS_OVERRIDE" && openEarlier > 0 ? ` · ${openEarlier} earlier step${openEarlier === 1 ? "" : "s"} still open` : ""}
            {row.state === "NEEDS_OVERRIDE" && !row.canOverride ? " · ask your supervisor to start it early" : ""}
            {row.startedAt ? d.floor.startedAt(new Date(row.startedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })) : ""}
            {row.qty ? ` · ${row.qty.done} of ${row.qty.planned} done` : ""}
            {others > 0 && (row.state === "READY" || row.state === "IN_PROGRESS") ? d.floor.alsoOnOthers(others) : ""}
          </span>
          {row.returnedNote != null && <span className="fl-returned">{d.floor.returnedByQc(row.returnedNote)}</span>}
          {row.needsReview && <span className="fl-returned">{d.floor.needsReview(bomRevisionNo)}</span>}
        </div>
        {canRecord && (row.state === "READY" || row.state === "IN_PROGRESS") && (
          <div className="fl-actions">
            {row.state === "READY" && (
              <button className="btn" disabled={busy} onClick={() => onAct("START")}>
                {d.common.start}
              </button>
            )}
            <button className="btn btn-accent fl-done" disabled={busy} onClick={() => onAct("DONE")}>
              {d.common.done}
            </button>
          </div>
        )}
        {canRecord && row.state === "NEEDS_OVERRIDE" && row.canOverride && (
          <button className="btn" disabled={busy} onClick={() => onAct("START")}>
            {d.common.startEarly}
          </button>
        )}
      </div>
      {refusal && (
        <div className="fl-refusal" role="note">
          <b>{refusal.message}</b>
          {refusal.missing.length > 0 && (
            <span>
              Not done yet: {refusal.missing.join(", ")}
              {refusal.moreMissing > 0 ? ` and ${refusal.moreMissing} more` : ""}
            </span>
          )}
          {refusal.clearedBy && <span>Can clear it: {refusal.clearedBy.label}</span>}
          {canRecord && row.heatComponentId != null && <HeatPickButton componentId={row.heatComponentId} />}
          {canRecord && <NotifyBlockerButton unitPublicId={unitPublicId} row={row} />}
          <RaiseRuleNcrButton row={row} />
        </div>
      )}
    </li>
  );
}
