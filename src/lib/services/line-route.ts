import type { Tx } from "@/lib/db";

// Lean Core J3a: which job_processes a line runs.
//
// A line on the job's own route (its pinned template version is the job's, or
// unset on a legacy block) uses the job-level set: every `equipment_id IS NULL`
// row. A line pinned to another version has its own UNIT-grain rows
// (`equipment_id` = the line) and still shares the job's JOB-grain rows. The
// scheduler and the floor read through these two functions only.

/** null = the line runs the job's own route; otherwise the line's id (its rows carry it). */
export function routeKey(
  jobTemplateVersionId: number,
  equipment: { id: number; templateVersionId: number | null },
): number | null {
  return equipment.templateVersionId == null || equipment.templateVersionId === jobTemplateVersionId
    ? null
    : equipment.id;
}

/** Does a job process belong to the route identified by `key` (see routeKey)? */
export function inRoute(p: { equipmentId: number | null; grain: string }, key: number | null): boolean {
  return p.equipmentId === key || (p.equipmentId == null && (key == null || p.grain === "JOB"));
}

/** The `inRoute` test as a Prisma `where` on job_processes. */
export function routeWhere(key: number | null) {
  return key == null
    ? { equipmentId: null }
    : { OR: [{ equipmentId: key }, { equipmentId: null, grain: "JOB" as const }] };
}

// ── J3b: the readers' side (DB) ───────────────────────────────────────────


/** The route of one unit (null = the job's own). */
export async function unitRouteKey(tx: Tx, unitId: number): Promise<number | null> {
  const u = await tx.unit.findUnique({
    where: { id: unitId },
    select: { equipment: { select: { id: true, templateVersionId: true, job: { select: { templateVersionId: true } } } } },
  });
  return u ? routeKey(u.equipment.job.templateVersionId, u.equipment) : null;
}

export interface JobRoute {
  key: number | null;
  /** Equipment.name; several blocks on the job's own route are joined with " / ". */
  name: string;
  /** Family whose work-order stage names this route shows. */
  familyId: number;
  unitIds: number[];
}

/** Every route a job has, with its units. One entry for a single-route job. */
export async function loadJobRoutes(tx: Tx, jobId: number): Promise<{ routes: JobRoute[]; keyOfUnit: Map<number, number | null> }> {
  const job = await tx.job.findUniqueOrThrow({ where: { id: jobId }, select: { templateVersionId: true, familyId: true } });
  const eqs = await tx.equipment.findMany({
    where: { jobId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      templateVersionId: true,
      templateVersion: { select: { template: { select: { familyId: true } } } },
      units: { select: { id: true } },
    },
  });
  const byKey = new Map<number | null, { names: string[]; familyId: number; unitIds: number[] }>();
  const keyOfUnit = new Map<number, number | null>();
  for (const e of eqs) {
    const key = routeKey(job.templateVersionId, e);
    const r = byKey.get(key) ?? {
      names: [],
      familyId: key == null ? job.familyId : (e.templateVersion?.template.familyId ?? job.familyId),
      unitIds: [],
    };
    r.names.push(e.name);
    for (const u of e.units) {
      r.unitIds.push(u.id);
      keyOfUnit.set(u.id, key);
    }
    byKey.set(key, r);
  }
  if (byKey.size === 0) byKey.set(null, { names: [], familyId: job.familyId, unitIds: [] });
  return {
    routes: [...byKey].map(([key, r]) => ({ key, name: r.names.join(" / "), familyId: r.familyId, unitIds: r.unitIds })),
    keyOfUnit,
  };
}
