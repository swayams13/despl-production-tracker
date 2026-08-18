"use client";
import { useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  startAction,
  submitAction,
  holdAction,
  resumeAction,
  verifyAction,
  rejectAction,
  startBulkAction,
} from "@/app/actions/process";
import { fileDelayAction, fileDelayBulkAction } from "@/app/actions/delay";
import { recordQcpAction } from "@/app/actions/qcp";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ActionResult } from "@/app/actions/_action";
import type { WsUnitRow, WsQcRow } from "@/lib/services/workspace.read";

type Category = { id: number; name: string };

function fmtDue(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Run a server action, toasting its refusal message on failure. */
function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else if (ok) toast.success(ok);
    });
  return { pending, run };
}

/**
 * Shared state + handlers for the unit row/card pair (`UnitRow` /
 * `UnitCardView`) — same `useState`s, same `useRun`, same `fileReason`
 * handler. Only the JSX (table row vs. card) stays split between the two.
 */
function useUnitRowActions(row: WsUnitRow) {
  const { pending, run } = useRun();
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [detail, setDetail] = useState("");

  const fileReason = () => {
    if (categoryId === "") return toast.error("Choose a delay reason first.");
    run(() => fileDelayAction(row.planId, categoryId, detail || undefined), "Delay reason filed.");
  };

  const status: StageDisplayStatus = row.overdue
    ? "overdue"
    : row.state === "IN_PROGRESS"
      ? "progress"
      : row.state === "ON_HOLD"
        ? "hold"
        : row.state === "READY"
          ? "idle"
          : "hold"; // BLOCKED

  return { pending, run, categoryId, setCategoryId, detail, setDetail, fileReason, status };
}

// ── One unit row inside a process card ───────────────────────────────────
export function UnitRow({ row, categories }: { row: WsUnitRow; categories: Category[] }) {
  const { pending, run, categoryId, setCategoryId, detail, setDetail, fileReason } = useUnitRowActions(row);

  return (
    <tr className="row">
      <td className="mono" style={{ color: "var(--muted)" }}>{row.serialNo}</td>
      <td className="mono">{fmtDue(row.plannedFinish)}</td>
      <td className="num mono" style={{ color: row.overdue ? "var(--s-overdue)" : "var(--muted)" }}>
        {row.overdue ? `${row.daysOverdue}d` : "—"}
      </td>
      {row.overdue ? (
        <>
          <td>
            <select
              className="btn"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}
              aria-label={`Delay reason for ${row.serialNo}`}
            >
              <option value="">Delay reason…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </td>
          <td>
            <input
              className="ws-detail"
              placeholder="Detail (optional)"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              aria-label={`Delay detail for ${row.serialNo}`}
            />
          </td>
          <td className="num">
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
              <button className="btn" disabled={pending} onClick={fileReason}>File</button>
              <UnitActionButton row={row} pending={pending} run={run} />
            </div>
          </td>
        </>
      ) : (
        <>
          <td colSpan={2} style={{ color: "var(--muted)", fontSize: 12 }}>{row.reasonText}</td>
          <td className="num"><UnitActionButton row={row} pending={pending} run={run} /></td>
        </>
      )}
    </tr>
  );
}

function UnitActionButton({
  row,
  pending,
  run,
}: {
  row: WsUnitRow;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok?: string) => void;
}) {
  if (row.state === "READY")
    return <button className="btn btn-accent" disabled={pending} onClick={() => run(() => startAction(row.planId), "Started.")}>Start</button>;
  if (row.state === "IN_PROGRESS")
    return (
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button className="btn" disabled={pending} onClick={() => run(() => holdAction(row.planId, "Held from workspace"), "On hold.")}>Hold</button>
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => submitAction(row.planId), "Submitted for QC.")}>Submit for QC</button>
      </div>
    );
  if (row.state === "ON_HOLD")
    return <button className="btn btn-accent" disabled={pending} onClick={() => run(() => resumeAction(row.planId), "Resumed.")}>Resume</button>;
  // BLOCKED — nothing actionable; the reason is shown in the row.
  return <span style={{ color: "var(--muted)", fontSize: 11 }}>Blocked</span>;
}

