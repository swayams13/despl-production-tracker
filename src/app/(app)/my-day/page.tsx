import Link from "next/link";
import { redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadMyDay } from "@/lib/services/myday.read";
import { MyDayClient } from "./_client";

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGEMENT: "Management",
  PRODUCTION_HEAD: "Production Head",
  SUPERVISOR: "Supervisor",
  QC: "QC / QA",
  CLIENT_VIEWER: "Client",
};

/** The actor's own department names, for the header's "role · departments"
 * line — a page-level concern (like workspace/page.tsx's pilotJobId), not
 * worth a new service function for two columns of one table. */
async function deptNames(tenantId: number, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.department.findMany({ where: { id: { in: ids } }, select: { name: true }, orderBy: { name: "asc" } });
    return rows.map((d) => d.name);
  });
}

/**
 * `/my-day` (personal dashboards v1, SPEC §7.2) — the personal dashboard
 * every SUPERVISOR/QC employee lands on after login (Task 2.2's router).
 * "Command Center →" (office depts, P3) is deliberately NOT rendered — it
 * has no target yet, and this app never ships a dead control (CLAUDE.md
 * hard ban).
 */
export default async function MyDay() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const [view, depts] = await Promise.all([loadMyDay(actor), deptNames(actor.tenantId, actor.departmentIds)]);

  const today = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const roleLabel = actor.roles.map((r) => ROLE_LABEL[r] ?? r).join(" / ");
  const firstName = actor.name.split(" ")[0];
  const isQc = hasRole(actor, ROLES.QC);
  const canAssign = hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return (
    <>
      <div className="page-h">
        <h1>My Day</h1>
        <span className="sub">
          Hi {firstName} · {roleLabel || "—"} · {depts.join(", ") || "—"} · {today} · cleared today:{" "}
          <span className="mono">{view.clearedToday}</span>
        </span>
        <Link href="/workspace" className="sub" style={{ marginLeft: "auto" }}>
          Department view →
        </Link>
      </div>

      <MyDayClient view={view} actorUserId={actor.userId} isQc={isQc} canAssign={canAssign} />
    </>
  );
}
