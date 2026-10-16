"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ensureJointAction, notifyBlockerAction, recordWorkAction } from "@/app/actions/work";
import type { FloorRow, FloorUnitView } from "@/lib/services/floor.read";

/**
 * Lean Core L2.2 / L2.3: the write side shared by the Floor screen (/u/...) and
 * Today (/today). One sheet (done-at, late reason, welder, other units, early
 * start reason), one 10 s Undo queue, one outcome list.
 *
 * Undo is a delayed send: the write goes out when the bar expires, or at once
 * if the page is hidden. Closing the tab inside the 10 s can drop a write; the
 * row is then simply still not done when the page is reopened (never silent
 * wrong state). Each write carries a requestId, so a retry or a double flush
 * is idempotent (recordWork replays a request it has already recorded).
 */

export const UNDO_MS = 10_000;
export const OVERRIDE_LABEL: Record<string, string> = {
  MATERIAL_READY_EARLY: "Material or part ready early",
  CREW_OR_MACHINE_FREE: "Crew or machine free, upstream not ready",
  ACCESS_AVAILABLE_NOW: "Crane, access or space available now",
  CLIENT_PRIORITY: "Client or delivery priority",
  OTHER: "Other",
};
export const STATE_LABEL: Record<FloorRow["state"], string> = {
  READY: "Ready",
  IN_PROGRESS: "In progress",
  WITH_QC: "With QC",
  BLOCKED: "Can't start yet",
  NEEDS_OVERRIDE: "Out of usual order",
  QC_STEP: "Waiting for QC",
};

type Kind = FloorRow["kind"] | "PROCESS_PLAN";
/** What the sheet reads of a row; Today also passes plan-level rows (kind PROCESS_PLAN). */
export type SheetRow = Pick<FloorRow, "key" | "id" | "title" | "group" | "state" | "canOverride" | "weld" | "siblings" | "lateReasonNeeded"> & {
  kind: Kind;
};
export interface Outcome {
  id: string;
  label: string;
  applied: number;
  refused: Array<{ title: string; message: string }>;
  error?: string;
  retry?: () => void;
}
export interface PendingView {
  id: string;
  label: string;
}
export interface SendResult {
  applied: number;
  refused: Array<{ kind: Kind | "PROCESS_PLAN"; id: number; message: string }>;
  error?: string;
}
/** What the sheet needs about the unit a row belongs to. */
export interface SheetContext {
  jobId: number;
  serialNo: string;
  overrideCategories: FloorUnitView["overrideCategories"];
  welders: FloorUnitView["welders"];
  lateCategories: FloorUnitView["lateCategories"];
}

