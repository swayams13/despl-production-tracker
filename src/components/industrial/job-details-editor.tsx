"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { updateJobDetailsAction } from "@/app/actions/job-intake";

type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

function toValue(s: string | null): string {
  return s ?? "";
}

/**
 * Lets ADMIN/PRODUCTION_HEAD revise a job's descriptive/reference fields
 * (client PO, project name, design code, priority, remarks) after creation —
 * a plain field-level correction, not the structural client/family/route/
 * equipment set createJob() builds (see updateJobDetailsSchema's own note).
 * Mirrors the admin-dialog pattern from admin/equipment-types/_client.tsx.
 */
export function JobDetailsEditor({
  jobId,
  clientOrderNo,
  projectName,
  poRef,
  designCode,
  priority,
  remarks,
}: {
  jobId: number;
  clientOrderNo: string | null;
  projectName: string | null;
  poRef: string | null;
  designCode: string | null;
  priority: Priority;
  remarks: string | null;
}) {
  const themeClass = useThemeClass();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    clientOrderNo: toValue(clientOrderNo),
    projectName: toValue(projectName),
    poRef: toValue(poRef),
    designCode: toValue(designCode),
    priority,
    remarks: toValue(remarks),
  });
  const [pending, startTransition] = useTransition();

  function openDialog() {
    setForm({
      clientOrderNo: toValue(clientOrderNo),
      projectName: toValue(projectName),
      poRef: toValue(poRef),
      designCode: toValue(designCode),
      priority,
      remarks: toValue(remarks),
    });
    setOpen(true);
  }

  function save() {
    startTransition(async () => {
      const result = await updateJobDetailsAction({
        jobId,
        clientOrderNo: form.clientOrderNo.trim() || null,
        projectName: form.projectName.trim() || null,
        poRef: form.poRef.trim() || null,
        designCode: form.designCode.trim() || null,
        priority: form.priority,
        remarks: form.remarks.trim() || null,
      });
      if (result.ok) {
        toast.success("Job details saved.");
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <>
      <button className="btn" style={{ marginLeft: 10 }} onClick={openDialog}>Edit job</button>
      <Dialog.Root open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <Dialog.Portal>
          <Dialog.Overlay className="admin-dialog-ov" />
          <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
            <div className="sh-hd">
              <Dialog.Close asChild>
                <button className="sh-x" aria-label="Close">✕</button>
              </Dialog.Close>
              <Dialog.Title asChild><h2>Edit job</h2></Dialog.Title>
            </div>
            <div className="sh-body">
              <div className="emp-grid">
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Project name</label>
                  <input
                    className="ws-detail"
                    value={form.projectName}
                    disabled={pending}
                    onChange={(e) => setForm((f) => ({ ...f, projectName: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Client PO / order no.</label>
                  <input
                    className="ws-detail"
                    value={form.clientOrderNo}
                    disabled={pending}
                    onChange={(e) => setForm((f) => ({ ...f, clientOrderNo: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>PO reference</label>
                  <input
                    className="ws-detail"
                    value={form.poRef}
                    disabled={pending}
                    onChange={(e) => setForm((f) => ({ ...f, poRef: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Design code</label>
                  <input
                    className="ws-detail mono"
                    value={form.designCode}
                    disabled={pending}
                    onChange={(e) => setForm((f) => ({ ...f, designCode: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Priority</label>
                  <select
                    className="ws-detail"
                    value={form.priority}
                    disabled={pending}
                    onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as Priority }))}
                  >
                    <option value="LOW">Low</option>
                    <option value="NORMAL">Normal</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Remarks</label>
                <textarea
                  className="ws-detail"
                  style={{ width: "100%", minHeight: 70 }}
                  value={form.remarks}
                  disabled={pending}
                  onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                />
              </div>
            </div>
            <div className="sh-ft">
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn btn-accent" disabled={pending} onClick={save}>Save</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
