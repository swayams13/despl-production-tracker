"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startAction, submitAction, holdAction, resumeAction, verifyAction, rejectAction } from "@/app/actions/process";
import { fileDelayAction } from "@/app/actions/delay";
import { claimPlanAction, assignPlanAction, releasePlanAction } from "@/app/actions/assignment";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { CountUp } from "@/components/industrial/count-up";
import { ResponsiveTable } from "@/components/industrial/responsive-table";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ActionResult } from "@/app/actions/_action";
import type { MyDayView, MyDayRow } from "@/lib/services/myday.read";

type Category = { id: number; name: string };
type Refusal = { code: string; message: string };
type TabKey = "attention" | "due" | "qc" | "upnext" | "pool";

// Fixed UTC+5:30 offset — same convention myday.read.ts's istDay() uses
// server-side. This component renders both on the server (UTC) and the
// client (whatever the browser's local zone is); a local-timezone Date
// method (getDate()/toDateString()/toLocaleDateString() without an explicit
// timeZone) would make the two renders disagree during the 00:00–05:30 IST
// window and trip a React hydration mismatch. Deterministic IST calendar-day
// number regardless of runtime timezone.
function istEpochDay(d: Date): number {
  return Math.floor((d.getTime() + 5.5 * 3600 * 1000) / 864e5);
}

function fmtDue(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
}

function isToday(d: Date | string | null): boolean {
  if (!d) return false;
  return istEpochDay(new Date(d)) === istEpochDay(new Date());
}

function daysOverdue(d: Date | string | null): number {
  if (!d) return 0;
  return Math.max(0, istEpochDay(new Date()) - istEpochDay(new Date(d)));
}

function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "—";
}

/** Which of the 4 non-pool KPI tabs a "mine" row belongs to — mutually
 * exclusive, priority order matches the prioritizer's own bucket()
 * precedence (overdue beats everything, then awaiting-QC, then due-today). */
function mineBucket(row: MyDayRow): Exclude<TabKey, "pool"> {
  if (row.ranked.overdue) return "attention";
  if (row.ranked.state === "SUBMITTED") return "qc";
  if (isToday(row.ranked.plan.plannedFinish)) return "due";
  return "upnext";
}

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** Card-view status chip for a "mine" row — overdue beats state, matching
 * the row/priority precedence already used elsewhere on this page. Maps the
 * raw `PlanState` enum onto <StatusChip />'s display vocabulary so the card
 * never renders a raw enum (CLAUDE.md hard ban). */
function mineDisplayStatus(row: MyDayRow): { status: StageDisplayStatus; label?: string } {
  if (row.ranked.overdue) return { status: "overdue" };
  switch (row.ranked.state) {
    case "READY": return { status: "idle", label: "Ready" };
    case "IN_PROGRESS": return { status: "progress" };
    case "ON_HOLD": return { status: "hold" };
    case "SUBMITTED": return { status: "submitted" };
    case "BLOCKED": return { status: "hold", label: "Blocked" };
    default: return { status: "idle" };
  }
}

/**
 * Run a server action: track the refusal (code + sentence) for inline
 * rendering — SPEC §7.2's differentiator from `/workspace`'s toast-only
 * `useRun` — plus a toast, then refresh on success. `process.ts`/`delay.ts`/
 * `assignment.ts`'s actions only `revalidatePath("/workspace")`, so `/my-day`
 * needs its own `router.refresh()` to re-fetch `loadMyDay` (same pattern
 * `admin/_client.tsx`'s `useRun` and `stage-sheet-launcher.tsx`'s
 * `refreshStage` already use).
 */
function useRun(onRefusal: (r: Refusal | null) => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        onRefusal({ code: r.code, message: r.message });
        toast.error(r.message);
      } else {
        onRefusal(null);
        if (ok) toast.success(ok);
        router.refresh();
      }
    });
  return { pending, run };
}

