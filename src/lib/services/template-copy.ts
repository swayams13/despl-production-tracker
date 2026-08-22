import type { Tx } from "@/lib/db";

/**
 * Per-process edits to apply while copying. Only the fields
 * `updateStandardDurations` has ever changed — this helper deliberately does
 * NOT accept arbitrary field overrides, because a template version copy that
 * can silently rewrite anything is how a "versioned" template stops being an
 * honest record of what changed.
 */
export interface ProcessOverride {
  durationMinDays?: number;
  durationMaxDays?: number;
  provisional?: boolean;
}

/**
 * Deep-copy a template version's processes and edges onto another (already
 * created) version row, returning a source-id → new-id map so the caller can
 * re-point anything else that referenced the originals.
 *
 * Extracted verbatim from admin.service.ts::updateStandardDurations so the
 * clone path in template.service.ts cannot drift from it. Runs in the
 * caller's transaction; creates no version row of its own.
 */
export async function copyVersionContents(
  tx: Tx,
  sourceVersionId: number,
  targetVersionId: number,
  overrideByProcessId: Map<number, ProcessOverride> = new Map(),
): Promise<Map<number, number>> {
  const processes = await tx.templateProcess.findMany({ where: { versionId: sourceVersionId } });
  const edges = await tx.templateEdge.findMany({ where: { versionId: sourceVersionId } });

  const oldToNewProcessId = new Map<number, number>();
  for (const p of processes) {
    const o = overrideByProcessId.get(p.id);
    const copy = await tx.templateProcess.create({
      data: {
        versionId: targetVersionId,
        seq: p.seq,
        code: p.code,
        name: p.name,
        mainActivities: p.mainActivities,
        durationMinDays: o?.durationMinDays ?? p.durationMinDays,
        durationMaxDays: o?.durationMaxDays ?? p.durationMaxDays,
        cumulativePrinted: p.cumulativePrinted,
        defaultDepartmentId: p.defaultDepartmentId,
        workOrderStages: p.workOrderStages,
        envelopeFinishByMinDays: p.envelopeFinishByMinDays,
        envelopeFinishByMaxDays: p.envelopeFinishByMaxDays,
        envelopeStartByMinDays: p.envelopeStartByMinDays,
        envelopeStartByMaxDays: p.envelopeStartByMaxDays,
        optional: p.optional,
        provisional: o?.provisional ?? p.provisional,
      },
    });
    oldToNewProcessId.set(p.id, copy.id);
  }

  for (const e of edges) {
    await tx.templateEdge.create({
      data: {
        versionId: targetVersionId,
        processId: oldToNewProcessId.get(e.processId)!,
        predecessorId: oldToNewProcessId.get(e.predecessorId)!,
        type: e.type,
        lagDays: e.lagDays,
      },
    });
  }

  return oldToNewProcessId;
}
