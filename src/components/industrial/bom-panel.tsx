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
  rejectComponentOperationAction,
} from "@/app/actions/component";
import type { ActionResult } from "@/app/actions/_action";
import { formatBomQty, type BomTree, type BomItemRow, type BomComponentOp, type WelderOption, type DelayCategoryOption } from "@/lib/services/bom.read";
import { groupProjectedRoute } from "@/lib/services/bom-route";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Humanized procurement status label — B5, Phase 4 (matches CLAUDE.md's "humanize enums" copy rule). */
function procurementStatusLabel(status: BomItemRow["procurement"]["status"]): string {
  switch (status) {
    case "NOT_STARTED": return "Not started";
    case "INDENT_RAISED": return "Indent raised";
    case "INDENT_APPROVED": return "Indent approved";
    case "PO_PLACED": return "PO placed";
    case "RECEIPT": return "Received";
  }
}
function procurementChipClass(status: BomItemRow["procurement"]["status"]): string {
  if (status === "RECEIPT") return "c-complete";
  if (status === "NOT_STARTED") return "c-idle";
  return "c-progress";
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
        {selected ? <ComponentDetail jobId={jobId} item={selected} welders={bom.welders} delayCategories={bom.delayCategories} /> : (
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
                  <RouteSteps jobId={jobId} operations={comp.operations} welders={bom.welders} delayCategories={bom.delayCategories} />
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

function ComponentDetail({
  jobId,
  item,
  welders,
  delayCategories,
}: {
  jobId: number;
  item: BomItemRow;
  welders: WelderOption[];
  delayCategories: DelayCategoryOption[];
}) {
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
      const r = await recordMtcAction(jobId, item.id, heatNumber.trim(), pmiResult, mtcRef.trim() || undefined, comp?.id);
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
        <dt>Qty</dt><dd>{formatBomQty(item)}</dd>
        <dt>Required</dt>
        <dd>
          {item.requiredQty != null ? (
            <span className="mono">{item.requiredQty}{item.uom ? ` ${item.uom}` : ""}</span>
          ) : (
            <span style={{ color: "var(--muted)" }}>—</span>
          )}
          {/* SEAM: no StockLot activity at all → shortage stays null, never a fabricated
              "0 available"/"fully short" number (B6 acceptance). */}
          {item.shortage != null && (
            <span className={`chip ${item.shortage > 0 ? "c-overdue" : item.shortage < 0 ? "c-complete" : "c-idle"}`} style={{ marginLeft: 6 }}>
              <i />
              {item.shortage > 0
                ? `Short ${item.shortage}`
                : item.shortage < 0
                  ? `Surplus ${Math.abs(item.shortage)}`
                  : "On hand"}
            </span>
          )}
        </dd>
        <dt>Procurement</dt>
        <dd>
          <span className={`chip ${procurementChipClass(item.procurement.status)}`}>
            <i />{procurementStatusLabel(item.procurement.status)}
          </span>
          {/* receivedQty is `null` (unknown quantity) vs `0`/a number — never collapse the two (B5 acceptance).
              A mixed known+unknown case (hasUnknownReceipt with a non-null receivedQty) must not read as a
              confident total either — task review I1. */}
          {item.procurement.status === "RECEIPT" && (
            <span style={{ marginLeft: 6, color: "var(--muted)", fontSize: 11 }}>
              {item.procurement.receivedQty != null
                ? `${item.procurement.receivedQty} received${item.procurement.hasUnknownReceipt ? ", plus an unrecorded quantity" : ""}`
                : "quantity not recorded"}
            </span>
          )}
        </dd>
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
          {/* B8, Phase 4: heat traces to a specific serial once componentId is set —
              distinct from the equipment-shared BomItem grain everything else here reads at. */}
          {mtc?.componentId != null && (
            <span style={{ marginLeft: 6, color: "var(--muted)", fontSize: 11 }}>
              Traces to {comp && comp.id === mtc.componentId ? comp.tag : `component #${mtc.componentId}`}
            </span>
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
        <RouteSteps jobId={jobId} operations={comp.operations} welders={welders} delayCategories={delayCategories} />
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
function RouteSteps({
  jobId,
  operations,
  welders,
  delayCategories,
}: {
  jobId: number;
  operations: BomComponentOp[];
  welders: WelderOption[];
  delayCategories: DelayCategoryOption[];
}) {
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
            <RouteStepAction jobId={jobId} op={op} pending={pending} run={run} welders={welders} delayCategories={delayCategories} />
          </div>
          <StepMeta op={op} />
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

/** F3/F4/F5 — operator, remarks, quantities and the latest rejection, shown
 * under the step name once recorded. Nothing renders when none are set. */
function StepMeta({ op }: { op: BomComponentOp }) {
  const operator = op.performedByWelderName ?? op.performedByUserName;
  const qty =
    op.qtyPlanned != null || op.qtyGood != null || op.qtyRejected != null
      ? `${op.qtyGood ?? 0}${op.qtyPlanned != null ? `/${op.qtyPlanned}` : ""} good${op.qtyRejected ? ` · ${op.qtyRejected} rejected` : ""}`
      : null;
  const hasMeta = operator || op.remarks || qty || op.rejection;
  if (!hasMeta) return null;
  return (
    <div className="sh-route-step-meta" style={{ padding: "0 0 6px 22px", fontSize: 11, color: "var(--muted)" }}>
      {operator && <span>{operator}</span>}
      {qty && <span>{operator ? " · " : ""}{qty}</span>}
      {op.remarks && <div>{op.remarks}</div>}
      {op.rejection && (
        <div style={{ color: "var(--s-overdue)" }}>
          Rejected — {op.rejection.categoryName}
          {op.rejection.detail ? `: ${op.rejection.detail}` : ""}
        </div>
      )}
    </div>
  );
}

/**
 * Start / Submit / Verify / Reject for one component-route step. Mirrors the
 * always-show-the-button-and-let-the-server-refuse idiom already used by
 * <StageSheetFooter>/my-day's row actions — role/maker-checker enforcement
 * lives server-side (component.service.ts); this is UX, not the gate.
 * A route step merged in from the canonical route with no matching
 * ComponentOperation row yet (`op.id === null`) has nothing to act on.
 * Submit/Reject open a small inline form (F3/F4/F5) instead of firing
 * immediately, since both can carry optional detail.
 */
function RouteStepAction({
  jobId,
  op,
  pending,
  run,
  welders,
  delayCategories,
}: {
  jobId: number;
  op: BomComponentOp;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string) => void;
  welders: WelderOption[];
  delayCategories: DelayCategoryOption[];
}) {
  const [mode, setMode] = useState<"idle" | "submit" | "reject">("idle");
  const [welderId, setWelderId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [qtyGood, setQtyGood] = useState("");
  const [qtyRejected, setQtyRejected] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [detail, setDetail] = useState("");

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

  if (op.status === "IN_PROGRESS") {
    if (mode !== "submit")
      return (
        <button
          type="button"
          className="btn btn-accent sh-route-step-action"
          disabled={pending}
          onClick={(e) => { stop(e); setMode("submit"); }}
        >
          Submit
        </button>
      );
    return (
      <div className="sh-route-step-form" onClick={stop} style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "6px 0" }}>
        <select className="btn" value={welderId} onChange={(e) => setWelderId(e.target.value)} aria-label="Operator / welder">
          <option value="">Operator/welder — none</option>
          {welders.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input className="ws-detail" placeholder="Remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minWidth: 140 }} />
        <input className="ws-detail" type="number" min={0} placeholder="Qty good" value={qtyGood} onChange={(e) => setQtyGood(e.target.value)} style={{ width: 80 }} />
        <input className="ws-detail" type="number" min={0} placeholder="Qty rejected" value={qtyRejected} onChange={(e) => setQtyRejected(e.target.value)} style={{ width: 90 }} />
        <button
          type="button"
          className="btn btn-accent"
          disabled={pending}
          onClick={() => {
            setMode("idle");
            run(
              () =>
                submitComponentOperationAction(jobId, id, {
                  performedByWelderId: welderId ? Number(welderId) : undefined,
                  remarks: remarks.trim() || undefined,
                  qtyGood: qtyGood !== "" ? Number(qtyGood) : undefined,
                  qtyRejected: qtyRejected !== "" ? Number(qtyRejected) : undefined,
                }),
              "Submitted for QC.",
            );
          }}
        >
          Save
        </button>
        <button type="button" className="btn" disabled={pending} onClick={() => setMode("idle")}>Cancel</button>
      </div>
    );
  }

  if (op.status === "SUBMITTED") {
    if (mode === "reject")
      return (
        <div className="sh-route-step-form" onClick={stop} style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "6px 0" }}>
          <select className="btn" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Rejection reason">
            <option value="">Reason…</option>
            {delayCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="ws-detail" placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} style={{ minWidth: 140 }} />
          <button
            type="button"
            className="btn btn-accent"
            disabled={pending || !categoryId}
            onClick={() => {
              setMode("idle");
              run(() => rejectComponentOperationAction(jobId, id, Number(categoryId), detail.trim() || undefined), "Rejected.");
            }}
          >
            Reject
          </button>
          <button type="button" className="btn" disabled={pending} onClick={() => setMode("idle")}>Cancel</button>
        </div>
      );
    return (
      <>
        <button
          type="button"
          className="btn btn-accent sh-route-step-action"
          disabled={pending}
          onClick={(e) => { stop(e); run(() => verifyComponentOperationAction(jobId, id), "Verified."); }}
        >
          Verify
        </button>
        <button
          type="button"
          className="btn sh-route-step-action"
          disabled={pending}
          onClick={(e) => { stop(e); setMode("reject"); }}
        >
          Reject
        </button>
      </>
    );
  }

  return null;
}