function RefusalNote({ refusal }: { refusal: Refusal | null }) {
  if (!refusal) return null;
  return (
    // flexWrap + a flex-basis on the message (not display:flex's default
    // nowrap): the action <td>s these render in are a fixed ~200-220px
    // (thead `width` above), already narrower than the chip + a full
    // sentence. Without this, the message span gets flex-shrunk toward
    // zero and wraps one word per line down the row instead of wrapping
    // normally — found live in Task 2.4's browser pass (a real
    // REASON_REQUIRED refusal rendered as an unreadable vertical word
    // stack).
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6, fontSize: 11 }} onClick={stop}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)", flex: "1 1 160px" }}>{refusal.message}</span>
    </div>
  );
}

function MineActionButton({
  row,
  pending,
  run,
}: {
  row: MyDayRow;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok?: string) => void;
}) {
  const planId = row.ranked.plan.id;
  if (row.ranked.state === "READY")
    return (
      <button className="btn btn-accent" disabled={pending} onClick={(e) => { stop(e); run(() => startAction(planId), "Started."); }}>
        Start
      </button>
    );
  if (row.ranked.state === "IN_PROGRESS")
    return (
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn" disabled={pending} onClick={(e) => { stop(e); run(() => holdAction(planId, "Held from My Day"), "On hold."); }}>Hold</button>
        <button className="btn btn-accent" disabled={pending} onClick={(e) => { stop(e); run(() => submitAction(planId), "Submitted for QC."); }}>Submit</button>
      </div>
    );
  if (row.ranked.state === "ON_HOLD")
    return (
      <button className="btn btn-accent" disabled={pending} onClick={(e) => { stop(e); run(() => resumeAction(planId), "Resumed."); }}>
        Resume
      </button>
    );
  if (row.ranked.state === "SUBMITTED")
    return <span style={{ color: "var(--muted)", fontSize: 11 }}>Awaiting QC</span>;
  return <span style={{ color: "var(--muted)", fontSize: 11 }}>Blocked</span>;
}

/**
 * Shared state + handlers for the "Mine" row/card pair (`MineRowView` /
 * `MineCardView`) — same `useState`s, same `useRun`, same derived values,
 * same `fileReason` handler, so a future behavior change (validation rule,
 * toast copy) only needs to happen once. Only the JSX (table row vs. card)
 * stays split between the two components, per the brief.
 */
function useMineRowActions(row: MyDayRow) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [detail, setDetail] = useState("");
  const overdue = row.ranked.overdue;
  // Only a READY row can actually start right after filing — an overdue row
  // that's IN_PROGRESS/ON_HOLD/SUBMITTED/BLOCKED still needs the reason filed
  // (invariant #7), but "start" doesn't apply to it (its own action, if any,
  // is MineActionButton's job). Label follows this so the button never
  // claims to do more than it will.
  const canStartAfterFile = row.ranked.state === "READY";
  // Job-grain plans (office departments — Engineering/Procurement/Planning,
  // myday.read.ts's serialNo: "—" fallback) have no unitId; the StageSheet
  // launcher (`useStageSheetLauncher().openStage`) silently no-ops without
  // one. Don't offer a click that does nothing (CLAUDE.md: "No dead
  // controls") — unit-grain rows keep click-to-open exactly as before.
  const clickable = row.ranked.plan.unitId != null;

  const fileReason = (e: MouseEvent) => {
    stop(e);
    if (categoryId === "") return toast.error("Choose a delay reason first.");
    run(async () => {
      const filed = await fileDelayAction(row.ranked.plan.id, categoryId, detail || undefined);
      if (!filed.ok || !canStartAfterFile) return filed;
      return startAction(row.ranked.plan.id); // sequential — only fires once the file succeeds
    }, canStartAfterFile ? "Filed & started." : "Delay reason filed.");
  };

  return { refusal, pending, run, categoryId, setCategoryId, detail, setDetail, overdue, canStartAfterFile, clickable, fileReason };
}

