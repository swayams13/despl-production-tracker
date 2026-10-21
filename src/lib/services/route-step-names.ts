import type { Tx } from "@/lib/db";

/**
 * The route's own name ("Trimming") for each component operation, by (component.routeVersionId, seq):
 * materialisation copies RouteStep.seq into ComponentOperation.seq. A part with no route version, or an
 * operation past the route, has no entry; the caller falls back to numbering (op-title.ts).
 */
export async function routeStepNames(
  tx: Tx,
  ops: ReadonlyArray<{ id: number; seq: number; routeVersionId: number | null }>,
): Promise<Map<number, string>> {
  const versionIds = [...new Set(ops.flatMap((o) => (o.routeVersionId == null ? [] : [o.routeVersionId])))];
  if (!versionIds.length) return new Map();
  const steps = await tx.routeStep.findMany({
    where: { routeVersionId: { in: versionIds } },
    select: { routeVersionId: true, seq: true, printed: true },
  });
  const byStep = new Map<string, string>(steps.flatMap((s) => (s.printed ? [[`${s.routeVersionId}:${s.seq}`, s.printed] as const] : [])));
  return new Map(ops.flatMap((o) => {
    const name = byStep.get(`${o.routeVersionId}:${o.seq}`);
    return name ? [[o.id, name] as const] : [];
  }));
}