// ── One unit card (<1024px) — same handlers as UnitRow. ──────────────────
export function UnitCardView({ row, categories }: { row: WsUnitRow; categories: Category[] }) {
  const { pending, run, categoryId, setCategoryId, detail, setDetail, fileReason, status } = useUnitRowActions(row);

  return (
    <div className="rt-card">
      <div className="rt-card-top">
        <b className="mono">{row.serialNo}</b>
        <StatusChip status={status} />
      </div>
      <div className="rt-card-row">
        <span>Due {fmtDue(row.plannedFinish)}</span>
        {row.overdue && <span className="mono" style={{ color: "var(--s-overdue)" }}>{row.daysOverdue}d overdue</span>}
      </div>
      {row.overdue ? (
        <div className="rt-card-delay">
          <select
            className="btn"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}
            aria-label={`Delay reason for ${row.serialNo}`}
          >
            <option value="">Delay reason…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input
            className="ws-detail"
            placeholder="Detail (optional)"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            aria-label={`Delay detail for ${row.serialNo}`}
          />
          <button className="btn" disabled={pending} onClick={fileReason}>File</button>
        </div>
      ) : (
        <p className="note" style={{ margin: 0, textAlign: "left" }}>{row.reasonText}</p>
      )}
      <div className="rt-card-action">
        <UnitActionButton row={row} pending={pending} run={run} />
      </div>
    </div>
  );
}

// ── Card header bulk actions ─────────────────────────────────────────────
export function CardBulkActions({
  overduePlanIds,
  startablePlanIds,
  categories,
}: {
  overduePlanIds: number[];
  startablePlanIds: number[];
  categories: Category[];
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [detail, setDetail] = useState("");

  const applyReason = () => {
    if (categoryId === "") return toast.error("Choose a delay reason first.");
    start(async () => {
      const r = await fileDelayBulkAction(overduePlanIds, categoryId, detail || undefined);
      if (!r.ok) toast.error(r.message);
      else {
        toast.success(`Reason filed on ${r.filed ?? overduePlanIds.length} unit${(r.filed ?? 0) === 1 ? "" : "s"} — logged with your name & time.`);
        setOpen(false);
        setCategoryId("");
        setDetail("");
      }
    });
  };

  const startAll = () =>
    start(async () => {
      const r = await startBulkAction(startablePlanIds);
      if (!r.ok) toast.error(r.message);
      else toast.success(`${r.started ?? 0} stage${(r.started ?? 0) === 1 ? "" : "s"} started.`);
    });

  return (
    <div className="actions">
      {overduePlanIds.length > 0 && (
        <button className="btn" disabled={pending} onClick={() => setOpen((o) => !o)}>
          Apply reason to all overdue
        </button>
      )}
      {startablePlanIds.length > 0 && (
        <button className="btn btn-accent" disabled={pending} onClick={startAll}>Start all</button>
      )}
      {open && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexBasis: "100%", marginTop: 8 }}>
          <select className="btn" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")} aria-label="Bulk delay reason">
            <option value="">Delay reason…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <input className="ws-detail" style={{ maxWidth: 200 }} placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="Bulk delay detail" />
          <button className="btn btn-accent" disabled={pending} onClick={applyReason}>Apply to {overduePlanIds.length}</button>
        </div>
      )}
    </div>
  );
}

/**
 * Shared state + handlers for the QC verification row/card pair (`QcRow` /
 * `QcCardView`) — same `useState`s, same `useRun`, same `reject` handler.
 * Only the JSX (table row vs. card) stays split between the two.
 */
function useQcRowActions(row: WsQcRow) {
  const { pending, run } = useRun();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const reject = () => {
    if (!reason.trim()) return toast.error("A reason is required to reject.");
    run(() => rejectAction(row.planId, reason.trim()), "Rejected — returned to the maker.");
    setRejecting(false);
    setReason("");
  };

  return { pending, run, rejecting, setRejecting, reason, setReason, reject };
}

