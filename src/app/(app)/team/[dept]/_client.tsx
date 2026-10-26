"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { assignPlansAction } from "@/app/actions/assignment";
import { fileDelayBulkAction } from "@/app/actions/delay";
import { acknowledgeOverrideAction } from "@/app/actions/override";
import { leastLoadedFirst } from "@/lib/shared/team";
import { fmtDay } from "@/lib/shared/board";
import type { TeamRow, TeamView } from "@/lib/services/team.read";

/**
 * Lean Core L2.5: Team. The header numbers are filters and add up (open =
 * assigned + unassigned). Workload by person is the centrepiece; the pool is
 * multi-select with Assign to… listing people least-loaded first, and the
 * button names the person (no confirm step). Per-process "Apply reason to all
 * overdue" is the one bulk action absorbed from /workspace.
 */

type Focus = "all" | "overdue" | "blocked";
const PAGE = 25;

const dueText = (r: TeamRow) =>
  r.overdue && r.daysLate ? `${r.daysLate} d late` : r.dueAt ? fmtDay(r.dueAt) : "not scheduled";

/** The first 25 rows, with "Show all N" for the rest (a job with many units makes these long). */
const CAP = 25;
function Capped<T extends { planId?: number; id?: number }>({ rows, render }: { rows: T[]; render: (r: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, CAP);
  return (
    <>
      <ul className="tm-items">{shown.map(render)}</ul>
      {rows.length > CAP && (
        <button className="tm-link" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

export function TeamClient({
  view,
  canAct,
  canSwitch,
  initialJob,
  initialFocus,
}: {
  view: TeamView;
  canAct: boolean;
  canSwitch: boolean;
  initialJob: number | null;
  initialFocus: Focus;
}) {
  const router = useRouter();
  const [focus, setFocus] = useState<Focus>(initialFocus);
  const [job, setJob] = useState<number | null>(initialJob);
  const [process, setProcess] = useState("");
  const [thisWeek, setThisWeek] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null); // person whose items are expanded
  const [reasonCat, setReasonCat] = useState<number | "">("");
  const [busy, startBusy] = useTransition();
  const k = view.kpi;

  const people = useMemo(() => leastLoadedFirst(view.people), [view.people]);

  const matches = (r: TeamRow) =>
    (job == null || r.jobId === job) &&
    (focus === "all" || (focus === "overdue" ? r.overdue : r.state === "BLOCKED")) &&
    (!process || r.processName === process) &&
    (!thisWeek || (r.dueAt != null && new Date(r.dueAt).getTime() <= Date.now() + 7 * 86_400_000));
  const pool = view.pool.filter(matches);
  const pageRows = pool.slice(page * PAGE, page * PAGE + PAGE);
  const processes = [...new Set(view.pool.map((r) => r.processName))].sort();

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const assign = (userId: number, name: string) =>
    startBusy(async () => {
      const ids = [...selected];
      const r = await assignPlansAction(ids, userId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const { assigned, failed } = r.result;
      if (failed.length === 0) toast.success(`Assigned ${assigned.length} to ${name}.`);
      else toast.error(`Assigned ${assigned.length} to ${name}. ${failed.length} could not be assigned: ${failed[0].message}`);
      setSelected(new Set());
      setOpen(null);
      router.refresh();
    });

  const applyReason = (planIds: number[]) =>
    startBusy(async () => {
      if (reasonCat === "") return;
      const r = await fileDelayBulkAction(planIds, reasonCat);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Reason filed on ${r.filed ?? planIds.length} item${planIds.length === 1 ? "" : "s"}.`);
      router.refresh();
    });

  // D2: one tap, no confirm. "Already acknowledged" just means someone beat us to it; refresh shows who.
  const acknowledge = (overrideId: number) =>
    startBusy(async () => {
      const r = await acknowledgeOverrideAction(overrideId);
      if (r.ok) toast.success("Acknowledged.");
      else if (r.code === "OVERRIDE_ALREADY_ACKNOWLEDGED") toast.message(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const FocusChip = ({ id, label, value }: { id: Focus; label: string; value: string }) => (
    <button
      type="button"
      className={`tm-kpi${focus === id && id !== "all" ? " on" : ""}`}
      aria-pressed={focus === id && id !== "all"}
      onClick={() => {
        setFocus(focus === id ? "all" : id);
        setPage(0);
      }}
    >
      <b className="mono">{value}</b>
      <span>{label}</span>
    </button>
  );

  return (
    <>
      <div className="page-h">
        <h1>
          Team · {canSwitch ? (
            <select
              className="tm-switch"
              aria-label="Department"
              value={view.department.code}
              onChange={(e) => router.push(`/team/${e.target.value.toLowerCase()}`)}
            >
              {view.departments.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            view.department.name
          )}
        </h1>
        <span className="sub">
          {view.department.supervisors.length ? `${view.department.supervisors.join(", ")} · ` : ""}
          {view.people.length} {view.people.length === 1 ? "person" : "people"}
          {!canAct ? " · read only" : ""}
        </span>
      </div>

      <div className="tm-kpis" role="group" aria-label="Department numbers">
        <FocusChip id="all" label="Open" value={String(k.open)} />
        <div className="tm-kpi static">
          <b className="mono">{k.onTimePct == null ? "—" : `${Math.round(k.onTimePct)}%`}</b>
          <span>On time</span>
        </div>
        <FocusChip id="overdue" label="Overdue" value={String(k.overdue)} />
        <FocusChip id="blocked" label="Blocked" value={String(k.blocked)} />
        <div className="tm-kpi static" title={`${k.sameDayTotal} updates in the last 7 days`}>
          <b className="mono">{k.sameDayPct == null ? "—" : `${k.sameDayPct}%`}</b>
          <span>Same-day updates</span>
        </div>
      </div>
      <p className="sub" style={{ margin: "6px 0 14px" }}>
        Open {k.open} is {k.assigned} assigned plus {k.unassigned} unassigned · cleared today {k.clearedToday}
        {k.openRework > 0 ? ` · open rework ${k.openRework}` : ""}
      </p>

      <section className="tm-sec" aria-labelledby="tm-load">
        <h2 id="tm-load">Workload by person · {view.people.length}</h2>
        {view.people.length === 0 ? (
          <p className="note">Nobody is on this department yet.</p>
        ) : (
          <div className="bd-scroll">
            <table className="tm-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Assigned</th>
                  <th>Overdue</th>
                  <th>Due today</th>
                  <th>Blocked</th>
                  <th>Oldest</th>
                </tr>
              </thead>
              <tbody>
                {view.people.map((p) => (
                  <Fragment key={p.userId}>
                    <tr className={p.idle ? "tm-idle" : ""}>
                      <th scope="row">
                        {p.name}
                        {canAct && p.assigned > 0 && (
                          <button className="tm-link" onClick={() => setOpen(open === p.userId ? null : p.userId)} aria-expanded={open === p.userId}>
                            Reassign
                          </button>
                        )}
                      </th>
                      {p.idle ? (
                        <>
                          <td className="mono">0</td>
                          <td className="mono">0</td>
                          <td className="mono">0</td>
                          <td className="mono">0</td>
                          <td>Idle</td>
                        </>
                      ) : (
                        <>
                          <td className="mono">{p.assigned}</td>
                          <td className={`mono${p.overdue ? " tm-bad" : ""}`}>{p.overdue}</td>
                          <td className="mono">{p.dueToday}</td>
                          <td className="mono">{p.blocked}</td>
                          <td className="mono">{p.oldest}</td>
                        </>
                      )}
                    </tr>
                    {open === p.userId && (
                      <tr>
                        <td colSpan={6}>
                          <ul className="tm-items">
                            {p.items.map((r) => (
                              <li key={r.planId}>
                                <label>
                                  <input type="checkbox" checked={selected.has(r.planId)} onChange={() => toggle(r.planId)} />
                                  <span className="mono">{r.jobNumber} › {r.serialNo}</span> {r.processName}
                                  <small>{dueText(r)}</small>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tm-sec" aria-labelledby="tm-pool" id="pool">
        <h2 id="tm-pool">Unassigned · {view.pool.length}</h2>
        <div className="tm-filters">
          <select aria-label="Process" value={process} onChange={(e) => { setProcess(e.target.value); setPage(0); }}>
            <option value="">Process: all</option>
            {processes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select aria-label="Job" value={job ?? ""} onChange={(e) => { setJob(e.target.value ? Number(e.target.value) : null); setPage(0); }}>
            <option value="">Job: all</option>
            {view.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.jobNumber}
              </option>
            ))}
          </select>
          <label className="tm-check">
            <input type="checkbox" checked={thisWeek} onChange={(e) => { setThisWeek(e.target.checked); setPage(0); }} /> Due this week
          </label>
        </div>
        {pool.length === 0 ? (
          <p className="note">Nothing is waiting to be assigned{focus !== "all" || process || job != null || thisWeek ? " with these filters" : ""}.</p>
        ) : (
          <div className="bd-scroll">
            <table className="tm-table">
              <thead>
                <tr>
                  {canAct && <th aria-label="Select" />}
                  <th>Unit</th>
                  <th>Process</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.planId}>
                    {canAct && (
                      <td>
                        <input type="checkbox" aria-label={`Select ${r.processName} on ${r.serialNo}`} checked={selected.has(r.planId)} onChange={() => toggle(r.planId)} />
                      </td>
                    )}
                    <td className="mono">
                      {r.jobNumber} › {r.serialNo}
                    </td>
                    <td>{r.processName}</td>
                    <td className={r.overdue ? "tm-bad" : ""}>{dueText(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pool.length > PAGE && (
          <div className="tm-pager">
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              {page * PAGE + 1}–{Math.min(pool.length, page * PAGE + PAGE)} of {pool.length}
            </span>
            <button className="btn" disabled={(page + 1) * PAGE >= pool.length} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
      </section>

      {canAct && selected.size > 0 && (
        <div className="tm-assign" role="region" aria-label="Assign selected">
          <b>
            Assign {selected.size} item{selected.size === 1 ? "" : "s"} to
          </b>
          <ul>
            {people.map((p) => (
              <li key={p.userId}>
                <button className="btn" disabled={busy} onClick={() => assign(p.userId, p.name)}>
                  {p.name} <small>{p.assigned} open</small>
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {view.earlyStarts && view.earlyStarts.pendingTotal > 0 && (
        <section className="tm-sec" aria-labelledby="tm-early">
          <h2 id="tm-early">
            Early starts to review · {view.earlyStarts.pendingTotal}
            {view.earlyStarts.staleTotal > 0 && ` · ${view.earlyStarts.staleTotal} waiting over 2 working days`}
          </h2>
          <Capped
            rows={view.earlyStarts.pending}
            render={(o) => (
              <li key={o.id} className="tm-ack">
                <div>
                  <b>
                    <span className="mono">{o.serialNo}</span> · {o.title}
                  </b>
                  <small>
                    {o.jobNumber} · {o.category.replace(/_/g, " ").toLowerCase()}
                    {o.note ? ` · “${o.note}”` : ""} · {o.by} · {fmtDay(o.at)}
                    {o.stale ? " · waiting over 2 working days" : ""}
                  </small>
                </div>
                <button className="btn" disabled={busy} onClick={() => acknowledge(o.id)}>
                  Acknowledge
                </button>
              </li>
            )}
          />
        </section>
      )}

      {view.outOfSequence.length > 0 && (
        <section className="tm-sec" aria-labelledby="tm-oos">
          <h2 id="tm-oos">Out of sequence · last 7 days · {view.outOfSequence.length}</h2>
          <Capped
            rows={view.outOfSequence}
            render={(o) => (
              <li key={o.id}>
                <b>
                  <span className="mono">{o.serialNo}</span> · {o.title}
                </b>
                <small>
                  {o.jobNumber} · {o.category.replace(/_/g, " ").toLowerCase()}
                  {o.note ? ` · “${o.note}”` : ""} · {o.by} · {fmtDay(o.at)}
                  {o.ack ? ` · acknowledged by ${o.ack.by}, ${fmtDay(o.ack.at)}` : ""}
                </small>
              </li>
            )}
          />
        </section>
      )}

      <section className="tm-sec" aria-labelledby="tm-od">
        <h2 id="tm-od">Overdue and blocked · {view.overdueBlocked.length}</h2>
        {view.overdueBlocked.length === 0 ? (
          <p className="note">Nothing is late or blocked.</p>
        ) : (
          <Capped
            rows={view.overdueBlocked}
            render={(r) => (
              <li key={r.planId}>
                <b>
                  <span className="mono">{r.jobNumber} › {r.serialNo}</span> {r.processName}
                </b>
                <small>
                  {r.assigneeName ?? "Unassigned"} ·{" "}
                  {r.state === "BLOCKED" ? `blocked${r.waitingOn ? ` · ${r.waitingOn}` : ""}` : `${r.daysLate ?? 1} d late`} ·{" "}
                  {r.reason.filed ? `Reason given: ${r.reason.category}` : "No reason yet"}
                </small>
              </li>
            )}
          />
        )}
      </section>

      {canAct && view.byProcess.some((g) => g.overdueIds.length > 0) && (
        <section className="tm-sec" aria-labelledby="tm-proc">
          <h2 id="tm-proc">By process</h2>
          <div className="tm-filters">
            <select aria-label="Reason for all overdue" value={reasonCat} onChange={(e) => setReasonCat(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Pick a reason…</option>
              {view.delayCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <ul className="tm-items">
            {view.byProcess.map((g) => (
              <li key={g.processName}>
                <b>{g.processName}</b>
                <small>
                  {g.open} open · {g.overdueIds.length} overdue with no reason
                </small>
                {g.overdueIds.length > 0 && (
                  <button className="btn" disabled={busy || reasonCat === ""} onClick={() => applyReason(g.overdueIds)}>
                    Apply reason to {g.overdueIds.length} overdue
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(view.blocking.length > 0 || view.waitingOnOthers.length > 0) && (
        <section className="tm-sec" aria-labelledby="tm-dep">
          <h2 id="tm-dep">Dependencies</h2>
          <div className="tm-two">
            <div>
              <h3>You&apos;re blocking · {view.blocking.length}</h3>
              <Capped
                rows={view.blocking}
                render={(r) => (
                  <li key={r.planId}>
                    <b>
                      <span className="mono">{r.jobNumber} › {r.serialNo}</span> {r.processName}
                    </b>
                    <small>{r.waitingOn}</small>
                  </li>
                )}
              />
            </div>
            <div>
              <h3>Waiting on others · {view.waitingOnOthers.length}</h3>
              <Capped
                rows={view.waitingOnOthers}
                render={(r) => (
                  <li key={r.planId}>
                    <b>
                      <span className="mono">{r.jobNumber} › {r.serialNo}</span> {r.processName}
                    </b>
                    <small>{r.waitingOn}</small>
                  </li>
                )}
              />
            </div>
          </div>
        </section>
      )}

      {view.welders.length > 0 && (
        <section className="tm-sec" aria-labelledby="tm-weld">
          <h2 id="tm-weld">
            Welder output · <Link href="/welding">all welders</Link>
          </h2>
          <div className="bd-scroll">
            <table className="tm-table">
              <thead>
                <tr>
                  <th>Welder</th>
                  <th>Joints</th>
                  <th>Repair rate</th>
                </tr>
              </thead>
              <tbody>
                {view.welders.map((w) => (
                  <tr key={w.welderId} className={w.flagged ? "tm-flag" : ""}>
                    <th scope="row">{w.name}</th>
                    <td className="mono">{w.jointsCount}</td>
                    <td className="mono">{w.repairRatePct == null ? "—" : `${Math.round(w.repairRatePct)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
