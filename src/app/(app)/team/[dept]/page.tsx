import { redirectToLogin } from "@/lib/auth/login-redirect";
import { notFound, redirect } from "next/navigation";
import { getActor } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { FEATURES } from "@/lib/shared/flags";
import { loadTeam } from "@/lib/services/team.read";
import { TeamClient } from "./_client";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Lean Core L2.5: Team for one department (`dept` = its code, any case, like
 * /command/[dept]). Members, the Production Head and Admin act; Management
 * reads; anyone else (another department's supervisor) gets the same not-found
 * as an unknown code, not a leaky "forbidden" page.
 */
export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ dept: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!FEATURES.leanFloor) notFound();
  const actor = await getActor();
  if (!actor) return redirectToLogin();
  if (actor.clientId !== null) redirect("/portal");

  const { dept } = await params;
  const department = await withTenant(actor.tenantId, (tx) =>
    tx.department.findFirst({
      where: { tenantId: actor.tenantId, code: dept.toUpperCase() },
      select: { id: true, code: true, name: true },
    }),
  );
  if (!department) notFound();

  const view = await loadTeam(actor, department);
  if (!view) notFound();

  const sp = await searchParams;
  const jobParam = Number(first(sp.job));
  const status = first(sp.status);
  return (
    <TeamClient
      view={view}
      canAct={view.access === "full"}
      canSwitch={actor.departmentIds.length !== 1 || !actor.departmentIds.includes(department.id)}
      initialJob={Number.isInteger(jobParam) && jobParam > 0 ? jobParam : null}
      initialFocus={status === "overdue" ? "overdue" : status === "blocked" ? "blocked" : "all"}
    />
  );
}
