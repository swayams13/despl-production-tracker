import { notFound, redirect } from "next/navigation";
import { getActor, hasRole, ROLES } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadStageDetail } from "@/lib/services/stage-detail.read";
import { ActivityDetailClient } from "./_client";

/** Active staff in `deptId`, for the Reassign select — same shape/query as
 * myday.read.ts's `deptMembers`, but NOT intersected with the viewing
 * actor's own departments: a Production Head/Admin can legitimately view and
 * reassign a stage outside their own department, and `assignPlanAction`'s
 * own server-side gate is authoritative either way (UI is cosmetic, matching
 * this codebase's existing `canManagePacking`-style convention). */
async function deptMembers(tenantId: number, deptId: number | null): Promise<{ id: number; name: string }[]> {
  if (deptId == null) return [];
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.userDepartment.findMany({
      where: { departmentId: deptId, user: { active: true, clientId: null } },
      select: { user: { select: { id: true, name: true } } },
    });
    return rows.map((r) => r.user);
  });
}

/**
 * Activity Detail (Round 2 mockup `03`) — execute/progress one unit×stage,
 * as a real page rather than the `StageSheet` 460px drawer (RESPONSIVE_
 * GUIDELINES.md wants content + right rail side-by-side on desktop, which a
 * drawer can't do). Reuses `loadStageDetail` directly — the same read
 * `StageSheetLauncher` already fetches via `/api/jobs/:id/stage`, called
 * here from the Server Component instead of through the API route.
 *
 * Reached from `StageSheetLauncher`'s footer "Open full detail →" link (any
 * spine segment/matrix cell/gantt row/worklist row that already opens the
 * drawer now also offers this) — NOT yet from the Activity Log tab, whose
 * `ActivityEvent` rows don't carry a `unitId`/`stageNo` today (a job process
 * can map to more than one work-order stage, so "which stage does this log
 * line belong to" isn't unambiguous without a real events.read.ts change;
 * logged as a follow-up in progress.md rather than guessed at here).
 */
export default async function ActivityDetailPage({
  params,
}: {
  params: Promise<{ id: string; unitId: string; stageNo: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const { id, unitId, stageNo } = await params;
  const jobId = Number(id);
  const unitIdNum = Number(unitId);
  const stageNoNum = Number(stageNo);
  if (!Number.isInteger(jobId) || !Number.isInteger(unitIdNum) || !Number.isInteger(stageNoNum)) notFound();

  const detail = await loadStageDetail(actor, jobId, unitIdNum, stageNoNum);
  if (!detail) notFound();

  const isQc = hasRole(actor, ROLES.QC);
  const canAssign = hasRole(actor, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);
  const members = canAssign ? await deptMembers(actor.tenantId, detail.deptId) : [];

  return <ActivityDetailClient detail={detail} actorUserId={actor.userId} isQc={isQc} canAssign={canAssign} members={members} />;
}