/** The Undo queue and outcome list. `titleOf` names a refused item as "<key>" -> text. */
export function useFloorWrites(titleOf: Map<string, string>) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingView[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const queued = useRef(new Map<string, { send: () => Promise<SendResult>; label: string; timer: ReturnType<typeof setTimeout> }>());

  const finish = useCallback(
    async (id: string, label: string, send: () => Promise<SendResult>) => {
      let out: SendResult;
      try {
        out = await send();
      } catch {
        out = { applied: 0, refused: [], error: "No connection. Nothing was sent." };
      }
      const outcome: Outcome = {
        id,
        label,
        applied: out.applied,
        refused: out.refused.map((r) => ({
          title: titleOf.get(`${r.kind}:${r.id}`) ?? "Another unit's step",
          message: r.message,
        })),
        error: out.error,
        retry: out.error ? () => { setOutcomes((o) => o.filter((x) => x.id !== id)); void finish(id, label, send); } : undefined,
      };
      setOutcomes((o) => [outcome, ...o.filter((x) => x.id !== id)]);
      router.refresh();
    },
    [router, titleOf],
  );

  const flush = useCallback(
    (id: string) => {
      const q = queued.current.get(id);
      if (!q) return;
      clearTimeout(q.timer);
      queued.current.delete(id);
      setPending((p) => p.filter((x) => x.id !== id));
      void finish(id, q.label, q.send);
    },
    [finish],
  );

  const queue = (label: string, send: () => Promise<SendResult>) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => flush(id), UNDO_MS);
    queued.current.set(id, { send, label, timer });
    setPending((p) => [...p, { id, label }]);
  };

  const undo = (id: string) => {
    const q = queued.current.get(id);
    if (q) clearTimeout(q.timer);
    queued.current.delete(id);
    setPending((p) => p.filter((x) => x.id !== id));
  };

  const dismiss = (id: string) => setOutcomes((x) => x.filter((y) => y.id !== id));

  // A clean success clears itself; a partial result or error stays until dismissed.
  useEffect(() => {
    const clean = outcomes.filter((o) => !o.error && o.refused.length === 0);
    if (clean.length === 0) return;
    const t = setTimeout(() => setOutcomes((all) => all.filter((o) => !clean.includes(o))), 5000);
    return () => clearTimeout(t);
  }, [outcomes]);

  // A hidden page sends what is waiting now; the Undo window ends with the screen.
  useEffect(() => {
    const sendAll = () => {
      for (const id of [...queued.current.keys()]) flush(id);
    };
    const onVis = () => document.visibilityState === "hidden" && sendAll();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", sendAll);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", sendAll);
    };
  }, [flush]);

  return { pending, outcomes, queue, undo, dismiss };
}

