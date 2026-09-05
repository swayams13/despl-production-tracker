"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { createQcpTemplateLibraryAction, addQcpItemToLibraryTemplateAction } from "@/app/actions/qcp-template";
import type { QcpTemplateLibraryAdminRow, QcpTemplateItemAdminRow, QcpCodeRefOption } from "@/lib/services/job-intake.read";

const KIND_LABEL: Record<string, string> = { SECTION: "Section", CHECKPOINT: "Checkpoint" };
function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function nextKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function QcpTemplateLibraryClient({
  templates,
  qcpCodes,
}: {
  templates: QcpTemplateLibraryAdminRow[];
  qcpCodes: QcpCodeRefOption[];
}) {
  const [selectedId, setSelectedId] = useState<number | null>(templates[0]?.id ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  return (
    <>
      <div className="page-h">
        <h1>QCP templates</h1>
        <span className="sub">From-scratch QCP/ITP authoring — build a library template, then add checkpoints one at a time</span>
        <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setCreateOpen(true)}>
          + New QCP template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="card">
          <p className="note" style={{ padding: 16 }}>
            No QCP templates yet. Create one to start authoring checkpoints.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 420px) 1fr", gap: 14, alignItems: "start" }}>
          <div className="card">
            <div className="hd">
              <h3>Library templates</h3>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Job label</th>
                  <th className="num">Items</th>
                  <th>Parties</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr
                    className="row"
                    key={t.id}
                    style={{
                      cursor: "pointer",
                      background: t.id === selectedId ? "var(--surface-2)" : undefined,
                    }}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <td>
                      <div>{t.jobLabel}</div>
                      <div className="emp-hint" style={{ marginTop: 2 }}>{t.vessel}</div>
                    </td>
                    <td className="num mono">{t.items.length}</td>
                    <td style={{ color: "var(--muted)" }}>{t.parties.map((p) => p.code).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <TemplateDetail template={selected} qcpCodes={qcpCodes} addItemOpen={addItemOpen} setAddItemOpen={setAddItemOpen} />
          ) : (
            <div className="card">
              <p className="note" style={{ padding: 16 }}>Select a template to see its items.</p>
            </div>
          )}
        </div>
      )}

      {createOpen && <CreateTemplateDialog onClose={() => setCreateOpen(false)} onCreated={setSelectedId} />}
    </>
  );
}

function TemplateDetail({
  template,
  qcpCodes,
  addItemOpen,
  setAddItemOpen,
}: {
  template: QcpTemplateLibraryAdminRow;
  qcpCodes: QcpCodeRefOption[];
  addItemOpen: boolean;
  setAddItemOpen: (open: boolean) => void;
}) {
  return (
    <div className="card">
      <div className="hd">
        <div>
          <h3>{template.jobLabel}</h3>
          <div className="emp-hint" style={{ marginTop: 2 }}>
            {template.vessel}
            {template.designCode ? ` · ${template.designCode}` : ""} · revision {template.revision}
          </div>
        </div>
        <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setAddItemOpen(true)}>
          + Add item
        </button>
      </div>

      <div style={{ padding: "0 16px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {template.parties.map((p) => (
          <span className="tag" key={p.id}>
            {p.code}
            {p.name ? ` — ${p.name}` : ""}
          </span>
        ))}
      </div>

      {template.items.length === 0 ? (
        <p className="note" style={{ padding: "0 16px 14px" }}>No items yet. Add the first one above.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }}>Seq</th>
                <th>Sr. no.</th>
                <th>Kind</th>
                <th>Activity</th>
                <th>Characteristic</th>
                <th>Party / QCP code</th>
                <th>Gates process</th>
              </tr>
            </thead>
            <tbody>
              {template.items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addItemOpen && (
        <AddItemDialog
          templateId={template.id}
          nextSequence={(template.items.at(-1)?.sequence ?? 0) + 1}
          existingPartyCodes={template.parties.map((p) => p.code)}
          qcpCodes={qcpCodes}
          onClose={() => setAddItemOpen(false)}
        />
      )}
    </div>
  );
}

