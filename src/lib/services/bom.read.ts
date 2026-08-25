import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import type { StageDisplayStatus } from "@/components/industrial/stage-status";
import type { PmiResult } from "@/generated/prisma/client";
import { projectComponentRoute, type ActualOp, type ProjectedOp, type RouteStepDef } from "./bom-route";

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
export interface BomQcpCheckpoint {
  qcpItemId: number;
  srNo: string;
  activity: string;
}

export interface BomComponentOp extends ProjectedOp {
  /** QCP checkpoints gated to this route step (via OperationRef.leadTimeProcessSeq → JobProcess → QcpItemProcess). */
  qcpCheckpoints: BomQcpCheckpoint[];
}

export interface BomComponentSummary {
  id: number;
  tag: string;
  /** Only populated for `BomTree.subAssemblyComponents` — real `ComponentTypeRef.name`, not a fabricated BOM category. */
  componentTypeName?: string;
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
  /**
   * `Component` rows for this equipment with no `BomItem` (bomItemId: null)
   * — e.g. DESPL-320's seeded sub-assembly register, which has no real
   * procurement BOM export to link to yet (see
   * `scripts/seed-despl320-components.ts`). Fabricating a fake `BomItem` to
   * hang these off would violate the "real data only" rule, so they get their
   * own section instead of being folded into `groups`.
   */
  subAssemblyComponents: BomComponentSummary[];
}

function opDisplayStatus(status: string): StageDisplayStatus {
  if (status === "COMPLETE") return "complete";
  if (status === "SUBMITTED") return "submitted";
  if (status === "IN_PROGRESS") return "progress";
  return "idle";
}

interface RawComponentForSummary {
  id: number;
  tag: string;
  componentType?: { name: string } | null;
  routeVersion: {
    steps: { seq: number; operation: { id: number; name: string; leadTimeProcessSeq: number | null } }[];
  } | null;
  operations: {
    id: number;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    operation: { id: number; name: string; leadTimeProcessSeq: number | null };
  }[];
}

/** Shared projection from a raw `Component` row (however it was reached — via
 * `BomItem.components` or directly by equipment) into the route-aware summary
 * shape both the BOM-item-linked path and the bomless sub-assembly path render. */
function buildComponentSummary(
  c: RawComponentForSummary,
  checkpointsByProcessCode: Map<string, BomQcpCheckpoint[]>,
): BomComponentSummary {
  const routeSteps: RouteStepDef[] = (c.routeVersion?.steps ?? []).map((s) => ({
    seq: s.seq,
    operationId: s.operation.id,
    operationName: s.operation.name,
    leadTimeProcessSeq: s.operation.leadTimeProcessSeq,
  }));
  const actualOps: ActualOp[] = c.operations.map((o) => ({
    id: o.id,
    operationId: o.operation.id,
    operationName: o.operation.name,
    status: o.status,
    startedAt: o.startedAt?.toISOString() ?? null,
    finishedAt: o.finishedAt?.toISOString() ?? null,
    leadTimeProcessSeq: o.operation.leadTimeProcessSeq,
  }));
  const ops: BomComponentOp[] = projectComponentRoute(routeSteps, actualOps).map((p) => ({
    ...p,
    qcpCheckpoints: p.leadTimeProcessSeq != null ? (checkpointsByProcessCode.get(String(p.leadTimeProcessSeq)) ?? []) : [],
  }));
  const displayStatus: StageDisplayStatus =
    ops.length === 0
      ? "idle"
      : ops.every((o) => o.status === "COMPLETE")
        ? "complete"
        : opDisplayStatus(ops.find((o) => o.status !== "COMPLETE" && o.status !== "NOT_STARTED")?.status ?? ops[0].status);
  return { id: c.id, tag: c.tag, componentTypeName: c.componentType?.name, displayStatus, operations: ops };
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
    if (equipments.length === 0) return { equipmentId: 0, equipmentName: "", equipments: [], groups: [], subAssemblyComponents: [] };

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
            componentType: { select: { name: true } },
            routeVersion: {
              select: {
                steps: {
                  orderBy: { seq: "asc" },
                  select: { seq: true, operation: { select: { id: true, name: true, leadTimeProcessSeq: true } } },
                },
              },
            },
            operations: {
              orderBy: { seq: "asc" },
              select: {
                id: true,
                status: true,
                startedAt: true,
                finishedAt: true,
                operation: { select: { id: true, name: true, leadTimeProcessSeq: true } },
              },
            },
          },
        },
      },
    });

    // Component rows for this equipment with no BomItem (bomItemId: null) —
    // e.g. DESPL-320's seeded sub-assembly register, unreachable via
    // `items[].components` above since that path only walks BomItem.components.
    const bomlessComponents = await tx.component.findMany({
      where: { equipmentId: targetId, bomItemId: null },
      orderBy: { tag: "asc" },
      select: {
        id: true,
        tag: true,
        componentType: { select: { name: true } },
        routeVersion: {
          select: {
            steps: {
              orderBy: { seq: "asc" },
              select: { seq: true, operation: { select: { id: true, name: true, leadTimeProcessSeq: true } } },
            },
          },
        },
        operations: {
          orderBy: { seq: "asc" },
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            operation: { select: { id: true, name: true, leadTimeProcessSeq: true } },
          },
        },
      },
    });

    // Checkpoints gated to each of the job's 36 lead-time processes, keyed
    // by JobProcess.code (a stage seq number, as text) — the same identity
    // OperationRef.leadTimeProcessSeq points at.
    const checkpointLinks = await tx.qcpItemProcess.findMany({
      where: { jobProcess: { jobId } },
      select: {
        jobProcess: { select: { code: true } },
        qcpItem: { select: { id: true, srNo: true, activity: true } },
      },
    });
    const checkpointsByProcessCode = new Map<string, BomQcpCheckpoint[]>();
    for (const link of checkpointLinks) {
      const list = checkpointsByProcessCode.get(link.jobProcess.code) ?? [];
      list.push({ qcpItemId: link.qcpItem.id, srNo: link.qcpItem.srNo, activity: link.qcpItem.activity });
      checkpointsByProcessCode.set(link.jobProcess.code, list);
    }

    const subAssemblyComponents = bomlessComponents.map((c) => buildComponentSummary(c, checkpointsByProcessCode));

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
        components: it.components.map((c) => buildComponentSummary(c, checkpointsByProcessCode)),
      };
      const list = byGroup.get(groupName) ?? [];
      list.push(row);
      byGroup.set(groupName, list);
    }

    const groups: BomGroup[] = [...byGroup.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupItems]) => ({ name, items: groupItems }));

    return { equipmentId: targetId, equipmentName: equipment.name, equipments, groups, subAssemblyComponents };
  });
}
