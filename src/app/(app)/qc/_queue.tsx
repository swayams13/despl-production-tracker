"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/industrial/page-header";
import { inspectAction } from "@/app/actions/work";
import { recordQcpEvidenceAction, approveQcpWaiverAction } from "@/app/actions/qcp";
import { dispositionNcrAction, ratifyConcessionAction } from "@/app/actions/ncr";
import type { ActionResult } from "@/app/actions/_action";
import type { QcQueueView } from "@/lib/services/qc-queue.read";
import {
  HOLD_STATUS_LABEL,
  qcHref,
  type HoldRow,
  type JobGroup,
  type NcrQueueRow,
  type QcTab,
  type ReadyRow,
} from "@/lib/shared/qc-queue";

type Refusal = { key: string; code: string; message: string };
type Disposition = "USE_AS_IS" | "REPAIR" | "REWORK" | "SCRAP" | "CONCESSION";

const TAB_LABEL: Record<QcTab, string> = { ready: "Ready to inspect", holds: "Open holds", ncrs: "NCRs" };
const STATUS_CHIP: Record<string, string> = {
  AWAITING_TPI: "c-hold",
  PENDING: "c-idle",
  QC_REVIEW: "c-submitted",
  REINSPECT: "c-overdue",
  WAIVER_PENDING: "c-hold",
};
const NCR_CHIP: Record<string, string> = { OPEN: "c-overdue", DISPOSITIONED: "c-hold", REWORK_IN_PROGRESS: "c-progress" };
const NCR_LABEL: Record<string, string> = { OPEN: "Needs disposition", DISPOSITIONED: "Dispositioned", REWORK_IN_PROGRESS: "In rework" };

const ageText = (d: number) => (d <= 0 ? "today" : `${d} d`);

