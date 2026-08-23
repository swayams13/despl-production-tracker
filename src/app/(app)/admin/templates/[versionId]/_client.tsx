"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import * as Dialog from "@radix-ui/react-dialog";
import { useThemeClass } from "@/components/industrial/theme-root";
import { StatusChip } from "@/components/industrial/status-chip";
import { saveDraftVersionAction, publishVersionAction } from "@/app/actions/template";
import type { VersionEditorView, VersionEditorProcess, VersionEditorEdge } from "@/lib/services/template.read";
import type { SaveDraftVersionInput, PublishVersionInput, TemplateWarningCode } from "@/lib/shared/schemas";

/**
 * Editor + publish dialog for one ProcessTemplateVersion (Task 12, route
 * authoring plan). Mirrors _client.tsx (Task 11, the index this screen is
 * linked from) and admin/_client.tsx's StandardDurationsSection (the closest
 * existing analog for a dense numeric-cell table) for markup conventions.
 *
 * Invariant #9 is enforced here only as UX (hiding Save/Publish on a
 * PUBLISHED version) — saveDraftVersion/publishVersion refuse regardless.
 */

const EDGE_TYPE_LABEL: Record<VersionEditorEdge["type"], string> = {
  FINISH_TO_START: "Finish to start",
  START_TO_START_WITH_OVERLAP: "Start to start, overlapping",
};

// Static copy for the publish-dialog checkboxes: the TEMPLATE_INCOMPLETE
// refusal that lists `unacknowledgedWarnings` only echoes back the warning
// *codes*, not the live message/count/processCodes validateVersionForPublish
// built server-side (AppError.detail is a flat jsonb bag, not the full
// TemplateWarning objects) — so the checkbox copy is a fixed humanised
// sentence per code, not a re-hydration of the server's dynamic message.
const WARNING_COPY: Record<TemplateWarningCode, string> = {
  PROVISIONAL_DURATIONS:
    "Some processes have no confirmed duration. This route can be published, but jobs using it will not produce dates until the durations are confirmed.",
  MULTIPLE_TERMINALS:
    "More than one process ends without feeding another. That's normal for branches that genuinely finish on their own — confirm none of them is a wiring mistake.",
  EMPTY_WORK_ORDER_STAGES:
    "Some processes are not mapped to a work-order stage. That's correct for families with no 25-stage reporting view.",
  ENVELOPE_MISMATCH:
    "The computed lead time differs from the expected lead time by more than a week. Check the lags between processes — summing durations instead of overlapping concurrent work is the usual cause.",
};

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface ProcessRow {
  key: string;
  code: string;
  name: string;
  mainActivities: string;
  defaultDepartmentId: number | null;
  durationMinDays: string;
  durationMaxDays: string;
  envelopeStartByMinDays: string;
  envelopeStartByMaxDays: string;
  envelopeFinishByMinDays: string;
  envelopeFinishByMaxDays: string;
  workOrderStages: string;
  optional: boolean;
  provisional: boolean;
}

interface EdgeRow {
  key: string;
  processKey: string;
  predecessorKey: string;
  type: VersionEditorEdge["type"];
  lagDays: string;
}

function toProcessRow(p: VersionEditorProcess): ProcessRow {
  return {
    key: String(p.id),
    code: p.code,
    name: p.name,
    mainActivities: p.mainActivities ?? "",
    defaultDepartmentId: p.defaultDepartmentId,
    durationMinDays: p.durationMinDays != null ? String(p.durationMinDays) : "",
    durationMaxDays: p.durationMaxDays != null ? String(p.durationMaxDays) : "",
    envelopeStartByMinDays: p.envelopeStartByMinDays != null ? String(p.envelopeStartByMinDays) : "",
    envelopeStartByMaxDays: p.envelopeStartByMaxDays != null ? String(p.envelopeStartByMaxDays) : "",
    envelopeFinishByMinDays: p.envelopeFinishByMinDays != null ? String(p.envelopeFinishByMinDays) : "",
    envelopeFinishByMaxDays: p.envelopeFinishByMaxDays != null ? String(p.envelopeFinishByMaxDays) : "",
    workOrderStages: p.workOrderStages.join(","),
    optional: p.optional,
    provisional: p.provisional,
  };
}

