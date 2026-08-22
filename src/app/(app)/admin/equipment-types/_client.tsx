"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import {
  createEquipmentTypeAction,
  updateEquipmentTypeAction,
} from "@/app/actions/job-intake";
import { specFieldsFor, type SpecField } from "@/lib/shared/specs";
import type { EquipmentTypeAdminRow } from "@/lib/services/job-intake.read";

type Family = { id: number; code: string; name: string };

function summarizeSpecs(specs: Record<string, unknown> | null): string {
  if (!specs) return "—";
  const n = Object.keys(specs).length;
  if (n === 0) return "—";
  return `${n} field${n === 1 ? "" : "s"}`;
}

export function EquipmentTypesClient({ rows, families }: { rows: EquipmentTypeAdminRow[]; families: Family[] }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editRow, setEditRow] = useState<EquipmentTypeAdminRow | null>(null);
  const [deactivateRow, setDeactivateRow] = useState<EquipmentTypeAdminRow | null>(null);
  const [pending, startTransition] = useTransition();

  const familyByName = useMemo(() => {
    const groups = new Map<string, EquipmentTypeAdminRow[]>();
    for (const r of rows) {
      const list = groups.get(r.familyName) ?? [];
      list.push(r);
      groups.set(r.familyName, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const reactivate = (row: EquipmentTypeAdminRow) =>
    startTransition(async () => {
      const r = await updateEquipmentTypeAction({ id: row.id, active: true });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Reactivated.");
        router.refresh();
      }
    });

  return (
    <>
      <div className="page-h">
        <h1>Equipment types</h1>
        <span className="sub">The catalog the new-job wizard picks equipment types from</span>
        <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setAddOpen(true)}>
          + Add equipment type
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p className="note" style={{ padding: 16 }}>
            No equipment types yet. Add one to speed up creating jobs.
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Default design code</th>
                <th>Default specs</th>
                <th>Status</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {familyByName.map(([familyName, familyRows]) => (
                <FamilyGroup
                  key={familyName}
                  familyName={familyName}
                  rows={familyRows}
                  pending={pending}
                  onEdit={setEditRow}
                  onDeactivate={setDeactivateRow}
                  onReactivate={reactivate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && (
        <EquipmentTypeDialog
          families={families}
          onClose={() => setAddOpen(false)}
        />
      )}
      {editRow && (
        <EquipmentTypeDialog
          families={families}
          row={editRow}
          onClose={() => setEditRow(null)}
        />
      )}
      {deactivateRow && (
        <ConfirmDeactivateDialog
          row={deactivateRow}
          pending={pending}
          onClose={() => setDeactivateRow(null)}
          onConfirm={() =>
            startTransition(async () => {
              const r = await updateEquipmentTypeAction({ id: deactivateRow.id, active: false });
              if (!r.ok) toast.error(r.message);
              else {
                toast.success("Deactivated.");
                router.refresh();
                setDeactivateRow(null);
              }
            })
          }
        />
      )}
    </>
  );
}

function FamilyGroup({
  familyName,
  rows,
  pending,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  familyName: string;
  rows: EquipmentTypeAdminRow[];
  pending: boolean;
  onEdit: (row: EquipmentTypeAdminRow) => void;
  onDeactivate: (row: EquipmentTypeAdminRow) => void;
  onReactivate: (row: EquipmentTypeAdminRow) => void;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={6}
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: ".5px",
            color: "var(--muted)",
            background: "var(--surface-2)",
            fontWeight: 600,
          }}
        >
          {familyName}
        </td>
      </tr>
      {rows.map((r) => (
        <tr className="row" key={r.id}>
          <td className="mono">{r.code}</td>
          <td>{r.name}</td>
          <td className="mono" style={{ color: "var(--muted)" }}>{r.defaultDesignCode ?? "—"}</td>
          <td style={{ color: "var(--muted)" }}>{summarizeSpecs(r.defaultSpecs)}</td>
          <td>
            {r.active ? (
              <span className="chip c-complete"><i />Active</span>
            ) : (
              <span className="chip c-idle"><i />Inactive</span>
            )}
          </td>
          <td className="num">
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button className="btn" onClick={() => onEdit(r)}>Edit</button>
              {r.active ? (
                <button className="btn" disabled={pending} onClick={() => onDeactivate(r)}>Deactivate</button>
              ) : (
                <button className="btn" disabled={pending} onClick={() => onReactivate(r)}>Reactivate</button>
              )}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

function SpecsEditor({
  fields,
  values,
  onChange,
}: {
  fields: SpecField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (fields.length === 0) {
    return <p className="note" style={{ margin: 0, textAlign: "left" }}>No design fields are defined for this family yet.</p>;
  }
  return (
    <div className="emp-grid">
      {fields.map((f) => (
        <div key={f.key}>
          <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>
            {f.label}{f.unit ? ` (${f.unit})` : ""}
          </label>
          {f.type === "select" ? (
            <select className="ws-detail" value={values[f.key] ?? ""} onChange={(e) => onChange(f.key, e.target.value)}>
              <option value="">—</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              className="ws-detail"
              type={f.type === "number" ? "number" : "text"}
              value={values[f.key] ?? ""}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** One dialog for both add (no `row`) and edit (`row` supplied) — same fields, different submit call. */
function EquipmentTypeDialog({
  families,
  row,
  onClose,
}: {
  families: Family[];
  row?: EquipmentTypeAdminRow;
  onClose: () => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [familyId, setFamilyId] = useState<number | null>(row?.familyId ?? families[0]?.id ?? null);
  const [code, setCode] = useState(row?.code ?? "");
  const [name, setName] = useState(row?.name ?? "");
  const [defaultDesignCode, setDefaultDesignCode] = useState(row?.defaultDesignCode ?? "");
  const [specs, setSpecs] = useState<Record<string, string>>(
    row?.defaultSpecs ? Object.fromEntries(Object.entries(row.defaultSpecs).map(([k, v]) => [k, String(v)])) : {},
  );

  const family = families.find((f) => f.id === familyId) ?? null;
  const fields = family ? specFieldsFor(family.code) : [];
  const setSpec = (key: string, value: string) => setSpecs((s) => ({ ...s, [key]: value }));

  const submit = () => {
    if (!familyId) return toast.error("A product family is required.");
    if (!name.trim()) return toast.error("A name is required.");
    if (!row && !code.trim()) return toast.error("A code is required.");
    const trimmedSpecs = Object.fromEntries(Object.entries(specs).filter(([, v]) => v.trim() !== ""));
    startTransition(async () => {
      const r = row
        ? await updateEquipmentTypeAction({
            id: row.id,
            name: name.trim(),
            defaultDesignCode: defaultDesignCode.trim() || null,
            defaultSpecs: Object.keys(trimmedSpecs).length ? trimmedSpecs : null,
          })
        : await createEquipmentTypeAction({
            familyId,
            code: code.trim(),
            name: name.trim(),
            defaultDesignCode: defaultDesignCode.trim() || null,
            defaultSpecs: Object.keys(trimmedSpecs).length ? trimmedSpecs : null,
          });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(row ? "Equipment type updated." : "Equipment type added.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>{row ? `Edit ${row.name}` : "Add equipment type"}</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Product family *</label>
                <select
                  className="ws-detail"
                  value={familyId ?? ""}
                  disabled={!!row}
                  onChange={(e) => setFamilyId(e.target.value ? Number(e.target.value) : null)}
                >
                  {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Code *</label>
                <input
                  className="ws-detail mono"
                  value={code}
                  disabled={!!row}
                  placeholder="e.g. HP_AIR_RECEIVER"
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <input className="ws-detail" placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} />
              <input
                className="ws-detail"
                placeholder="Default design code (optional)"
                value={defaultDesignCode}
                onChange={(e) => setDefaultDesignCode(e.target.value)}
              />
            </div>

            <div className="sh-sec">Default design specs</div>
            <SpecsEditor fields={fields} values={specs} onChange={setSpec} />
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>
              {row ? "Save" : "Add equipment type"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConfirmDeactivateDialog({
  row,
  pending,
  onClose,
  onConfirm,
}: {
  row: EquipmentTypeAdminRow;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const themeClass = useThemeClass();
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined} style={{ width: 420 }}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Deactivate {row.name}?</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <p style={{ fontSize: 13, margin: 0 }}>
              Deactivating keeps existing jobs intact. Equipment already using this type is unaffected.
            </p>
            <p className="note" style={{ textAlign: "left" }}>
              It will no longer appear in the new-job wizard&apos;s equipment type picker.
            </p>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={onConfirm}>Deactivate</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
