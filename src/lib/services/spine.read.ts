import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { stageName } from "@/lib/shared/stage-names";
import type { StageDisplayStatus, StageSegment } from "@/components/industrial/stage-status";

/**
 * Per-unit stage spine for a job, read from the canonical `v_unit_stage_status`
 * view (DESIGN_SPEC §11.5). The view does the whole §11.2 rollup; this only
 * groups the rows by unit, attaches display names, and shapes them into the
 * `StageSegment` contract the industrial components already render. Backs
 * `GET /api/jobs/:id/spine` and, later, `<StageSpine unit=… />` + the matrix.
 */
export interface UnitSpine {
  unitId: number;
  serialNo: string;
  segments: StageSegment[];
}

interface Row {
  unit_id: number;
  serial_no: string;
  stage_no: number;
  fill_status: StageDisplayStatus;
  is_overdue: boolean;
  is_rejected: boolean;
  governing_plan_id: number | null;
}

export async function loadJobSpines(actor: Actor, jobId: number): Promise<UnitSpine[] | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    // RLS (security_invoker view) already scopes to the tenant; the explicit
    // job_id filter is the query predicate, not the security boundary.
    const rows = await tx.$queryRaw<Row[]>`
      SELECT v.unit_id, u.serial_no, v.stage_no, v.fill_status,
             v.is_overdue, v.is_rejected, v.governing_plan_id
      FROM v_unit_stage_status v
      JOIN units u ON u.id = v.unit_id
      WHERE v.job_id = ${jobId}
      ORDER BY u.serial_no, v.stage_no
    `;

    const byUnit = new Map<number, UnitSpine>();
    for (const r of rows) {
      let spine = byUnit.get(r.unit_id);
      if (!spine) {
        spine = { unitId: r.unit_id, serialNo: r.serial_no, segments: [] };
        byUnit.set(r.unit_id, spine);
      }
      spine.segments.push({
        stageNo: r.stage_no,
        stageName: stageName(r.stage_no),
        status: r.fill_status,
        // Raw "any plan overdue" flag — the component's showsOverduePip() decides
        // whether it renders as a pip (overdue but the fill isn't already overdue).
        overdue: r.is_overdue,
        rejected: r.is_rejected,
        governingPlanId: r.governing_plan_id ?? undefined,
      });
    }
    return Array.from(byUnit.values());
  });
}