function ItemRow({ item }: { item: QcpTemplateItemAdminRow }) {
  return (
    <tr className="row">
      <td className="mono">{item.sequence}</td>
      <td className="mono">{item.srNo}</td>
      <td><span className="tag">{kindLabel(item.kind)}</span></td>
      <td>
        {item.section && <div className="emp-hint" style={{ marginBottom: 2 }}>{item.section}</div>}
        {item.activity}
      </td>
      <td style={{ color: "var(--muted)" }}>{item.characteristic ?? "—"}</td>
      <td>
        {item.partyCodes.length === 0 ? (
          "—"
        ) : (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {item.partyCodes.map((pc, i) => (
              <span className="tag" key={i}>
                {pc.partyCode} · {pc.qcpCode}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        {item.libraryProcessCodes.length === 0 ? (
          "—"
        ) : (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {item.libraryProcessCodes.map((code) => (
              <span className="tag" key={code}>{code}</span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function CreateTemplateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [jobLabel, setJobLabel] = useState("");
  const [vessel, setVessel] = useState("");
  const [designCode, setDesignCode] = useState("");
  const [parties, setParties] = useState<Array<{ key: string; code: string; name: string }>>([
    { key: nextKey(), code: "", name: "" },
  ]);

  const updateParty = (key: string, patch: Partial<{ code: string; name: string }>) =>
    setParties((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addParty = () => setParties((rows) => [...rows, { key: nextKey(), code: "", name: "" }]);
  const removeParty = (key: string) => setParties((rows) => rows.filter((r) => r.key !== key));

  const submit = () => {
    if (!jobLabel.trim()) return toast.error("A label is required.");
    if (!vessel.trim()) return toast.error("A vessel description is required.");
    const cleanParties = parties
      .map((p) => ({ code: p.code.trim(), name: p.name.trim() }))
      .filter((p) => p.code !== "");
    if (cleanParties.length === 0) return toast.error("At least one inspecting party is required.");

    startTransition(async () => {
      const r = await createQcpTemplateLibraryAction({
        jobLabel: jobLabel.trim(),
        vessel: vessel.trim(),
        designCode: designCode.trim() || undefined,
        parties: cleanParties.map((p) => ({ code: p.code, name: p.name || undefined })),
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("QCP template created.");
      router.refresh();
      if (r.qcpTemplateId) onCreated(r.qcpTemplateId);
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
            <Dialog.Title asChild><h2>New QCP template</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <input className="ws-detail" placeholder="Job label *" value={jobLabel} onChange={(e) => setJobLabel(e.target.value)} />
              <input className="ws-detail" placeholder="Vessel *" value={vessel} onChange={(e) => setVessel(e.target.value)} />
              <input
                className="ws-detail"
                placeholder="Design code (optional)"
                value={designCode}
                onChange={(e) => setDesignCode(e.target.value)}
              />
            </div>

            <div className="sh-sec">Inspecting parties</div>
            {parties.map((p) => (
              <div key={p.key} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  className="ws-detail mono"
                  style={{ width: 90 }}
                  placeholder="Code *"
                  value={p.code}
                  onChange={(e) => updateParty(p.key, { code: e.target.value })}
                />
                <input
                  className="ws-detail"
                  style={{ flex: 1 }}
                  placeholder="Name (optional)"
                  value={p.name}
                  onChange={(e) => updateParty(p.key, { name: e.target.value })}
                />
                <button className="btn" disabled={parties.length === 1} onClick={() => removeParty(p.key)}>
                  Remove
                </button>
              </div>
            ))}
            <button className="btn" onClick={addParty}>+ Add party</button>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>
              {pending ? "Creating…" : "Create template"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AddItemDialog({
  templateId,
  nextSequence,
  existingPartyCodes,
  qcpCodes,
  onClose,
}: {
  templateId: number;
  nextSequence: number;
  existingPartyCodes: string[];
  qcpCodes: QcpCodeRefOption[];
  onClose: () => void;
}) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sequence, setSequence] = useState(String(nextSequence));
  const [srNo, setSrNo] = useState("");
  const [kind, setKind] = useState<"SECTION" | "CHECKPOINT">("CHECKPOINT");
  const [section, setSection] = useState("");
  const [activity, setActivity] = useState("");
  const [characteristic, setCharacteristic] = useState("");
  const [extentOfCheck, setExtentOfCheck] = useState("");
  const [applicableDocument, setApplicableDocument] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [record, setRecord] = useState("");
  const [remarks, setRemarks] = useState("");
  const [processCodes, setProcessCodes] = useState("");
  const [partyRows, setPartyRows] = useState<Array<{ key: string; partyCode: string; qcpCode: string }>>([
    { key: nextKey(), partyCode: "", qcpCode: qcpCodes[0]?.code ?? "" },
  ]);

  const updatePartyRow = (key: string, patch: Partial<{ partyCode: string; qcpCode: string }>) =>
    setPartyRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addPartyRow = () =>
    setPartyRows((rows) => [...rows, { key: nextKey(), partyCode: "", qcpCode: qcpCodes[0]?.code ?? "" }]);
  const removePartyRow = (key: string) => setPartyRows((rows) => rows.filter((r) => r.key !== key));

  const parsedSequence = Number(sequence);

  const submit = () => {
    if (!Number.isInteger(parsedSequence) || parsedSequence <= 0) return toast.error("Sequence must be a positive whole number.");
    if (!srNo.trim()) return toast.error("A sr. no. is required.");
    if (!activity.trim()) return toast.error("An activity is required.");
    const cleanPartyRows = partyRows
      .map((r) => ({ partyCode: r.partyCode.trim(), qcpCode: r.qcpCode.trim() }))
      .filter((r) => r.partyCode !== "" && r.qcpCode !== "");
    const libraryProcessCodes = processCodes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    startTransition(async () => {
      const r = await addQcpItemToLibraryTemplateAction({
        qcpTemplateId: templateId,
        sequence: parsedSequence,
        srNo: srNo.trim(),
        kind,
        section: section.trim() || undefined,
        activity: activity.trim(),
        characteristic: characteristic.trim() || undefined,
        extentOfCheck: extentOfCheck.trim() || undefined,
        applicableDocument: applicableDocument.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.trim() || undefined,
        record: record.trim() || undefined,
        remarks: remarks.trim() || undefined,
        libraryProcessCodes,
        partyCodes: cleanPartyRows,
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Item added.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog wide`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Add item</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <div className="emp-grid">
              <input
                className="ws-detail mono"
                style={{ width: 80 }}
                placeholder="Seq *"
                value={sequence}
                onChange={(e) => setSequence(e.target.value)}
              />
              <input className="ws-detail" placeholder="Sr. no. *" value={srNo} onChange={(e) => setSrNo(e.target.value)} />
              <select className="ws-detail" value={kind} onChange={(e) => setKind(e.target.value as "SECTION" | "CHECKPOINT")}>
                <option value="CHECKPOINT">Checkpoint</option>
                <option value="SECTION">Section</option>
              </select>
              <input className="ws-detail" placeholder="Section (optional)" value={section} onChange={(e) => setSection(e.target.value)} />
            </div>

            <div className="emp-grid" style={{ gridTemplateColumns: "1fr" }}>
              <input className="ws-detail" placeholder="Activity *" value={activity} onChange={(e) => setActivity(e.target.value)} />
            </div>
            <div className="emp-grid">
              <input
                className="ws-detail"
                placeholder="Characteristic (optional)"
                value={characteristic}
                onChange={(e) => setCharacteristic(e.target.value)}
              />
              <input
                className="ws-detail"
                placeholder="Extent of check (optional)"
                value={extentOfCheck}
                onChange={(e) => setExtentOfCheck(e.target.value)}
              />
              <input
                className="ws-detail"
                placeholder="Applicable document (optional)"
                value={applicableDocument}
                onChange={(e) => setApplicableDocument(e.target.value)}
              />
              <input
                className="ws-detail"
                placeholder="Acceptance criteria (optional)"
                value={acceptanceCriteria}
                onChange={(e) => setAcceptanceCriteria(e.target.value)}
              />
              <input className="ws-detail" placeholder="Record (optional)" value={record} onChange={(e) => setRecord(e.target.value)} />
              <input className="ws-detail" placeholder="Remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>

            <div className="sh-sec">Party / QCP codes</div>
            <datalist id="qtl-party-codes">
              {existingPartyCodes.map((code) => (
                <option key={code} value={code} />
              ))}
            </datalist>
            {partyRows.map((row) => (
              <div key={row.key} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  className="ws-detail mono"
                  style={{ width: 110 }}
                  list="qtl-party-codes"
                  placeholder="Party code"
                  value={row.partyCode}
                  onChange={(e) => updatePartyRow(row.key, { partyCode: e.target.value })}
                />
                <select
                  className="ws-detail"
                  style={{ flex: 1 }}
                  value={row.qcpCode}
                  onChange={(e) => updatePartyRow(row.key, { qcpCode: e.target.value })}
                >
                  <option value="">— QCP code —</option>
                  {qcpCodes.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.label}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={partyRows.length === 1} onClick={() => removePartyRow(row.key)}>
                  Remove
                </button>
              </div>
            ))}
            <p className="emp-hint" style={{ marginBottom: 8 }}>
              Type an existing party code or a new one — a new party is created automatically on this template.
            </p>
            <button className="btn" onClick={addPartyRow}>+ Add party code</button>

            <div className="sh-sec">Gates process(es)</div>
            <input
              className="ws-detail"
              placeholder="e.g. 12, 16"
              value={processCodes}
              onChange={(e) => setProcessCodes(e.target.value)}
            />
            <p className="emp-hint">
              Which process number(s) in the job&apos;s route this checkpoint will gate, once this template is used on a real job — e.g. 12, 16.
            </p>
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-accent" disabled={pending} onClick={submit}>
              {pending ? "Adding…" : "Add item"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