// ── "Mine" row: state-correct action, delay-reason filing when overdue,
// row click opens the StageSheet. ────────────────────────────────────────
function MineRowView({
  row,
  categories,
  onOpenStage,
}: {
  row: MyDayRow;
  categories: Category[];
  onOpenStage: () => void;
}) {
  const { refusal, pending, run, categoryId, setCategoryId, detail, setDetail, overdue, canStartAfterFile, clickable, fileReason } = useMineRowActions(row);

  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      </td>
      <td className="mono">{fmtDue(row.ranked.plan.plannedFinish)}</td>
      <td className="num mono" style={{ color: overdue ? "var(--s-overdue)" : "var(--muted)" }}>
        {overdue ? `${daysOverdue(row.ranked.plan.plannedFinish)}d` : "—"}
      </td>
      <td className="num" style={{ minWidth: 200 }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }} onClick={stop}>
          {overdue && (
            <>
              <select className="btn" disabled={pending} value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")} aria-label={`Delay reason for ${row.jobNumber} · ${row.processName}`}>
                <option value="">Delay reason…</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="ws-detail" style={{ maxWidth: 160 }} disabled={pending} placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label={`Delay detail for ${row.jobNumber} · ${row.processName}`} />
              <button className="btn" disabled={pending} onClick={fileReason}>{canStartAfterFile ? "File & start" : "File"}</button>
            </>
          )}
          <MineActionButton row={row} pending={pending} run={run} />
        </div>
        <RefusalNote refusal={refusal} />
      </td>
    </tr>
  );
}

// ── "Mine" card (<1024px): same state/handlers as MineRowView, re-laid out
// per SPEC §4's phone row — task name, unit chip, status chip, due, one
// full-width primary action. Independent local state from the table row (the
// two are alternates, CSS-swapped, never both visible at once). ──────────
function MineCardView({
  row,
  categories,
  onOpenStage,
}: {
  row: MyDayRow;
  categories: Category[];
  onOpenStage: () => void;
}) {
  const { refusal, pending, run, categoryId, setCategoryId, detail, setDetail, overdue, canStartAfterFile, clickable, fileReason } = useMineRowActions(row);
  const { status, label } = mineDisplayStatus(row);

  return (
    <div className="rt-card" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status={status} label={label} />
      </div>
      <div className="rt-card-meta">{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
        <span>Due {fmtDue(row.ranked.plan.plannedFinish)}</span>
        {overdue && <span className="mono" style={{ color: "var(--s-overdue)" }}>{daysOverdue(row.ranked.plan.plannedFinish)}d overdue</span>}
      </div>
      {overdue && (
        <div className="rt-card-delay" onClick={stop}>
          <select className="btn" disabled={pending} value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")} aria-label={`Delay reason for ${row.jobNumber} · ${row.processName}`}>
            <option value="">Delay reason…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="ws-detail" disabled={pending} placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label={`Delay detail for ${row.jobNumber} · ${row.processName}`} />
          <button className="btn" disabled={pending} onClick={fileReason}>{canStartAfterFile ? "File & start" : "File"}</button>
        </div>
      )}
      <div className="rt-card-action" onClick={stop}>
        <MineActionButton row={row} pending={pending} run={run} />
      </div>
      <RefusalNote refusal={refusal} />
    </div>
  );
}

// ── Department pool row: Claim (+ Assign-to… for supervisors). ───────────
function PoolRowView({
  row,
  canAssign,
  members,
  onOpenStage,
}: {
  row: MyDayRow;
  canAssign: boolean;
  members: { id: number; name: string }[];
  onOpenStage: () => void;
}) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView

  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      </td>
      <td className="mono">{fmtDue(row.ranked.plan.plannedFinish)}</td>
      <td className="num" style={{ minWidth: 220 }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }} onClick={stop}>
          {canAssign && members.length > 0 && (
            <select
              className="btn"
              defaultValue=""
              disabled={pending}
              aria-label={`Assign ${row.processName} to…`}
              onChange={(e) => {
                const userId = Number(e.target.value);
                if (userId) run(() => assignPlanAction(row.ranked.plan.id, userId), "Assigned.");
                e.target.value = "";
              }}
            >
              <option value="">Assign to…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <button className="btn btn-accent" disabled={pending} onClick={(e) => { stop(e); run(() => claimPlanAction(row.ranked.plan.id), "Claimed."); }}>
            Claim
          </button>
        </div>
        <RefusalNote refusal={refusal} />
      </td>
    </tr>
  );
}

