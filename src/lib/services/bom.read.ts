import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { PmiResult } from "@/generated/prisma/client";

/**
 * Job detail — BOM & Components tab (§4.3, §9.6).
 *
 * **Deviation from the mockup, noted (same pattern as the §9.5 job-spine
 * rollup and C27):** the mockup groups items into "Shell / Heads / Nozzles /
 * Supports / Bought-out" — an illustrative taxonomy with no backing DB field.
 * The real seed's `ComponentTypeRef` assignment doesn't cleanly support it
 * (e.g. WNRF flanges are tagged `OTHER`, not `FLANGE`, in the live-CSV-sourced
 * data) — see `bom_items` for equipment 3. Grouping by the real
 * `ComponentTypeRef.name` (alphabetical, "Uncategorized" for items with none)
 * is honest to what's actually in the DB rather than inventing a bucket map
 * the data doesn't support (functional rule #2: real data only).
 *
 * **Equipment-, not unit-, scoped (also a real-data finding):** `Component`
 * rows in the current seed all have `unitId = null` — BOM/component data
 * exists at the equipment grain only, components are not yet fanned out per
 * serial. The mockup's "Unit 1" selector would show identical data for every
 * unit, so this tab uses an equipment selector instead (a job can have
 * multiple equipments — e.g. DE0463 has 2). Per-serial component fan-out is
 * the same deferred concern already logged for schedule stagger.
 */
export interface BomComponentOp {
  seq: number;
  operationName: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BomComponentSummary {
  id: number;
  tag: string;
  displayStatus: StageDisplayStatus;
  operations: BomComponentOp[];
}

export interface BomMtc {
  id: number;
  heatNumber: string;
  mtcRef: string | null;
  pmiResult: PmiResult;
}

export interface BomItemRow {
  id: number;
  itemNo: number;
  partName: string;
  description: string | null;
  material: string | null;
  qty: string;
  mtc: BomMtc[];
  components: BomComponentSummary[];
}

export interface BomGroup {
  name: string;
  items: BomItemRow[];
}

export interface EquipmentOption {
  id: number;
  name: string;
}

export interface BomTree {
  equipmentId: number;
  equipmentName: string;
  equipments: EquipmentOption[];
  groups: BomGroup[];
}

function opDisplayStatus(status: string): StageDisplayStatus {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

export async function loadBomTree(actor: Actor, jobId: number, equipmentId?: number): Promise<BomTree | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const equipments = await tx.equipment.findMany({
      where: { jobId },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    if (equipments.length === 0) return { equipmentId: 0, equipmentName: "", equipments: [], groups: [] };

    const targetId = equipmentId != null && equipments.some((e) => e.id === equipmentId) ? equipmentId : equipments[0].id;
    const equipment = equipments.find((e) => e.id === targetId)!;

    const items = await tx.bomItem.findMany({
      where: { equipmentId: targetId },
      orderBy: { itemNo: "asc" },
      select: {
        id: true,
        itemNo: true,
        partName: true,
        description: true,
        material: true,
        qty: true,
        componentType: { select: { name: true } },
        materialIdentifications: { select: { id: true, heatNumber: true, mtcRef: true, pmiResult: true } },
        components: {
          select: {
            id: true,
            tag: true,
            operations: {
              orderBy: { seq: "asc" },
              select: { seq: true, status: true, startedAt: true, finishedAt: true, operation: { select: { name: true } } },
            },
          },
        },
      },
    });

    const byGroup = new Map<string, BomItemRow[]>();
    for (const it of items) {
      const groupName = it.componentType?.name ?? "Uncategorized";
      const row: BomItemRow = {
        id: it.id,
        itemNo: it.itemNo,
        partName: it.partName,
        description: it.description,
        material: it.material,
        qty: it.qty,
        mtc: it.materialIdentifications.map((m) => ({ id: m.id, heatNumber: m.heatNumber, mtcRef: m.mtcRef, pmiResult: m.pmiResult ?? "PENDING" })),
        components: it.components.map((c) => {
          const ops = c.operations.map((o) => ({
            seq: o.seq,
            operationName: o.operation.name,
            status: o.status,
            startedAt: o.startedAt?.toISOString() ?? null,
            finishedAt: o.finishedAt?.toISOString() ?? null,
          }));
          const displayStatus: StageDisplayStatus =
            ops.length === 0
              ? "idle"
              : ops.every((o) => o.status === "COMPLETE")
                ? "complete"
                : opDisplayStatus(ops.find((o) => o.status !== "COMPLETE" && o.status !== "NOT_STARTED")?.status ?? ops[0].status);
          return { id: c.id, tag: c.tag, displayStatus, operations: ops };
        }),
      };
      const list = byGroup.get(groupName) ?? [];
      list.push(row);
      byGroup.set(groupName, list);
    }

    const groups: BomGroup[] = [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupItems]) => ({ name, items: groupItems }));

    return { equipmentId: targetId, equipmentName: equipment.name, equipments, groups };
  });
}
