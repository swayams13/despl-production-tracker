import { redirectToLogin } from "@/lib/auth/login-redirect";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, hasRole } from "@/lib/authz";
import { PageHeader } from "@/components/industrial/page-header";
import { loadStoresQueue, STORES_QUEUE_CAP } from "@/lib/services/stores-queue.read";
import { MATERIALS_QUEUE_ROLES, storesAccess } from "@/lib/shared/stores-access";
import { NEED_LABEL, NEED_ORDER, inLabel, type StoresNeed } from "@/lib/shared/stores-queue";

/**
 * Lean Core L2.14: Stores' queue across active jobs. Which BOM lines still need
 * receiving, identifying, issuing, or hold a lot with no heat number. Read only;
 * each line opens the job's Parts and stock on that item, where the actions are
 * (and show only for roles that may do them).
 */
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const num = (n: number | null) => (n == null ? "—" : Number.isInteger(n) ? String(n) : n.toFixed(1));

export default async function MaterialsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ...MATERIALS_QUEUE_ROLES)) {
    return (
      <>
        <PageHeader title="Materials" subtitle="Not available for your role" />
        <p className="note" style={{ textAlign: "left" }}>The Materials queue is for Stores, Planning, the Production Head and Admins.</p>
      </>
    );
  }

  const sp = await searchParams;
  const want = first(sp.need);
  const need: StoresNeed = NEED_ORDER.find((n) => n === want) ?? "receive";
  const q = await loadStoresQueue(actor);
  const lines = q.lines.filter((l) => l.needs.includes(need));
  const access = storesAccess(actor.roles);
  const canAct = access.receive || access.issue || access.identify || access.receiptEvent || access.lotHeat;

  const byJob = new Map<number, { jobNumber: string; projectName: string | null; lines: typeof lines }>();
  for (const l of lines) {
    const g = byJob.get(l.jobId) ?? { jobNumber: l.jobNumber, projectName: l.projectName, lines: [] };
    g.lines.push(l);
    byJob.set(l.jobId, g);
  }

  return (
    <>
      <PageHeader title="Materials" subtitle="What Stores has to do, across active jobs" />
      <div className="jt-filters" role="group" aria-label="What to show">
        {NEED_ORDER.map((n) => (
          <Link key={n} className={`jt-chip${n === need ? " jt-on" : ""}`} href={`/materials?need=${n}`} aria-current={n === need ? "page" : undefined}>
            {NEED_LABEL[n]} <b>{q.counts[n]}</b>
          </Link>
        ))}
        <span className="jt-hint">
          {need === "receive" && "A PO is placed and the quantity is not all in."}
          {need === "identify" && "Something is in, but no heat number or MTC is recorded against the line."}
          {need === "issue" && "Received and identified, and not all of it is issued."}
          {need === "heat" && "Otherwise done, but a lot was received without a heat number. Without one the floor cannot pick a heat to cut a pressure part."}
        </span>
      </div>

      {byJob.size === 0 ? (
        <p className="note" style={{ textAlign: "left" }}>Nothing to do here.</p>
      ) : (
        [...byJob.entries()].map(([jobId, g]) => (
          <div key={jobId} className="card" style={{ marginBottom: 14 }}>
            <div className="hd">
              <h3><Link href={`/jobs/${jobId}?tab=materials`}>{g.jobNumber}</Link></h3>
              {g.projectName && <span className="note" style={{ margin: "0 0 0 8px" }}>{g.projectName}</span>}
              <span className="note" style={{ margin: "0 0 0 auto" }}>{g.lines.length} {g.lines.length === 1 ? "line" : "lines"}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>Part</th><th>Material</th><th className="num">Qty</th><th className="num">In</th><th className="num">Issued</th><th>Heat</th><th /></tr>
                </thead>
                <tbody>
                  {g.lines.map((l) => (
                    <tr className="row" key={l.id}>
                      <td>
                        <b>{l.partName}</b>
                        <small style={{ display: "block", color: "var(--muted)" }}>{l.equipmentName} · item {l.itemNo}</small>
                      </td>
                      <td>{l.material ?? "—"}</td>
                      <td className="num mono">{l.qtyLabel}</td>
                      <td className="num mono">{inLabel(l)}</td>
                      <td className="num mono">{num(l.issuedQty)}</td>
                      <td>
                        {l.heats.length ? <span className="mono">{l.heats.join(", ")}</span> : <span style={{ color: "var(--muted)" }}>none recorded</span>}
                        {l.lotsWithoutHeat > 0 && <small style={{ display: "block", color: "var(--s-hold)" }}>{l.lotsWithoutHeat} {l.lotsWithoutHeat === 1 ? "lot has" : "lots have"} no heat number</small>}
                      </td>
                      <td>
                        {canAct ? (
                          <Link className="btn" href={`/jobs/${jobId}?tab=materials&view=parts&item=${l.id}`}>Open</Link>
                        ) : (
                          <Link href={`/jobs/${jobId}?tab=materials`}>View</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
      {q.truncated && <p className="note" style={{ textAlign: "left" }}>Showing the first {STORES_QUEUE_CAP} lines.</p>}
    </>
  );
}
