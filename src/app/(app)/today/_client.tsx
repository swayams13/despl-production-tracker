"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ActionSheet,
  FloorOutcomes,
  FloorUndoStack,
  NotifyBlockerButton,
  STATE_LABEL,
  useFloorWrites,
  type SendResult,
} from "@/components/industrial/floor-actions";
import { recordWorkAction } from "@/app/actions/work";
import { fileDelayAction } from "@/app/actions/delay";
import { claimNextAction } from "@/app/actions/assignment";
import { buildCheckIn, type CheckInChoice, type CheckInRow } from "@/lib/shared/today";
import type { TodayRow, TodayView } from "@/lib/services/today.read";

/**
 * Lean Core L2.3: Today. Sections are the server's (sectionize): Do this first,
 * Today, Blocked, Upcoming and My progress (folded). Mark done opens the same
 * sheet as the Floor screen, with the same 10 s Undo. The end-of-shift
 * check-in posts only what the person changed, in one Undo.
 */

const SHOWN = 7;
/** A job-level plan has no unit: name the job instead of a dash. */
const where = (r: { unitId: number | null; serialNo: string; jobNumber: string }) => (r.unitId != null ? r.serialNo : r.jobNumber);
const fmtDue = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "not scheduled";

export function TodayClient({
  view,
  name,
  afterFour,
  dateLabel,
}: {
  view: TodayView;
  name: string;
  afterFour: boolean;
  dateLabel: string;
}) {
  const router = useRouter();
  const [sheet, setSheet] = useState<{ row: TodayRow; action: "DONE" | "START" } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [checkIn, setCheckIn] = useState(false);
  const [claiming, startClaim] = useTransition();
  const { sections: s } = view;

  const titleOf = useMemo(
    () =>
      new Map<string, string>(
        [...(s.doFirst ? [s.doFirst] : []), ...s.today, ...s.blocked, ...s.upcoming].flatMap((r) => [
          [`${r.kind}:${r.id}`, `${where(r)} · ${r.title}`] as const,
          ...r.siblings.map((x) => [`${r.kind}:${x.id}`, `${x.serialNo} · ${r.title}`] as const),
        ]),
      ),
    [s],
  );
  const { pending, outcomes, queue, undo, dismiss } = useFloorWrites(titleOf);

  const total = s.summary.assigned;
  const todayRows = showAll ? s.today : s.today.slice(0, SHOWN);
  const showCheckIn = (afterFour && view.checkIn.open.length > 0) || checkIn;

  const claim = () =>
    startClaim(async () => {
      const r = await claimNextAction();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Claimed. It is on your list.");
        router.refresh();
      }
    });

  const act = (row: TodayRow, action: "DONE" | "START") => setSheet({ row, action });

  return (
    <div className="fl-wrap">
      <header className="fl-head">
        <h1>Today</h1>
        <p>
          {dateLabel} · {name}
        </p>
        <p className="fl-dept">
          {total} assigned · {s.summary.needsAttention} needs attention · {s.summary.dueToday} due today · {s.summary.blocked} blocked
        </p>
      </header>

      <FloorOutcomes outcomes={outcomes} dismiss={dismiss} />

      {showCheckIn && (
        <CheckIn
          view={view}
          onClose={() => setCheckIn(false)}
          onSend={(label, send) => {
            setCheckIn(false);
            queue(label, send);
          }}
        />
      )}
      {!showCheckIn && view.checkIn.open.length + view.checkIn.doneToday.length > 0 && (
        <button className="btn fl-more" onClick={() => setCheckIn(true)}>
          End-of-shift check-in
        </button>
      )}

      {total === 0 ? (
        <div className="fl-empty">
          <b>Nothing is assigned to you.</b>
          {view.canClaimNext ? (
            <>
              <span>Take the next job waiting in your department.</span>
              <button className="btn btn-accent" disabled={claiming} onClick={claim}>
                Claim next
              </button>
            </>
          ) : (
            <span>{view.canAssign ? "Work assigned to you appears here. Unassigned work is in the section below." : "Ask your supervisor to assign you work."}</span>
          )}
        </div>
      ) : (
        <>
          {s.doFirst && (
            <section className="fl-group">
              <h2>Do this first</h2>
              <ul>
                <RowCard row={s.doFirst} first onAct={act} />
              </ul>
            </section>
          )}
          {s.today.length > 0 && (
            <section className="fl-group">
              <h2>Today · {s.today.length}</h2>
              <ul>
                {todayRows.map((r) => (
                  <RowCard key={r.key} row={r} onAct={act} />
                ))}
              </ul>
              {s.today.length > SHOWN && !showAll && (
                <button className="btn fl-more" onClick={() => setShowAll(true)}>
                  Show all {s.today.length}
                </button>
              )}
            </section>
          )}
          {s.blocked.length > 0 && (
            <section className="fl-group">
              <h2>Blocked · {s.blocked.length}</h2>
              <ul>
                {s.blocked.map((r) => (
                  <RowCard key={r.key} row={r} onAct={act} />
                ))}
              </ul>
            </section>
          )}
          {s.upcoming.length > 0 && (
            <details className="fl-group">
              <summary>
                <h2 style={{ display: "inline" }}>Upcoming · {s.upcoming.length}</h2>
              </summary>
              <ul>
                {s.upcoming.map((r) => (
                  <RowCard key={r.key} row={r} onAct={act} />
                ))}
              </ul>
            </details>
          )}
          {view.canClaimNext && (
            <button className="btn fl-more" disabled={claiming} onClick={claim}>
              Claim next
            </button>
          )}
        </>
      )}

      {view.canAssign && view.pool.length > 0 && (
        <p className="fl-sub" data-testid="pool">
          {view.pool.length} unassigned in your department.{" "}
          <Link href="/team" className="tm-link">
            Assign from Team
          </Link>
        </p>
      )}

      <details className="fl-group">
        <summary>
          <h2 style={{ display: "inline" }}>My progress</h2>
        </summary>
        <p className="fl-sub">
          On time, last 30 days:{" "}
          <b>{view.scoreboard.onTimePct30d == null ? "no data yet" : `${Math.round(view.scoreboard.onTimePct30d)}%`}</b> · Done this week:{" "}
          <b>{view.scoreboard.doneThisWeek}</b> · Cleared today: <b>{view.clearedToday}</b>
        </p>
      </details>

      <FloorUndoStack pending={pending} undo={undo} />

      {sheet && (
        <ActionSheet
          key={`${sheet.row.key}:${sheet.action}`}
          ctx={sheet.row.sheet}
          row={sheet.row}
          action={sheet.action}
          onClose={() => setSheet(null)}
          onConfirm={(label, send) => {
            setSheet(null);
            queue(label, send);
          }}
        />
      )}
    </div>
  );
}

