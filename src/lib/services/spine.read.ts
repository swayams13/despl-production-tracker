import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { loadWorkOrderStageNames, workOrderStageName } from "./_shared";
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
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true, familyId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const stageNames = await loadWorkOrderStageNames(tx, actor.tenantId, job.familyId);

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
        stageName: workOrderStageName(stageNames, r.stage_no),
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

/**
 * Job-level (cross-unit) spine — the single big StageSpine at the top of the
 * job Overview page (§4.3), which the per-unit `v_unit_stage_status` view
 * doesn't itself produce (§11 is defined per-unit only; the §9.2 session log
 * flagged this rollup as deferred to its first UI consumer, which is this one).
 *
 * Collapse rule: the same §11.2 first-match-wins ladder, applied across units
 * instead of across backing plans — complete only if EVERY unit is complete at
 * that stage; otherwise hold > overdue > submitted > progress > idle, first
 * match across the unit set wins. The "winning" unit (the one whose status
 * produced the collapsed result) supplies `governingPlanId`/`unitId`/
 * `serialNo`, so a click on this spine still resolves to one real StageSheet
 * target instead of an unclickable multi-unit summary.
 */
export function rollupJobSpine(units: UnitSpine[]): StageSegment[] {
  if (units.length === 0) return [];
  const stageCount = units[0].segments.length;
  const out: StageSegment[] = [];
  for (let i = 0; i < stageCount; i++) {
    const cells = units.map((u) => ({ unit: u, seg: u.segments[i] }));
    out.push(collapseAcrossUnits(cells));
  }
  return out;
}

function collapseAcrossUnits(cells: { unit: UnitSpine; seg: StageSegment }[]): StageSegment {
  const first = cells[0].seg;
  const findByStatus = (status: StageDisplayStatus) => cells.find((c) => c.seg.status === status);

  let status: StageDisplayStatus;
  let winner: { unit: UnitSpine; seg: StageSegment };
  if (cells.every((c) => c.seg.status === "complete")) {
    status = "complete";
    winner = cells[cells.length - 1]; // all done — last unit, mirroring §11.3's all-complete convention
  } else if (findByStatus("hold")) {
    status = "hold";
    winner = findByStatus("hold")!;
  } else if (findByStatus("overdue")) {
    status = "overdue";
    winner = findByStatus("overdue")!;
  } else if (findByStatus("submitted")) {
    status = "submitted";
    winner = findByStatus("submitted")!;
  } else if (findByStatus("progress") || findByStatus("complete")) {
    status = "progress";
    winner = findByStatus("progress") ?? findByStatus("complete")!;
  } else {
    status = "idle";
    winner = cells[0];
  }

  return {
    stageNo: first.stageNo,
    stageName: first.stageName,
    status,
    overdue: cells.some((c) => c.seg.overdue),
    rejected: cells.some((c) => c.seg.rejected),
    governingPlanId: winner.seg.governingPlanId,
    unitId: winner.unit.unitId,
    serialNo: winner.unit.serialNo,
  };
}