/**
 * Shared state + handlers for the QC verify-queue row/card pair
 * (`QcQueueRowView` / `QcQueueCardView`) — same `useState`s, same `useRun`,
 * same `reject` handler, same `clickable` derivation. Only the JSX (table
 * row vs. card) stays split between the two components, per the brief.
 */
function useQcRowActions(row: MyDayRow) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const reject = (e: MouseEvent) => {
    stop(e);
    if (!reason.trim()) return toast.error("A reason is required to reject.");
    run(() => rejectAction(row.ranked.plan.id, reason.trim()), "Rejected — returned to the maker.");
    setRejecting(false);
    setReason("");
  };
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView

  return { refusal, pending, run, rejecting, setRejecting, reason, setReason, reject, clickable };
}

// ── QC verify queue row (submitted by a teammate) — mirrors /workspace's QcRow. ─
function QcQueueRowView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
  const { refusal, pending, run, rejecting, setRejecting, reason, setReason, reject, clickable } = useQcRowActions(row);

  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
        {rejecting && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }} onClick={stop}>
            <input className="ws-detail" style={{ maxWidth: 260 }} placeholder="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason" autoFocus />
            <button className="btn btn-accent" disabled={pending} onClick={reject}>Confirm reject</button>
            <button className="btn" disabled={pending} onClick={(e) => { stop(e); setRejecting(false); }}>Cancel</button>
          </div>
        )}
      </td>
      <td className="num" style={{ width: 200 }}>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }} onClick={stop}>
          {!rejecting && <button className="btn" disabled={pending} onClick={(e) => { stop(e); setRejecting(true); }}>Reject…</button>}
          <button className="btn btn-accent" disabled={pending} onClick={(e) => { stop(e); run(() => verifyAction(row.ranked.plan.id), "Verified — next stage unlocked."); }}>Verify</button>
        </div>
        <RefusalNote refusal={refusal} />
      </td>
    </tr>
  );
}

// ── QC verify queue card (<1024px) — same handlers as QcQueueRowView. ────
function QcQueueCardView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
  const { refusal, pending, run, rejecting, setRejecting, reason, setReason, reject, clickable } = useQcRowActions(row);

  return (
    <div className="rt-card" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status="submitted" />
      </div>
      <div className="rt-card-meta">{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
      </div>
      {rejecting && (
        <div className="rt-card-delay" onClick={stop}>
          <input className="ws-detail" placeholder="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason" autoFocus />
        </div>
      )}
      <div className="rt-card-action" onClick={stop}>
        {!rejecting && <button className="btn" disabled={pending} onClick={(e) => { stop(e); setRejecting(true); }}>Reject…</button>}
        {rejecting && <button className="btn" disabled={pending} onClick={(e) => { stop(e); setRejecting(false); }}>Cancel</button>}
        <button className="btn btn-accent" disabled={pending} onClick={rejecting ? reject : (e) => { stop(e); run(() => verifyAction(row.ranked.plan.id), "Verified — next stage unlocked."); }}>
          {rejecting ? "Confirm reject" : "Verify"}
        </button>
      </div>
      <RefusalNote refusal={refusal} />
    </div>
  );
}

// ── A QC actor's OWN submitted plan, shown in the verify queue read-only
// (Fix 2, final whole-branch review) — maker-checker means this actor can
// never verify/reject it, so it gets no action controls, just a same-shape
// row (3 <td>s, matching QcQueueRowView) so the headerless verify-mode table
// stays column-aligned. ────────────────────────────────────────────────────
function SelfSubmittedRowView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView
  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      </td>
      <td className="num" style={{ width: 200 }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>Awaiting QC — submitted by you</span>
      </td>
    </tr>
  );
}

