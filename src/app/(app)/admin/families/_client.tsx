"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { createProductFamilyAction } from "@/app/actions/job-intake";
import type { ProductFamilyAdminRow } from "@/lib/services/job-intake.read";

/**
 * C1: create + list only. Readiness (published route? QCP authored?) is C8,
 * not this screen — deliberately no delete, matching every other reference
 * catalog in this app (invariant #6): a family's code is immutable and
 * referenced by value from templates/routes/QCPs, so there is nothing here
 * to edit once created.
 */
export function ProductFamiliesClient({
  rows,
  canCreate,
}: {
  rows: ProductFamilyAdminRow[];
  canCreate: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <div className="page-h">
        <h1>Product families</h1>
        <span className="sub">The families a route, QCP, or equipment type can be authored against</span>
        {canCreate && (
          <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setAddOpen(true)}>
            + Add product family
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p className="note" style={{ padding: 16 }}>No product families yet. Add one to start authoring its route.</p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Status</th>
                <th className="num">Jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr className="row" key={r.id}>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td>
                    {r.active ? (
                      <span className="chip c-complete"><i />Active</span>
                    ) : (
                      <span className="chip c-idle"><i />Inactive</span>
                    )}
                  </td>
                  <td className="num mono">{r.jobCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addOpen && <AddProductFamilyDialog onClose={() => setAddOpen(false)} />}
    </>
  );
}

function AddProductFamilyDialog({ onClose }: { onClose: () => void }) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const submit = () => {
    if (!code.trim()) return toast.error("A code is required.");
    if (!name.trim()) return toast.error("A name is required.");
    startTransition(async () => {
      const r = await createProductFamilyAction({ code: code.trim(), name: name.trim() });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Product family added.");
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
            <Dialog.Title asChild><h2>Add product family</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <p className="note" style={{ textAlign: "left" }}>
              The code cannot be changed later — routes, QCPs and equipment types will reference it.
            </p>
            <div className="emp-grid">
              <div>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Code *</label>
                <input
                  className="ws-detail mono"
                  value={code}
                  placeholder="e.g. PIPE_SPOOL"
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <input className="ws-detail" placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>Add product family</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
