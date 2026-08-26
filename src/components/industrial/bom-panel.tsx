"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { StatusChip } from "./status-chip";
import { STAGE_STATUS } from "./stage-status";
import { recordMtcAction } from "@/app/actions/bom";
import {
  startComponentOperationAction,
  submitComponentOperationAction,
  verifyComponentOperationAction,
} from "@/app/actions/component";
import type { ActionResult } from "@/app/actions/_action";
import type { BomTree, BomItemRow, BomComponentOp } from "@/lib/services/bom.read";
import { groupProjectedRoute } from "@/lib/services/bom-route";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

export function BomPanel({ jobId, bom }: { jobId: number; bom: BomTree }) {
  const router = useRouter();
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(bom.groups[0] ? [bom.groups[0].name] : []));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Derived from the current `bom` prop (not a stored snapshot) so a
  // router.refresh() after a mutation (e.g. Record MTC) reflects immediately
  // instead of showing the pre-mutation object.
  const selected = selectedId != null ? bom.groups.flatMap((g) => g.items).find((it) => it.id === selectedId) ?? null : null;

  if (bom.equipments.length === 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No BOM loaded for this job.</p>;
  }

  const toggle = (name: string) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const totalItems = bom.groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="grid-2">
      <div className="card">
        <div className="hd">
          <h3>Bill of materials — {bom.equipmentName}</h3>
          <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{totalItems} items</span>
          {bom.equipments.length > 1 && (
            <select
              className="btn"
              style={{ marginLeft: 8 }}
              value={bom.equipmentId}
              onChange={(e) => router.push(`/jobs/${jobId}?tab=bom&equipment=${e.target.value}`)}
              aria-label="Equipment"
            >
              {bom.equipments.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
            </select>
          )}
        </div>
        <div>
          {totalItems === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>No BOM items recorded for this equipment.</p>
          ) : (
            bom.groups.map((g) => (
              <div key={g.name} className={`bom-grp${openGroups.has(g.name) ? " open" : ""}`}>
                <div className="bom-hd" onClick={() => toggle(g.name)}>
                  <span className="car">▶</span>{g.name}<span className="cnt">{g.items.length} items</span>
                </div>
                <div className="bom-items">
                  {g.items.map((it) => {
                    const comp = it.components[0];
                    return (
                      <div
                        key={it.id}
                        className={`bom-item${selected?.id === it.id ? " selected" : ""}`}
                        onClick={() => setSelectedId(it.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <span>
                          {it.partName}
                          <div className="mat">{it.material ?? "—"}{it.mtc[0] ? ` · ${it.mtc[0].heatNumber}` : ""}</div>
                        </span>
                        <span className="spine-mini">
                          {(comp?.operations.length ? comp.operations.map((op) => op.status) : ["NOT_STARTED"]).map((status, k) => (
                            <i key={k} style={{ background: STAGE_STATUS[mapOpStatus(status)].colorVar }} />
                          ))}
                        </span>
                        <StatusChip status={comp?.displayStatus ?? "idle"} />
                        <button className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(it.id); }}>→</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="hd">
          <h3>{selected ? `Component — ${selected.partName}` : "Select an item"}</h3>
          {selected?.components[0] && <StatusChip status={selected.components[0].displayStatus} />}
        </div>
        {selected ? <ComponentDetail jobId={jobId} item={selected} /> : (
          <p className="note" style={{ margin: "16px 0" }}>Click a BOM item on the left to view its component detail.</p>
        )}
      </div>

      {bom.subAssemblyComponents.length > 0 && (
        <SubAssemblyComponents jobId={jobId} bom={bom} />
      )}
    </div>
  );
}

/**
 * `Component` rows with no linked `BomItem` (no real procurement BOM export
 * exists for this job yet — see `BomTree.subAssemblyComponents`). Rendered as
 * its own expandable list, not folded into the BOM-item grid above and not
 * sharing that grid's `selectedId` state — these ids are `Component.id`, a
 * different id space than `BomItem.id`, and keeping them in a visually
 * separate section with its own toggle state avoids any risk of collision.
 */
function SubAssemblyComponents({ jobId, bom }: { jobId: number; bom: BomTree }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const router = useRouter();
  const components = bom.subAssemblyComponents;

  return (
    <div className="card" style={{ gridColumn: "1 / -1" }}>
      <div className="hd">
        <h3>Sub-assembly components — {components.length} tracked</h3>
        <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>No procurement BOM export yet — routed directly from the component register</span>
        {bom.units.length > 1 && (
          <select
            className="btn"
            style={{ marginLeft: 8 }}
            value={bom.unitId ?? ""}
            onChange={(e) => router.push(`/jobs/${jobId}?tab=bom&equipment=${bom.equipmentId}&unit=${e.target.value}`)}
            aria-label="Unit"
          >
            {bom.units.map((u) => <option key={u.id} value={u.id}>{u.serialNo}</option>)}
          </select>
        )}
      </div>
      <div>
        {components.map((comp) => (
          <div key={comp.id}>
            <div
              className={`bom-item${openId === comp.id ? " selected" : ""}`}
              onClick={() => setOpenId((s) => (s === comp.id ? null : comp.id))}
              role="button"
              tabIndex={0}
            >
              <span>
                {comp.tag}
                <div className="mat">{comp.componentTypeName ?? "—"}</div>
              </span>
              <span className="spine-mini">
                {(comp.operations.length ? comp.operations.map((op) => op.status) : ["NOT_STARTED"]).map((status, k) => (
                  <i key={k} style={{ background: STAGE_STATUS[mapOpStatus(status)].colorVar }} />
                ))}
              </span>
              <StatusChip status={comp.displayStatus} />
              <button className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); setOpenId((s) => (s === comp.id ? null : comp.id)); }}>{openId === comp.id ? "×" : "→"}</button>
            </div>
            {openId === comp.id && (
              <div style={{ padding: "12px 16px" }}>
                {comp.operations.length > 0 ? (
                  <RouteSteps jobId={jobId} operations={comp.operations} />
                ) : (
                  <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No component instance / operation route recorded yet.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function mapOpStatus(status: string): "idle" | "progress" | "submitted" | "complete" {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

function ComponentDetail({ jobId, item }: { jobId: number; item: BomItemRow }) {
  const comp = item.components[0];
  const [recording, setRecording] = useState(false);
  const [heatNumber, setHeatNumber] = useState("");
  const [mtcRef, setMtcRef] = useState("");
  const [pmiResult, setPmiResult] = useState<"NA" | "PENDING" | "ACCEPT" | "REJECT">("PENDING");
  const [pending, start] = useTransition();
  const router = useRouter();

  const mtc = item.mtc[0] ?? null;

  const submitMtc = () => {
    if (!heatNumber.trim()) return toast.error("Heat number is required.");
    start(async () => {
      const r = await recordMtcAction(jobId, item.id, heatNumber.trim(), pmiResult, mtcRef.trim() || undefined);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("MTC recorded.");
        setRecording(false);
        setHeatNumber("");
        setMtcRef("");
        router.refresh();
      }
    });
  };

  return (
    <div style={{ padding: "14px 16px" }}>
      <div className="sh-kv">
        <dt>Material</dt><dd>{item.material ?? "—"}</dd>
        <dt>Qty</dt><dd>{item.qty}</dd>
        <dt>Heat no.</dt><dd className="mono">{mtc?.heatNumber ?? "—"}</dd>
        <dt>MTC</dt>
        <dd>
          {mtc ? (
            <span className={`chip ${mtc.pmiResult === "ACCEPT" ? "c-complete" : mtc.pmiResult === "REJECT" ? "c-overdue" : "c-idle"}`}>
              <i />{mtc.pmiResult === "ACCEPT" ? "Verified" : mtc.pmiResult === "REJECT" ? "Rejected" : mtc.pmiResult}
              {mtc.mtcRef ? ` · ${mtc.mtcRef}` : ""}
            </span>
          ) : (
            <span style={{ color: "var(--muted)" }}>Not recorded</span>
          )}
        </dd>
      </div>

      {recording ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          <input className="ws-detail" placeholder="Heat number" value={heatNumber} onChange={(e) => setHeatNumber(e.target.value)} style={{ flex: 1, minWidth: 120 }} autoFocus />
          <input className="ws-detail" placeholder="MTC ref (optional)" value={mtcRef} onChange={(e) => setMtcRef(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
          <select className="btn" value={pmiResult} onChange={(e) => setPmiResult(e.target.value as typeof pmiResult)} aria-label="PMI result">
            <option value="PENDING">PMI pending</option>
            <option value="ACCEPT">PMI accept</option>
            <option value="REJECT">PMI reject</option>
            <option value="NA">PMI N/A</option>
          </select>
          <button className="btn btn-accent" disabled={pending} onClick={submitMtc}>Save</button>
          <button className="btn" disabled={pending} onClick={() => setRecording(false)}>Cancel</button>
        </div>
      ) : (
        <button className="btn" style={{ marginBottom: 14 }} onClick={() => setRecording(true)}>Record MTC…</button>
      )}

      <div className="sh-sec">Component route</div>
      {comp && comp.operations.length > 0 ? (
        <RouteSteps jobId={jobId} operations={comp.operations} />
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No component instance / operation route recorded yet.</p>
      )}

      <div className="sh-sec">Process log</div>
      {comp && comp.operations.some((o) => o.startedAt || o.finishedAt) ? (
        <div className="sh-hist">
          {comp.operations
            .filter((o) => o.startedAt || o.finishedAt)
            .map((o, i) => (
              <div key={i}>
                {o.operationName} — {o.status === "COMPLETE" ? "complete" : o.status === "IN_PROGRESS" ? "in progress" : o.status.toLowerCase()}
                <small>{o.finishedAt ? fmtDate(o.finishedAt) : o.startedAt ? `started ${fmtDate(o.startedAt)}` : ""}</small>
              </div>
            ))}
        </div>
      ) : (
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>No activity yet.</p>
      )}
    </div>
  );
}

function stepStatusLabel(status: string): string {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "in progress";
  return "not started";
}

/** Full planned route (§ component route projection): a leading run of completed steps
 * collapses into one chip so a component deep into fabrication doesn't render its whole
 * finished history every time — the current/next steps are what matter day to day. */
function RouteSteps({ jobId, operations }: { jobId: number; operations: BomComponentOp[] }) {
  const { collapsedDoneCount, visible } = groupProjectedRoute(operations);
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const router = useRouter();
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<ActionResult>, ok: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(ok);
        router.refresh();
      }
    });

  return (
    <div className="sh-route">
      {collapsedDoneCount > 0 && (
        <div className="chip c-complete sh-route-collapsed">
          <i />{collapsedDoneCount} step{collapsedDoneCount > 1 ? "s" : ""} complete
        </div>
      )}
      {visible.map((op) => (
        <div key={op.seq} className="sh-route-step">
          <div className="sh-route-step-hd">
            <button
              type="button"
              className="sh-route-step-toggle"
              onClick={() => setOpenSeq((s) => (s === op.seq ? null : op.seq))}
              aria-expanded={openSeq === op.seq}
              disabled={op.qcpCheckpoints.length === 0}
            >
              <i style={{ background: STAGE_STATUS[mapOpStatus(op.status)].colorVar }} />
              <span className="sh-route-step-name">{op.operationName}</span>
              <span className="sh-route-step-status">{stepStatusLabel(op.status)}</span>
              {op.qcpCheckpoints.length > 0 && (
                <span className="sh-route-step-badge">{op.qcpCheckpoints.length} QCP</span>
              )}
            </button>
            <RouteStepAction jobId={jobId} op={op} pending={pending} run={run} />
          </div>
          {openSeq === op.seq && op.qcpCheckpoints.length > 0 && (
            <div className="sh-route-step-checkpoints">
              {op.qcpCheckpoints.map((cp) => (
                <div key={cp.qcpItemId}>
                  <span className="mono">{cp.srNo}</span> {cp.activity}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Start / Submit / Verify for one component-route step. Mirrors the
 * always-show-the-button-and-let-the-server-refuse idiom already used by
 * <StageSheetFooter>/my-day's row actions — role/maker-checker enforcement
 * lives server-side (component.service.ts); this is UX, not the gate.
 * A route step merged in from the canonical route with no matching
 * ComponentOperation row yet (`op.id === null`) has nothing to act on.
 */
function RouteStepAction({
  jobId,
  op,
  pending,
  run,
}: {
  jobId: number;
  op: BomComponentOp;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string) => void;
}) {
  if (op.id == null) return null;
  const id = op.id;
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  if (op.status === "NOT_STARTED")
    return (
      <button
        type="button"
        className="btn btn-accent sh-route-step-action"
        disabled={pending}
        onClick={(e) => { stop(e); run(() => startComponentOperationAction(jobId, id), "Started."); }}
      >
        Start
      </button>
    );
  if (op.status === "IN_PROGRESS")
    return (
      <button
        type="button"
        className="btn btn-accent sh-route-step-action"
        disabled={pending}
        onClick={(e) => { stop(e); run(() => submitComponentOperationAction(jobId, id), "Submitted for QC."); }}
      >
        Submit
      </button>
    );
  if (op.status === "SUBMITTED")
    return (
      <button
        type="button"
        className="btn btn-accent sh-route-step-action"
        disabled={pending}
        onClick={(e) => { stop(e); run(() => verifyComponentOperationAction(jobId, id), "Verified."); }}
      >
        Verify
      </button>
    );
  return null;
}
