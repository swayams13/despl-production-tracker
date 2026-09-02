"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { STAGE_STATUS } from "./stage-status";
import {
  startAssemblyStepAction,
  submitAssemblyStepAction,
  verifyAssemblyStepAction,
  rejectAssemblyStepAction,
} from "@/app/actions/assembly";
import type { ActionResult } from "@/app/actions/_action";
import type { AssemblyGrid, AssemblyStepRow } from "@/lib/services/assembly.read";

function mapStatus(status: string): "idle" | "progress" | "submitted" | "complete" {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}
function statusLabel(status: string): string {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "in progress";
  return "not started";
}

export function AssemblyPanel({ jobId, data }: { jobId: number; data: AssemblyGrid }) {
  const router = useRouter();
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(data.groups[0] ? [data.groups[0].groupCode] : []),
  );
  const [pending, start] = useTransition();

  if (!data.hasTemplate) {
    return (
      <p className="note" style={{ margin: "16px 0" }}>
        No assembly template pinned for this job&apos;s product family yet — the A–Q sequence has not been authored for it.
      </p>
    );
  }
  if (data.groups.length === 0) {
    return <p className="note" style={{ margin: "16px 0" }}>No units on this job yet.</p>;
  }

  const toggle = (code: string) =>
    setOpenGroups((s) => {
      const next = new Set(s);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const run = (fn: () => Promise<ActionResult>, ok: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(ok);
        router.refresh();
      }
    });

  const totalSteps = data.groups.reduce((n, g) => n + g.steps.length, 0);
  const doneSteps = data.groups.reduce((n, g) => n + g.steps.filter((s) => s.status === "COMPLETE").length, 0);

  return (
    <div className="card" style={{ gridColumn: "1 / -1" }}>
      <div className="hd">
        <h3>Assembly &amp; weld sequence — A to Q</h3>
        <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
          {doneSteps} of {totalSteps} complete
        </span>
        {data.units.length > 1 && (
          <select
            className="btn"
            style={{ marginLeft: 8 }}
            value={data.unitId ?? ""}
            onChange={(e) => router.push(`/jobs/${jobId}?tab=assembly&unit=${e.target.value}`)}
            aria-label="Unit"
          >
            {data.units.map((u) => (
              <option key={u.id} value={u.id}>{u.serialNo}</option>
            ))}
          </select>
        )}
      </div>
      <div>
        {data.groups.map((g) => {
          const groupDone = g.steps.filter((s) => s.status === "COMPLETE").length;
          return (
            <div key={g.groupCode} className={`bom-grp${openGroups.has(g.groupCode) ? " open" : ""}`}>
              <div className="bom-hd" onClick={() => toggle(g.groupCode)}>
                <span className="car">▶</span>
                {g.groupCode}. {g.groupName}
                <span className="cnt">{groupDone}/{g.steps.length}</span>
              </div>
              <div className="sh-route" style={{ padding: "4px 16px 10px" }}>
                {g.steps.map((step) => (
                  <AssemblyStepItem
                    key={step.id}
                    jobId={jobId}
                    step={step}
                    pending={pending}
                    run={run}
                    welders={data.welders}
                    delayCategories={data.delayCategories}
                    testTypes={data.testTypes}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AssemblyStepItem({
  jobId,
  step,
  pending,
  run,
  welders,
  delayCategories,
  testTypes,
}: {
  jobId: number;
  step: AssemblyStepRow;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string) => void;
  welders: AssemblyGrid["welders"];
  delayCategories: AssemblyGrid["delayCategories"];
  testTypes: AssemblyGrid["testTypes"];
}) {
  return (
    <div className="sh-route-step">
      <div className="sh-route-step-hd">
        <i style={{ background: STAGE_STATUS[mapStatus(step.status)].colorVar }} />
        <span className="sh-route-step-name">
          <span className="mono" style={{ color: "var(--muted)", fontSize: 10 }}>{step.srNo}</span> {step.activity}
          {step.kind === "INSPECTION" && <span className="sh-route-step-badge">INSP</span>}
        </span>
        <span className="sh-route-step-status">{statusLabel(step.status)}</span>
        <AssemblyStepAction
          jobId={jobId}
          step={step}
          pending={pending}
          run={run}
          welders={welders}
          delayCategories={delayCategories}
          testTypes={testTypes}
        />
      </div>
      <AssemblyStepMeta step={step} />
    </div>
  );
}

function AssemblyStepMeta({ step }: { step: AssemblyStepRow }) {
  const operator = step.performedByWelderName ?? step.performedByUserName;
  const hasMeta = operator || step.remarks || step.weldJoint || step.rejection;
  if (!hasMeta) return null;
  return (
    <div className="sh-route-step-meta" style={{ padding: "0 0 6px 22px", fontSize: 11, color: "var(--muted)" }}>
      {operator && <span>{operator}</span>}
      {step.weldJoint && (
        <span>
          {operator ? " · " : ""}Joint {step.weldJoint.jointNo} ({step.weldJoint.jointType})
          {step.weldJoint.welderNames.length > 0 ? ` — ${step.weldJoint.welderNames.join(", ")}` : ""}
          {step.weldJoint.ndtResults.map((n) => ` · ${n.testTypeName}: ${n.result}`).join("")}
        </span>
      )}
      {step.remarks && <div>{step.remarks}</div>}
      {step.rejection && (
        <div style={{ color: "var(--s-overdue)" }}>
          Rejected — {step.rejection.categoryName}
          {step.rejection.detail ? `: ${step.rejection.detail}` : ""}
        </div>
      )}
    </div>
  );
}

/**
 * Start / Submit / Verify / Reject for one assembly step. Same
 * always-show-and-let-the-server-refuse idiom as bom-panel.tsx's
 * RouteStepAction. A WORK step whose template step carries a `jointRef`
 * (the three single-joint weld groups — LS-1/CS-2/CS-1) gets an inline
 * joint-log form on Submit (one welder — the existing single-picker UX this
 * app already uses for the operator field; the spec's "welder(s)" plural is
 * served by the Welding page's own multi-welder picker for joints logged
 * there directly). A reject on a step with a bound joint offers an optional
 * NDT test type, so "PAUT/TOFD reject" is one action from QC's side.
 */
function AssemblyStepAction({
  jobId,
  step,
  pending,
  run,
  welders,
  delayCategories,
  testTypes,
}: {
  jobId: number;
  step: AssemblyStepRow;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok: string) => void;
  welders: AssemblyGrid["welders"];
  delayCategories: AssemblyGrid["delayCategories"];
  testTypes: AssemblyGrid["testTypes"];
}) {
  const [mode, setMode] = useState<"idle" | "submit" | "reject">("idle");
  const [performedByWelderId, setPerformedByWelderId] = useState("");
  const [remarks, setRemarks] = useState("");
  const [jointNo, setJointNo] = useState(step.jointRef ?? "");
  const [jointType, setJointType] = useState("");
  const [jointWelderId, setJointWelderId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [detail, setDetail] = useState("");
  const [testTypeId, setTestTypeId] = useState("");

  const needsNewJoint = step.jointRef != null && step.weldJoint == null;

  if (step.status === "NOT_STARTED")
    return (
      <button
        type="button"
        className="btn btn-accent sh-route-step-action"
        disabled={pending}
        onClick={() => run(() => startAssemblyStepAction(jobId, step.id), "Started.")}
      >
        Start
      </button>
    );

  if (step.status === "IN_PROGRESS") {
    if (mode !== "submit")
      return (
        <button
          type="button"
          className="btn btn-accent sh-route-step-action"
          disabled={pending}
          onClick={() => setMode("submit")}
        >
          Submit
        </button>
      );
    return (
      <div className="sh-route-step-form" style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "6px 0" }}>
        <select className="btn" value={performedByWelderId} onChange={(e) => setPerformedByWelderId(e.target.value)} aria-label="Operator / welder">
          <option value="">Operator/welder — none</option>
          {welders.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <input className="ws-detail" placeholder="Remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} style={{ minWidth: 140 }} />
        {needsNewJoint && (
          <>
            <input className="ws-detail" placeholder="Joint no. (e.g. LS-1)" value={jointNo} onChange={(e) => setJointNo(e.target.value)} style={{ width: 110 }} />
            <input className="ws-detail" placeholder="Joint type" value={jointType} onChange={(e) => setJointType(e.target.value)} style={{ width: 110 }} />
            <select className="btn" value={jointWelderId} onChange={(e) => setJointWelderId(e.target.value)} aria-label="Welder">
              <option value="">Welder…</option>
              {welders.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </>
        )}
        <button
          type="button"
          className="btn btn-accent"
          disabled={pending || (needsNewJoint && (!jointNo.trim() || !jointType.trim() || !jointWelderId))}
          onClick={() => {
            setMode("idle");
            run(
              () =>
                submitAssemblyStepAction(jobId, step.id, {
                  performedByWelderId: performedByWelderId ? Number(performedByWelderId) : undefined,
                  remarks: remarks.trim() || undefined,
                  ...(needsNewJoint
                    ? { newJoint: { jointNo: jointNo.trim(), jointType: jointType.trim(), welderIds: [Number(jointWelderId)] } }
                    : {}),
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

  if (step.status === "SUBMITTED") {
    if (mode === "reject")
      return (
        <div className="sh-route-step-form" style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "6px 0" }}>
          <select className="btn" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Rejection reason">
            <option value="">Reason…</option>
            {delayCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="ws-detail" placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} style={{ minWidth: 140 }} />
          {step.weldJoint && (
            <select className="btn" value={testTypeId} onChange={(e) => setTestTypeId(e.target.value)} aria-label="NDT test type">
              <option value="">NDT result (optional)…</option>
              {testTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <button
            type="button"
            className="btn btn-accent"
            disabled={pending || !categoryId}
            onClick={() => {
              setMode("idle");
              run(
                () =>
                  rejectAssemblyStepAction(
                    jobId,
                    step.id,
                    Number(categoryId),
                    detail.trim() || undefined,
                    testTypeId ? Number(testTypeId) : undefined,
                  ),
                "Rejected.",
              );
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
          onClick={() => run(() => verifyAssemblyStepAction(jobId, step.id), "Verified.")}
        >
          Verify
        </button>
        <button
          type="button"
          className="btn sh-route-step-action"
          disabled={pending}
          onClick={() => setMode("reject")}
        >
          Reject
        </button>
      </>
    );
  }

  return null;
}