/** Outcome cards (a partial result stays until dismissed). */
export function FloorOutcomes({ outcomes, dismiss }: { outcomes: Outcome[]; dismiss: (id: string) => void }) {
  return (
    <>
      {outcomes.map((o) => (
        <div key={o.id} className={`fl-result${o.error || o.refused.length ? " fl-result-warn" : ""}`} role="status">
          <b>
            {o.error
              ? "Not sent"
              : o.refused.length
                ? `${o.applied} done · ${o.refused.length} blocked`
                : `${o.label} — recorded`}
          </b>
          {o.error && <span>{o.error}</span>}
          {o.refused.map((r, i) => (
            <span key={i}>
              {r.title}: {r.message}
            </span>
          ))}
          <div className="fl-actions">
            {o.retry && (
              <button className="btn btn-accent" onClick={o.retry}>
                Try again
              </button>
            )}
            <button className="btn" onClick={() => dismiss(o.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** The 10 s Undo bars. */
export function FloorUndoStack({ pending, undo }: { pending: PendingView[]; undo: (id: string) => void }) {
  return (
    <>
      {pending.length > 0 && (
        <div className="fl-undo-stack" aria-live="polite">
          {pending.map((p) => (
            <div key={p.id} className="fl-undo">
              <span>{p.label}</span>
              <button className="btn" onClick={() => undo(p.id)}>
                Undo
              </button>
              <i style={{ animationDuration: `${UNDO_MS}ms` }} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** "Notify QC / Stores / ..." for a blocked row; one tap, cooldown reported by the server. */
export function NotifyBlockerButton({
  unitPublicId,
  row,
}: {
  unitPublicId: string;
  row: Pick<FloorRow, "id" | "refusal"> & { kind: "COMPONENT_OP" | "ASSEMBLY_STEP" };
}) {
  const [nudge, setNudge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = row.refusal?.clearedBy;
  if (!who) return null;
  const notify = async () => {
    if (busy) return;
    setBusy(true);
    const r = await notifyBlockerAction({
      unitPublicId,
      kind: row.kind,
      id: row.id,
      role: who.role as "QC" | "STORES" | "ENGINEERING" | "PRODUCTION_HEAD",
    });
    setBusy(false);
    setNudge(r.ok ? `${who.label} has been told.` : r.message);
  };
  return (
    <button className="btn" disabled={busy || nudge != null} onClick={notify}>
      {nudge ?? `Notify ${who.label}`}
    </button>
  );
}

export function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ActionSheet({
  ctx,
  row,
  action,
  onClose,
  onConfirm,
}: {
  ctx: SheetContext;
  row: SheetRow;
  action: "DONE" | "START";
  onClose: () => void;
  onConfirm: (label: string, send: () => Promise<SendResult>) => void;
}) {
  const [when, setWhen] = useState<"now" | "earlier">("now");
  const [earlier, setEarlier] = useState("");
  const [picker, setPicker] = useState(false);
  const [units, setUnits] = useState<Set<number>>(new Set());
  const [category, setCategory] = useState<number | null>(null);
  const [lateNote, setLateNote] = useState("");
  const [welder, setWelder] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const [whyNote, setWhyNote] = useState("");

  const done = action === "DONE";
  const overriding = row.state === "NEEDS_OVERRIDE";
  const needsWelder = done && !!row.weld && row.weld.existingJointId == null;
  const lateRequired = done && row.lateReasonNeeded;
  const showLate = done && (lateRequired || units.size > 0);
  const missing =
    (needsWelder && !welder ? "Pick the welder" : null) ??
    (lateRequired && category == null ? "Pick what held it up" : null) ??
    (overriding && !why ? "Pick why now" : null) ??
    (overriding && why === "OTHER" && !whyNote.trim() ? "Say why" : null) ??
    (when === "earlier" && !earlier ? "Pick the time" : null);

  const now = new Date();
  const min = localInput(new Date(now.getTime() - 72 * 3600_000));
  const max = localInput(now);
  const sibs = row.siblings;
  const serials = sibs.length ? `${sibs[0].serialNo}–${sibs[sibs.length - 1].serialNo}` : "";

  const submit = () => {
    if (missing) return;
    const requestId = crypto.randomUUID();
    const reportedAt = when === "earlier" && earlier ? new Date(earlier).toISOString() : undefined;
    const chosen = sibs.filter((s) => units.has(s.id));
    const count = 1 + chosen.length;
    const verb = done ? "marked done" : overriding ? "started early" : "started";
    const label = `${row.title} ${verb}${count > 1 ? ` on ${count} units` : ""}`;
    const send = async (): Promise<SendResult> => {
      const items: Array<{ kind: Kind; id: number; detail?: { weldJointId?: number; performedByWelderId?: number } }> = [
        { kind: row.kind, id: row.id },
        ...chosen.map((s) => ({ kind: row.kind, id: s.id })),
      ];
      if (needsWelder || (done && row.weld)) {
        const j = await ensureJointAction({ assemblyStepId: row.id, welderIds: welder ? [Number(welder)] : undefined });
        if (!j.ok) return { applied: 0, refused: [], error: j.message };
        items[0].detail = { weldJointId: j.weldJointId, ...(welder ? { performedByWelderId: Number(welder) } : {}) };
      }
      const r = await recordWorkAction({
        requestId,
        jobId: ctx.jobId,
        action,
        ...(reportedAt ? { reportedAt } : {}),
        items,
        ...(overriding && why
          ? { override: { category: why as "MATERIAL_READY_EARLY", ...(whyNote.trim() ? { note: whyNote.trim() } : {}) } }
          : {}),
        ...(category != null ? { lateReason: { categoryId: category, ...(lateNote.trim() ? { note: lateNote.trim() } : {}) } } : {}),
      });
      if (!r.ok) return { applied: 0, refused: [], error: r.message };
      return {
        applied: r.result.applied.length,
        refused: r.result.refused.map((x) => ({ kind: x.kind, id: x.id, message: x.message })),
      };
    };
    onConfirm(label, send);
  };

  return (
    <div className="fl-sheet-ov" onClick={onClose}>
      <div className="fl-sheet" role="dialog" aria-label={row.title} onClick={(e) => e.stopPropagation()}>
        <h2>
          {done ? "Mark done" : overriding ? "Start early" : "Start"} · {row.title}
        </h2>
        <p className="fl-sub">
          {row.group} · {ctx.serialNo}
        </p>

        {overriding && (
          <fieldset>
            <legend>Why now?</legend>
            <div className="fl-chips">
              {ctx.overrideCategories.map((c) => (
                <button key={c} type="button" className={`fl-chip${why === c ? " on" : ""}`} onClick={() => setWhy(c)}>
                  {OVERRIDE_LABEL[c] ?? c}
                </button>
              ))}
            </div>
            <input
              className="ws-detail"
              placeholder={why === "OTHER" ? "Say why (required)" : "Add a note (optional)"}
              value={whyNote}
              maxLength={500}
              onChange={(e) => setWhyNote(e.target.value)}
            />
            <p className="fl-sub">This is flagged for the Production Head. Nothing waits for approval.</p>
          </fieldset>
        )}

        <fieldset>
          <legend>{done ? "Done at" : "Started at"}</legend>
          <div className="fl-chips">
            <button type="button" className={`fl-chip${when === "now" ? " on" : ""}`} onClick={() => setWhen("now")}>
              Now
            </button>
            <button type="button" className={`fl-chip${when === "earlier" ? " on" : ""}`} onClick={() => setWhen("earlier")}>
              Earlier
            </button>
          </div>
          {when === "earlier" && (
            <>
              <input
                type="datetime-local"
                className="ws-detail"
                min={min}
                max={max}
                value={earlier}
                onChange={(e) => setEarlier(e.target.value)}
              />
              <p className="fl-sub">You can record up to 3 days back.</p>
            </>
          )}
        </fieldset>

        {needsWelder && (
          <fieldset>
            <legend>Welder for {row.weld!.jointRef}</legend>
            <select className="ws-detail" value={welder} onChange={(e) => setWelder(e.target.value)}>
              <option value="">Pick the welder…</option>
              {ctx.welders.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.employeeCode}
                </option>
              ))}
            </select>
          </fieldset>
        )}

        {sibs.length > 0 && done && (
          <fieldset>
            <button type="button" className="btn" onClick={() => setPicker((v) => !v)} aria-expanded={picker}>
              Also for {serials}
              {units.size > 0 ? ` (${units.size})` : ""}
            </button>
            {picker && (
              <div className="fl-units">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setUnits(units.size === sibs.length ? new Set() : new Set(sibs.map((s) => s.id)))}
                >
                  {units.size === sibs.length ? "Clear all" : "Select all"}
                </button>
                {sibs.map((s) => (
                  <label key={s.id} className="fl-unit">
                    <input
                      type="checkbox"
                      checked={units.has(s.id)}
                      onChange={() => {
                        const n = new Set(units);
                        if (n.has(s.id)) n.delete(s.id);
                        else n.add(s.id);
                        setUnits(n);
                      }}
                    />
                    <span className="mono">{s.serialNo}</span>
                    <small>{s.status === "IN_PROGRESS" ? "in progress" : "not started"}</small>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {showLate && (
          <fieldset>
            <legend>{lateRequired ? "This is late. What held it up?" : "If any of these are late, what held them up?"}</legend>
            <div className="fl-chips">
              {ctx.lateCategories.map((c) => (
                <button key={c.id} type="button" className={`fl-chip${category === c.id ? " on" : ""}`} onClick={() => setCategory(c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
            <input className="ws-detail" placeholder="Add a note (optional)" value={lateNote} maxLength={500} onChange={(e) => setLateNote(e.target.value)} />
          </fieldset>
        )}

        <div className="fl-actions fl-sheet-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent fl-done" disabled={!!missing} onClick={submit}>
            {missing ??
              (done
                ? units.size > 0
                  ? `Mark done for ${units.size + 1} units`
                  : "Mark done"
                : overriding
                  ? "Start and flag for Production Head"
                  : "Start")}
          </button>
        </div>
      </div>
    </div>
  );
}