function RowCard({ row, first, onAct }: { row: TodayRow; first?: boolean; onAct: (row: TodayRow, a: "DONE" | "START") => void }) {
  const stopped = row.state === "BLOCKED" || (row.state === "NEEDS_OVERRIDE" && !row.canOverride);
  const waiting = row.refusal ? row.refusal.missing.length + row.refusal.moreMissing : 0;
  return (
    <li className={`fl-row fl-s-${row.state.toLowerCase()}${first ? " fl-first" : ""}`}>
      <div className="fl-line">
        <div className="fl-main">
          <b>
            <span className="mono">{where(row)}</span> · {row.title}
          </b>
          <span>
            {row.lateReasonNeeded ? "Overdue · reason needed · " : ""}
            {STATE_LABEL[row.state]}
            {row.stage !== row.title ? ` · ${row.stage}` : ""} · due {fmtDue(row.dueAt)}
          </span>
        </div>
        {!stopped && (
          <div className="fl-actions">
            {row.state === "READY" && (
              <button className="btn" onClick={() => onAct(row, "START")}>
                Start
              </button>
            )}
            {row.state === "NEEDS_OVERRIDE" && row.canOverride && (
              <button className="btn" onClick={() => onAct(row, "START")}>
                Start early…
              </button>
            )}
            {(row.state === "READY" || row.state === "IN_PROGRESS" || row.state === "NEEDS_OVERRIDE") && (
              <button className="btn btn-accent fl-done" onClick={() => onAct(row, "DONE")}>
                Mark done
              </button>
            )}
          </div>
        )}
      </div>
      {stopped && (
        <div className="fl-refusal" role="note">
          <b>{row.refusal?.message ?? "Waiting on an earlier step."}</b>
          {row.refusal && row.refusal.missing.length > 0 && (
            <span>
              Waiting on: {row.refusal.missing.join(", ")}
              {row.refusal.moreMissing > 0 ? ` and ${row.refusal.moreMissing} more` : ""}
            </span>
          )}
          {row.state === "NEEDS_OVERRIDE" && waiting === 0 && <span>Ask your supervisor to start this early.</span>}
          {row.refusal?.clearedBy && <span>Can clear it: {row.refusal.clearedBy.label}</span>}
          {row.unitPublicId && row.kind !== "PROCESS_PLAN" && row.refusal?.clearedBy && (
            <NotifyBlockerButton unitPublicId={row.unitPublicId} row={{ kind: row.kind, id: row.id, refusal: row.refusal }} />
          )}
        </div>
      )}
    </li>
  );
}

