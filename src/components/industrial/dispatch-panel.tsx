"use client";

import { useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createDispatchBatchAction,
  addUnitToBatchAction,
  approveDispatchReleaseAction,
  recordDispatchAction,
} from "@/app/actions/dispatch";
import type { ActionResult } from "@/app/actions/_action";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { DispatchPanel as DispatchPanelData, DispatchBatchRow } from "@/lib/services/dispatch.read";

type Refusal = { code: string; message: string };

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** Inline refusal display — same stronger pattern as packing-panel.tsx / my-day, not toast-only. */
function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 11 }} onClick={stop}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)", flex: "1 1 160px" }}>{refusal.message}</span>
    </div>
  );
}

/**
 * Display status for a DispatchBatch — the underlying enum (PLANNED/
 * RELEASED/DISPATCHED) comes straight from `loadDispatchPanel`'s
 * `deriveDispatchBatchStatus` call (dispatch.service.ts), never
 * re-derived here from the nullable columns. This only maps that already-
 * derived enum onto the shared chip vocabulary + label.
 */
function statusMeta(status: DispatchBatchRow["status"]): { status: StageDisplayStatus; label: string } {
  switch (status) {
    case "PLANNED": return { status: "idle", label: "Planned" };
    case "RELEASED": return { status: "progress", label: "Released" };
    case "DISPATCHED": return { status: "complete", label: "Dispatched" };
  }
}

/**
 * Which action is legal next, purely a function of the already-derived
 * `status` (PLANNED -> approveRelease, RELEASED -> recordDispatch,
 * DISPATCHED -> none) — the same linear order
 * dispatch.service.ts's DISPATCH_BATCH_TRANSITIONS encodes. Only the
 * server's assertDispatchBatchTransition is authoritative; this just
 * decides which single button to show.
 */
