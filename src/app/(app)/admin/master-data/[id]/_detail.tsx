"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Modal, ModalConfirmFooter } from "@/components/industrial/modal";
import { StatusChip } from "@/components/industrial/status-chip";
import { Tabs } from "@/components/industrial/tabs";
import {
  approvePartFamilyAction,
  editPartFamilyAction,
  reviewPartFamiliesAction,
  revisePartFamilyAction,
} from "@/app/actions/master-data";
import type { PartFamilyDetail } from "@/lib/services/master-data.read";
import type { Finding, StepField } from "@/lib/services/master-data.readiness";
import { formatTime, MAKE_BUY_LABEL, partStatus, SCOPE_LABEL, versionStatus } from "../_labels";
import { StepEditor } from "./_step-editor";

const ROUTE_SOURCES = ["Current shop practice", "Client / QAP requirement", "Code / standard", "Assumed – to be confirmed"];

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

type Dialog = "edit" | "approve" | "revise" | null;
type Mark = { kind: "blocker" | "warning"; message: string };

export function PartFamilyDetailView({ detail, variant }: { detail: PartFamilyDetail; variant: string | null }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState(false);
  const [busy, startBusy] = useTransition();

  const active = detail.variants.find((v) => v.variant === variant) ?? detail.variants[0] ?? null;
  const st = partStatus(detail.status);
  const needsPv = detail.scope === "PV" || detail.scope === "BOTH";
  const needsHe = detail.scope === "HE" || detail.scope === "BOTH";
  const opName = useMemo(() => new Map(detail.reference.operations.map((o) => [o.code, o.name])), [detail.reference.operations]);

  // Cell markers for the variant on screen: approval blockers (amber) and warnings (muted).
  const marks = useMemo(() => {
    const m = new Map<string, Mark>();
    if (!active) return m;
    const put = (list: Finding[], kind: Mark["kind"]) => {
      for (const f of list) {
        if (f.variant !== active.variant || f.seq == null) continue;
        for (const field of f.fields) if (!m.has(`${f.seq}:${field}`)) m.set(`${f.seq}:${field}`, { kind, message: f.message });
      }
    };
    put(detail.readiness.blockers, "blocker");
    put(detail.readiness.warnings, "warning");
    return m;
  }, [active, detail.readiness]);

  const changeBySeq = new Map((active?.changes ?? []).map((c) => [c.seq, c]));
  const removed = (active?.changes ?? []).filter((c) => c.kind === "removed").map((c) => c.seq);

  const refuse = (r: { message: string; detail?: Record<string, unknown> }) => {
    const reason = (r.detail as { reason?: string } | undefined)?.reason;
    toast.error(reason ?? r.message);
  };

  const markReviewed = () =>
    startBusy(async () => {
      const r = await reviewPartFamiliesAction([detail.id]);
      if (!r.ok) toast.error(r.message);
      else if (r.refused[0]) toast.error(r.refused[0].message);
      else {
        toast.success("Marked reviewed.");
        router.refresh();
      }
    });

  const jump = (f: Finding) => {
    if (f.variant && f.variant !== active?.variant) router.push(`?v=${f.variant}${f.seq != null ? `#step-${f.seq}` : ""}`);
    else if (f.seq != null) document.getElementById(`step-${f.seq}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    else if (f.code === "ROUTE_SOURCE") setDialog("edit");
  };

  const blockers = detail.readiness.blockers;
  const warnings = detail.readiness.warnings;

  return (
    <>
      <div className="page-h" style={{ flexWrap: "wrap", gap: 8 }}>
        <Link href="/admin/master-data" className="sub" style={{ textDecoration: "none" }}>‹ Master data</Link>
        <h1>
          <span className="mono">{detail.code}</span> {detail.name}
        </h1>
        <StatusChip status={st.status} label={st.label} />
        {detail.selfApproved && <StatusChip status="hold" label="Self-approved" />}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {detail.can.edit && (
            <button type="button" className="btn" onClick={() => setDialog("edit")}>Edit part</button>
          )}
          {detail.can.review && (
            <button type="button" className="btn" disabled={busy} onClick={markReviewed}>Mark reviewed</button>
          )}
          {detail.can.revise && (
            <button type="button" className="btn" onClick={() => setDialog("revise")}>Revise part</button>
          )}
          {detail.can.approveRole && detail.status !== "APPROVED" && (
            <button type="button" className="btn btn-accent" disabled={!detail.can.approve} onClick={() => setDialog("approve")}>
              Approve part
            </button>
          )}
        </div>
      </div>
      {detail.can.approveRole && detail.approveRefusal && detail.status !== "APPROVED" && (
        <p className="note" style={{ textAlign: "left", margin: "0 0 12px" }}>{detail.approveRefusal}</p>
      )}

      <div className="card" style={{ marginBottom: 14, padding: "12px 16px", fontSize: "var(--fs-md, 13px)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span>{SCOPE_LABEL[detail.scope]}</span>
        {detail.assemblyGroup && <><span aria-hidden>·</span><span>{detail.assemblyGroup}</span></>}
        {detail.makeBuy && <><span aria-hidden>·</span><span>{MAKE_BUY_LABEL[detail.makeBuy]}</span></>}
        {detail.rawForm && <><span aria-hidden>·</span><span>{detail.rawForm}</span></>}
        {detail.typicalMoc && <><span aria-hidden>·</span><span className="mono">{detail.typicalMoc}</span></>}
        {detail.weightBasis && <><span aria-hidden>·</span><span>Weight: {detail.weightBasis}</span></>}
        {detail.isSpare && <><span aria-hidden>·</span><span>Also a spare</span></>}
        {detail.dimensionKeys.length > 0 && (
          <span style={{ flexBasis: "100%", color: "var(--muted)" }}>
            Dimensions entered per job: <span className="mono">{detail.dimensionKeys.join(", ")}</span>
          </span>
        )}
        {detail.routeSource && <span style={{ flexBasis: "100%", color: "var(--muted)" }}>Route source: {detail.routeSource}</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginBottom: 14 }}>
        <div className="card">
          <div className="hd"><h3>Approval</h3></div>
          <dl style={{ margin: 0, padding: "0 16px 14px", display: "grid", gridTemplateColumns: "110px 1fr", rowGap: 6, fontSize: "var(--fs-md, 13px)" }}>
            <dt style={{ color: "var(--muted)" }}>Last edited by</dt>
            <dd style={{ margin: 0 }}>{detail.preparedBy ?? "—"}</dd>
            <dt style={{ color: "var(--muted)" }}>Reviewed</dt>
            <dd style={{ margin: 0 }}>
              {detail.reviewedBy ? `${detail.reviewedBy}, ${fmtDate(detail.reviewedAt)}` : detail.status === "APPROVED" ? "Not separately" : "Not yet"}
            </dd>
            <dt style={{ color: "var(--muted)" }}>Approved</dt>
            <dd style={{ margin: 0 }}>
              {detail.approvedBy
                ? `${detail.approvedBy}, ${fmtDate(detail.approvedAt)}`
                : detail.status === "APPROVED"
                  ? "—"
                  : "Waiting for the Production Head"}
              {detail.selfApproved && <span style={{ color: "var(--muted)" }}> · approved by the person who made the last change</span>}
            </dd>
          </dl>
          {detail.status !== "APPROVED" && !detail.can.approveRole && (
            <p className="note" style={{ textAlign: "left", padding: "0 16px 12px", margin: 0 }}>
              Only the Production Head approves master data.
            </p>
          )}
        </div>

        <div className="card" id="readiness">
          <div className="hd"><h3>Before approval</h3></div>
          {blockers.length === 0 ? (
            <p className="note" style={{ textAlign: "left", padding: "0 16px 12px", margin: 0 }}>
              {detail.status === "APPROVED" ? "Approved." : "Nothing blocks approval."}
            </p>
          ) : (
            <ul style={{ margin: 0, padding: "0 16px 12px", listStyle: "none", display: "grid", gap: 6, fontSize: "var(--fs-md, 13px)" }}>
              {blockers.map((b, i) => (
                <li key={i}>
                  <button type="button" className="btn btn-ghost" style={{ textAlign: "left" }} onClick={() => jump(b)}>
                    <span style={{ color: "var(--s-hold)" }} aria-hidden>▲ </span>
                    {b.variant && <span className="mono">{b.variant}{b.seq != null ? ` · ${b.seq}` : ""} </span>}
                    {b.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <details style={{ padding: "0 16px 12px", fontSize: "var(--fs-sm, 12px)", color: "var(--muted)" }}>
              <summary>{warnings.length} to check</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                {warnings.map((w, i) => (
                  <li key={i}>{w.variant && <span className="mono">{w.variant}{w.seq != null ? ` · ${w.seq}` : ""} </span>}{w.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {active == null && !editing ? (
        <div className="card" style={{ padding: 16 }}>
          <p style={{ margin: "0 0 12px", fontSize: "var(--fs-md, 13px)" }}>This part has no route yet.</p>
          {detail.can.edit ? (
            <button type="button" className="btn btn-accent" onClick={() => setEditing(true)}>Add route (variant A)</button>
          ) : detail.can.revise ? (
            <button type="button" className="btn" onClick={() => setDialog("revise")}>Revise part</button>
          ) : null}
        </div>
      ) : (
        <>
          <Tabs
            items={detail.variants.map((v) => {
              const vs = versionStatus(v.status);
              return {
                key: v.variant,
                label: `${v.variant} · ${vs.label} v${v.version}`,
                href: `?v=${v.variant}`,
                active: v.variant === active?.variant,
              };
            })}
          />
        </>
      )}

      {editing && (
        <StepEditor
          partFamilyId={detail.id}
          variant={active?.variant ?? "A"}
          scope={detail.scope}
          steps={(active?.steps ?? []).map((s) => ({ ...s }))}
          signature={active?.signature ?? "[]"}
          blockers={detail.readiness.blockers}
          warnings={detail.readiness.warnings}
          reference={detail.reference}
          canRevise={detail.can.revise}
          onRevise={() => setDialog("revise")}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}

      {active && !editing && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd" style={{ gap: 8, flexWrap: "wrap" }}>
            <StatusChip status={versionStatus(active.status).status} label={`${versionStatus(active.status).label} v${active.version}`} />
            <span className="note" style={{ margin: 0, textAlign: "left" }}>
              {active.status === "DRAFT"
                ? active.liveVersion != null
                  ? `New jobs keep using v${active.liveVersion} until this is approved.`
                  : "Not used by any job until this is approved."
                : "New jobs use this version."}
            </span>
            {detail.can.edit && (
              <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={() => setEditing(true)}>Edit steps</button>
            )}
            {!detail.can.edit && detail.can.revise && (
              <button type="button" className="btn" style={{ marginLeft: "auto" }} onClick={() => setDialog("revise")}>
                Revise to change this route
              </button>
            )}
          </div>
          {active.variant !== detail.variants[0].variant && (
            <p className="note" style={{ textAlign: "left", padding: "0 16px 10px", margin: 0 }}>
              New jobs use variant {detail.variants[0].variant}. This variant is used once BOM release can choose between variants.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th className="num">Step</th>
                  <th>Operation</th>
                  <th>Department</th>
                  <th>Time</th>
                  {needsPv && <th className="num">PV stage</th>}
                  {needsHe && <th className="num">HE stage</th>}
                  <th>Condition</th>
                  <th>QC</th>
                  <th>Acceptance</th>
                  <th>Record</th>
                  {active.changes && <th>Changed</th>}
                </tr>
              </thead>
              <tbody>
                {active.steps.map((s) => {
                  const mk = (field: StepField) => marks.get(`${s.seq}:${field}`);
                  const cellStyle = (field: StepField): React.CSSProperties | undefined => {
                    const m = mk(field);
                    return m?.kind === "blocker" ? { outline: "1px solid var(--s-hold)" } : undefined;
                  };
                  const flag = (field: StepField) => {
                    const m = mk(field);
                    if (!m) return null;
                    return (
                      <span title={m.message} aria-label={m.message} style={{ color: m.kind === "blocker" ? "var(--s-hold)" : "var(--muted)" }}>
                        {m.kind === "blocker" ? "▲ " : "ⓘ "}
                      </span>
                    );
                  };
                  const ch = changeBySeq.get(s.seq);
                  return (
                    <tr className="row" id={`step-${s.seq}`} key={s.seq}>
                      <td className="num mono">{s.seq}</td>
                      <td style={cellStyle("operation")}>{flag("operation")}{opName.get(s.operationCode) ?? s.operationCode}</td>
                      <td style={cellStyle("department")}>{flag("department")}{s.department || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                      <td className="mono" style={cellStyle("stdTime")}>{flag("stdTime")}{formatTime(s.stdTime, s.stdTimeUnit, s.stdTimeBasis)}</td>
                      {needsPv && <td className="num mono" style={cellStyle("pvStage")}>{flag("pvStage")}{s.pvStage ?? "—"}</td>}
                      {needsHe && <td className="num mono" style={cellStyle("heStage")}>{flag("heStage")}{s.heStage ?? "—"}</td>}
                      <td>{s.conditional ? s.conditionText || "Yes" : "—"}</td>
                      <td>{s.requiresQc ? "Yes" : "No"}</td>
                      <td>{s.acceptanceStandard || "—"}</td>
                      <td>{s.recordDocument || "—"}</td>
                      {active.changes && (
                        <td style={{ fontSize: "var(--fs-sm, 12px)" }}>
                          {ch?.kind === "added" && <span className="chip c-progress"><i />New</span>}
                          {ch?.kind === "changed" && <span title={ch.fields.join(", ")}>Changed: {ch.fields.join(", ")}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {removed.length > 0 && (
            <p className="note" style={{ textAlign: "left", padding: "10px 16px 0", margin: 0 }}>
              Removed since v{active.liveVersion}: step{removed.length === 1 ? "" : "s"} <span className="mono">{removed.join(", ")}</span>.
            </p>
          )}
          <p className="note" style={{ textAlign: "left", padding: "10px 16px 14px", margin: 0 }}>
            {active.history
              .map((h) => {
                const vs = versionStatus(h.status);
                const live = h.status === "PUBLISHED" && h.version === active.liveVersion;
                const label = h.status === "PUBLISHED" && !live ? "Superseded" : vs.label;
                return `v${h.version} ${label}${live ? ", used for new jobs" : ""}${h.components > 0 ? `, ${h.components} component${h.components === 1 ? "" : "s"}` : ""}`;
              })
              .join(" · ")}
          </p>
        </div>
      )}

      {dialog === "edit" && <EditPartDialog detail={detail} onClose={() => setDialog(null)} onRefuse={refuse} onDone={() => { setDialog(null); router.refresh(); }} />}
      {dialog === "revise" && <ReviseDialog detail={detail} onClose={() => setDialog(null)} onRefuse={refuse} onDone={() => { setDialog(null); setEditing(false); router.refresh(); }} />}
      {dialog === "approve" && (
        <ApproveDialog
          detail={detail}
          onClose={() => setDialog(null)}
          onBlocked={() => {
            setDialog(null);
            document.getElementById("readiness")?.scrollIntoView?.({ behavior: "smooth" });
            router.refresh();
          }}
          onRefuse={refuse}
          onDone={() => { setDialog(null); router.refresh(); }}
        />
      )}
    </>
  );
}

type DialogProps = {
  detail: PartFamilyDetail;
  onClose: () => void;
  onDone: () => void;
  onRefuse: (r: { message: string; detail?: Record<string, unknown> }) => void;
};

function ApproveDialog({ detail, onClose, onDone, onRefuse, onBlocked }: DialogProps & { onBlocked: () => void }) {
  const [pending, start] = useTransition();
  const publishing = detail.variants.filter((v) => v.status === "DRAFT");
  const confirm = () =>
    start(async () => {
      const r = await approvePartFamilyAction({ partFamilyId: detail.id });
      if (r.ok) {
        toast.success(r.selfApproved ? "Approved. Recorded as self-approved." : "Approved.");
        return onDone();
      }
      if (r.code === "APPROVAL_BLOCKED") {
        const n = (r.detail as { blockers?: unknown[] } | undefined)?.blockers?.length ?? 0;
        toast.error(`Fix ${n || "the listed"} thing${n === 1 ? "" : "s"} first.`);
        return onBlocked();
      }
      onRefuse(r);
    });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Approve ${detail.code}?`}
      footer={<ModalConfirmFooter onCancel={onClose} onConfirm={confirm} confirmLabel={pending ? "Approving…" : "Approve part"} disabled={pending} />}
    >
      <div style={{ display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
        <p style={{ margin: 0 }}>
          {publishing.length > 0
            ? `Publishes ${publishing.map((v) => `variant ${v.variant} v${v.version}`).join(", ")}. Jobs created after this use the published version; jobs already running keep theirs.`
            : "There are no route changes to publish. This approves the part's details."}
        </p>
        {detail.willSelfApprove && (
          <p style={{ margin: 0 }}>
            You made the last change to this part. Approving it yourself is allowed and is recorded as self-approved.
          </p>
        )}
        {detail.status === "DRAFT" && <p style={{ margin: 0, color: "var(--muted)" }}>No one else has reviewed it.</p>}
        {detail.readiness.warnings.length > 0 && (
          <p style={{ margin: 0, color: "var(--muted)" }}>{detail.readiness.warnings.length} things to check remain; they do not block approval.</p>
        )}
      </div>
    </Modal>
  );
}

function ReviseDialog({ detail, onClose, onDone, onRefuse }: DialogProps) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const confirm = () =>
    start(async () => {
      const r = await revisePartFamilyAction({ partFamilyId: detail.id, reason });
      if (r.ok) {
        toast.success("Reopened as a draft. The approved version stays in use until the revision is approved.");
        return onDone();
      }
      onRefuse(r);
    });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Revise ${detail.code}`}
      footer={<ModalConfirmFooter onCancel={onClose} onConfirm={confirm} confirmLabel={pending ? "Reopening…" : "Revise part"} disabled={pending || reason.trim().length < 5} />}
    >
      <div style={{ display: "grid", gap: 10, fontSize: "var(--fs-md, 13px)" }}>
        <p style={{ margin: 0 }}>
          The part goes back to draft. The approved route stays in use for new jobs until the revision is approved.
        </p>
        <label style={{ display: "grid", gap: 4 }}>
          Why is it being revised? (at least 5 characters)
          <textarea className="ws-detail" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function EditPartDialog({ detail, onClose, onDone, onRefuse }: DialogProps) {
  const [f, setF] = useState({
    name: detail.name,
    scope: detail.scope,
    assemblyGroup: detail.assemblyGroup ?? "",
    makeBuy: detail.makeBuy ?? "",
    typicalMoc: detail.typicalMoc ?? "",
    weightBasis: detail.weightBasis ?? "",
    dimensionKeys: detail.dimensionKeys.join(", "),
    routeSource: detail.routeSource ?? "",
    isSpare: detail.isSpare,
  });
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const patch: Record<string, unknown> = {};
      if (f.name.trim() !== detail.name) patch.name = f.name.trim();
      if (f.scope !== detail.scope) patch.equipmentScope = f.scope;
      if (f.assemblyGroup.trim() !== (detail.assemblyGroup ?? "")) patch.assemblyGroup = f.assemblyGroup.trim() || null;
      if (f.makeBuy !== (detail.makeBuy ?? "")) patch.makeBuy = f.makeBuy || null;
      if (f.typicalMoc.trim() !== (detail.typicalMoc ?? "")) patch.typicalMoc = f.typicalMoc.trim() || null;
      if (f.weightBasis.trim() !== (detail.weightBasis ?? "")) patch.weightBasis = f.weightBasis.trim() || null;
      const keys = f.dimensionKeys.split(",").map((k) => k.trim()).filter(Boolean);
      if (JSON.stringify(keys) !== JSON.stringify(detail.dimensionKeys)) patch.dimensionKeys = keys;
      if (f.routeSource.trim() !== (detail.routeSource ?? "")) patch.routeSource = f.routeSource.trim() || null;
      if (f.isSpare !== detail.isSpare) patch.isSpare = f.isSpare;
      if (Object.keys(patch).length === 0) return onClose();
      const r = await editPartFamilyAction({ partFamilyId: detail.id, patch });
      if (r.ok) {
        toast.success("Saved.");
        return onDone();
      }
      onRefuse(r);
    });

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: "grid", gap: 4, fontSize: "var(--fs-sm, 12px)", color: "var(--muted)" }}>
      {label}
      {node}
    </label>
  );
  return (
    <Modal
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${detail.code}`}
      footer={<ModalConfirmFooter onCancel={onClose} onConfirm={save} confirmLabel={pending ? "Saving…" : "Save"} disabled={pending || f.name.trim() === ""} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {field("Name", <input className="ws-detail" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />)}
        {field(
          "Equipment",
          <select className="ws-detail" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as typeof f.scope })}>
            <option value="PV">PV</option>
            <option value="HE">HE</option>
            <option value="BOTH">PV + HE</option>
          </select>,
        )}
        {field("Assembly group", <input className="ws-detail" value={f.assemblyGroup} onChange={(e) => setF({ ...f, assemblyGroup: e.target.value })} />)}
        {field(
          "Make / buy",
          <select className="ws-detail" value={f.makeBuy} onChange={(e) => setF({ ...f, makeBuy: e.target.value })}>
            <option value="">—</option>
            {Object.entries(MAKE_BUY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>,
        )}
        {field("Typical material", <input className="ws-detail" value={f.typicalMoc} onChange={(e) => setF({ ...f, typicalMoc: e.target.value })} />)}
        {field("Weight basis", <input className="ws-detail" value={f.weightBasis} onChange={(e) => setF({ ...f, weightBasis: e.target.value })} />)}
        {field(
          "Route source",
          <>
            <input className="ws-detail" list="route-sources" value={f.routeSource} onChange={(e) => setF({ ...f, routeSource: e.target.value })} />
            <datalist id="route-sources">
              {ROUTE_SOURCES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>,
        )}
        {field("Dimensions entered per job (comma separated)", <input className="ws-detail" value={f.dimensionKeys} onChange={(e) => setF({ ...f, dimensionKeys: e.target.value })} />)}
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "var(--fs-md, 13px)" }}>
          <input type="checkbox" checked={f.isSpare} onChange={(e) => setF({ ...f, isSpare: e.target.checked })} />
          Also a spare
        </label>
      </div>
    </Modal>
  );
}
