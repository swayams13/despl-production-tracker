import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadCommandCenter, classifyDeptCode, resolveCommandCenterAccess } from "@/lib/services/command-center.read";
import { PageHeader } from "@/components/industrial/page-header";
import { CommandCenterClient } from "./_client";

/**
 * `/command/[dept]` (personal dashboards v1, SPEC §7.4, task 3.1). `dept` is
 * the department CODE, case-insensitively (e.g. "procurement" → PROCUREMENT)
 * — the codes are already stable identifiers (seed/lead-time-model.json), so
 * there's no separate slug table to maintain.
 *
 * Routing (task 3.1 ruling 1): an OFFICE department (`Department.isOfficeDept`)
 * renders this page; a real floor department redirects to `/workspace`;
 * anything that isn't a real department code at all in this tenant gets
 * `notFound()` — same convention `/departments/[id]` already uses for an
 * invalid id.
 */
export default async function CommandCenter({ params }: { params: Promise<{ dept: string }> }) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { dept } = await params;
  const deptCode = dept.toUpperCase();
  const department = await withTenant(actor.tenantId, (tx) =>
    tx.department.findFirst({ where: { tenantId: actor.tenantId, code: deptCode }, select: { id: true, name: true, isOfficeDept: true } }),
  );

  const kind = classifyDeptCode(department);
  if (kind === "invalid" || !department) notFound();
  if (kind === "floor") redirect("/workspace");

  // Access (task 3.1 ruling 3): dept members + PH/ADMIN get full read+action
  // access; MANAGEMENT gets read-only (page renders, zero action buttons);
  // anyone else — wrong department, no relevant role — gets notFound(), the
  // same refusal shape as an invalid id rather than a leaky "forbidden" page.
  const access = resolveCommandCenterAccess(actor, department.id);
  if (access === "none") notFound();
  const canAct = access === "full";

  const view = await loadCommandCenter(actor, department.id, deptCode, department.name);

  const today = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });

  return (
    <>
      <PageHeader
        title={department.name}
        subtitle={
          <>
            {actor.name} · {today} · cleared today: <span className="mono">{view.clearedToday}</span>
            {!canAct && " · read only"}
          </>
        }
      />

      <CommandCenterClient view={view} canAct={canAct} />
    </>
  );
}
