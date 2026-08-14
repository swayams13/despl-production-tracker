import { redirect } from "next/navigation";
import { getActor, ROLES, hasRole } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadPrioritizedJob, loadOpenHoldPoints } from "@/lib/services/workspace.read";
import { PlanRow } from "./plan-row";
import { QcpClear } from "./qcp-clear";

async function pilotJobId(tenantId: number): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    return j?.id ?? null;
  });
}

export default async function Workspace() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const jobId = await pilotJobId(actor.tenantId);
  const data = jobId ? await loadPrioritizedJob(actor, jobId) : null;
  if (!data) {
    return <main className="mx-auto max-w-5xl px-5 py-8"><p className="text-sm text-[var(--muted-fg)]">No current schedule. Run <code>pnpm db:bootstrap</code>.</p></main>;
  }

  const scoped = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT)
    ? data.departments
    : data.departments.filter((d) => actor.departmentIds.includes(d.id));

  const isQc = hasRole(actor, ROLES.QC);
  const verificationQueue = isQc
    ? Array.from(data.rankedByDept.values()).flat().filter((r) => r.state === "SUBMITTED")
    : [];
  const openHoldPoints = isQc && jobId ? await loadOpenHoldPoints(actor, jobId) : [];

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <h1 className="text-lg font-semibold tracking-tight">Today · DESPL-320</h1>
      {isQc && (
        <>
          <section className="mt-6">
            <h2 className="text-sm font-semibold">Verification queue</h2>
            {verificationQueue.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted-fg)]">Nothing awaiting verification.</p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                <table className="w-full text-sm">
                  <tbody>
                    {verificationQueue.map((r) => (
                      <tr key={r.plan.id} className="border-b border-[var(--hairline)] last:border-0">
                        <td className="px-4 py-2">
                          <div className="font-medium">{data.processNameById.get(r.plan.jobProcessId)}</div>
                          <div className="text-xs text-[var(--muted-fg)]">Unit {r.plan.unitId} · {r.reasonText}{r.criticalPath ? " · critical" : ""}</div>
                        </td>
                        <td className="px-4 py-2 text-right"><PlanRow planId={r.plan.id} state={r.state} canVerify /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="mt-6">
            <h2 className="text-sm font-semibold">Open hold points</h2>
            {openHoldPoints.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted-fg)]">No open hold points.</p>
            ) : (
              <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
                <table className="w-full text-sm">
                  <tbody>
                    {openHoldPoints.map((h) => (
                      <tr key={`${h.qcpItemId}-${h.unitId}`} className="border-b border-[var(--hairline)] last:border-0">
                        <td className="px-4 py-2">
                          <div className="font-medium">{h.activity}</div>
                          <div className="text-xs text-[var(--muted-fg)]">Serial {h.serialNo}</div>
                        </td>
                        <td className="px-4 py-2 text-right"><QcpClear qcpItemId={h.qcpItemId} unitId={h.unitId} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {scoped.map((dept) => {
        const rows = data.rankedByDept.get(dept.id) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={dept.id} className="mt-6">
            <h2 className="text-sm font-semibold">{dept.name}</h2>
            <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.plan.id} className="border-b border-[var(--hairline)] last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{data.processNameById.get(r.plan.jobProcessId)}</div>
                        <div className="text-xs text-[var(--muted-fg)]">Unit {r.plan.unitId} · {r.reasonText}{r.criticalPath ? " · critical" : ""}</div>
                      </td>
                      <td className="px-4 py-2 text-right"><PlanRow planId={r.plan.id} state={r.state} canVerify={isQc} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </main>
  );
}
