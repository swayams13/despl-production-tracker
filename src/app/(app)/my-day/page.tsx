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

/** The actor's own departments (name + code), for the header's "role ·
 * departments" line and the "Command Center →" link's target (task 3.1
 * ruling 5) — a page-level concern (like workspace/page.tsx's pilotJobId),
 * not worth a new service function for one small lookup. */
async function myDepartments(tenantId: number, ids: number[]): Promise<{ name: string; code: string; isOfficeDept: boolean }[]> {
  if (ids.length === 0) return [];
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.department.findMany({
      where: { id: { in: ids } },
      select: { name: true, code: true, isOfficeDept: true },
      orderBy: { name: "asc" },
    });
    return rows;
  });
}

/**
 * `/my-day` (personal dashboards v1, SPEC §7.2) — the personal dashboard
 * every SUPERVISOR/QC employee lands on after login (Task 2.2's router).
 */
export default async function MyDay() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const [view, depts] = await Promise.all([loadMyDay(actor), myDepartments(actor.tenantId, actor.departmentIds)]);

  const today = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  const roleLabel = actor.roles.map((r) => ROLE_LABEL[r] ?? r).join(" / ");
  const firstName = actor.name.split(" ")[0];
  const isQc = hasRole(actor, ROLES.QC);
  const canAssign = hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  // Task 3.1 ruling 5: link to Command Center only for actors who belong to
  // at least one of the six OFFICE departments — everyone else's dept(s) all
  // redirect to /workspace, so the link would be a dead control there
  // (CLAUDE.md hard ban). Belonging to more than one office dept: link to
  // the first — a nice-to-have nav link, not worth a picker.
  const officeDept = depts.find((d) => d.isOfficeDept);

  return (
    <>
      <div className="page-h">
        <h1>My Day</h1>
        <span className="sub">
          Hi {firstName} · {roleLabel || "—"} · {depts.map((d) => d.name).join(", ") || "—"} · {today} · cleared today:{" "}
          <span className="mono">{view.clearedToday}</span>
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
          {officeDept && (
            <Link href={`/command/${officeDept.code.toLowerCase()}`} className="sub">
              Command Center →
            </Link>
          )}
          <Link href="/workspace" className="sub">
            Department view →
          </Link>
        </div>
      </div>

      <MyDayClient view={view} actorUserId={actor.userId} isQc={isQc} canAssign={canAssign} />
    </>
  );
}