function newProcessRow(defaultDepartmentId: number | null): ProcessRow {
  return {
    key: `new-${newKey()}`,
    code: "",
    name: "",
    mainActivities: "",
    defaultDepartmentId,
    durationMinDays: "",
    durationMaxDays: "",
    envelopeStartByMinDays: "",
    envelopeStartByMaxDays: "",
    envelopeFinishByMinDays: "",
    envelopeFinishByMaxDays: "",
    workOrderStages: "",
    optional: false,
    // New rows default to provisional with null durations (spec §8) — the
    // author clears the flag deliberately, per process, once real data exists.
    provisional: true,
  };
}

function toEdgeRow(e: VersionEditorEdge): EdgeRow {
  return {
    key: newKey(),
    processKey: String(e.processId),
    predecessorKey: String(e.predecessorId),
    type: e.type,
    lagDays: String(e.lagDays),
  };
}

function parseStages(text: string): number[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Service-layer refusals carry the specific, process-naming sentence in
 * `detail.reason` (see template.service.ts's validateVersionForPublish
 * docstring) — the generic per-code `message` is only a fallback for the
 * refusals that don't set one (e.g. STALE_WRITE).
 */
function refusalMessage(message: string, detail: Record<string, unknown> | undefined): string {
  return typeof detail?.reason === "string" ? detail.reason : message;
}

/** Best-effort extra context appended to a toast — not every refusal carries it. */
function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const parts: string[] = [];
  if (Array.isArray(detail.processCodes) && detail.processCodes.length > 0) {
    parts.push(`processes: ${(detail.processCodes as string[]).join(", ")}`);
  } else if (typeof detail.code === "string") {
    parts.push(`process ${detail.code}`);
  }
  if (typeof detail.seq === "number") parts.push(`seq ${detail.seq}`);
  return parts.join(" — ");
}