function nextAction(status: DispatchBatchRow["status"]): "approveRelease" | "recordDispatch" | null {
  if (status === "PLANNED") return "approveRelease";
  if (status === "RELEASED") return "recordDispatch";
  return null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function DispatchPanel({
  jobId,
  data,
  canManageDispatch,
}: {
  jobId: number;
  data: DispatchPanelData;
  canManageDispatch: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const onResult = (r: ActionResult, ok?: string) => {
    if (!r.ok) {
      setRefusal({ code: r.code, message: r.message });
      toast.error(r.message);
    } else {
      setRefusal(null);
      if (ok) toast.success(ok);
      router.refresh();
    }
  };

  const hasBatches = data.batches.length > 0;

  return (
    <div className="card">
      <div className="hd">
        <h3>Dispatch</h3>
        {canManageDispatch && !creating && (
          <button className="btn btn-accent" style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
            + New batch
          </button>
        )}
      </div>

      {!hasBatches && !creating ? (
        <div style={{ padding: 16 }}>
          <p className="note" style={{ margin: "0 0 10px" }}>
            No dispatch batches for this job yet.
          </p>
          {canManageDispatch && (
            <button className="btn btn-accent" onClick={() => setCreating(true)}>
              + New batch
            </button>
          )}
          <RefusalNote refusal={refusal} />
        </div>
      ) : (
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          {creating && (
            <CreateBatchForm
              jobId={jobId}
              existingSeqs={data.batches.map((b) => b.seq)}
              onDone={(r) => {
                setCreating(false);
                if (r) onResult(r, "Dispatch batch created.");
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          {data.batches.map((batch) => (
            <BatchCard
              key={batch.id}
              jobId={jobId}
              batch={batch}
              packedUnits={data.packedUnits}
              canManageDispatch={canManageDispatch}
              onResult={onResult}
            />
          ))}
          <RefusalNote refusal={refusal} />
        </div>
      )}
    </div>
  );
}

function CreateBatchForm({
  jobId,
  existingSeqs,
  onDone,
  onCancel,
}: {
  jobId: number;
  existingSeqs: number[];
  onDone: (r: ActionResult | null) => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [seq, setSeq] = useState(String(Math.max(0, ...existingSeqs) + 1));
  const [plannedDate, setPlannedDate] = useState("");
  const [remarks, setRemarks] = useState("");

  const save = () => {
    const n = Number(seq);
    if (!Number.isInteger(n) || n <= 0) return toast.error("Batch no. must be a positive integer.");
    if (existingSeqs.includes(n)) return toast.error("A batch with this number already exists.");
    if (!plannedDate) return toast.error("Planned date is required.");

    start(async () => {
      const r = await createDispatchBatchAction(jobId, n, new Date(plannedDate), remarks.trim() || undefined);
      onDone(r);
    });
  };

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div style={{ padding: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input
          className="ws-detail"
          type="number"
          min={1}
          placeholder="Batch no."
          value={seq}
          onChange={(e) => setSeq(e.target.value)}
          style={{ width: 100 }}
          autoFocus
        />
        <input
          className="ws-detail"
          type="date"
          value={plannedDate}
          onChange={(e) => setPlannedDate(e.target.value)}
          style={{ width: 150 }}
          aria-label="Planned dispatch date"
        />
        <input
          className="ws-detail"
          placeholder="Remarks (optional)"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button className="btn btn-accent" disabled={pending} onClick={save}>
          Save
        </button>
        <button className="btn" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function BatchCard({
  jobId,
  batch,
  packedUnits,
  canManageDispatch,
  onResult,
}: {
  jobId: number;
  batch: DispatchBatchRow;
  packedUnits: DispatchPanelData["packedUnits"];
  canManageDispatch: boolean;
  onResult: (r: ActionResult, ok?: string) => void;
}) {
  const [addUnitPending, startAddUnit] = useTransition();
  const [releasePending, startRelease] = useTransition();
  const [dispatchPending, startDispatch] = useTransition();
  const [addUnitId, setAddUnitId] = useState("");
  const [approving, setApproving] = useState(false);
  const meta = statusMeta(batch.status);
  const action = nextAction(batch.status);

  const addUnit = () => {
    if (!addUnitId) return;
    startAddUnit(async () => {
      const r = await addUnitToBatchAction(jobId, batch.id, Number(addUnitId));
      if (r.ok) setAddUnitId("");
      onResult(r, "Unit added to batch.");
    });
  };

  const recordDispatchNow = () => {
    startDispatch(async () => {
      const r = await recordDispatchAction(jobId, batch.id);
      onResult(r, "Dispatch recorded.");
    });
  };

  return (
    <div className="card" style={{ background: "var(--surface-2)" }}>
      <div className="hd">
        <b className="mono">Batch {batch.seq}</b>
        <StatusChip status={meta.status} label={meta.label} />
        <span className="sub">Planned {fmtDate(batch.plannedDate)}</span>
        {batch.vehicleNo && <span className="sub mono">{batch.vehicleNo}</span>}
      </div>
      <div style={{ padding: 12, display: "grid", gap: 8 }}>
        {batch.remarks && (
          <p className="note" style={{ margin: 0 }}>
            {batch.remarks}
          </p>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {batch.units.length === 0 ? (
            <span className="note">No units in this batch yet.</span>
          ) : (
            batch.units.map((u) => (
              <span key={u.id} className="chip">
                Unit {u.serialNo}
              </span>
            ))
          )}
        </div>

        {canManageDispatch && batch.status === "PLANNED" && packedUnits.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              className="btn"
              value={addUnitId}
              onChange={(e) => setAddUnitId(e.target.value)}
              aria-label={`Add a unit into batch ${batch.seq}`}
            >
              <option value="">Add unit…</option>
              {packedUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  Unit {u.serialNo}
                </option>
              ))}
            </select>
            <button className="btn btn-accent" disabled={addUnitPending || !addUnitId} onClick={addUnit}>
              Add
            </button>
          </div>
        )}

        {batch.status === "DISPATCHED" && batch.actualDispatchDate && (
          <p className="note" style={{ margin: 0 }}>
            Dispatched {fmtDate(batch.actualDispatchDate)}
            {batch.dispatchNoteNo && ` · Note ${batch.dispatchNoteNo}`}
            {batch.gatePassNo && ` · Gate pass ${batch.gatePassNo}`}
            {batch.lrNo && ` · LR ${batch.lrNo}`}
          </p>
        )}

        {/* Only the legal next transition is ever offered — mirrors
            DISPATCH_BATCH_TRANSITIONS's linear PLANNED -> RELEASED ->
            DISPATCHED order; the server (assertDispatchBatchTransition)
            remains authoritative regardless of what renders here. */}
        {canManageDispatch && action === "approveRelease" && !approving && (
          <button className="btn btn-accent" style={{ justifySelf: "start" }} onClick={() => setApproving(true)}>
            Approve release
          </button>
        )}
        {canManageDispatch && action === "approveRelease" && approving && (
          <ApproveReleaseForm
            jobId={jobId}
            batchId={batch.id}
            pending={releasePending}
            start={startRelease}
            onDone={(r) => {
              setApproving(false);
              if (r) onResult(r, "Release approved.");
            }}
            onCancel={() => setApproving(false)}
          />
        )}
        {canManageDispatch && action === "recordDispatch" && (
          <button className="btn btn-accent" style={{ justifySelf: "start" }} disabled={dispatchPending} onClick={recordDispatchNow}>
            Record dispatch
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * All four fields required in this form by product decision (Swayam, 4 Sep
 * 2026) — the schema itself keeps them optional (String? on DispatchBatch),
 * this is a stricter UI-level requirement only, not a service-layer change.
 */
function ApproveReleaseForm({
  jobId,
  batchId,
  pending,
  start,
  onDone,
  onCancel,
}: {
  jobId: number;
  batchId: number;
  pending: boolean;
  start: (fn: () => Promise<void>) => void;
  onDone: (r: ActionResult | null) => void;
  onCancel: () => void;
}) {
  const [dispatchNoteNo, setDispatchNoteNo] = useState("");
  const [gatePassNo, setGatePassNo] = useState("");
  const [vehicleNo, setVehicleNo] = useState("");
  const [lrNo, setLrNo] = useState("");

  const save = () => {
    if (!dispatchNoteNo.trim()) return toast.error("Dispatch note no. is required.");
    if (!gatePassNo.trim()) return toast.error("Gate pass no. is required.");
    if (!vehicleNo.trim()) return toast.error("Vehicle no. is required.");
    if (!lrNo.trim()) return toast.error("LR no. is required.");

    start(async () => {
      const r = await approveDispatchReleaseAction(jobId, batchId, {
        dispatchNoteNo: dispatchNoteNo.trim(),
        gatePassNo: gatePassNo.trim(),
        vehicleNo: vehicleNo.trim(),
        lrNo: lrNo.trim(),
      });
      onDone(r);
    });
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input className="ws-detail" placeholder="Dispatch note no." value={dispatchNoteNo} onChange={(e) => setDispatchNoteNo(e.target.value)} style={{ width: 140 }} autoFocus />
      <input className="ws-detail" placeholder="Gate pass no." value={gatePassNo} onChange={(e) => setGatePassNo(e.target.value)} style={{ width: 130 }} />
      <input className="ws-detail" placeholder="Vehicle no." value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} style={{ width: 130 }} />
      <input className="ws-detail" placeholder="LR no." value={lrNo} onChange={(e) => setLrNo(e.target.value)} style={{ width: 130 }} />
      <button className="btn btn-accent" disabled={pending} onClick={save}>
        Approve release
      </button>
      <button className="btn" disabled={pending} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
