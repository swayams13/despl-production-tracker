import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { loadDepartmentCards } from "@/lib/services/departments.read";

function onTimeColor(pct: number | null): string {
  if (pct == null) return "var(--muted)";
  if (pct >= 85) return "var(--s-complete)";
  if (pct >= 75) return "var(--s-hold)";
  return "var(--s-overdue)";
}

export default async function Departments() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const departments = await loadDepartmentCards(actor);

  return (
    <>
      <div className="page-h">
        <h1>Departments</h1>
        <span className="sub">{departments.length} departments · load, on-time performance, overdue</span>
      </div>
      <div className="dept-grid">
        {departments.map((d) => (
          <Link href={`/departments/${d.id}`} className="dept-card" key={d.id}>
            <h4>{d.name}</h4>
            <div className="rep">{d.representative ?? "No supervisor assigned"} · representative</div>
            <div className="dept-nums">
              <span><b className="mono">{d.openCount}</b>open</span>
              <span><b className="mono" style={{ color: onTimeColor(d.onTimePct) }}>{d.onTimePct != null ? `${d.onTimePct}%` : "—"}</b>on-time</span>
              <span><b className="mono" style={{ color: d.overdueCount > 3 ? "var(--s-overdue)" : "var(--text)" }}>{d.overdueCount}</b>overdue</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