// ── Self-submitted card (<1024px) — same read-only rendering as
// SelfSubmittedRowView (maker-checker, invariant #3: no action controls). ─
function SelfSubmittedCardView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView
  return (
    <div className="rt-card" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status="submitted" />
      </div>
      <div className="rt-card-meta">{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
      </div>
      <p className="note" style={{ margin: 0, textAlign: "left" }}>Awaiting QC — submitted by you</p>
    </div>
  );
}

// ── A teammate's held plan — read-only except a "Release" control for
// whoever can also assign (SUPERVISOR/PH/ADMIN, matching releasePlan's
// dept-supervisor/PH/ADMIN allow-paths — see Finding 3, final whole-branch
// review: releasePlanAction had zero UI callers anywhere). This is the
// smallest honest fix: wires the already-built, already-tested, already-
// audited service action to a real button rather than inventing a new
// department-wide reassignment surface. ─────────────────────────────────
function TeamHeldRowView({
  row,
  canRelease,
  onOpenStage,
}: {
  row: MyDayRow;
  canRelease: boolean;
  onOpenStage: () => void;
}) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView

  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td style={{ width: 40 }}>
        <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initials(row.assigneeName ?? "—")}</div>
      </td>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.assigneeName ?? "—"} · {row.stageLabel} · {row.deptName}</div>
      </td>
      <td className="mono">{fmtDue(row.ranked.plan.plannedFinish)}</td>
      <td className="num">
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }} onClick={stop}>
          <span className={`chip ${row.ranked.overdue ? "c-overdue" : row.ranked.state === "SUBMITTED" ? "c-submitted" : row.ranked.state === "ON_HOLD" ? "c-hold" : "c-progress"}`}>
            <i />{row.ranked.overdue ? "Overdue" : row.ranked.reasonText.split(".")[0]}
          </span>
          {canRelease && (
            <button
              className="btn"
              disabled={pending}
              onClick={(e) => { stop(e); run(() => releasePlanAction(row.ranked.plan.id), "Released to pool."); }}
            >
              Release
            </button>
          )}
        </div>
        <RefusalNote refusal={refusal} />
      </td>
    </tr>
  );
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "due", label: "Due today" },
  { key: "qc", label: "With QC" },
  { key: "upnext", label: "Up next" },
  { key: "pool", label: "Pool" },
];