export function VersionEditorClient({ view }: { view: VersionEditorView }) {
  const router = useRouter();
  const [processes, setProcesses] = useState<ProcessRow[]>(() => view.processes.map(toProcessRow));
  const [edges, setEdges] = useState<EdgeRow[]>(() => view.edges.map(toEdgeRow));
  const [updatedAtToken, setUpdatedAtToken] = useState<string | null>(view.updatedAt);
  const [staleWrite, setStaleWrite] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [saving, startSaving] = useTransition();

  const editable = view.editable;

  const updateProcess = (key: string, patch: Partial<ProcessRow>) => {
    setProcesses((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  // Un-ticking provisional with a missing duration is blocked client-side —
  // a courtesy, since saveDraftVersion's schema refuses it too (spec §8).
  const setProvisional = (key: string, value: boolean) => {
    const row = processes.find((r) => r.key === key);
    if (!row) return;
    if (!value && (!row.durationMinDays.trim() || !row.durationMaxDays.trim())) {
      toast.error("Enter both durations before marking this process confirmed.");
      return;
    }
    updateProcess(key, { provisional: value });
  };

  const moveProcess = (index: number, dir: -1 | 1) => {
    setProcesses((rows) => {
      const target = index + dir;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // Removing a process also drops any edge that referenced it, so a save
  // never sends an edge pointing at a process no longer in the payload.
  const removeProcess = (key: string) => {
    setProcesses((rows) => rows.filter((r) => r.key !== key));
    setEdges((rows) => rows.filter((e) => e.processKey !== key && e.predecessorKey !== key));
  };

  const addProcess = () => {
    setProcesses((rows) => [...rows, newProcessRow(view.departments[0]?.id ?? null)]);
  };

  const updateEdge = (key: string, patch: Partial<EdgeRow>) => {
    setEdges((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const removeEdge = (key: string) => setEdges((rows) => rows.filter((r) => r.key !== key));

  const addEdge = () => {
    if (processes.length === 0) return toast.error("Add a process first.");
    setEdges((rows) => [
      ...rows,
      {
        key: newKey(),
        processKey: processes[Math.min(1, processes.length - 1)].key,
        predecessorKey: processes[0].key,
        type: "FINISH_TO_START",
        lagDays: "0",
      },
    ]);
  };

  const handleSave = () => {
    for (const p of processes) {
      if (!p.code.trim() || !p.name.trim()) {
        toast.error("Every process needs a code and a name.");
        return;
      }
    }
    const codes = new Set<string>();
    for (const p of processes) {
      const code = p.code.trim();
      if (codes.has(code)) {
        toast.error(`Duplicate process code "${code}".`);
        return;
      }
      codes.add(code);
    }
    for (const p of processes) {
      if (!p.provisional && (!p.durationMinDays.trim() || !p.durationMaxDays.trim())) {
        toast.error(`Enter both durations before marking "${p.name || p.code}" confirmed, or mark it provisional.`);
        return;
      }
    }

    const payload: SaveDraftVersionInput = {
      versionId: view.versionId,
      expectedUpdatedAt: updatedAtToken ? new Date(updatedAtToken) : null,
      processes: processes.map((p, i) => ({
        key: p.key,
        seq: i + 1,
        code: p.code.trim(),
        name: p.name.trim(),
        mainActivities: p.mainActivities.trim() || null,
        defaultDepartmentId: p.defaultDepartmentId!,
        durationMinDays: p.durationMinDays.trim() ? Number(p.durationMinDays) : null,
        durationMaxDays: p.durationMaxDays.trim() ? Number(p.durationMaxDays) : null,
        envelopeStartByMinDays: p.envelopeStartByMinDays.trim() ? Number(p.envelopeStartByMinDays) : null,
        envelopeStartByMaxDays: p.envelopeStartByMaxDays.trim() ? Number(p.envelopeStartByMaxDays) : null,
        envelopeFinishByMinDays: p.envelopeFinishByMinDays.trim() ? Number(p.envelopeFinishByMinDays) : null,
        envelopeFinishByMaxDays: p.envelopeFinishByMaxDays.trim() ? Number(p.envelopeFinishByMaxDays) : null,
        workOrderStages: parseStages(p.workOrderStages),
        optional: p.optional,
        provisional: p.provisional,
      })),
      edges: edges.map((e) => ({
        processKey: e.processKey,
        predecessorKey: e.predecessorKey,
        type: e.type,
        lagDays: Number(e.lagDays) || 0,
      })),
    };

    setStaleWrite(false);
    startSaving(async () => {
      const r = await saveDraftVersionAction(payload);
      if (!r.ok) {
        if (r.code === "STALE_WRITE") {
          setStaleWrite(true);
          toast.error(r.message);
          return;
        }
        const msg = refusalMessage(r.message, r.detail);
        const extra = formatDetail(r.detail);
        toast.error(extra ? `${msg} (${extra})` : msg);
        return;
      }
      setUpdatedAtToken(r.updatedAt ?? null);
      toast.success("Draft saved.");
      router.refresh();
    });
  };

  return (
    <>
      <div className="page-h">
        <h1>{view.templateName}</h1>
        <span className="sub">
          {view.familyName} · <span className="mono">v{view.version}</span>
        </span>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <StatusChip
            status={view.status === "PUBLISHED" ? "complete" : "idle"}
            label={view.status === "PUBLISHED" ? "Published" : "Draft"}
          />
          {editable && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save draft"}
              </button>
              <button className="btn btn-accent" disabled={saving} onClick={() => setPublishOpen(true)}>
                Publish
              </button>
            </div>
          )}
        </div>
        {!editable && (
          <p className="note" style={{ textAlign: "left", padding: "0 16px 14px", margin: 0 }}>
            Version {view.version} is published and cannot be changed.
            {view.supersededByVersion != null && ` Superseded by version ${view.supersededByVersion}.`}
          </p>
        )}
        {staleWrite && (
          <div style={{ padding: "0 16px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="chip c-overdue">
              <i />
              Someone else changed this while you were editing.
            </span>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Processes</h3>
        </div>
        {processes.length === 0 ? (
          <p className="note" style={{ padding: "0 16px 14px" }}>No processes yet. Add the first one below.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 64 }}>Seq</th>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Main activities</th>
                  <th>Department</th>
                  <th className="num">Min days</th>
                  <th className="num">Max days</th>
                  <th className="num">Start-by min</th>
                  <th className="num">Start-by max</th>
                  <th className="num">Finish-by min</th>
                  <th className="num">Finish-by max</th>
                  <th>Stages</th>
                  <th className="num">Optional</th>
                  <th className="num">Provisional</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {processes.map((p, i) => (
                  <tr className="row" key={p.key}>
                    <td className="mono">
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <button
                          className="btn"
                          style={{ padding: "2px 6px" }}
                          disabled={!editable || i === 0}
                          onClick={() => moveProcess(i, -1)}
                          aria-label={`Move ${p.name || p.code || "process"} up`}
                        >
                          ↑
                        </button>
                        {i + 1}
                        <button
                          className="btn"
                          style={{ padding: "2px 6px" }}
                          disabled={!editable || i === processes.length - 1}
                          onClick={() => moveProcess(i, 1)}
                          aria-label={`Move ${p.name || p.code || "process"} down`}
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                    <td>
                      <input
                        className="ws-detail mono"
                        style={{ width: 70 }}
                        value={p.code}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { code: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ws-detail"
                        style={{ minWidth: 150 }}
                        value={p.name}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ws-detail"
                        style={{ minWidth: 170 }}
                        value={p.mainActivities}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { mainActivities: e.target.value })}
                      />
                    </td>
                    <td>
                      <select
                        className="ws-detail"
                        style={{ minWidth: 130 }}
                        value={p.defaultDepartmentId ?? ""}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { defaultDepartmentId: Number(e.target.value) })}
                      >
                        {view.departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.durationMinDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { durationMinDays: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.durationMaxDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { durationMaxDays: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.envelopeStartByMinDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { envelopeStartByMinDays: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.envelopeStartByMaxDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { envelopeStartByMaxDays: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.envelopeFinishByMinDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { envelopeFinishByMinDays: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        value={p.envelopeFinishByMaxDays}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { envelopeFinishByMaxDays: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="ws-detail mono"
                        style={{ width: 90 }}
                        placeholder="e.g. 4,5"
                        value={p.workOrderStages}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { workOrderStages: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        type="checkbox"
                        checked={p.optional}
                        disabled={!editable}
                        onChange={(e) => updateProcess(p.key, { optional: e.target.checked })}
                        aria-label={`${p.name || p.code || "Process"} is optional`}
                      />
                    </td>
                    <td className="num">
                      <input
                        type="checkbox"
                        checked={p.provisional}
                        disabled={!editable}
                        onChange={(e) => setProvisional(p.key, e.target.checked)}
                        aria-label={`${p.name || p.code || "Process"} is provisional`}
                      />
                    </td>
                    <td className="num">
                      {editable && (
                        <button className="btn" onClick={() => removeProcess(p.key)}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div style={{ padding: "12px 16px" }}>
            <button className="btn" onClick={addProcess}>
              + Add process
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Edges</h3>
        </div>
        {edges.length === 0 ? (
          <p className="note" style={{ padding: "0 16px 14px" }}>No predecessor edges yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Predecessor</th>
                  <th>Type</th>
                  <th className="num">Lag (days)</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {edges.map((e) => (
                  <tr className="row" key={e.key}>
                    <td>
                      <select
                        className="ws-detail"
                        style={{ minWidth: 160 }}
                        disabled={!editable}
                        value={e.processKey}
                        onChange={(ev) => updateEdge(e.key, { processKey: ev.target.value })}
                      >
                        {processes.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.code || "—"} — {p.name || "Untitled"}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="ws-detail"
                        style={{ minWidth: 160 }}
                        disabled={!editable}
                        value={e.predecessorKey}
                        onChange={(ev) => updateEdge(e.key, { predecessorKey: ev.target.value })}
                      >
                        {processes.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.code || "—"} — {p.name || "Untitled"}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="ws-detail"
                        style={{ minWidth: 200 }}
                        disabled={!editable}
                        value={e.type}
                        onChange={(ev) => updateEdge(e.key, { type: ev.target.value as EdgeRow["type"] })}
                      >
                        <option value="FINISH_TO_START">{EDGE_TYPE_LABEL.FINISH_TO_START}</option>
                        <option value="START_TO_START_WITH_OVERLAP">{EDGE_TYPE_LABEL.START_TO_START_WITH_OVERLAP}</option>
                      </select>
                    </td>
                    <td className="num">
                      <input
                        className="ws-detail mono"
                        style={{ width: 55, textAlign: "right" }}
                        disabled={!editable}
                        value={e.lagDays}
                        onChange={(ev) => updateEdge(e.key, { lagDays: ev.target.value })}
                      />
                    </td>
                    <td className="num">
                      {editable && (
                        <button className="btn" onClick={() => removeEdge(e.key)}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="emp-hint" style={{ padding: "10px 16px 0" }}>
          Negative lag means this process may start before its predecessor finishes. It changes the schedule
          only — it never lets a process complete out of order.
        </p>
        {editable && (
          <div style={{ padding: "10px 16px 14px" }}>
            <button className="btn" onClick={addEdge}>
              + Add edge
            </button>
          </div>
        )}
      </div>

      {publishOpen && <PublishDialog versionId={view.versionId} onClose={() => setPublishOpen(false)} />}
    </>
  );
}

function PublishDialog({ versionId, onClose }: { versionId: number; onClose: () => void }) {
  const themeClass = useThemeClass();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState("");
  const [expectedDays, setExpectedDays] = useState("");
  const [warnings, setWarnings] = useState<TemplateWarningCode[] | null>(null);
  const [acked, setAcked] = useState<Set<TemplateWarningCode>>(new Set());
  const [blocking, setBlocking] = useState<{ message: string; processCodes: string[] } | null>(null);

  const toggleAck = (code: TemplateWarningCode) => {
    setAcked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // The two-step flow is real, not decorative: the first call always sends
  // acknowledgedWarnings: [] and expects the server's own list of what needs
  // acknowledging back — the client never invents that list itself.
  const submit = (acknowledgedWarnings: TemplateWarningCode[]) => {
    if (!notes.trim()) {
      toast.error("Say where this route's data came from.");
      return;
    }
    startTransition(async () => {
      const input: PublishVersionInput = {
        versionId,
        notes: notes.trim(),
        acknowledgedWarnings,
        expectedEnvelopeDays: expectedDays.trim() ? Number(expectedDays) : null,
      };
      const r = await publishVersionAction(input);
      if (r.ok) {
        toast.success(
          r.warnings && r.warnings.length > 0
            ? `Published — ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"} acknowledged.`
            : "Published.",
        );
        router.refresh();
        onClose();
        return;
      }
      setBlocking(null);
      setWarnings(null);
      const unacked = (r.detail?.unacknowledgedWarnings as TemplateWarningCode[] | undefined) ?? [];
      if (r.code === "TEMPLATE_INCOMPLETE" && unacked.length > 0) {
        setWarnings(unacked);
        setAcked(new Set());
        return;
      }
      const codes = (r.detail?.processCodes as string[] | undefined) ?? [];
      setBlocking({ message: refusalMessage(r.message, r.detail), processCodes: codes });
    });
  };

  const allAcked = warnings != null && warnings.every((w) => acked.has(w));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-ov" />
        <Dialog.Content className={`${themeClass} admin-dialog`} aria-describedby={undefined}>
          <div className="sh-hd">
            <Dialog.Close asChild>
              <button className="sh-x" aria-label="Close">✕</button>
            </Dialog.Close>
            <Dialog.Title asChild><h2>Publish this version</h2></Dialog.Title>
          </div>
          <div className="sh-body">
            <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>Notes *</label>
            <textarea
              className="ws-detail"
              style={{ width: "100%", minHeight: 56, resize: "vertical" }}
              placeholder="Where did this route's data come from? e.g. DESPL Lead Time.pdf, 11 Aug 2026"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={pending}
            />
            <div style={{ marginTop: 12 }}>
              <label className="emp-hint" style={{ display: "block", marginBottom: 4 }}>
                Expected lead time (days)
              </label>
              <input
                className="ws-detail mono"
                style={{ maxWidth: 140 }}
                type="number"
                value={expectedDays}
                onChange={(e) => setExpectedDays(e.target.value)}
                disabled={pending}
              />
            </div>

            {blocking && (
              <div style={{ marginTop: 14 }}>
                <span className="chip c-overdue">
                  <i />
                  {blocking.message}
                </span>
                {blocking.processCodes.length > 0 && (
                  <p className="emp-hint" style={{ marginTop: 6 }}>Processes: {blocking.processCodes.join(", ")}</p>
                )}
                <p className="emp-hint" style={{ marginTop: 6 }}>
                  Close this dialog, fix the draft, save, then publish again.
                </p>
              </div>
            )}

            {warnings && !blocking && (
              <div style={{ marginTop: 14 }}>
                <div className="sh-sec">Confirm before publishing</div>
                {warnings.map((code) => (
                  <label key={code} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 10, fontSize: 12 }}>
                    <input type="checkbox" checked={acked.has(code)} onChange={() => toggleAck(code)} style={{ marginTop: 2 }} />
                    <span>{WARNING_COPY[code]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="sh-ft">
            <button className="btn" onClick={onClose} disabled={pending}>Cancel</button>
            {warnings && !blocking ? (
              <button className="btn btn-accent" disabled={pending || !allAcked} onClick={() => submit([...acked])}>
                {pending ? "Publishing…" : "Publish"}
              </button>
            ) : (
              <button className="btn btn-accent" disabled={pending || blocking != null} onClick={() => submit([])}>
                {pending ? "Publishing…" : "Publish"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
