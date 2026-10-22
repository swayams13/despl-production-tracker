"use client";

import Link from "next/link";
import type { ScheduleVerdict } from "@/app/actions/job-intake";
import type { IntakeOptions, IntakeFamily } from "@/lib/services/job-intake.read";
import type { CreateJobResult } from "@/lib/services/job-intake.service";
import { plural } from "@/lib/shared/plural";
import { PRIORITY_LABEL, type WizardState } from "./wizard-state";
import type { PreviewState } from "./preview-panel";

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

type Clients = Array<{ id: number; name: string; code: string | null }>;

/** Frame 13F: the delivery window check, what you are about to create, and the Create button. */
export function StepRelease({
  state,
  options,
  clients,
  family,
  version,
  preview,
  onRetryPreview,
  canRelease,
  canCreate,
  blockReason,
  creating,
  createError,
  createdJob,
  verdict,
  onCreate,
  onOpenJob,
}: {
  state: WizardState;
  options: IntakeOptions;
  clients: Clients;
  family: IntakeFamily | null;
  version: IntakeFamily["versions"][number] | null;
  preview: PreviewState;
  onRetryPreview: () => void;
  canRelease: boolean;
  canCreate: boolean;
  blockReason: string | null;
  creating: boolean;
  createError: { message: string; detail?: Record<string, unknown> } | null;
  createdJob: CreateJobResult | undefined;
  verdict: ScheduleVerdict | null;
  onCreate: () => void;
  onOpenJob: () => void;
}) {
  const client = clients.find((c) => c.id === state.clientId);
  const qcp = options.qcpTemplates.find((q) => q.id === state.qcpTemplateSourceId);
  const calendar = options.calendars.find((c) => c.id === state.calendarId);
  const excludedCount = state.excludedProcessCodes.length;
  const data = preview.status === "ok" ? preview.data : preview.status === "loading" || preview.status === "error" ? preview.last : undefined;
  const feasibility = data?.feasibility ?? null;

  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd">
          <h3>Schedule, worked back from {state.committedDeliveryDate ? fmtDate(state.committedDeliveryDate) : "the committed date"}</h3>
          {preview.status === "loading" && <span className="emp-hint" role="status">Checking…</span>}
        </div>
        <div style={{ padding: 16 }}>
          {preview.status === "idle" || (preview.status === "loading" && !data) ? (
            <span className="skel" style={{ height: 18, width: "60%" }} />
          ) : preview.status === "error" && !data ? (
            <div>
              <div className="chip c-overdue" role="alert"><i />{preview.message}</div>
              <div style={{ marginTop: 8 }}><button className="btn" onClick={onRetryPreview}>Try again</button></div>
            </div>
          ) : !feasibility ? (
            <p className="note" style={{ textAlign: "left", margin: 0 }}>
              {state.orderDate ? "The delivery window cannot be checked yet." : "Add an order date on the first step to check the delivery window."} The schedule is still built from the committed date when the job is created.
            </p>
          ) : "dataMissing" in feasibility ? (
            <>
              <div className="chip c-hold"><i />Cannot check yet</div>
              <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>{feasibility.dataMissing} Those processes show as not scheduled. You can still create the job.</p>
            </>
          ) : feasibility.feasibility === "INFEASIBLE" ? (
            <>
              <div className="chip c-overdue"><i />Short by {plural(feasibility.shortfallDays ?? 0, "working day")}</div>
              <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>
                {feasibility.availableWorkingDays} working days from the order to delivery; the route needs {feasibility.requiredMaxDays}. You can still create the job. It is saved with the gap, visible on the job page.
              </p>
            </>
          ) : (
            <>
              <div className={feasibility.feasibility === "TIGHT" ? "chip c-hold" : "chip c-complete"}>
                <i />{feasibility.feasibility === "TIGHT" ? "Tight" : "Fits the delivery window"}
              </div>
              <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>
                {feasibility.availableWorkingDays} working days from the order to delivery; the route needs {feasibility.requiredMinDays === feasibility.requiredMaxDays ? feasibility.requiredMaxDays : `${feasibility.requiredMinDays} to ${feasibility.requiredMaxDays}`}.
              </p>
            </>
          )}
          {data && data.lines.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Line</th><th className="num">Units</th><th>Tracking</th></tr></thead>
              <tbody>
                {state.equipments.map((b) => (
                  <tr className="row" key={b.key}>
                    <td>{b.name || "—"}</td>
                    <td className="num mono">{b.tracking === "LOT" ? b.lotQty : b.serials.filter((s) => s.trim()).length}</td>
                    <td style={{ color: "var(--muted)" }}>{b.tracking === "LOT" ? "One lot, counted" : "Serial units"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {version && version.provisionalCount > 0 && (
            <div className="chip c-hold" style={{ marginTop: 10 }}>
              <i />{version.provisionalCount} process{version.provisionalCount === 1 ? "" : "es"} are provisional, so dates cannot be computed for this job yet.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Order</h3></div>
        <div style={{ padding: 16 }}>
          <dl className="sh-kv">
            <div style={{ display: "contents" }}><dt>Client</dt><dd>{client?.name ?? "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Job number</dt><dd className="mono">{state.jobNumber || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Client order no.</dt><dd>{state.clientOrderNo || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>PO reference</dt><dd>{state.poRef || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Project name</dt><dd>{state.projectName || "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Order date</dt><dd>{state.orderDate ? fmtDate(state.orderDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Committed delivery</dt><dd>{state.committedDeliveryDate ? fmtDate(state.committedDeliveryDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Target dispatch</dt><dd>{state.targetDispatchDate ? fmtDate(state.targetDispatchDate) : "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Priority</dt><dd>{PRIORITY_LABEL[state.priority]}</dd></div>
            <div style={{ display: "contents" }}><dt>Work calendar</dt><dd>{calendar?.name ?? "—"}</dd></div>
            <div style={{ display: "contents" }}><dt>Family and route</dt><dd>{family?.name ?? "—"}{version ? `, ${version.templateName} v${version.version}` : ""}</dd></div>
            <div style={{ display: "contents" }}><dt>Processes</dt><dd>{excludedCount > 0 ? `${excludedCount} left out` : "All included"}</dd></div>
            <div style={{ display: "contents" }}><dt>QC plan</dt><dd>{qcp ? `${qcp.vessel} rev ${qcp.revision}, ${plural(qcp.itemCount, "item")} copied` : "None: no hold points until one is attached"}</dd></div>
          </dl>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="hd"><h3>Equipment lines</h3></div>
        <table>
          <thead><tr><th>Line</th><th className="num">Units</th><th>Serial numbers</th><th>BOM</th></tr></thead>
          <tbody>
            {state.equipments.map((b) => (
              <tr className="row" key={b.key}>
                <td>{b.name || "—"}</td>
                <td className="num mono">{b.tracking === "LOT" ? b.lotQty : b.serials.filter((s) => s.trim()).length}</td>
                <td className="mono" style={{ color: "var(--muted)" }}>{b.tracking === "LOT" ? "One lot, counted" : b.serials.filter((s) => s.trim()).join(", ")}</td>
                <td style={{ color: "var(--muted)" }}>{b.bomMode === "KIT" ? "From the standard kit" : b.bomMode === "COPY" ? "Copied from a previous job" : "Not started"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createError && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--s-overdue)" }}>
          <div style={{ padding: 16 }}>
            <div className="chip c-overdue" role="alert"><i />{createError.message}</div>
            {createError.detail && typeof createError.detail.existingJobId === "number" ? (
              <div style={{ marginTop: 8 }}>
                <Link href={`/jobs/${createError.detail.existingJobId}`} className="btn">View existing job →</Link>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {createdJob && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="hd"><h3>Job created</h3></div>
          <div style={{ padding: 16 }}>
            <p style={{ margin: "0 0 10px" }}>
              <b>{state.jobNumber.trim()}</b>: {plural(createdJob.unitCount, "unit")}, {createdJob.processCount} processes, {createdJob.qcpItemCount} QC points, {createdJob.bomItemCount} BOM lines.
            </p>
            <p className="note" style={{ textAlign: "left", margin: "0 0 10px" }}>
              Floor steps are created when the BOM is released{createdJob.bomItemCount > 0 ? "; the BOM is waiting there as a draft" : ""}.
            </p>
            {createdJob.unmatchedQcpProcessCodes.length > 0 && (
              <p className="note" style={{ textAlign: "left", margin: "0 0 10px" }}>
                {plural(createdJob.unmatchedQcpProcessCodes.length, "QC point")} skipped: no matching process on this route ({createdJob.unmatchedQcpProcessCodes.join(", ")}).
              </p>
            )}
            {verdict ? <VerdictPanel verdict={verdict} /> : <div className="chip c-idle"><i />Computing schedule…</div>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <Link className="btn btn-accent" href={`/jobs/${createdJob.jobId}/release`}>
                Next: release the BOM →
              </Link>
              <button className="btn" onClick={onOpenJob} disabled={!verdict}>
                Open job →
              </button>
            </div>
          </div>
        </div>
      )}

      {!createdJob && canRelease && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-accent" disabled={creating || !canCreate} onClick={onCreate}>
            {creating ? "Creating…" : "Create job"}
          </button>
          {blockReason && <span className="emp-hint" role="status">{blockReason}</span>}
          <span className="emp-hint">Floor steps are created when Engineering releases the BOM.</span>
        </div>
      )}
      {!createdJob && !canRelease && (
        <p className="note" style={{ textAlign: "left" }}>Your draft is saved. The Production Head or an Admin creates the job from it.</p>
      )}
    </>
  );
}

// Split out of StepReview's JSX: TS's control-flow narrowing on a
// multi-value discriminant ("FEASIBLE" | "INFEASIBLE" sharing one union
// member) doesn't survive a chain of ternaries, but does survive an if/else
// in its own function body.
/** J6: quantity bands are stored for these processes but not applied; say so. */
function BandWarning({ warning }: { warning?: { lots: Array<{ name: string; qty: number }>; processes: string[] } | null }) {
  if (!warning) return null;
  return (
    <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>
      Warning: {warning.lots.map((l) => `${l.name} is a lot of ${l.qty}`).join("; ")}. Quantity bands are recorded for {warning.processes.join(", ")} but are not used for these dates, so they assume the normal quantity. Check them against the lot size.
    </p>
  );
}

function VerdictPanel({ verdict }: { verdict: ScheduleVerdict }) {
  switch (verdict.kind) {
    case "FEASIBLE":
      return (
        <>
          <div className="chip c-complete"><i />Schedule feasible — {verdict.planCount} process plans generated</div>
          <BandWarning warning={verdict.qtyBandWarning} />
        </>
      );
    case "INFEASIBLE":
      return (
        <>
          <div className="chip c-overdue"><i />Infeasible by {verdict.shortfallDays ?? "?"} day{verdict.shortfallDays === 1 ? "" : "s"}</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>The schedule was still saved, so the gap is visible on the job page.</p>
          <BandWarning warning={verdict.qtyBandWarning} />
        </>
      );
    case "DATA_MISSING":
      return (
        <>
          <div className="chip c-hold"><i />No schedule yet</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>{verdict.message}</p>
        </>
      );
    case "FAILED":
      return (
        <>
          <div className="chip c-overdue"><i />Scheduling failed</div>
          <p className="note" style={{ textAlign: "left", margin: "8px 0 0" }}>{verdict.message}</p>
        </>
      );
  }
}
