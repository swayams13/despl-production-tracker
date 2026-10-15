"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveRouteDraftAction } from "@/app/actions/master-data";
import type { Finding } from "@/lib/services/master-data.readiness";
import type { PartFamilyDetail } from "@/lib/services/master-data.read";
import { BASIS_OPTIONS, FIELD_LABEL } from "../_labels";
import {
  isDirty, moveRow, newRow, problemsFromFindings, renumberBy10, rowsFromSteps, toInput, validateRows,
  type EditorRow, type RowProblem, type SourceStep,
} from "./_step-model";

type Reference = PartFamilyDetail["reference"];

/**
 * Full-width edit mode for one variant: one save for the whole variant, so it is
 * one transaction and one audit row (`saveRouteDraft` replaces the variant).
 * Red = the save would be refused; amber ▲ = saves, but blocks approval.
 */
export function StepEditor({
  partFamilyId,
  variant,
  scope,
  steps,
  signature,
  blockers: knownBlockers,
  warnings: knownWarnings,
  reference,
  canRevise,
  onRevise,
  onClose,
  onSaved,
}: {
  partFamilyId: number;
  variant: string;
  scope: "PV" | "HE" | "BOTH";
  steps: SourceStep[];
  /** `signature` of the variant as loaded ("[]" for a route that does not exist yet). */
  signature: string;
  /** Approval blockers on the saved version (amber on their cell). */
  blockers: Finding[];
  /** Things to check that do not block (a tooltip only, so the grid stays calm). */
  warnings: Finding[];
  reference: Reference;
  canRevise: boolean;
  onRevise: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = useMemo(() => rowsFromSteps(steps), [steps]);
  const [rows, setRows] = useState<EditorRow[]>(() => (initial.length > 0 ? initial : [newRow([])]));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saving, startSaving] = useTransition();
  const [clientProblems, setClientProblems] = useState<RowProblem[]>([]);
  const [serverProblems, setServerProblems] = useState<RowProblem[]>([]);
  const [banner, setBanner] = useState<{ kind: "stale" | "revise" | "error"; text: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const focusKey = useRef<string | null>(null);

  const dirty = isDirty(rows, initial.length > 0 ? initial : []);
  const wantPv = scope === "PV" || scope === "BOTH";
  const wantHe = scope === "HE" || scope === "BOTH";

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  useEffect(() => {
    if (!focusKey.current) return;
    document.getElementById(`ed-${focusKey.current}-operation`)?.focus();
    focusKey.current = null;
  }, [rows.length]);

  // Approval blockers already known for the saved version, placed on their cells.
  const blockerProblems = useMemo(
    () => problemsFromFindings(rows, knownBlockers.filter((f) => f.variant === variant)),
    [rows, knownBlockers, variant],
  );
  const warningProblems = useMemo(
    () => problemsFromFindings(rows, knownWarnings.filter((f) => f.variant === variant)),
    [rows, knownWarnings, variant],
  );
  const refusals = new Map<string, string>();
  for (const p of [...clientProblems, ...serverProblems]) refusals.set(`${p.key}:${p.field}`, p.message);
  const blockers = new Map<string, string>();
  for (const p of blockerProblems) if (!refusals.has(`${p.key}:${p.field}`)) blockers.set(`${p.key}:${p.field}`, p.message);
  const warns = new Map<string, string>();
  for (const p of warningProblems) warns.set(`${p.key}:${p.field}`, p.message);

  const update = (key: string, patch: Partial<EditorRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setClientProblems((ps) => ps.filter((p) => p.key !== key));
    setServerProblems((ps) => ps.filter((p) => p.key !== key));
  };
  const addAfter = (index: number) =>
    setRows((rs) => {
      const r = newRow(rs);
      focusKey.current = r.key;
      const next = [...rs];
      next.splice(index + 1, 0, r);
      return next;
    });

  const pickOperation = (r: EditorRow, code: string) => {
    const op = reference.operations.find((o) => o.code === code);
    update(r.key, {
      operationCode: code,
      // Pre-fill what the operation normally means; the editor can still change both.
      department: r.department || op?.defaultDepartment || "",
      pvStage: wantPv && r.pvStage === "" && op?.defaultPvStage != null ? String(op.defaultPvStage) : r.pvStage,
    });
  };

  const save = () => {
    const problems = validateRows(rows);
    setClientProblems(problems);
    setBanner(null);
    if (problems.length > 0) {
      toast.error(`${problems.length} thing${problems.length === 1 ? "" : "s"} to fix before this can be saved.`);
      return;
    }
    startSaving(async () => {
      const r = await saveRouteDraftAction({ partFamilyId, variant, steps: toInput(rows), baseSignature: signature });
      if (r.ok) {
        const blocked = r.readiness?.blockers.length ?? 0;
        toast.success(
          blocked > 0
            ? `Draft v${r.version} saved. ${blocked} thing${blocked === 1 ? "" : "s"} still to fix before approval.`
            : `Draft v${r.version} saved.`,
        );
        onSaved();
        return;
      }
      if (r.code === "STALE_WRITE") {
        setBanner({ kind: "stale", text: r.message ? "Someone else changed this variant while you were editing. Reload to see their version; your edits stay here until you do." : "" });
        return;
      }
      if (r.code === "REVISE_REQUIRED") {
        setBanner({ kind: "revise", text: r.message });
        return;
      }
      const detail = r.detail as { findings?: Finding[]; reason?: string; issues?: Array<{ message: string }> } | undefined;
      if (detail?.findings) setServerProblems(problemsFromFindings(rows, detail.findings));
      const reason = detail?.reason ?? detail?.issues?.map((i) => i.message).join(" ") ?? r.message;
      setBanner({ kind: "error", text: reason });
    });
  };

  const discard = () => (dirty ? setConfirmDiscard(true) : onClose());

  const cell = (r: EditorRow, field: keyof typeof FIELD_LABEL) => {
    const refused = refusals.get(`${r.key}:${field}`);
    const blocked = blockers.get(`${r.key}:${field}`);
    return {
      title: refused ?? blocked ?? warns.get(`${r.key}:${field}`),
      "aria-invalid": refused ? true : undefined,
      style: {
        outline: refused ? "1px solid var(--s-overdue)" : blocked ? "1px solid var(--s-hold)" : undefined,
      } as React.CSSProperties,
    };
  };

  return (
    <div
      className="card"
      style={{ marginBottom: 14 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") discard();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      }}
    >
      <div className="hd" style={{ gap: 8, flexWrap: "wrap" }}>
        <h3>Editing variant {variant}</h3>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={() => setRows((rs) => renumberBy10(rs))}>
            Renumber by 10
          </button>
          <button type="button" className="btn" onClick={discard} disabled={saving}>
            Discard
          </button>
          <button type="button" className="btn btn-accent" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save draft"}
          </button>
        </div>
      </div>

      {confirmDiscard && (
        <div style={{ padding: "0 16px 12px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="chip c-hold"><i />Discard your changes to variant {variant}?</span>
          <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          <button type="button" className="btn btn-destructive" onClick={onClose}>Discard changes</button>
        </div>
      )}
      {banner && (
        <div style={{ padding: "0 16px 12px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }} role="alert">
          <span className="chip c-overdue"><i />{banner.text}</span>
          {banner.kind === "stale" && (
            <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
          )}
          {banner.kind === "revise" && canRevise && (
            <button type="button" className="btn" onClick={onRevise}>Revise part</button>
          )}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 132 }}>Step</th>
              <th>Operation</th>
              <th>Department</th>
              <th className="num">Time</th>
              <th>Unit</th>
              <th>Basis</th>
              {wantPv && <th>PV stage</th>}
              {wantHe && <th>HE stage</th>}
              <th>Cond.</th>
              <th>QC</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const expanded = open.has(r.key);
              const ops = reference.operations.filter((o) => o.active || o.code === r.operationCode);
              const onRowKey = (e: React.KeyboardEvent) => {
                if (!e.altKey) return;
                if (e.key === "ArrowUp") { e.preventDefault(); setRows((rs) => moveRow(rs, i, -1)); }
                if (e.key === "ArrowDown") { e.preventDefault(); setRows((rs) => moveRow(rs, i, 1)); }
                if (e.key === "Enter") { e.preventDefault(); addAfter(i); }
              };
              return (
                <RowFragment key={r.key}>
                  <tr className="row" onKeyDown={onRowKey}>
                    <td className="mono">
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button type="button" className="btn" style={{ padding: "2px 6px" }} disabled={i === 0} onClick={() => setRows((rs) => moveRow(rs, i, -1))} aria-label={`Move step ${r.seq} up`}>↑</button>
                        <input
                          className="ws-detail mono"
                          style={{ width: 54, ...cell(r, "seq").style }}
                          inputMode="numeric"
                          aria-label="Step number"
                          title={cell(r, "seq").title} aria-invalid={cell(r, "seq")["aria-invalid"]}
                          value={r.seq}
                          onChange={(e) => update(r.key, { seq: e.target.value })}
                        />
                        <button type="button" className="btn" style={{ padding: "2px 6px" }} disabled={i === rows.length - 1} onClick={() => setRows((rs) => moveRow(rs, i, 1))} aria-label={`Move step ${r.seq} down`}>↓</button>
                      </div>
                    </td>
                    <td>
                      <select id={`ed-${r.key}-operation`} className="ws-detail" style={{ width: 150, ...cell(r, "operation").style }} aria-label="Operation" title={cell(r, "operation").title} aria-invalid={cell(r, "operation")["aria-invalid"]} value={r.operationCode} onChange={(e) => pickOperation(r, e.target.value)}>
                        <option value="">— pick —</option>
                        {ops.map((o) => (
                          <option key={o.code} value={o.code}>{o.name}{o.active ? "" : " (inactive)"}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="ws-detail" style={{ width: 130, ...cell(r, "department").style }} aria-label="Department" title={cell(r, "department").title} aria-invalid={cell(r, "department")["aria-invalid"]} value={r.department} onChange={(e) => update(r.key, { department: e.target.value })}>
                        <option value="">— pick —</option>
                        {reference.departments.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input className="ws-detail mono" style={{ width: 70, ...cell(r, "stdTime").style }} inputMode="decimal" aria-label="Standard time" title={cell(r, "stdTime").title} aria-invalid={cell(r, "stdTime")["aria-invalid"]} value={r.stdTime} onChange={(e) => update(r.key, { stdTime: e.target.value })} />
                    </td>
                    <td>
                      <select className="ws-detail" style={cell(r, "stdTimeUnit").style} aria-label="Time unit" title={cell(r, "stdTimeUnit").title} aria-invalid={cell(r, "stdTimeUnit")["aria-invalid"]} value={r.stdTimeUnit} onChange={(e) => update(r.key, { stdTimeUnit: e.target.value as EditorRow["stdTimeUnit"] })}>
                        <option value="">—</option>
                        <option value="HOURS">h</option>
                        <option value="DAYS">d</option>
                      </select>
                    </td>
                    <td>
                      <select className="ws-detail" style={{ width: 116, ...cell(r, "stdTimeBasis").style }} aria-label="Time basis" title={cell(r, "stdTimeBasis").title} aria-invalid={cell(r, "stdTimeBasis")["aria-invalid"]} value={r.stdTimeBasis} onChange={(e) => update(r.key, { stdTimeBasis: e.target.value })}>
                        <option value="">—</option>
                        {BASIS_OPTIONS.map((b) => (
                          <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                      </select>
                    </td>
                    {wantPv && (
                      <td>
                        <select className="ws-detail" style={{ width: 128, ...cell(r, "pvStage").style }} aria-label="PV stage" title={cell(r, "pvStage").title} aria-invalid={cell(r, "pvStage")["aria-invalid"]} value={r.pvStage} onChange={(e) => update(r.key, { pvStage: e.target.value })}>
                          <option value="">— pick —</option>
                          {reference.pvStages.map((s) => (
                            <option key={s.no} value={s.no}>{s.no} · {s.name}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    {wantHe && (
                      <td>
                        <select className="ws-detail" style={{ width: 128, ...cell(r, "heStage").style }} aria-label="HE stage" title={cell(r, "heStage").title} aria-invalid={cell(r, "heStage")["aria-invalid"]} value={r.heStage} onChange={(e) => update(r.key, { heStage: e.target.value })}>
                          <option value="">— pick —</option>
                          {reference.heStages.map((s) => (
                            <option key={s.no} value={s.no}>{s.no} · {s.name}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td>
                      <input type="checkbox" aria-label="Conditional step" checked={r.conditional} onChange={(e) => update(r.key, { conditional: e.target.checked })} />
                    </td>
                    <td title="Switching QC off for a step is a Production Head decision (D3) and is not available yet.">Yes</td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button type="button" className="btn" style={{ padding: "2px 6px" }} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} details for step ${r.seq}`} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>{expanded ? "▾" : "▸"}</button>
                        <button type="button" className="btn" style={{ padding: "2px 6px" }} disabled={rows.length === 1} aria-label={`Remove step ${r.seq}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td />
                      <td colSpan={wantPv && wantHe ? 9 : wantPv || wantHe ? 8 : 7}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, padding: "4px 0 10px" }}>
                          {([
                            ["whatIsDone", "What is done"],
                            ["conditionText", "When it applies"],
                            ["acceptanceStandard", "Acceptance standard"],
                            ["recordDocument", "Record / document"],
                          ] as const).map(([field, label]) => (
                            <label key={field} style={{ display: "grid", gap: 2, fontSize: "var(--fs-xs, 11px)", color: "var(--muted)" }}>
                              {label}
                              <input className="ws-detail" value={r[field]} onChange={(e) => update(r.key, { [field]: e.target.value } as Partial<EditorRow>)} />
                            </label>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </RowFragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ padding: "10px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={() => addAfter(rows.length - 1)}>+ Add step</button>
        <span className="note" style={{ margin: 0 }}>
          Alt+↑/↓ move a step · Alt+Enter add below · Ctrl/⌘+Enter save · Esc discard
        </span>
      </div>
    </div>
  );
}

function RowFragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
