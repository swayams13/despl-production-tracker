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
