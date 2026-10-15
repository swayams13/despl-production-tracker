"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { PageHeader } from "@/components/industrial/page-header";
import { StatusChip } from "@/components/industrial/status-chip";
import {
  saveMaterialGradeAction,
  setMaterialStatusAction,
  setMaterialStatusBulkAction,
} from "@/app/actions/master-data";
import type { MaterialGradeRow } from "@/lib/services/master-data.read";
import { materialQueryString, type MaterialFilters } from "../_filters";
import { partStatus } from "../_labels";

interface Totals { all: number; draft: number; reviewed: number; approved: number; noDensity: number }
interface Can { edit: boolean; approve: boolean; revise: boolean }
interface Draft { spec: string; grade: string; productForm: string; density: string; remarks: string }

const blank: Draft = { spec: "", grade: "", productForm: "", density: "", remarks: "" };
const fromRow = (r: MaterialGradeRow): Draft => ({
  spec: r.spec, grade: r.grade, productForm: r.productForm, density: r.densityGcc == null ? "" : String(r.densityGcc), remarks: r.remarks ?? "",
});

/** What is wrong with a draft, before the round trip. Density is g/cm³: 7.85 for carbon steel. */
export function validateDraft(d: Draft): { field: keyof Draft; message: string } | null {
  if (!d.spec.trim()) return { field: "spec", message: "A specification is required." };
  if (!d.productForm.trim()) return { field: "productForm", message: "A product form is required." };
  if (d.density.trim() !== "") {
    const n = Number(d.density);
    if (!Number.isFinite(n) || n <= 0 || n > 999.999) return { field: "density", message: "Density must be above 0 and at most 999.999 g/cm³." };
  }
  return null;
}