function CheckIn({
  view,
  onClose,
  onSend,
}: {
  view: TodayView;
  onClose: () => void;
  onSend: (label: string, send: () => Promise<SendResult>) => void;
}) {
  const open = view.checkIn.open;
  const [choice, setChoice] = useState<Record<string, CheckInChoice | undefined>>({});
  const [reason, setReason] = useState<Record<string, number | undefined>>({});
  const [note, setNote] = useState<Record<string, string>>({});

  const rows: CheckInRow[] = open.map((r) => ({
    key: r.key,
    kind: r.kind,
    id: r.id,
    jobId: r.jobId,
    planId: r.planId,
    alreadyDone: false,
  }));
  const plan = buildCheckIn(rows, choice);
  const changed = plan.done.reduce((n, d) => n + d.items.length, 0) + Object.values(choice).filter((c) => c === "NOT_DONE").length;
  const lateDone = open.filter((r) => choice[r.key] === "DONE" && r.lateReasonNeeded);
  const missing =
    open.some((r) => choice[r.key] === "NOT_DONE" && reason[r.key] == null) || lateDone.some((r) => reason[r.key] == null);

  const send = () => {
    const requestIds = new Map(plan.done.map((d) => [d.jobId, crypto.randomUUID()]));
    const lateCategory = lateDone.length ? reason[lateDone[0].key] : undefined;
    const notDoneRows = open.filter((r) => choice[r.key] === "NOT_DONE" && r.planId != null);
    const doRun = async (): Promise<SendResult> => {
      let applied = 0;
      const refused: SendResult["refused"] = [];
      for (const d of plan.done) {
        const r = await recordWorkAction({
          requestId: requestIds.get(d.jobId)!,
          jobId: d.jobId,
          action: "DONE",
          items: d.items.map((i) => ({ kind: i.kind, id: i.id })),
          ...(lateCategory != null ? { lateReason: { categoryId: lateCategory } } : {}),
        });
        if (!r.ok) return { applied, refused, error: r.message };
        applied += r.result.applied.length;
        refused.push(...r.result.refused.map((x) => ({ kind: x.kind, id: x.id, message: x.message })));
      }
      const filedOn = new Set<number>();
      for (const row of notDoneRows) {
        if (filedOn.has(row.planId!)) continue;
        filedOn.add(row.planId!);
        const r = await fileDelayAction(row.planId!, reason[row.key]!, note[row.key]?.trim() || undefined);
        if (!r.ok) return { applied, refused, error: r.message };
      }
      return { applied, refused };
    };
    const doneN = plan.done.reduce((n, d) => n + d.items.length, 0);
    const notN = notDoneRows.length;
    onSend(`${doneN} marked done${notN ? ` · ${notN} held up, reason filed` : ""}`, doRun);
  };

  return (
    <section className="fl-sheet fl-checkin" aria-label="End-of-shift check-in" style={{ position: "static", borderRadius: 8, marginTop: 14 }}>
      <h2>Before you leave — today&apos;s plan</h2>
      <p className="fl-sub">
        {open.length + view.checkIn.doneToday.length} items · work you already marked is filled in
      </p>
      <ul className="fl-pool">
        {view.checkIn.doneToday.map((d) => (
          <li key={d.key} className="fl-row fl-s-ready">
            <div className="fl-line">
              <div className="fl-main">
                <b>
                  <span className="mono">{d.serialNo}</span> · {d.title}
                </b>
                <span>Done today</span>
              </div>
            </div>
          </li>
        ))}
        {open.map((r) => (
          <li key={r.key} className="fl-row">
            <div className="fl-line">
              <div className="fl-main">
                <b>
                  <span className="mono">{where(r)}</span> · {r.title}
                </b>
                <span>{STATE_LABEL[r.state]}</span>
              </div>
              <div className="fl-chips">
                <button
                  type="button"
                  className={`fl-chip${choice[r.key] === "DONE" ? " on" : ""}`}
                  onClick={() => setChoice((c) => ({ ...c, [r.key]: c[r.key] === "DONE" ? undefined : "DONE" }))}
                >
                  Done
                </button>
                <button
                  type="button"
                  className={`fl-chip${choice[r.key] === "NOT_DONE" ? " on" : ""}`}
                  onClick={() => setChoice((c) => ({ ...c, [r.key]: c[r.key] === "NOT_DONE" ? undefined : "NOT_DONE" }))}
                >
                  Not done
                </button>
              </div>
            </div>
            {(choice[r.key] === "NOT_DONE" || (choice[r.key] === "DONE" && r.lateReasonNeeded)) && (
              <fieldset className="fl-reason">
                <legend>What held it up?</legend>
                <div className="fl-chips">
                  {view.delayCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`fl-chip${reason[r.key] === c.id ? " on" : ""}`}
                      onClick={() => setReason((x) => ({ ...x, [r.key]: c.id }))}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                {choice[r.key] === "NOT_DONE" && (
                  <input
                    className="ws-detail"
                    placeholder="Add a note (optional)"
                    maxLength={500}
                    value={note[r.key] ?? ""}
                    onChange={(e) => setNote((n) => ({ ...n, [r.key]: e.target.value }))}
                  />
                )}
              </fieldset>
            )}
          </li>
        ))}
      </ul>
      {plan.notDoneWithoutPlan.length > 0 && (
        <p className="fl-sub">Some items have no process to file a reason on: they stay as they are.</p>
      )}
      <div className="fl-actions fl-sheet-foot">
        <button className="btn" onClick={onClose}>
          Not now
        </button>
        <button className="btn btn-accent fl-done" disabled={changed === 0 || missing} onClick={send}>
          {changed === 0 ? "Nothing changed" : missing ? "Pick what held it up" : `Send ${changed} update${changed === 1 ? "" : "s"}`}
        </button>
      </div>
    </section>
  );
}