export function QcQueueClient({ view, viewerId }: { view: QcQueueView; viewerId: number }) {
  const { access, query, counts } = view;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  /** One write: the refusal stays on its row (never toast-only), success refreshes the lists. */
  const act = (key: string, fn: () => Promise<ActionResult | ({ ok: true } & Record<string, unknown>)>, done: string) =>
    start(async () => {
      const r = (await fn()) as ActionResult;
      if (!r.ok) {
        setRefusal({ key, code: r.code, message: r.message });
        return;
      }
      setRefusal(null);
      setOpenKey(null);
      toast.success(done);
      router.refresh();
    });

  const ctx = { access, pending, openKey, setOpenKey, refusal, setRefusal, act, viewerId };
  const readOnly = !access.inspect;

  return (
    <>
      <PageHeader title="QC queue" subtitle="Oldest first · grouped by job and unit" />

      <nav className="qq-tabs" aria-label="QC queue sections">
        {(Object.keys(TAB_LABEL) as QcTab[]).map((t) => (
          <Link
            key={t}
            href={qcHref({ tab: t, jobId: query.jobId, unitId: query.unitId })}
            className={`qq-tab${t === query.tab ? " on" : ""}`}
            aria-current={t === query.tab ? "page" : undefined}
          >
            {TAB_LABEL[t]} <b className="mono">{counts[t]}</b>
          </Link>
        ))}
      </nav>

      <div className="qq-filters">
        <select
          aria-label="Job"
          value={query.jobId ?? ""}
          onChange={(e) => router.push(qcHref({ tab: query.tab, jobId: e.target.value ? Number(e.target.value) : null }))}
        >
          <option value="">All jobs</option>
          {view.jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.jobNumber}
            </option>
          ))}
        </select>
        {query.unitId != null && (
          <Link className="qq-chip" href={qcHref({ tab: query.tab, jobId: query.jobId })}>
            Unit {view.unitSerial ?? query.unitId} <span aria-hidden>×</span>
            <span className="sr-only"> clear the unit filter</span>
          </Link>
        )}
        {readOnly && <span className="qq-ro">Read only: QC inspects, the Production Head approves waivers.</span>}
      </div>

      {query.tab === "ready" && <Groups groups={view.ready} empty="Nothing is waiting for QC." render={(r) => <ReadyItem key={r.key} row={r} {...ctx} />} />}
      {query.tab === "holds" && <Groups groups={view.holds} empty="No open hold points." render={(r) => <HoldItem key={r.key} row={r} {...ctx} />} />}
      {query.tab === "ncrs" && <Groups groups={view.ncrs} empty="No open NCRs." render={(r) => <NcrItem key={r.ncrId} row={r} {...ctx} />} />}

      {view.pages > 1 && (
        <div className="qq-pager" role="navigation" aria-label="Pages">
          {view.page > 1 ? (
            <Link className="btn" href={qcHref({ ...query, page: view.page - 1 })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="mono">
            {view.page} / {view.pages} · {view.total} items
          </span>
          {view.page < view.pages ? (
            <Link className="btn" href={qcHref({ ...query, page: view.page + 1 })}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </>
  );
}

type Ctx = {
  access: QcQueueView["access"];
  pending: boolean;
  openKey: string | null;
  setOpenKey: (k: string | null) => void;
  refusal: Refusal | null;
  setRefusal: (r: Refusal | null) => void;
  act: (key: string, fn: () => Promise<ActionResult | ({ ok: true } & Record<string, unknown>)>, done: string) => void;
  viewerId: number;
};

function Groups<T extends { jobId: number; jobNumber: string; unitId: number | null; serialNo: string | null }>({
  groups,
  empty,
  render,
}: {
  groups: JobGroup<T>[];
  empty: string;
  render: (r: T) => React.ReactNode;
}) {
  if (groups.length === 0) return <p className="note">{empty}</p>;
  return (
    <>
      {groups.map((g) => (
        <section className="qq-job" key={g.jobId} aria-label={g.jobNumber}>
          <h2>
            <span className="mono">{g.jobNumber}</span> <span className="qq-n">{g.count} on this page</span>
          </h2>
          {g.units.map((u) => (
            <div className="qq-unit" key={u.unitId ?? "none"}>
              <h3>{u.serialNo ? `Unit ${u.serialNo}` : "Whole job"}</h3>
              <ul className="qq-rows">{u.rows.map(render)}</ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function Refused({ r, k }: { r: Refusal | null; k: string }) {
  if (!r || r.key !== k) return null;
  return (
    <div className="qq-refusal" role="alert">
      <span className="chip c-overdue">
        <i />
        {r.code}
      </span>
      <span>{r.message}</span>
    </div>
  );
}

function ReadyItem({ row, access, pending, openKey, setOpenKey, refusal, setRefusal, act }: Ctx & { row: ReadyRow }) {
  const [reason, setReason] = useState("");
  const rejecting = openKey === row.key;
  const target = { kind: row.kind, targetId: row.id } as const;
  return (
    <li>
      <div className="qq-line">
        <div className="qq-main">
          <b>{row.title}</b>
          {row.group && <span className="qq-sub"> · {row.group}</span>}
          <div className="qq-meta">
            {row.inspection ? "Inspection · recorded by QC" : `Done by ${row.makerName ?? "—"}`}
            {row.deptName ? ` · ${row.deptName}` : ""} · waiting <span className="mono">{ageText(row.ageDays)}</span>
          </div>
        </div>
        {access.inspect && !rejecting && (
          <span className="qq-acts">
            <button className="btn btn-accent" disabled={pending} onClick={() => act(row.key, () => inspectAction({ ...target, result: "ACCEPT" }), "Accepted.")}>
              Accept
            </button>
            <button className="btn" disabled={pending} onClick={() => { setRefusal(null); setOpenKey(row.key); }}>
              Reject…
            </button>
          </span>
        )}
      </div>
      {rejecting && (
        <div className="qq-form">
          <input aria-label="Reason for rejecting" placeholder="What is wrong (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            className="btn btn-accent"
            disabled={pending || !reason.trim()}
            onClick={() => act(row.key, () => inspectAction({ ...target, result: "REJECT", reason }), "Rejected. An NCR is open.")}
          >
            Reject
          </button>
          <button className="btn" disabled={pending} onClick={() => setOpenKey(null)}>
            Cancel
          </button>
        </div>
      )}
      <Refused r={refusal} k={row.key} />
    </li>
  );
}

function HoldItem({ row, access, pending, openKey, setOpenKey, refusal, setRefusal, act }: Ctx & { row: HoldRow }) {
  const [remarks, setRemarks] = useState("");
  const [inspector, setInspector] = useState("");
  const [report, setReport] = useState("");
  const [pressure, setPressure] = useState("");
  const [hold, setHold] = useState("");
  const [gauges, setGauges] = useState("");
  const open = openKey === row.key;
  const base = { qcpItemId: row.qcpItemId, unitId: row.unitId! };

  const clear = () => {
    const gaugeIds = gauges.split(",").map((g) => g.trim()).filter(Boolean);
    const testData = row.testPoint ? { pressureBar: Number(pressure), holdMinutes: Number(hold), gaugeIds } : undefined;
    if (testData && !(testData.pressureBar > 0 && testData.holdMinutes > 0 && gaugeIds.length > 0)) {
      setRefusal({ key: row.key, code: "VALIDATION_FAILED", message: "Enter the test pressure, the hold time and at least one gauge ID." });
      return;
    }
    act(
      row.key,
      () =>
        recordQcpEvidenceAction({
          ...base,
          result: "ACCEPTED",
          remarks: remarks.trim() || undefined,
          partyInspector: row.external ? inspector.trim() || undefined : undefined,
          reportRef: row.external ? report.trim() || undefined : undefined,
          testData,
        }),
      "Cleared.",
    );
  };

  return (
    <li>
      <div className="qq-line">
        <div className="qq-main">
          <span className="mono qq-sr">{row.srNo}</span> <span className="hclass" title="Hold class">{row.classCode}</span>{" "}
          <b>{row.activity}</b>
          <div className="qq-meta">
            {row.parties} · <span className={`chip ${STATUS_CHIP[row.status] ?? "c-idle"}`}><i />{HOLD_STATUS_LABEL[row.status]}</span> · open{" "}
            <span className="mono">{ageText(row.ageDays)}</span>
          </div>
        </div>
        {!open && (
          <span className="qq-acts">
            {access.inspect && row.status !== "WAIVER_PENDING" && (
              <button className="btn" disabled={pending} onClick={() => { setRefusal(null); setOpenKey(row.key); }}>
                Record…
              </button>
            )}
            {access.waive && row.waiverPending && (
              <button className="btn btn-accent" disabled={pending} onClick={() => act(row.key, () => approveQcpWaiverAction(base.qcpItemId, base.unitId), "Waiver approved.")}>
                Approve waiver
              </button>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="qq-form qq-grid">
          {row.external && (
            <>
              <input aria-label="Third-party inspector" placeholder="Inspector's name (required)" value={inspector} onChange={(e) => setInspector(e.target.value)} />
              <input aria-label="Report or IRN number" placeholder="Report / IRN no. (required)" value={report} onChange={(e) => setReport(e.target.value)} />
            </>
          )}
          {row.testPoint && (
            <>
              <input aria-label="Test pressure (bar)" inputMode="decimal" placeholder="Test pressure, bar" value={pressure} onChange={(e) => setPressure(e.target.value)} />
              <input aria-label="Hold time (minutes)" inputMode="decimal" placeholder="Hold time, minutes" value={hold} onChange={(e) => setHold(e.target.value)} />
              <input aria-label="Gauge IDs" placeholder="Gauge IDs, comma separated" value={gauges} onChange={(e) => setGauges(e.target.value)} />
            </>
          )}
          <input aria-label="Remarks" placeholder="Remarks (required to reject)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          <span className="qq-acts">
            <button className="btn btn-accent" disabled={pending} onClick={clear}>
              Clear point
            </button>
            <button
              className="btn"
              disabled={pending || !remarks.trim()}
              onClick={() => act(row.key, () => recordQcpEvidenceAction({ ...base, result: "REJECTED", remarks: remarks.trim() }), "Rejected. It needs reinspection.")}
            >
              Reject point
            </button>
            <button className="btn" disabled={pending} onClick={() => setOpenKey(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      <Refused r={refusal} k={row.key} />
    </li>
  );
}

function NcrItem({ row, access, pending, openKey, setOpenKey, refusal, setRefusal, act, viewerId }: Ctx & { row: NcrQueueRow }) {
  const key = `NCR:${row.ncrId}`;
  const [disposition, setDisposition] = useState<Disposition>("REWORK");
  const [notes, setNotes] = useState("");
  const [clause, setClause] = useState("");
  const [due, setDue] = useState("");
  const open = openKey === key;
  const rework = disposition === "REWORK" || disposition === "REPAIR";
  return (
    <li>
      <div className="qq-line">
        <div className="qq-main">
          <b>{row.entityLabel}</b> <span className="chip c-overdue"><i />{row.categoryName}</span>
          <div className="qq-meta">
            <span className={`chip ${NCR_CHIP[row.status] ?? "c-idle"}`}><i />{row.awaitingRatification ? "Awaiting QC ratification" : NCR_LABEL[row.status]}</span>
            {" · "}raised by {row.raisedByName} · <span className="mono">{ageText(row.ageDays)}</span>
            {row.detail ? ` · ${row.detail}` : ""}
          </div>
        </div>
        {!open && (
          <span className="qq-acts">
            {access.disposition && row.status === "OPEN" && (
              <button className="btn" disabled={pending} onClick={() => { setRefusal(null); setOpenKey(key); }}>
                Disposition…
              </button>
            )}
            {access.ratify && row.awaitingRatification && row.concessionBy !== viewerId && (
              <button className="btn btn-accent" disabled={pending} onClick={() => act(key, () => ratifyConcessionAction(row.ncrId), "Concession ratified. NCR closed.")}>
                Ratify
              </button>
            )}
          </span>
        )}
      </div>
      {open && (
        <div className="qq-form qq-grid">
          <select aria-label="Disposition" value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition)}>
            <option value="REWORK">Rework</option>
            <option value="REPAIR">Repair</option>
            <option value="USE_AS_IS">Use as is</option>
            <option value="CONCESSION">Concession</option>
            <option value="SCRAP">Scrap</option>
          </select>
          {rework && <input type="date" aria-label="Rework due date" value={due} onChange={(e) => setDue(e.target.value)} />}
          {disposition === "CONCESSION" && (
            <input aria-label="Code clause" placeholder="Code clause (required for H5 / H6)" value={clause} onChange={(e) => setClause(e.target.value)} />
          )}
          <input aria-label="Notes" placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <span className="qq-acts">
            <button
              className="btn btn-accent"
              disabled={pending}
              onClick={() =>
                act(
                  key,
                  () =>
                    dispositionNcrAction(row.ncrId, disposition, {
                      notes: notes.trim() || undefined,
                      reworkDueDate: rework && due ? new Date(due) : undefined,
                      codeClause: disposition === "CONCESSION" && clause.trim() ? clause.trim() : undefined,
                    }),
                  "Disposition recorded.",
                )
              }
            >
              Save disposition
            </button>
            <button className="btn" disabled={pending} onClick={() => setOpenKey(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      <Refused r={refusal} k={key} />
    </li>
  );
}
