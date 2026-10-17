"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ensureJointAction, notifyBlockerAction, recordWorkAction } from "@/app/actions/work";
import type { FloorRow, FloorUnitView } from "@/lib/services/floor.read";
import type { Dict } from "@/lib/i18n";
import { useDict } from "@/lib/i18n/provider";

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
/**
 * Floor state text. Blocked and out-of-order are refusal copy: English until a
 * DESPL speaker has reviewed a translation (L2.12).
 */
export function stateLabel(d: Dict, state: FloorRow["state"]): string {
  if (state === "BLOCKED") return "Can't start yet";
  if (state === "NEEDS_OVERRIDE") return "Out of usual order";
  return d.state[state];
}

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
  const d = useDict();
  const [pending, setPending] = useState<PendingView[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const queued = useRef(new Map<string, { send: () => Promise<SendResult>; label: string; timer: ReturnType<typeof setTimeout> }>());

  const finish = useCallback(
    async (id: string, label: string, send: () => Promise<SendResult>) => {
      let out: SendResult;
      try {
        out = await send();
      } catch {
        out = { applied: 0, refused: [], error: d.outcome.noConnection };
      }
      const outcome: Outcome = {
        id,
        label,
        applied: out.applied,
        refused: out.refused.map((r) => ({
          title: titleOf.get(`${r.kind}:${r.id}`) ?? d.outcome.otherUnitStep,
          message: r.message,
        })),
        error: out.error,
        retry: out.error ? () => { setOutcomes((o) => o.filter((x) => x.id !== id)); void finish(id, label, send); } : undefined,
      };
      setOutcomes((o) => [outcome, ...o.filter((x) => x.id !== id)]);
      router.refresh();
    },
    [router, titleOf, d],
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
  const d = useDict();
  return (
    <>
      {outcomes.map((o) => (
        <div key={o.id} className={`fl-result${o.error || o.refused.length ? " fl-result-warn" : ""}`} role="status">
          <b>
            {o.error
              ? d.outcome.notSent
              : o.refused.length
                ? d.outcome.partial(o.applied, o.refused.length)
                : d.outcome.recorded(o.label)}
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
                {d.common.tryAgain}
              </button>
            )}
            <button className="btn" onClick={() => dismiss(o.id)}>
              {d.common.dismiss}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** The 10 s Undo bars. */
export function FloorUndoStack({ pending, undo }: { pending: PendingView[]; undo: (id: string) => void }) {
  const d = useDict();
  return (
    <>
      {pending.length > 0 && (
        <div className="fl-undo-stack" aria-live="polite">
          {pending.map((p) => (
            <div key={p.id} className="fl-undo">
              <span>{p.label}</span>
              <button className="btn" onClick={() => undo(p.id)}>
                {d.common.undo}
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
  const d = useDict();
  const sh = d.sheet;

  const done = action === "DONE";
  const overriding = row.state === "NEEDS_OVERRIDE";
  const needsWelder = done && !!row.weld && row.weld.existingJointId == null;
  const lateRequired = done && row.lateReasonNeeded;
  const showLate = done && (lateRequired || units.size > 0);
  const missing =
    (needsWelder && !welder ? sh.pickWelder : null) ??
    (lateRequired && category == null ? sh.pickHeldUp : null) ??
    (overriding && !why ? sh.pickWhyNow : null) ??
    (overriding && why === "OTHER" && !whyNote.trim() ? sh.sayWhy : null) ??
    (when === "earlier" && !earlier ? sh.pickTime : null);

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
    const label = (done ? d.outcome.markedDone : overriding ? d.outcome.startedEarly : d.outcome.started)(row.title, count);
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
          {done ? sh.titleDone : overriding ? sh.titleStartEarly : sh.titleStart} · {row.title}
        </h2>
        <p className="fl-sub">
          {row.group} · {ctx.serialNo}
        </p>

        {overriding && (
          <fieldset>
            <legend>{sh.whyNow}</legend>
            <div className="fl-chips">
              {ctx.overrideCategories.map((c) => (
                <button key={c} type="button" className={`fl-chip${why === c ? " on" : ""}`} onClick={() => setWhy(c)}>
                  {(d.override as Record<string, string>)[c] ?? c}
                </button>
              ))}
            </div>
            <input
              className="ws-detail"
              placeholder={why === "OTHER" ? sh.sayWhyRequired : d.common.optionalNote}
              value={whyNote}
              maxLength={500}
              onChange={(e) => setWhyNote(e.target.value)}
            />
            <p className="fl-sub">{sh.flagged}</p>
          </fieldset>
        )}

        <fieldset>
          <legend>{done ? sh.doneAt : sh.startedAt}</legend>
          <div className="fl-chips">
            <button type="button" className={`fl-chip${when === "now" ? " on" : ""}`} onClick={() => setWhen("now")}>
              {d.common.now}
            </button>
            <button type="button" className={`fl-chip${when === "earlier" ? " on" : ""}`} onClick={() => setWhen("earlier")}>
              {d.common.earlier}
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
              <p className="fl-sub">{sh.upToThreeDays}</p>
            </>
          )}
        </fieldset>

        {needsWelder && (
          <fieldset>
            <legend>{sh.welderFor(row.weld!.jointRef)}</legend>
            <select className="ws-detail" value={welder} onChange={(e) => setWelder(e.target.value)}>
              <option value="">{sh.pickWelderOption}</option>
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
              {sh.alsoFor(serials, units.size)}
            </button>
            {picker && (
              <div className="fl-units">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setUnits(units.size === sibs.length ? new Set() : new Set(sibs.map((s) => s.id)))}
                >
                  {units.size === sibs.length ? sh.clearAll : sh.selectAll}
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
                    <small>{s.status === "IN_PROGRESS" ? sh.inProgress : sh.notStarted}</small>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}

        {showLate && (
          <fieldset>
            <legend>{lateRequired ? sh.lateRequired : sh.lateOptional}</legend>
            <div className="fl-chips">
              {ctx.lateCategories.map((c) => (
                <button key={c.id} type="button" className={`fl-chip${category === c.id ? " on" : ""}`} onClick={() => setCategory(c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
            <input className="ws-detail" placeholder={d.common.optionalNote} value={lateNote} maxLength={500} onChange={(e) => setLateNote(e.target.value)} />
          </fieldset>
        )}

        <div className="fl-actions fl-sheet-foot">
          <button className="btn" onClick={onClose}>
            {d.common.cancel}
          </button>
          <button className="btn btn-accent fl-done" disabled={!!missing} onClick={submit}>
            {missing ??
              (done
                ? units.size > 0
                  ? sh.markDoneFor(units.size + 1)
                  : d.common.markDone
                : overriding
                  ? sh.startAndFlag
                  : d.common.start)}
          </button>
        </div>
      </div>
    </div>
  );
}
