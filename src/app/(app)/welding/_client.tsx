"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { logWeldJointAction, recordNdtResultAction } from "@/app/actions/welding";
import { createWelderAction, updateWelderAction } from "@/app/actions/welder";
import type { WeldingView, WeldJointOption, WelderRegistryRow } from "@/lib/services/welding.read";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

const NDT_RESULT_LABEL: Record<string, string> = { PENDING: "Pending", ACCEPT: "Accept", REJECT: "Repair" };
const NDT_RESULT_CHIP: Record<string, string> = { PENDING: "c-submitted", ACCEPT: "c-complete", REJECT: "c-overdue" };

function sparklinePoints(values: number[]): string {
  const max = Math.max(1, ...values);
  const w = 70;
  const h = 20;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 2).toFixed(1)}`).join(" ");
}

export function WeldingClient({
  view,
  jobs,
  canManageWelders,
}: {
  view: WeldingView;
  jobs: { jobId: number; jobNumber: string }[];
  canManageWelders: boolean;
}) {
  const [logging, setLogging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [managing, setManaging] = useState(false);

  return (
    <>
      <div className="page-h">
        <h1>Welding</h1>
        <span className="sub">Butt-weld joints tracked per welder · NDT linked</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }} className="sub">
          <span>
            Team avg <b className="mono" style={{ color: "var(--text)" }}>{view.teamAvgJoints}</b> joints
          </span>
          <span>
            repair rate{" "}
            <b className="mono" style={{ color: "var(--text)" }}>
              {view.teamRepairRatePct == null ? "—" : `${view.teamRepairRatePct}%`}
            </b>
          </span>
          {canManageWelders && (
            <button className="btn" onClick={() => setManaging((v) => !v)}>
              {managing ? "Close registry" : "Manage welders…"}
            </button>
          )}
          <button className="btn btn-accent" onClick={() => setLogging((v) => !v)}>
            {logging ? "Cancel" : "Log joint…"}
          </button>
        </span>
      </div>

      {managing && canManageWelders && (
        <WelderRegistryPanel welders={view.welderRegistry} departments={view.departments} />
      )}

      {logging && (
        <LogJointForm jobs={jobs} welders={view.welders} onDone={() => setLogging(false)} />
      )}

      {view.welders.length === 0 ? (
        <p className="note" style={{ padding: "0 24px" }}>
          No welders in the registry yet. Add welders via Admin before logging joints.
        </p>
      ) : (
        <div className="weld-grid">
          {view.welders.map((w) => (
            <div key={w.welderId} className={`weld-card${w.flagged ? " warn" : ""}`}>
              <h4>{w.name}</h4>
              <div className="role">{w.roleLabel}</div>
              <div className="weld-stats">
                <span>
                  <b className="mono">{w.jointsCount}</b>joints · all jobs
                </span>
                <span>
                  <b className="mono">
                    <span className={`delta ${w.vsTeamAvgPct == null ? "" : w.vsTeamAvgPct >= 0 ? "d-good" : "d-bad"}`}>
                      {w.vsTeamAvgPct == null ? "—" : `${w.vsTeamAvgPct > 0 ? "+" : ""}${w.vsTeamAvgPct}%`}
                    </span>
                  </b>
                  vs team avg
                </span>
                <span>
                  <b className="mono" style={{ color: w.flagged ? "var(--s-overdue)" : "var(--text)" }}>
                    {w.repairRatePct == null ? "—" : `${w.repairRatePct}%`}
                  </b>
                  NDT repair rate
                </span>
                <span>
                  <svg width="70" height="20" viewBox="0 0 70 20">
                    <polyline
                      points={sparklinePoints(w.sparkline14d)}
                      fill="none"
                      stroke={w.flagged ? "#F0524D" : "#4C8DFF"}
                      strokeWidth={1.5}
                    />
                  </svg>
                  <span style={{ fontSize: 10 }}>14-day output</span>
                </span>
              </div>
              {w.flagged && (
                <div style={{ marginTop: 10 }}>
                  <span className="chip c-overdue">
                    <i />
                    Repair rate above threshold — review WPS adherence
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid-h" style={{ marginTop: 0 }}>
        <div className="card">
          <div className="hd">
            <h3>Open joints per welder — balance workload</h3>
          </div>
          <div style={{ padding: "8px 0" }}>
            {view.openJointsByWelder.length === 0 ? (
              <p className="note" style={{ padding: "0 16px" }}>No open joints — every logged joint has an NDT result.</p>
            ) : (
              view.openJointsByWelder.map((r) => {
                const max = Math.max(1, ...view.openJointsByWelder.map((x) => x.openCount));
                return (
                  <div className="gbar-row" key={r.welderId}>
                    <span style={{ color: "var(--muted)" }}>{r.welderName}</span>
                    <div className="gbar">
                      <i style={{ width: `${(r.openCount / max) * 100}%`, background: "rgba(76,141,255,.75)" }} />
                    </div>
                    <span className="mono num">{r.openCount} open</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="card">
          <div className="hd">
            <h3>Recent NDT results</h3>
            <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setRecording((v) => !v)}>
              {recording ? "Cancel" : "Record result…"}
            </button>
          </div>
          {recording && (
            <RecordNdtForm jobs={jobs} testTypes={view.testTypes} onDone={() => setRecording(false)} />
          )}
          {view.recentNdt.length === 0 ? (
            <p className="note" style={{ padding: "12px 16px" }}>No NDT results recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Joint</th>
                  <th>Job / unit</th>
                  <th>Welder(s)</th>
                  <th>Method</th>
                  <th>Result</th>
                  <th className="num">Date</th>
                </tr>
              </thead>
              <tbody>
                {view.recentNdt.map((n) => (
                  <tr className="row" key={n.ndtResultId}>
                    <td className="mono" style={{ color: "var(--muted)" }}>{n.jointNo}</td>
                    <td className="mono">{n.jobNumber} · {n.unitLabel}</td>
                    <td>{n.welderNames || "—"}</td>
                    <td className="mono">{n.testTypeCode}</td>
                    <td>
                      <span className={`chip ${NDT_RESULT_CHIP[n.result] ?? "c-submitted"}`}>
                        <i />
                        {NDT_RESULT_LABEL[n.result] ?? n.result}
                      </span>
                    </td>
                    <td className="num mono" style={{ color: "var(--muted)" }}>{fmtDate(n.recordedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

/** A5 (Phase 2) — Welder had no write path at all before this; the wrapping
 * page gates visibility to ADMIN/PRODUCTION_HEAD (server also enforces it —
 * this is UX, not the gate). Inline add form + a flat list with
 * name/department edit and an active toggle; no delete (deactivate only —
 * historical ComponentOperation/AssemblyStep/WeldJointWelder rows keep
 * resolving the welder). */
function WelderRegistryPanel({
  welders,
  departments,
}: {
  welders: WelderRegistryRow[];
  departments: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDepartmentId, setEditDepartmentId] = useState("");

  const addWelder = () => {
    if (!name.trim()) return toast.error("Name is required.");
    if (!employeeCode.trim()) return toast.error("Employee code is required.");
    start(async () => {
      const r = await createWelderAction({
        name: name.trim(),
        employeeCode: employeeCode.trim(),
        departmentId: departmentId ? Number(departmentId) : null,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Welder added.");
        setName("");
        setEmployeeCode("");
        setDepartmentId("");
        router.refresh();
      }
    });
  };

  const startEdit = (w: WelderRegistryRow) => {
    setEditingId(w.id);
    setEditName(w.name);
    setEditDepartmentId(w.departmentId != null ? String(w.departmentId) : "");
  };

  const saveEdit = (id: number) => {
    start(async () => {
      const r = await updateWelderAction({
        id,
        name: editName.trim() || undefined,
        departmentId: editDepartmentId ? Number(editDepartmentId) : null,
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Welder updated.");
        setEditingId(null);
        router.refresh();
      }
    });
  };

  const toggleActive = (w: WelderRegistryRow) => {
    start(async () => {
      const r = await updateWelderAction({ id: w.id, active: !w.active });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(w.active ? "Welder deactivated." : "Welder reactivated.");
        router.refresh();
      }
    });
  };

  return (
    <div className="card" style={{ margin: "0 24px 14px", padding: 16 }}>
      <div className="hd" style={{ padding: 0, marginBottom: 10 }}>
        <h3>Welder registry</h3>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input className="ws-detail" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ minWidth: 140 }} />
        <input className="ws-detail" placeholder="Employee code" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} style={{ minWidth: 120 }} />
        <select className="btn" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
          <option value="">Department (optional)…</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button className="btn btn-accent" disabled={pending} onClick={addWelder}>Add welder</button>
      </div>
      {welders.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>No welders in the registry yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Employee code</th>
              <th>Department</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {welders.map((w) => (
              <tr className="row" key={w.id}>
                {editingId === w.id ? (
                  <>
                    <td><input className="ws-detail" value={editName} onChange={(e) => setEditName(e.target.value)} /></td>
                    <td className="mono" style={{ color: "var(--muted)" }}>{w.employeeCode}</td>
                    <td>
                      <select className="btn" value={editDepartmentId} onChange={(e) => setEditDepartmentId(e.target.value)} aria-label="Department">
                        <option value="">—</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </td>
                    <td>{w.active ? "Active" : "Inactive"}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-accent" disabled={pending} onClick={() => saveEdit(w.id)}>Save</button>
                      <button className="btn" disabled={pending} onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{w.name}</td>
                    <td className="mono" style={{ color: "var(--muted)" }}>{w.employeeCode}</td>
                    <td>{w.departmentName ?? "—"}</td>
                    <td>
                      <span className={`chip ${w.active ? "c-complete" : "c-idle"}`}><i />{w.active ? "Active" : "Inactive"}</span>
                    </td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <button className="btn" disabled={pending} onClick={() => startEdit(w)}>Edit</button>
                      <button className="btn" disabled={pending} onClick={() => toggleActive(w)}>
                        {w.active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LogJointForm({
  jobs,
  welders,
  onDone,
}: {
  jobs: { jobId: number; jobNumber: string }[];
  welders: WeldingView["welders"];
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [jobId, setJobId] = useState<number | "">("");
  const [units, setUnits] = useState<{ unitId: number; serialNo: string }[]>([]);
  const [unitId, setUnitId] = useState<number | "">("");
  const [jointNo, setJointNo] = useState("");
  const [jointType, setJointType] = useState("");
  const [weldSize, setWeldSize] = useState("");
  const [wpsRef, setWpsRef] = useState("");
  const [welderIds, setWelderIds] = useState<Set<number>>(new Set());

  const onJobChange = async (v: string) => {
    const id = v ? Number(v) : "";
    setJobId(id);
    setUnitId("");
    setUnits([]);
    if (!id) return;
    const res = await fetch(`/api/jobs/${id}/spine`);
    if (res.ok) {
      const body: { units: { unitId: number; serialNo: string }[] } = await res.json();
      setUnits(body.units.map((u) => ({ unitId: u.unitId, serialNo: u.serialNo })));
    }
  };

  const toggleWelder = (id: number) =>
    setWelderIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = () => {
    if (!jobId) return toast.error("Choose a job.");
    if (!jointNo.trim()) return toast.error("Joint number is required.");
    if (!jointType.trim()) return toast.error("Joint type is required.");
    if (welderIds.size === 0) return toast.error("Choose at least one welder.");
    start(async () => {
      const r = await logWeldJointAction({
        jobId,
        unitId: unitId || undefined,
        jointNo: jointNo.trim(),
        jointType: jointType.trim(),
        weldSize: weldSize.trim() || undefined,
        wpsRef: wpsRef.trim() || undefined,
        welderIds: [...welderIds],
      });
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("Joint logged.");
        onDone();
      }
    });
  };

  return (
    <div className="card" style={{ margin: "0 24px 14px", padding: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <select className="btn" value={jobId} onChange={(e) => onJobChange(e.target.value)} aria-label="Job">
          <option value="">Job…</option>
          {jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.jobNumber}</option>)}
        </select>
        <select className="btn" value={unitId} onChange={(e) => setUnitId(e.target.value ? Number(e.target.value) : "")} aria-label="Unit" disabled={units.length === 0}>
          <option value="">Unit (optional)…</option>
          {units.map((u) => <option key={u.unitId} value={u.unitId}>Unit {u.serialNo}</option>)}
        </select>
        <input className="ws-detail" placeholder="Joint no. (e.g. LS-1)" value={jointNo} onChange={(e) => setJointNo(e.target.value)} style={{ minWidth: 140 }} />
        <input className="ws-detail" placeholder="Type (e.g. Longitudinal seam)" value={jointType} onChange={(e) => setJointType(e.target.value)} style={{ minWidth: 160 }} />
        <input className="ws-detail" placeholder="Weld size (optional)" value={weldSize} onChange={(e) => setWeldSize(e.target.value)} style={{ minWidth: 120 }} />
        <input className="ws-detail" placeholder="WPS ref (optional)" value={wpsRef} onChange={(e) => setWpsRef(e.target.value)} style={{ minWidth: 120 }} />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        {welders.map((w) => (
          <label key={w.welderId} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, color: "var(--muted)" }}>
            <input type="checkbox" checked={welderIds.has(w.welderId)} onChange={() => toggleWelder(w.welderId)} />
            {w.name}
          </label>
        ))}
      </div>
      <button className="btn btn-accent" disabled={pending} onClick={submit}>Log joint</button>
    </div>
  );
}

function RecordNdtForm({
  jobs,
  testTypes,
  onDone,
}: {
  jobs: { jobId: number; jobNumber: string }[];
  testTypes: { id: number; code: string; name: string }[];
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [jobId, setJobId] = useState<number | "">("");
  const [joints, setJoints] = useState<WeldJointOption[]>([]);
  const [weldJointId, setWeldJointId] = useState<number | "">("");
  const [testTypeId, setTestTypeId] = useState<number | "">("");
  const [result, setResult] = useState<"PENDING" | "ACCEPT" | "REJECT">("ACCEPT");

  const onJobChange = async (v: string) => {
    const id = v ? Number(v) : "";
    setJobId(id);
    setWeldJointId("");
    setJoints([]);
    if (!id) return;
    const res = await fetch(`/api/welding/joints?job=${id}`);
    if (res.ok) {
      const body: { joints: WeldJointOption[] } = await res.json();
      setJoints(body.joints);
    }
  };

  const submit = () => {
    if (!weldJointId) return toast.error("Choose a joint.");
    if (!testTypeId) return toast.error("Choose a test method.");
    start(async () => {
      const r = await recordNdtResultAction(weldJointId, testTypeId, result);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success("NDT result recorded.");
        onDone();
      }
    });
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 16px 14px" }}>
      <select className="btn" value={jobId} onChange={(e) => onJobChange(e.target.value)} aria-label="Job">
        <option value="">Job…</option>
        {jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.jobNumber}</option>)}
      </select>
      <select className="btn" value={weldJointId} onChange={(e) => setWeldJointId(e.target.value ? Number(e.target.value) : "")} aria-label="Joint" disabled={joints.length === 0}>
        <option value="">Joint…</option>
        {joints.map((j) => <option key={j.weldJointId} value={j.weldJointId}>{j.jointNo} · {j.unitLabel}</option>)}
      </select>
      <select className="btn" value={testTypeId} onChange={(e) => setTestTypeId(e.target.value ? Number(e.target.value) : "")} aria-label="Method">
        <option value="">Method…</option>
        {testTypes.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
      </select>
      <select className="btn" value={result} onChange={(e) => setResult(e.target.value as "PENDING" | "ACCEPT" | "REJECT")} aria-label="Result">
        <option value="ACCEPT">Accept</option>
        <option value="REJECT">Repair</option>
        <option value="PENDING">Pending</option>
      </select>
      <button className="btn btn-accent" disabled={pending} onClick={submit}>Record</button>
    </div>
  );
}
