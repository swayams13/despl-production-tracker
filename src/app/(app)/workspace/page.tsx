import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadWorkspaceView } from "@/lib/services/workspace.read";
import { UnitRow, UnitCardView, CardBulkActions, QcRow, QcCardView, HoldRow, HoldCardView, FilterChip, SortSelect } from "./_client";
import { ResponsiveTable } from "@/components/industrial/responsive-table";

async function pilotJobId(tenantId: number): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    return j?.id ?? null;
  });
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Workspace({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const sp = await searchParams;
  const jobParam = Number(first(sp.job));
  const jobId = Number.isInteger(jobParam) && jobParam > 0 ? jobParam : await pilotJobId(actor.tenantId);
  const view = jobId
    ? await loadWorkspaceView(actor, jobId, {
        dept: first(sp.dept),
        status: first(sp.status),
        sort: first(sp.sort),
      })
    : null;

  if (!view) {
    return (
      <>
        <div className="page-h"><h1>My Workspace</h1></div>
        <p className="note">No current schedule for this job. Generate one, or run the demo bootstrap, to see the worklist.</p>
      </>
    );
  }

  const today = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const nothing = view.cards.length === 0 && view.qcQueue.length === 0 && view.holdPoints.length === 0;

  return (
    <>
      <div className="page-h">
        <h1>My Workspace</h1>
        <span className="sub">Today · {today} · {view.jobNumber}</span>
      </div>

      <div className="sumchips">
        <span className="chip c-overdue"><i />{view.counts.overdue} overdue</span>
        <span className="chip c-hold"><i />{view.counts.dueToday} due today</span>
        <span className="chip c-submitted"><i />{view.counts.awaitingQc} awaiting QC</span>
        {view.filter && <FilterChip label={view.filter.label} />}
        <span style={{ marginLeft: "auto" }}><SortSelect /></span>
      </div>

      {view.cards.map((card) => {
        const overduePlanIds = card.units.filter((u) => u.overdue).map((u) => u.planId);
        const startablePlanIds = card.units.filter((u) => u.state === "READY").map((u) => u.planId);
        return (
          <div key={card.jobProcessId} className="card ws-card">
            <div className="hd">
              <b>{card.processName}</b>
              <span className="meta">{view.jobNumber} · {card.stageLabel} · {card.deptName}</span>
              {card.overdueCount > 0 && (
                <span className="chip c-overdue"><i />{card.overdueCount} overdue{card.criticalPath ? " · critical path" : ""}</span>
              )}
              <CardBulkActions overduePlanIds={overduePlanIds} startablePlanIds={startablePlanIds} categories={view.delayCategories} />
            </div>
            <ResponsiveTable
              table={
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>Unit</th>
                      <th style={{ width: 80 }}>Due</th>
                      <th className="num" style={{ width: 80 }}>Overdue</th>
                      <th>Delay reason / status</th>
                      <th />
                      <th style={{ width: 200 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {card.units.map((u) => (
                      <UnitRow key={u.planId} row={u} categories={view.delayCategories} />
                    ))}
                  </tbody>
                </table>
              }
              cards={card.units.map((u) => (
                <UnitCardView key={u.planId} row={u} categories={view.delayCategories} />
              ))}
            />
          </div>
        );
      })}

      {view.isQc && view.qcQueue.length > 0 && (
        <div className="card ws-card">
          <div className="hd">
            <b>Awaiting your verification</b>
            <span className="meta">QC gate · maker / checker</span>
            <span className="chip c-submitted"><i />{view.qcQueue.length} item{view.qcQueue.length === 1 ? "" : "s"}</span>
          </div>
          <ResponsiveTable
            table={<table><tbody>{view.qcQueue.map((r) => <QcRow key={r.planId} row={r} />)}</tbody></table>}
            cards={view.qcQueue.map((r) => <QcCardView key={r.planId} row={r} />)}
          />
        </div>
      )}

      {view.isQc && view.holdPoints.length > 0 && (
        <div className="card ws-card">
          <div className="hd">
            <b>Open hold points</b>
            <span className="meta">Clear to unblock completion</span>
            <span className="chip c-hold"><i />{view.holdPoints.length} open</span>
          </div>
          <ResponsiveTable
            table={
              <table><tbody>
                {view.holdPoints.map((h) => (
                  <HoldRow key={`${h.qcpItemId}-${h.unitId}`} qcpItemId={h.qcpItemId} unitId={h.unitId} activity={h.activity} serialNo={h.serialNo} />
                ))}
              </tbody></table>
            }
            cards={view.holdPoints.map((h) => (
              <HoldCardView key={`${h.qcpItemId}-${h.unitId}`} qcpItemId={h.qcpItemId} unitId={h.unitId} activity={h.activity} serialNo={h.serialNo} />
            ))}
          />
        </div>
      )}

      {nothing && <p className="note">Nothing due right now — you&apos;re caught up.</p>}
    </>
  );
}
