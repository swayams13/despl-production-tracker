"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { createClientAction } from "@/app/actions/job-intake";
import type { IntakeOptions } from "@/lib/services/job-intake.read";
import { PRIORITIES, PRIORITY_LABEL, type Priority, type WizardState } from "./wizard-state";

// ── Step 1: Order ──────────────────────────────────────────────────────
export function StepOrder({
  state,
  patch,
  options,
  clients,
  onAddClient,
}: {
  state: WizardState;
  patch: (p: Partial<WizardState>) => void;
  options: IntakeOptions;
  clients: Array<{ id: number; name: string; code: string | null }>;
  onAddClient: () => void;
}) {
  const dateOrderError =
    state.targetDispatchDate && state.committedDeliveryDate && state.targetDispatchDate > state.committedDeliveryDate;

  return (
    <div className="card">
      <div className="hd"><h3>Order details</h3></div>
      <div style={{ padding: 16 }}>
        <div className="emp-grid">
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Client *</label>
            <ClientPicker clients={clients} value={state.clientId} onChange={(id) => patch({ clientId: id })} onAddNew={onAddClient} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Job number *</label>
            <input className="ws-detail" value={state.jobNumber} onChange={(e) => patch({ jobNumber: e.target.value })} placeholder="e.g. DESPL-321" />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Client order no.</label>
            <input className="ws-detail" value={state.clientOrderNo} onChange={(e) => patch({ clientOrderNo: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>PO reference</label>
            <input className="ws-detail" value={state.poRef} onChange={(e) => patch({ poRef: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Project name</label>
            <input className="ws-detail" value={state.projectName} onChange={(e) => patch({ projectName: e.target.value })} />
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Order date</label>
            <input className="ws-detail" type="date" value={state.orderDate} onChange={(e) => patch({ orderDate: e.target.value })} />
          </div>
        </div>

        <div className="emp-grid" style={{ marginTop: 4 }}>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Committed delivery date *</label>
            <input className="ws-detail" type="date" value={state.committedDeliveryDate} onChange={(e) => patch({ committedDeliveryDate: e.target.value })} />
            <div className="emp-hint">The date promised to the client. Required: the schedule is built backwards from it, and lateness is measured against it.</div>
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Target dispatch date</label>
            <input className="ws-detail" type="date" value={state.targetDispatchDate} onChange={(e) => patch({ targetDispatchDate: e.target.value })} />
            <div className="emp-hint">DESPL&apos;s internal aim, usually earlier.</div>
            {dateOrderError && (
              <div className="ws-err">Target dispatch cannot be later than the committed delivery date.</div>
            )}
          </div>
        </div>

        <div className="emp-grid" style={{ marginTop: 4 }}>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Priority</label>
            <select className="ws-detail" value={state.priority} onChange={(e) => patch({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
          <div>
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Work calendar</label>
            <select
              className="ws-detail"
              value={state.calendarId ?? ""}
              onChange={(e) => patch({ calendarId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">No calendar selected</option>
              {options.calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.isDefault ? " (default)" : ""}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Client searchable picker — reuses the topbar job switcher's .drop/.d-row
// idiom instead of pulling in a combobox dependency. ────────────────────
function ClientPicker({
  clients,
  value,
  onChange,
  onAddNew,
}: {
  clients: Array<{ id: number; name: string; code: string | null }>;
  value: number | null;
  onChange: (id: number) => void;
  onAddNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = clients.find((c) => c.id === value) ?? null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = clients.filter(
    (c) => c.name.toLowerCase().includes(q.toLowerCase()) || (c.code ?? "").toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        className="ws-detail"
        placeholder="Search client…"
        value={open ? q : (selected?.name ?? "")}
        onFocus={() => { setOpen(true); setQ(""); }}
        onChange={(e) => setQ(e.target.value)}
      />
      {open && (
        <div className="drop" style={{ left: 0, right: "auto", top: "calc(100% + 4px)", minWidth: "100%" }}>
          {filtered.length === 0 ? (
            <div className="d-row" style={{ color: "var(--muted)" }}>No matches</div>
          ) : (
            filtered.map((c) => (
              <div key={c.id} className="d-row" onClick={() => { onChange(c.id); setOpen(false); }}>
                {c.name}{c.code ? <small> {c.code}</small> : null}
              </div>
            ))
          )}
          <div className="d-row" style={{ color: "var(--accent)", fontWeight: 600 }} onClick={() => { setOpen(false); onAddNew(); }}>
            + Add client…
          </div>
        </div>
      )}
    </div>
  );
}

export function AddClientDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: { id: number; name: string; code: string | null }) => void;
}) {
  const themeClass = useThemeClass();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const submit = () => {
    if (!name.trim()) return toast.error("A client name is required.");
    startTransition(async () => {
      const r = await createClientAction({ name: name.trim(), code: code.trim() || null });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Client added.");
      onCreated({ id: r.clientId!, name: r.name!, code: code.trim() || null });
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild><button className="sh-x" aria-label="Close">✕</button></Dialog.Close>
            <Dialog.Title asChild><h2>Add client</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <input className="ws-detail" placeholder="Client name *" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="ws-detail" placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Add client</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
