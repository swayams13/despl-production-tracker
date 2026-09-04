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
import { QueueCard } from "@/components/industrial/queue-card";
import { StatusChip } from "@/components/industrial/status-chip";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { ActionResult } from "@/app/actions/_action";
import type { MyDayView, MyDayRow } from "@/lib/services/myday.read";
import { ProjectFilter, groupByJobNumber } from "./_project-filter";

type Category = { id: number; name: string };
type Refusal = { code: string; message: string };
type TabKey = "attention" | "due" | "qc" | "upnext" | "hold" | "pool";

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

/** Which of the 5 non-pool KPI tabs a "mine" row belongs to — mutually
 * exclusive, priority order matches the prioritizer's own bucket()
 * precedence (overdue beats everything, then held, then awaiting-QC, then
 * due-today). ON_HOLD checked before SUBMITTED/due-today so a held task is
 * never buried in a due-date tab it can't act on anyway. */
function mineBucket(row: MyDayRow): Exclude<TabKey, "pool"> {
  if (row.ranked.overdue) return "attention";
  if (row.ranked.state === "ON_HOLD") return "hold";
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

/**
 * Shared state + handlers for the Department pool row/card pair
 * (`PoolRowView` / `PoolCardView`) — same `useState`s, same `useRun`, same
 * `clickable` derivation. Only the JSX (table row vs. card) stays split
 * between the two components, per the brief.
 */
function usePoolRowActions(row: MyDayRow) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView
  return { refusal, pending, run, clickable };
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
  const { refusal, pending, run, clickable } = usePoolRowActions(row);

  return (
    <tr className="row" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      </td>
      <td className="mono">{fmtDue(row.ranked.plan.plannedFinish)}</td>
      <td className="num" style={{ minWidth: 220 }}>
        {/* gap 8, not 6: on the tablet viewport the "Assign to…" select (239px)
            and "Claim" (59px) wrap onto two lines, and 6px between two 48px
            touch targets is below SPEC §8 assertion 3's 8px minimum — a real
            mis-tap risk on a shop-floor tablet, caught by
            e2e/supervisor-viewport.spec.ts once that test started running in
            CI. 8px is also the design grid (CLAUDE.md § Layout). */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }} onClick={stop}>
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

// ── Department pool card (<1024px) — same handlers as PoolRowView. ───────
function PoolCardView({
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
  const { refusal, pending, run, clickable } = usePoolRowActions(row);

  return (
    <div className="rt-card" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status="idle" label="Unassigned" />
      </div>
      <div className="rt-card-meta">{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
        <span>Due {fmtDue(row.ranked.plan.plannedFinish)}</span>
      </div>
      <div className="rt-card-action" onClick={stop}>
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
    </div>
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
function useTeamHeldRowActions(row: MyDayRow) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const { pending, run } = useRun(setRefusal);
  const clickable = row.ranked.plan.unitId != null; // job-grain rows have no StageSheet to open — see MineRowView
  const status: StageDisplayStatus = row.ranked.overdue ? "overdue" : row.ranked.state === "SUBMITTED" ? "submitted" : row.ranked.state === "ON_HOLD" ? "hold" : "progress";
  const label = row.ranked.overdue ? "Overdue" : row.ranked.reasonText.split(".")[0];
  return { refusal, pending, run, clickable, status, label };
}

function TeamHeldRowView({
  row,
  canRelease,
  onOpenStage,
}: {
  row: MyDayRow;
  canRelease: boolean;
  onOpenStage: () => void;
}) {
  const { refusal, pending, run, clickable, status, label } = useTeamHeldRowActions(row);

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
          <StatusChip status={status} label={label} />
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

// ── Held-by-teammates card (<1024px) — same handlers as TeamHeldRowView. ──
function TeamHeldCardView({
  row,
  canRelease,
  onOpenStage,
}: {
  row: MyDayRow;
  canRelease: boolean;
  onOpenStage: () => void;
}) {
  const { refusal, pending, run, clickable, status, label } = useTeamHeldRowActions(row);

  return (
    <div className="rt-card" onClick={clickable ? onOpenStage : undefined} style={clickable ? { cursor: "pointer" } : undefined}>
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status={status} label={label} />
      </div>
      <div className="rt-card-meta">
        <div className="avatar" style={{ width: 20, height: 20, fontSize: 9, display: "inline-flex", verticalAlign: "middle", marginRight: 6 }}>{initials(row.assigneeName ?? "—")}</div>
        {row.assigneeName ?? "—"} · {row.stageLabel} · {row.deptName}
      </div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
        <span>Due {fmtDue(row.ranked.plan.plannedFinish)}</span>
      </div>
      {canRelease && (
        <div className="rt-card-action" onClick={stop}>
          <button className="btn" disabled={pending} onClick={(e) => { stop(e); run(() => releasePlanAction(row.ranked.plan.id), "Released to pool."); }}>
            Release
          </button>
        </div>
      )}
      <RefusalNote refusal={refusal} />
    </div>
  );
}

// ── Completed history — read-only, no actions (the work is done). ────────
function CompletedRowView({ row }: { row: MyDayRow }) {
  const finish = row.ranked.plan.actualFinish;
  const planned = row.ranked.plan.plannedFinish;
  const late = finish != null && planned != null && finish > planned;
  return (
    <tr className="row">
      <td className="mono" style={{ color: "var(--muted)" }}>{row.jobNumber}</td>
      <td>
        {row.processName}
        <div style={{ color: "var(--muted)", fontSize: 11 }}>{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      </td>
      <td className="mono">{fmtDue(finish)}</td>
      <td className="num">
        <span className={`chip ${late ? "c-overdue" : "c-complete"}`}><i />{late ? "Late" : "On time"}</span>
      </td>
    </tr>
  );
}

function CompletedCardView({ row }: { row: MyDayRow }) {
  const finish = row.ranked.plan.actualFinish;
  const planned = row.ranked.plan.plannedFinish;
  const late = finish != null && planned != null && finish > planned;
  return (
    <div className="rt-card">
      <div className="rt-card-top">
        <b>{row.processName}</b>
        <StatusChip status="complete" label={late ? "Late" : "On time"} />
      </div>
      <div className="rt-card-meta">{row.stageLabel} · {row.deptName}{row.serialNo !== "—" ? ` · ${row.serialNo}` : ""}</div>
      <div className="rt-card-row">
        <span className="tag mono">{row.serialNo !== "—" ? row.serialNo : row.jobNumber}</span>
        <span>Completed {fmtDue(finish)}</span>
      </div>
    </div>
  );
}

// ── Queue-first view (<640px, R2 Task 1, SPEC-supervisor-ui-v3.md P3-03/04)
// One action per card (the mockup's own rule: "a queue card never offers
// two taps") — a leaner action than MineActionButton's IN_PROGRESS case
// (which also renders Hold), reusing the same `run`/server actions, not
// new business logic. Overdue always routes to the sheet ("File reason &
// start" must open the reason grid per the mockup's own annotation — the
// full-screen phone version of that grid is Task 2; until it ships this
// opens the existing StageSheet, itself a real, working action). ─────────
function QueueMineAction({
  row,
  pending,
  run,
  onOpenStage,
  outline,
}: {
  row: MyDayRow;
  pending: boolean;
  run: (fn: () => Promise<ActionResult>, ok?: string) => void;
  onOpenStage: () => void;
  outline: boolean;
}) {
  const cls = `btn ${outline ? "btn-outline-accent" : "btn-accent"}`;
  const planId = row.ranked.plan.id;
  if (row.ranked.overdue)
    return <button className={cls} disabled={pending} onClick={(e) => { stop(e); onOpenStage(); }}>File reason &amp; start</button>;
  if (row.ranked.state === "READY")
    return <button className={cls} disabled={pending} onClick={(e) => { stop(e); run(() => startAction(planId), "Started."); }}>Start</button>;
  if (row.ranked.state === "IN_PROGRESS")
    return <button className={cls} disabled={pending} onClick={(e) => { stop(e); run(() => submitAction(planId), "Submitted for QC."); }}>Submit finish</button>;
  if (row.ranked.state === "ON_HOLD")
    return <button className={cls} disabled={pending} onClick={(e) => { stop(e); run(() => resumeAction(planId), "Resumed."); }}>Resume</button>;
  if (row.ranked.state === "SUBMITTED")
    return <span style={{ color: "var(--muted)", fontSize: 11 }}>Awaiting QC</span>;
  return <span style={{ color: "var(--muted)", fontSize: 11 }}>Blocked</span>;
}

function MineQueueCardView({ row, top, onOpenStage }: { row: MyDayRow; top: boolean; onOpenStage: () => void }) {
  const { pending, run, overdue, clickable } = useMineRowActions(row);
  const { status, label } = mineDisplayStatus(row);
  return (
    <QueueCard
      top={top}
      onClick={clickable ? onOpenStage : undefined}
      metaLine={`${row.jobNumber}${row.serialNo !== "—" ? ` · ${row.serialNo}` : ""} · ${row.stageLabel}`}
      due={fmtDue(row.ranked.plan.plannedFinish)}
      overdue={overdue}
      title={row.processName}
      tags={
        <>
          <StatusChip status={status} label={label} />
          {overdue && <span className="chip c-overdue"><i />{daysOverdue(row.ranked.plan.plannedFinish)}d overdue</span>}
        </>
      }
      action={<QueueMineAction row={row} pending={pending} run={run} onOpenStage={onOpenStage} outline={!top} />}
    />
  );
}

function PoolQueueCardView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
  const { pending, run, clickable } = usePoolRowActions(row);
  return (
    <QueueCard
      onClick={clickable ? onOpenStage : undefined}
      metaLine={`${row.jobNumber}${row.serialNo !== "—" ? ` · ${row.serialNo}` : ""} · ${row.stageLabel}`}
      due={fmtDue(row.ranked.plan.plannedFinish)}
      title={row.processName}
      action={
        <button className="btn btn-outline-accent" disabled={pending} onClick={(e) => { stop(e); run(() => claimPlanAction(row.ranked.plan.id), "Claimed."); }}>
          Claim
        </button>
      }
    />
  );
}

// ── Collapsed summary line <-> 2x2 grid, built entirely from data the page
// already fetches (scoreboard fields + counts already computed for the
// KPI tab badges) — no new read-layer work. ───────────────────────────────
function QueueScoreboard({ view, overdueCount, qcCount }: { view: MyDayView; overdueCount: number; qcCount: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="queue-scoreboard">
      <div className="queue-scoreboard-summary" onClick={() => setExpanded((e) => !e)}>
        <b>My stats</b>
        <span className="mono" style={{ color: "var(--s-complete)" }}>
          {view.scoreboard.onTimePct30d == null ? "—" : `${view.scoreboard.onTimePct30d}% on-time`}
        </span>
        <span className="mono" style={{ color: "var(--muted-2)" }}>· {view.scoreboard.doneThisWeek} done</span>
        <div style={{ flex: 1 }} />
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(-90deg)" : "rotate(90deg)" }}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </div>
      {expanded && (
        <div className="queue-scoreboard-grid">
          <div>
            <div className="v" style={{ color: "var(--s-complete)" }}>{view.scoreboard.onTimePct30d == null ? "—" : `${view.scoreboard.onTimePct30d}%`}</div>
            <div className="sub">On-time · 30d</div>
          </div>
          <div>
            <div className="v">{view.scoreboard.doneThisWeek}</div>
            <div className="sub">Done this week</div>
          </div>
          <div>
            <div className="v" style={{ color: overdueCount > 0 ? "var(--s-overdue)" : undefined }}>{overdueCount}</div>
            <div className="sub">Overdue now</div>
          </div>
          <div>
            <div className="v" style={{ color: "var(--s-submitted)" }}>{qcCount}</div>
            <div className="sub">Waiting on QC</div>
          </div>
        </div>
      )}
    </div>
  );
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "due", label: "Due today" },
  { key: "qc", label: "With QC" },
  { key: "upnext", label: "Up next" },
  { key: "hold", label: "On hold" },
  { key: "pool", label: "Pool" },
];
const TAB_BY_KEY = new Map(TABS.map((t) => [t.key, t]));

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
    hold: view.mine.filter((r) => mineBucket(r) === "hold").length,
    pool: view.pool.length,
  };

  // QC actors want their verify queue first; everyone else keeps TABS' order.
  const orderedTabs = isQc
    ? (["qc", "attention", "due", "hold", "upnext", "pool"] as TabKey[]).map((k) => TAB_BY_KEY.get(k)!)
    : TABS;
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
  const [completedOpen, setCompletedOpen] = useState(false);
  const poolRef = useRef<HTMLDivElement | null>(null);

  // S13a — project filter over the "Department pool" section only (the tab
  // with real row counts per the work item; Mine/Held/Completed are all
  // scoped to one actor and stay small). Client-side over view.pool, already
  // fetched — no new query, resets to "All projects" on nothing special
  // (selecting a project that empties out just shows the empty state).
  const [poolProject, setPoolProject] = useState<string | null>(null);
  const poolProjectOptions = useMemo(() => groupByJobNumber(view.pool), [view.pool]);
  const filteredPool = poolProject == null ? view.pool : view.pool.filter((r) => r.jobNumber === poolProject);

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
      {/* <640px: flat ranked queue replaces the tabbed KPI/Mine view below
          entirely (CSS-only swap, .day-queue/.day-standard in globals.css —
          both branches render, only one is visible, matching <ResponsiveTable
          />'s own pattern). Held-by-teammates and Completed are unaffected —
          read-only history/status, not actionable queue items, so they stay
          outside both branches. */}
      <div className="day-queue">
        <QueueScoreboard view={view} overdueCount={counts.attention} qcCount={counts.qc} />
        {isQc && (qcQueueRows.length > 0 || selfSubmittedRows.length > 0) && (
          <>
            <div className="queue-section-label"><span>WITH QC · {qcQueueRows.length + selfSubmittedRows.length}</span></div>
            {[...qcQueueRows, ...selfSubmittedRows].map((r) =>
              r.ranked.plan.submittedBy === actorUserId ? (
                <SelfSubmittedCardView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
              ) : (
                <QcQueueCardView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
              ),
            )}
          </>
        )}
        <div className="queue-section-label"><span>MINE · {view.mine.length}</span><span>RANKED BY DUE + GATE</span></div>
        {view.mine.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing due right now — you&apos;re caught up.</p>
        ) : (
          view.mine.map((r, i) => (
            <MineQueueCardView key={r.ranked.plan.id} row={r} top={i === 0} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
          ))
        )}
        <div className="queue-section-label"><span>POOL · {view.pool.length} UNCLAIMED</span></div>
        {view.pool.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>Nothing in the department pool right now.</p>
        ) : (
          view.pool.map((r) => (
            <PoolQueueCardView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
          ))
        )}
      </div>
      <div className="day-standard">
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
          {poolProjectOptions.length > 1 && (
            <ProjectFilter options={poolProjectOptions} value={poolProject} onChange={setPoolProject} />
          )}
          <span className="chip c-idle"><i />{filteredPool.length}</span>
        </div>
        {filteredPool.length === 0 ? (
          <p className="note" style={{ margin: "16px 0" }}>
            {view.pool.length === 0 ? "Nothing in the department pool right now." : "No pool items for this project."}
          </p>
        ) : (
          <ResponsiveTable
            table={
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
                  {filteredPool.map((r) => (
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
            }
            cards={filteredPool.map((r) => (
              <PoolCardView
                key={r.ranked.plan.id}
                row={r}
                canAssign={canAssign}
                members={view.deptMembers[r.ranked.plan.ownerDepartmentId] ?? []}
                onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
              />
            ))}
          />
        )}
      </div>
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
            <ResponsiveTable
              table={
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
              }
              cards={view.teamHeld.map((r) => (
                <TeamHeldCardView
                  key={r.ranked.plan.id}
                  row={r}
                  canRelease={canAssign}
                  onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)}
                />
              ))}
            />
          )
        )}
      </div>

      <div className="card ws-card">
        <div className="hd" style={{ cursor: "pointer" }} onClick={() => setCompletedOpen((o) => !o)}>
          <b>Completed</b>
          <span className="meta">Last 30 days · read-only</span>
          <span className="chip c-idle"><i />{view.completed.length}</span>
          <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>{completedOpen ? "Hide ▲" : "Show ▼"}</span>
        </div>
        {completedOpen && (
          view.completed.length === 0 ? (
            <p className="note" style={{ margin: "16px 0" }}>Nothing completed in the last 30 days.</p>
          ) : (
            <ResponsiveTable
              table={
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>Job</th>
                      <th>Process</th>
                      <th style={{ width: 80 }}>Completed</th>
                      <th className="num" style={{ width: 100 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {view.completed.map((r) => (
                      <CompletedRowView key={r.ranked.plan.id} row={r} />
                    ))}
                  </tbody>
                </table>
              }
              cards={view.completed.map((r) => <CompletedCardView key={r.ranked.plan.id} row={r} />)}
            />
          )
        )}
      </div>

      <StageSheetLauncher sheet={sheet} onOpenChange={closeSheet} onChanged={refreshStage} />
    </>
  );
}