// ── QC verification row ──────────────────────────────────────────────────
export function QcRow({ row }: { row: WsQcRow }) {
  const { pending, run, rejecting, setRejecting, reason, setReason, reject } = useQcRowActions(row);

  return (
    <tr className="row">
      <td className="mono" style={{ color: "var(--muted)" }}>{row.serialNo}</td>
      <td>
        {row.processName}
        {row.submittedBy && <span style={{ color: "var(--muted)" }}> — submitted by {row.submittedBy}</span>}
        {rejecting && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input className="ws-detail" style={{ maxWidth: 260 }} placeholder="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason" autoFocus />
            <button className="btn btn-accent" disabled={pending} onClick={reject}>Confirm reject</button>
            <button className="btn" disabled={pending} onClick={() => setRejecting(false)}>Cancel</button>
          </div>
        )}
      </td>
      <td className="num" style={{ width: 190 }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {!rejecting && <button className="btn" disabled={pending} onClick={() => setRejecting(true)}>Reject…</button>}
          <button className="btn btn-accent" disabled={pending} onClick={() => run(() => verifyAction(row.planId), "Verified — next stage unlocked.")}>Verify</button>
        </div>
      </td>
    </tr>
  );
}

// ── QC verification card (<1024px) — same handlers as QcRow. ─────────────
export function QcCardView({ row }: { row: WsQcRow }) {
  const { pending, run, rejecting, setRejecting, reason, setReason, reject } = useQcRowActions(row);

  return (
    <div className="rt-card">
      <div className="rt-card-top">
        <b className="mono">{row.serialNo}</b>
        <StatusChip status="submitted" />
      </div>
      <div className="rt-card-meta">
        {row.processName}
        {row.submittedBy && <> — submitted by {row.submittedBy}</>}
      </div>
      {rejecting && (
        <div className="rt-card-delay">
          <input className="ws-detail" placeholder="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason" autoFocus />
        </div>
      )}
      <div className="rt-card-action">
        {!rejecting && <button className="btn" disabled={pending} onClick={() => setRejecting(true)}>Reject…</button>}
        {rejecting && <button className="btn" disabled={pending} onClick={() => setRejecting(false)}>Cancel</button>}
        <button className="btn btn-accent" disabled={pending} onClick={rejecting ? reject : () => run(() => verifyAction(row.planId), "Verified — next stage unlocked.")}>
          {rejecting ? "Confirm reject" : "Verify"}
        </button>
      </div>
    </div>
  );
}

// ── QC hold-point clearance row ──────────────────────────────────────────
export function HoldRow({ qcpItemId, unitId, activity, serialNo }: { qcpItemId: number; unitId: number; activity: string; serialNo: string }) {
  const { pending, run } = useRun();
  return (
    <tr className="row">
      <td className="mono" style={{ color: "var(--muted)" }}>{serialNo}</td>
      <td>{activity}</td>
      <td className="num" style={{ width: 140 }}>
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => recordQcpAction(qcpItemId, unitId, "ACCEPTED"), "Hold point cleared.")}>Record clearance</button>
      </td>
    </tr>
  );
}

// ── QC hold-point clearance card (<1024px) — same handlers as HoldRow. ───
export function HoldCardView({ qcpItemId, unitId, activity, serialNo }: { qcpItemId: number; unitId: number; activity: string; serialNo: string }) {
  const { pending, run } = useRun();
  return (
    <div className="rt-card">
      <div className="rt-card-top">
        <b className="mono">{serialNo}</b>
        <StatusChip status="hold" />
      </div>
      <div className="rt-card-meta">{activity}</div>
      <div className="rt-card-action">
        <button className="btn btn-accent" disabled={pending} onClick={() => run(() => recordQcpAction(qcpItemId, unitId, "ACCEPTED"), "Hold point cleared.")}>Record clearance</button>
      </div>
    </div>
  );
}

// ── Dismissible deep-link filter chip + sort select ──────────────────────
export function FilterChip({ label }: { label: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const clear = () => {
    const next = new URLSearchParams(params);
    next.delete("dept");
    next.delete("status");
    router.push(next.toString() ? `${pathname}?${next}` : pathname);
  };

  return (
    <span className="filter-chip">
      Filtered: {label}
      <button onClick={clear} aria-label="Clear filter">×</button>
    </span>
  );
}

export function SortSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("sort") ?? "critical";

  const change = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "critical") next.delete("sort");
    else next.set("sort", value);
    router.push(next.toString() ? `${pathname}?${next}` : pathname);
  };

  return (
    <select className="btn" value={current} onChange={(e) => change(e.target.value)} aria-label="Sort worklist">
      <option value="critical">Sort: critical path first</option>
      <option value="overdue">Sort: most overdue</option>
      <option value="due">Sort: due date</option>
    </select>
  );
}
