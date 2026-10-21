/**
 * J5a test helper: createJob no longer makes floor rows, so a test that wants the old shape
 * releases each line's BOM revision after creating the job. Test-only (imported by *.test.ts).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { Actor } from "@/lib/authz";

export interface ReleasedTotals {
  components: number;
  operations: number;
  steps: number;
}

/** Release every line of a job: its DRAFT revision (the copied BOM) or, if it has none, a new empty one. */
export async function releaseJobBoms(owner: PrismaClient, actor: Actor, jobId: number): Promise<ReleasedTotals> {
  const { releaseBomRevision } = await import("./bom-release.service");
  const totals: ReleasedTotals = { components: 0, operations: 0, steps: 0 };
  for (const eq of await owner.equipment.findMany({ where: { jobId }, orderBy: { id: "asc" } })) {
    let rev = await owner.bomRevision.findFirst({ where: { equipmentId: eq.id, materializedAt: null }, orderBy: { revisionNo: "asc" } });
    rev ??= await owner.bomRevision.create({ data: { equipmentId: eq.id, revisionNo: 1, status: "DRAFT", jobId } });
    const r = await releaseBomRevision(actor, { equipmentId: eq.id, bomRevisionId: rev.id, acknowledgeWarnings: true });
    totals.components += r.counts.components;
    totals.operations += r.counts.operations;
    totals.steps += r.counts.steps;
  }
  return totals;
}