export function MyDayClient({
  view,
  actorUserId,
  isQc,
  canAssign,
}: {
  view: MyDayView;
  actorUserId: number;
  isQc: boolean;
  canAssign: boolean;
}) {
  const { sheet, openStage, refreshStage, closeSheet } = useStageSheetLauncher();

  // The verify queue for a QC actor: SUBMITTED rows across mine/pool/teamHeld
  // that someone ELSE submitted (maker-checker, `assertMakerChecker` — this
  // is a client-side courtesy filter for the right list, not the gate; the
  // server still refuses a same-actor verify either way).
  const qcQueueRows = useMemo(
    () =>
      isQc
        ? [...view.mine, ...view.pool, ...view.teamHeld].filter(
            (r) => r.ranked.state === "SUBMITTED" && r.ranked.plan.submittedBy !== actorUserId,
          )
        : view.mine.filter((r) => mineBucket(r) === "qc"),
    [isQc, view.mine, view.pool, view.teamHeld, actorUserId],
  );

  // A QC actor's own self-submitted plans (Fix 2, final whole-branch review):
  // `qcQueueRows` deliberately excludes these (maker-checker), but that
  // exclusion must not make the row disappear from the whole page — mineBucket()
  // already routes every non-overdue SUBMITTED "mine" row into the "qc"
  // bucket, so reuse that same filter to surface them read-only. The
  // `submittedBy === actorUserId` check (not just "mine") matters:
  // assignPlan doesn't restrict reassignment by status, so a SUBMITTED plan
  // CAN have an assignee different from its submitter — that row already
  // belongs to `qcQueueRows` (this actor genuinely can verify it) and must
  // not also land here, or it renders twice.
  const selfSubmittedRows = useMemo(
    () => view.mine.filter((r) => mineBucket(r) === "qc" && r.ranked.plan.submittedBy === actorUserId),
    [view.mine, actorUserId],
  );

  const counts: Record<TabKey, number> = {
    attention: view.mine.filter((r) => mineBucket(r) === "attention").length,
    due: view.mine.filter((r) => mineBucket(r) === "due").length,
    qc: isQc ? qcQueueRows.length + selfSubmittedRows.length : qcQueueRows.length,
    upnext: view.mine.filter((r) => mineBucket(r) === "upnext").length,
    pool: view.pool.length,
  };

  const orderedTabs = isQc ? [TABS[2], TABS[0], TABS[1], TABS[3], TABS[4]] : TABS;
  const defaultMineTab: Exclude<TabKey, "pool"> = isQc ? "qc" : "attention";
  const [tab, setTab] = useState<TabKey>(defaultMineTab);
  // The last-selected non-pool tab — what Mine actually shows. Kept separate
  // from `tab` (which also tracks "pool", for the tab bar's `.on` highlight
  // and the scroll trigger below) so clicking "Pool" to check pool items
  // doesn't silently reset Mine's filter back to a fixed default (task
  // review round 2 — a plain `tab === "pool" ? defaultMineTab : tab` fallback
  // discarded whatever the user had actually selected, e.g. "Due today").
  const [mineTab, setMineTab] = useState<Exclude<TabKey, "pool">>(defaultMineTab);
  const [teamHeldOpen, setTeamHeldOpen] = useState(false);
  const poolRef = useRef<HTMLDivElement | null>(null);

  const selectTab = (key: TabKey) => {
    setTab(key);
    if (key !== "pool") setMineTab(key);
  };

  // Controller ruling: Mine and Department pool are both always-visible
  // sections (matching "Held by teammates" already being one) — the KPI
  // tabs filter WITHIN Mine, they don't hide Pool. "Pool" is still one of
  // the 5 tabs (for its count + the tab bar's `.on` highlight), but
  // selecting it doesn't change what Mine shows — it scrolls the
  // always-visible Pool section into view instead (below), so a supervisor
  // never has to leave the default view to see claimable pool items.
  const isVerifyMode = mineTab === "qc" && isQc;
  const mineSectionRows = isVerifyMode ? [...qcQueueRows, ...selfSubmittedRows] : view.mine.filter((r) => mineBucket(r) === mineTab);

  useEffect(() => {
    if (tab === "pool") poolRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [tab]);

  // "Next item" for Mine's empty state (SPEC §7.2 bullet 7) looks across ALL
  // of mine, not just the current filter — "nothing needs attention" should
  // still say what's coming up next, not just "nothing here".
  const nextUp = view.mine[0] ?? null;

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="kpi">
          <h6>On-time · 30d</h6>
          <div className="v mono">{view.scoreboard.onTimePct30d == null ? "—" : <><CountUp value={view.scoreboard.onTimePct30d} /><small>%</small></>}</div>
          <div className="sub">of my completed stages</div>
        </div>
        <div className="kpi">
          <h6>Done this week</h6>
          <div className="v mono"><CountUp value={view.scoreboard.doneThisWeek} /></div>
          <div className="sub">rolling 7 days</div>
        </div>
        <div className="kpi">
          <h6>Cycle vs standard</h6>
          <div className="v mono" style={{ color: (view.scoreboard.avgCycleVsStdDays ?? 0) > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
            {view.scoreboard.avgCycleVsStdDays == null ? "—" : <>{view.scoreboard.avgCycleVsStdDays > 0 ? "+" : ""}{view.scoreboard.avgCycleVsStdDays}<small>d</small></>}
          </div>
          <div className="sub">avg vs standard duration</div>
        </div>
        <div className="kpi">
          <h6>First-pass rejects · 30d</h6>
          <div className="v mono" style={{ color: view.scoreboard.firstPassRejects30d > 0 ? "var(--s-overdue)" : undefined }}>
            <CountUp value={view.scoreboard.firstPassRejects30d} />
          </div>
          <div className="sub">QC bounced back</div>
        </div>
      </div>

      <div className="tabs">
        {orderedTabs.map((t) => (
          <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} style={{ cursor: "pointer" }} onClick={() => selectTab(t.key)}>
            {t.label} <span className="mono">({counts[t.key]})</span>
          </button>
        ))}
      </div>

      {/* Mine — always visible; the active tab filters which rows show. */}
      <div className="card ws-card">
        <div className="hd">
          <b>{isVerifyMode ? "Awaiting your verification" : "Mine"}</b>
          <span className="meta">{isVerifyMode ? "QC gate · maker / checker" : "Ranked by priority"}</span>
        </div>
        {mineSectionRows.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>
            {isVerifyMode
              ? "Nothing awaiting your verification right now."
              : nextUp
                ? `Nothing due here. Next item: ${nextUp.processName} · ${nextUp.serialNo} · due ${fmtDue(nextUp.ranked.plan.plannedFinish)}.`
                : "Nothing due right now — you're caught up."}
          </p>
        ) : (
          <ResponsiveTable
            table={
              <table>
                {/* No thead in verify mode — QcQueueRowView is a 3-cell row
                    (job+process / action), same headerless convention
                    /workspace's own QC section uses; a 4-column header here
                    would misalign against it. */}
                {!isVerifyMode && (
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>Job</th>
                      <th>Process</th>
                      <th style={{ width: 80 }}>Due</th>
                      <th className="num" style={{ width: 80 }}>Overdue</th>
                      <th style={{ width: 220 }} />
                    </tr>
                  </thead>
                )}
                <tbody>
                  {isVerifyMode
                    ? mineSectionRows.map((r) =>
                        // Self-submitted rows (Fix 2) get the read-only render —
                        // maker-checker means this actor can never verify/reject
                        // their own work, so QcQueueRowView's controls don't apply.
                        r.ranked.plan.submittedBy === actorUserId ? (
                          <SelfSubmittedRowView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
                        ) : (
                          <QcQueueRowView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
                        ),
                      )
                    : mineSectionRows.map((r) => (
                        <MineRowView
                          key={r.ranked.plan.id}
                          row={r}
                          categories={view.delayCategories}
                          onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
                        />
                      ))}
                </tbody>
              </table>
            }
            cards={
              isVerifyMode
                ? mineSectionRows.map((r) =>
                    r.ranked.plan.submittedBy === actorUserId ? (
                      <SelfSubmittedCardView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
                    ) : (
                      <QcQueueCardView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
                    ),
                  )
                : mineSectionRows.map((r) => (
                    <MineCardView
                      key={r.ranked.plan.id}
                      row={r}
                      categories={view.delayCategories}
                      onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
                    />
                  ))
            }
          />
        )}
      </div>

      {/* Department pool — always visible; "Pool" tab just scrolls here. */}
      <div className="card ws-card" ref={poolRef}>
        <div className="hd">
          <b>Department pool</b>
          <span className="meta">Unassigned — claim to take ownership</span>
          <span className="chip c-idle"><i />{view.pool.length}</span>
        </div>
        {view.pool.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing in the department pool right now.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 130 }}>Job</th>
                <th>Process</th>
                <th style={{ width: 80 }}>Due</th>
                <th style={{ width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {view.pool.map((r) => (
                <PoolRowView
                  key={r.ranked.plan.id}
                  row={r}
                  canAssign={canAssign}
                  members={view.deptMembers[r.ranked.plan.ownerDepartmentId] ?? []}
                  onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card ws-card">
        <div className="hd" style={{ cursor: "pointer" }} onClick={() => setTeamHeldOpen((o) => !o)}>
          <b>Held by teammates</b>
          <span className="meta">Read-only</span>
          <span className="chip c-idle"><i />{view.teamHeld.length}</span>
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{teamHeldOpen ? "Hide ▲" : "Show ▼"}</span>
        </div>
        {teamHeldOpen && (
          view.teamHeld.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>Nothing held by teammates right now.</p>
          ) : (
            <table>
              <tbody>
                {view.teamHeld.map((r) => (
                  <TeamHeldRowView
                    key={r.ranked.plan.id}
                    row={r}
                    canRelease={canAssign}
                    onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
                  />
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}
