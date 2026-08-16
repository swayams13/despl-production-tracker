"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startAction, submitAction, holdAction, resumeAction, verifyAction, rejectAction } from "@/app/actions/process";
import { fileDelayAction } from "@/app/actions/delay";
import { claimPlanAction, assignPlanAction } from "@/app/actions/assignment";
import { useStageSheetLauncher, StageSheetLauncher } from "@/components/industrial/stage-sheet-launcher";
import { CountUp } from "@/components/industrial/count-up";
import type { ActionResult } from "@/app/actions/_action";
import type { MyDayView, MyDayRow } from "@/lib/services/myday.read";

type Category = { id: number; name: string };
type Refusal = { code: string; message: string };
type TabKey = "attention" | "due" | "qc" | "upnext" | "pool";

function fmtDue(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function isToday(d: Date | string | null): boolean {
  if (!d) return false;
  return new Date(d).toDateString() === new Date().toDateString();
}

function daysOverdue(d: Date | string | null): number {
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 864e5));
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
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11 }} onClick={stop}>
      <span className="chip c-overdue"><i />{refusal.code}</span>
      <span style={{ color: "var(--muted)" }}>{refusal.message}</span>
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

  const fileReason = (e: MouseEvent) => {
    stop(e);
    if (categoryId === "") return toast.error("Choose a delay reason first.");
    run(async () => {
      const filed = await fileDelayAction(row.ranked.plan.id, categoryId, detail || undefined);
      if (!filed.ok || !canStartAfterFile) return filed;
      return startAction(row.ranked.plan.id); // sequential — only fires once the file succeeds
    }, canStartAfterFile ? "Filed & started." : "Delay reason filed.");
  };

  return (
    <tr className="row" onClick={onOpenStage} style={{ cursor: "pointer" }}>
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
              <select className="btn" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")} aria-label={`Delay reason for ${row.jobNumber} · ${row.processName}`}>
                <option value="">Delay reason…</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="ws-detail" style={{ maxWidth: 160 }} placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} aria-label={`Delay detail for ${row.jobNumber} · ${row.processName}`} />
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

  return (
    <tr className="row" onClick={onOpenStage} style={{ cursor: "pointer" }}>
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

// ── QC verify queue row (submitted by a teammate) — mirrors /workspace's QcRow. ─
function QcQueueRowView({ row, onOpenStage }: { row: MyDayRow; onOpenStage: () => void }) {
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

  return (
    <tr className="row" onClick={onOpenStage} style={{ cursor: "pointer" }}>
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

  const counts: Record<TabKey, number> = {
    attention: view.mine.filter((r) => mineBucket(r) === "attention").length,
    due: view.mine.filter((r) => mineBucket(r) === "due").length,
    qc: qcQueueRows.length,
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
  const mineSectionRows = isVerifyMode ? qcQueueRows : view.mine.filter((r) => mineBucket(r) === mineTab);

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
                ? qcQueueRows.map((r) => (
                    <QcQueueRowView key={r.ranked.plan.id} row={r} onOpenStage={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} />
                  ))
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
                  <tr key={r.ranked.plan.id} className="row" onClick={() => openStage(r.jobId, r.ranked.plan.unitId ?? undefined, r.stageNo)} style={{ cursor: "pointer" }}>
                    <td style={{ width: 40 }}>
                      <div className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>{initials(r.assigneeName ?? "—")}</div>
                    </td>
                    <td className="mono" style={{ color: "var(--muted)" }}>{r.jobNumber}</td>
                    <td>
                      {r.processName}
                      <div style={{ color: "var(--muted)", fontSize: 11 }}>{r.assigneeName ?? "—"} · {r.stageLabel} · {r.deptName}</div>
                    </td>
                    <td className="mono">{fmtDue(r.ranked.plan.plannedFinish)}</td>
                    <td className="num">
                      <span className={`chip ${r.ranked.overdue ? "c-overdue" : r.ranked.state === "SUBMITTED" ? "c-submitted" : r.ranked.state === "ON_HOLD" ? "c-hold" : "c-progress"}`}>
                        <i />{r.ranked.overdue ? "Overdue" : r.ranked.reasonText.split(".")[0]}
                      </span>
                    </td>
                  </tr>
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