export function MaterialsView({
  rows, totals, filters, can, sections,
}: { rows: MaterialGradeRow[]; totals: Totals; filters: MaterialFilters; can: Can; sections?: ReactNode }) {
  const router = useRouter();
  const [, nav] = useTransition();
  const [busy, start] = useTransition();
  const [q, setQ] = useState(filters.q ?? "");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [problem, setProblem] = useState<{ field: keyof Draft; message: string } | null>(null);
  const [reviseFor, setReviseFor] = useState<MaterialGradeRow | null>(null);
  const [reason, setReason] = useState("");
  const first = useRef(true);

  const go = (next: MaterialFilters) => nav(() => router.replace(`/admin/master-data/materials${materialQueryString(next)}`, { scroll: false }));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => go({ ...filters, q: q.trim() || undefined }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const refuse = (r: { message: string; detail?: Record<string, unknown> }) => {
    const d = r.detail as { reason?: string; blockers?: Array<{ message?: string }> } | undefined;
    toast.error(d?.reason ?? d?.blockers?.map((b) => b.message).filter(Boolean).join(" ") ?? r.message);
  };

  const startEdit = (r: MaterialGradeRow | null) => {
    setEditing(r ? r.id : "new");
    setDraft(r ? fromRow(r) : blank);
    setProblem(null);
  };
  const cancel = () => {
    setEditing(null);
    setProblem(null);
  };
  const save = () => {
    const p = validateDraft(draft);
    setProblem(p);
    if (p) return;
    start(async () => {
      const r = await saveMaterialGradeAction({
        ...(editing !== "new" && editing != null ? { id: editing } : {}),
        spec: draft.spec.trim(),
        grade: draft.grade.trim(),
        productForm: draft.productForm.trim(),
        densityGcc: draft.density.trim() === "" ? null : Number(draft.density),
        remarks: draft.remarks.trim() || null,
      });
      if (r.ok) {
        toast.success("Saved.");
        cancel();
        router.refresh();
      } else refuse(r);
    });
  };

  const move = (id: number, to: "REVIEWED" | "APPROVED") =>
    start(async () => {
      const r = await setMaterialStatusAction({ materialGradeId: id, to });
      if (r.ok) {
        toast.success(to === "APPROVED" ? "Approved." : "Marked reviewed.");
        router.refresh();
      } else refuse(r);
    });

  const bulk = (to: "REVIEWED" | "APPROVED") =>
    start(async () => {
      const r = await setMaterialStatusBulkAction([...selected], to);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const skipped = r.refused.length;
      if (r.reviewed.length > 0) toast.success(`${r.reviewed.length} ${to === "APPROVED" ? "approved" : "marked reviewed"}${skipped ? `, ${skipped} skipped` : ""}.`);
      if (skipped > 0) toast.error([...new Set(r.refused.map((x) => x.message))].join(" "));
      setSelected(new Set());
      router.refresh();
    });

  const revise = () =>
    start(async () => {
      if (!reviseFor) return;
      const r = await setMaterialStatusAction({ materialGradeId: reviseFor.id, to: "DRAFT", reason });
      if (r.ok) {
        toast.success("Reopened as a draft.");
        setReviseFor(null);
        setReason("");
        router.refresh();
      } else refuse(r);
    });

  const tab = (label: string, count: number, active: boolean, next: MaterialFilters) => (
    <button type="button" className={active ? "btn btn-outline-accent" : "btn"} aria-pressed={active} onClick={() => go(next)}>
      {label} <span className="mono">{count}</span>
    </button>
  );
  const base = { q: filters.q };
  const picked = rows.filter((r) => selected.has(r.id));
  const canBulkReview = can.edit && picked.length > 0 && picked.every((r) => r.status === "DRAFT");
  const canBulkApprove = can.approve && picked.length > 0 && picked.every((r) => r.status !== "APPROVED");
  const field = (key: keyof Draft, label: string, extra: { width?: number; mono?: boolean; inputMode?: "decimal" } = {}) => (
    <input
      className={`ws-detail${extra.mono ? " mono" : ""}`}
      style={{ width: extra.width ?? 120, outline: problem?.field === key ? "1px solid var(--s-overdue)" : undefined }}
      aria-label={label}
      aria-invalid={problem?.field === key ? true : undefined}
      title={problem?.field === key ? problem.message : undefined}
      inputMode={extra.inputMode}
      value={draft[key]}
      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") cancel();
      }}
    />
  );
  const editingRow = rows.find((r) => r.id === editing);

  return (
    <>
      <PageHeader
        title="Master data"
        subtitle="Material grades"
        actions={can.edit && editing == null ? <button type="button" className="btn btn-accent" onClick={() => startEdit(null)}>Add grade</button> : undefined}
      />
      {sections}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        {tab("All", totals.all, !filters.status && !filters.noDensity, base)}
        {tab("Draft", totals.draft, filters.status === "DRAFT", { ...base, status: "DRAFT" })}
        {tab("Reviewed", totals.reviewed, filters.status === "REVIEWED", { ...base, status: "REVIEWED" })}
        {tab("Approved", totals.approved, filters.status === "APPROVED", { ...base, status: "APPROVED" })}
        {tab("No density", totals.noDensity, Boolean(filters.noDensity), { ...base, noDensity: true })}
        <input
          className="ws-detail"
          style={{ marginLeft: "auto", width: 260, maxWidth: "100%" }}
          type="search"
          placeholder="Search specification, grade or form"
          aria-label="Search specification, grade or form"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {(canBulkReview || canBulkApprove) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span className="note" style={{ margin: 0 }}>{picked.length} selected</span>
          {canBulkReview && <button type="button" className="btn" disabled={busy} onClick={() => bulk("REVIEWED")}>Mark reviewed</button>}
          {canBulkApprove && <button type="button" className="btn btn-accent" disabled={busy} onClick={() => bulk("APPROVED")}>Approve</button>}
        </div>
      )}

      {rows.length === 0 && editing !== "new" ? (
        <div className="card" style={{ padding: 16, fontSize: "var(--fs-md, 13px)" }}>
          {totals.all === 0
            ? "No material grades yet. Load the Standard Parts Master on the Import tab, or add a grade."
            : "No grades match these filters."}
        </div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {can.edit && <th style={{ width: 28 }} />}
                <th>Specification</th>
                <th>Grade</th>
                <th>Form</th>
                <th className="num">Density (g/cm³)</th>
                <th>Remarks</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {editing === "new" && (
                <tr className="row">
                  {can.edit && <td />}
                  <td>{field("spec", "Specification", { width: 130 })}</td>
                  <td>{field("grade", "Grade", { width: 90 })}</td>
                  <td>{field("productForm", "Form", { width: 100 })}</td>
                  <td className="num">{field("density", "Density (g/cm³)", { width: 80, mono: true, inputMode: "decimal" })}</td>
                  <td>{field("remarks", "Remarks", { width: 200 })}</td>
                  <td><StatusChip status="idle" label="New" /></td>
                  <td>
                    <button type="button" className="btn btn-accent" disabled={busy} onClick={save}>Save</button>{" "}
                    <button type="button" className="btn" onClick={cancel}>Cancel</button>
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const st = partStatus(r.status);
                const isEditing = editing === r.id;
                return (
                  <tr className="row" key={r.id}>
                    {can.edit && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.spec} ${r.grade}`}
                          checked={selected.has(r.id)}
                          onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                        />
                      </td>
                    )}
                    {isEditing ? (
                      <>
                        <td>{field("spec", "Specification", { width: 130 })}</td>
                        <td>{field("grade", "Grade", { width: 90 })}</td>
                        <td>{field("productForm", "Form", { width: 100 })}</td>
                        <td className="num">{field("density", "Density (g/cm³)", { width: 80, mono: true, inputMode: "decimal" })}</td>
                        <td>{field("remarks", "Remarks", { width: 200 })}</td>
                      </>
                    ) : (
                      <>
                        <td>{r.spec}</td>
                        <td>{r.grade || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                        <td>{r.productForm}</td>
                        <td className="num mono">{r.densityGcc == null ? <span style={{ color: "var(--muted)" }}>—</span> : r.densityGcc.toFixed(3)}</td>
                        <td>{r.remarks ?? ""}</td>
                      </>
                    )}
                    <td><StatusChip status={st.status} label={st.label} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {isEditing ? (
                        <>
                          <button type="button" className="btn btn-accent" disabled={busy} onClick={save}>Save</button>{" "}
                          <button type="button" className="btn" onClick={cancel}>Cancel</button>
                        </>
                      ) : (
                        <>
                          {can.edit && r.status !== "APPROVED" && editing == null && (
                            <button type="button" className="btn" onClick={() => startEdit(r)}>Edit</button>
                          )}{" "}
                          {can.edit && r.status === "DRAFT" && editing == null && (
                            <button type="button" className="btn" disabled={busy} onClick={() => move(r.id, "REVIEWED")}>Mark reviewed</button>
                          )}{" "}
                          {can.approve && r.status !== "APPROVED" && editing == null && (
                            r.densityGcc == null ? (
                              <span className="note" style={{ margin: 0 }}>Needs a density to approve</span>
                            ) : (
                              <button type="button" className="btn btn-accent" disabled={busy} onClick={() => move(r.id, "APPROVED")}>Approve</button>
                            )
                          )}{" "}
                          {can.revise && r.status !== "DRAFT" && editing == null && (
                            <button type="button" className="btn" onClick={() => setReviseFor(r)}>Revise</button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing != null && (
        <p className="note" style={{ textAlign: "left", margin: "10px 0 0" }}>
          {problem && <span style={{ color: "var(--s-overdue)" }}>{problem.message} </span>}
          {editingRow?.status === "REVIEWED" && "Saving returns this grade to draft. "}
          {Number(draft.density) > 25 && "Looks like kg/m³: enter g/cm³ (7.85 for carbon steel). "}
          Enter saves, Esc cancels.
        </p>
      )}

      {reviseFor && (
        <Modal
          open
          onOpenChange={(o) => !o && setReviseFor(null)}
          title={`Revise ${reviseFor.spec} ${reviseFor.grade}`}
          footer={<ModalConfirmFooter onCancel={() => setReviseFor(null)} onConfirm={revise} confirmLabel={busy ? "Reopening…" : "Revise grade"} disabled={busy || reason.trim().length < 5} />}
        >
          <div style={{ display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
            <p style={{ margin: 0 }}>The grade goes back to draft and needs review and approval again.</p>
            <label style={{ display: "grid", gap: 4 }}>
              Why is it being revised? (at least 5 characters)
              <textarea className="ws-detail" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}
