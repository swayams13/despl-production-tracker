"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { applySwitchOverAction } from "@/app/actions/switch-over";
import { localInput } from "@/components/industrial/floor-actions";
import type { SwitchOverView, SwitchRow } from "@/lib/services/switch-over.read";
import type { SwitchOverResult } from "@/lib/services/switch-over.service";

/**
 * Lean Core L2.10 part B. One checkbox per open item, per unit, in the order the
 * rules need. "Up to here" ticks every open item above and including a row, since
 * Excel tells you how far a unit got, not which boxes. The write is recordWork
 * DONE at the date you pick; what it refuses is listed with the reason.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isOpen = (r: SwitchRow) => r.status === "NOT_STARTED" || r.status === "IN_PROGRESS";
const STATE: Record<string, string> = { NOT_STARTED: "Not started", IN_PROGRESS: "In progress", SUBMITTED: "With QC", COMPLETE: "Done" };

export function SwitchOverClient({ view }: { view: SwitchOverView }) {
  const router = useRouter();
  const nowLocal = localInput(new Date());
  const [doneAt, setDoneAt] = useState(nowLocal);
  const other = view.lateCategories.find((c) => c.code === "OTHER") ?? view.lateCategories[0];
  const [late, setLate] = useState<number | "">(other?.id ?? "");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<SwitchOverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const all = useMemo(() => new Map(view.units.flatMap((u) => u.rows.map((r) => [r.key, { row: r, unit: u.label }] as const))), [view]);
  const min = localInput(new Date(Date.now() - 72 * 3600_000));

  const setMany = (keys: string[], on: boolean) =>
    setPicked((cur) => {
      const n = new Set(cur);
      for (const k of keys) {
        if (on) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  const openKeys = (rows: SwitchRow[]) => rows.filter(isOpen).map((r) => r.key);

  const sameOnAll = (unitIdx: number) => {
    const match = new Set(view.units[unitIdx].rows.filter((r) => picked.has(r.key)).map((r) => r.matchKey));
    setPicked((cur) => {
      const n = new Set(cur);
      view.units.forEach((u, i) => {
        if (i === unitIdx || u.unitId === null) return;
        for (const r of u.rows) if (isOpen(r) && match.has(r.matchKey)) n.add(r.key);
      });
      return n;
    });
  };

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await applySwitchOverAction({
        jobId: view.job.id,
        doneAt: new Date(doneAt).toISOString(),
        ...(late !== "" ? { lateCategoryId: late } : {}),
        items: [...picked].map((k) => ({ kind: all.get(k)!.row.kind, id: all.get(k)!.row.id })),
      });
      setConfirm(false);
      if (r.ok && r.result) {
        setResult(r.result);
        setPicked(new Set());
        toast.success(`${plural(r.result.completed + r.result.toQc, "item")} recorded.`);
        router.refresh();
        return;
      }
      const reason = !r.ok && typeof r.detail?.reason === "string" ? r.detail.reason : r.ok ? "Nothing was recorded." : r.message;
      setError(reason);
    });

  const n = picked.size;
  const when = new Date(doneAt).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

  return (
    <>
      <PageHeader title="Switch over from Excel" subtitle={`${view.job.jobNumber}${view.job.projectName ? ` · ${view.job.projectName}` : ""} · ${plural(view.open, "item")} open of ${view.total}`} />
      <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>
        Tick the work Excel already shows as done. It is recorded as done at the date below, by you, through the same rules as the floor: anything that needs QC goes to
        the QC queue, and anything the rules refuse is listed with the reason. <Link href={`/jobs/${view.job.id}`}>Back to the job</Link>
      </p>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>When was it done?</h3></div>
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 12, fontSize: "var(--fs-md, 13px)" }}>
          <label style={{ display: "grid", gap: 6 }}>
            Switch-over date and time
            <input type="datetime-local" className="ws-detail" value={doneAt} min={min} max={nowLocal} onChange={(e) => setDoneAt(e.target.value)} />
            <small style={{ color: "var(--muted)" }}>Within the last 3 working days, never in the future: the same limit as any other update. Do this on the first day.</small>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            If an item was already overdue, file the reason as
            <select className="ws-detail" value={late} onChange={(e) => setLate(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">Nothing (overdue items are refused)</option>
              {view.lateCategories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <div role="alert" className="card" style={{ marginBottom: 14, padding: 12 }}><span className="chip c-overdue"><i />{error}</span></div>}

      {result && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Recorded</h3></div>
          <div style={{ padding: "0 16px 14px", display: "grid", gap: 8, fontSize: "var(--fs-md, 13px)" }}>
            <p style={{ margin: 0 }}>
              {plural(result.completed, "item")} done · {plural(result.toQc, "item")} sent to QC to verify · {result.skipped} already done · {plural(result.refused.length, "item")} refused.
            </p>
            {result.toQc > 0 && <p style={{ margin: 0, color: "var(--muted)" }}>QC verifies those in the QC queue; until then they show as with QC, not done.</p>}
            {result.refused.some((x) => x.code === "SEQUENCE_OVERRIDE_REQUIRED") && (
              <p style={{ margin: 0, color: "var(--muted)" }}>Some items were out of order: tick the earlier items in that unit too, or use Up to here on the item.</p>
            )}
            {result.refused.length > 0 && (
              <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontSize: "var(--fs-sm, 12px)" }}>
                {result.refused.map((x) => (
                  <li key={`${x.kind}:${x.id}`}>
                    <span className="mono" style={{ color: "var(--muted)" }}>{x.unit}</span> <b>{x.title}</b>: {x.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {view.units.length === 0 || view.open === 0 ? (
        <p className="note" style={{ textAlign: "left" }}>Nothing is open on this job.</p>
      ) : (
        view.units.map((u, ui) => {
          const open = openKeys(u.rows);
          const mine = u.rows.filter((r) => picked.has(r.key)).length;
          if (open.length === 0) return null;
          return (
            <details key={u.unitId ?? "job"} className="card" style={{ marginBottom: 10 }} open={view.units.length <= 3 || mine > 0}>
              <summary style={{ cursor: "pointer", padding: "10px 16px", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <b className="mono">{u.label}</b>
                <span style={{ color: "var(--muted)", fontSize: "var(--fs-sm, 12px)" }}>{plural(open.length, "item")} open · {mine} ticked</span>
              </summary>
              <div style={{ padding: "0 16px 8px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn" onClick={() => setMany(open, true)}>Tick all</button>
                <button type="button" className="btn" onClick={() => setMany(u.rows.map((r) => r.key), false)}>Clear</button>
                {u.unitId !== null && view.units.filter((x) => x.unitId !== null).length > 1 && (
                  <button type="button" className="btn" disabled={mine === 0} onClick={() => sameOnAll(ui)}>Same on every unit</button>
                )}
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: "0 0 8px" }}>
                {u.rows.map((r, ri) => {
                  const o = isOpen(r);
                  return (
                    <li key={r.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 16px", borderTop: "1px solid var(--border)", opacity: o ? 1 : 0.6 }}>
                      <input
                        type="checkbox"
                        aria-label={`${u.label}: ${r.title}`}
                        checked={picked.has(r.key)}
                        disabled={!o}
                        onChange={(e) => setMany([r.key], e.target.checked)}
                        style={{ width: 20, height: 20 }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {r.title}
                        <small style={{ display: "block", color: "var(--muted)" }}>{r.group}</small>
                      </span>
                      <span style={{ fontSize: "var(--fs-sm, 12px)", color: "var(--muted)" }}>{STATE[r.status] ?? r.status}</span>
                      {o && (
                        <button type="button" className="btn btn-ghost" onClick={() => setMany(openKeys(u.rows.slice(0, ri + 1)), true)}>
                          Up to here
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })
      )}

      <div className="so-bar">
        <button type="button" className="btn btn-accent" disabled={n === 0 || pending || !doneAt} onClick={() => setConfirm(true)}>
          Record {plural(n, "item")} as done
        </button>
        {n > 0 && <button type="button" className="btn" onClick={() => setPicked(new Set())}>Clear all</button>}
      </div>

      {confirm && (
        <Modal
          open
          onOpenChange={(o) => !o && !pending && setConfirm(false)}
          title="Record as done?"
          footer={<ModalConfirmFooter onCancel={() => setConfirm(false)} onConfirm={submit} confirmLabel={pending ? "Recording…" : "Record"} disabled={pending} />}
        >
          <div style={{ display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
            <p style={{ margin: 0 }}>{plural(n, "item")} on {view.job.jobNumber} will be recorded as done at <b>{when}</b>, as you.</p>
            <p style={{ margin: 0, color: "var(--muted)" }}>
              Items that need QC are sent to QC, not completed. The rules can refuse some; you will see which and why. This cannot be undone from here.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
