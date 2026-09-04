import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { deriveDispatchBatchStatus, type DispatchBatchStatus } from "./dispatch.service";

/**
 * S9 — Dispatch tab on /jobs/[id]. Status is ALWAYS derived through
 * `deriveDispatchBatchStatus` (dispatch.service.ts) — this read model must
 * never invent a second source of truth for it, same discipline the service
 * itself already follows over the nullable `releaseApprovedAt`/
 * `actualDispatchDate` columns.
 */
export interface DispatchUnitRow {
  id: number;
  serialNo: string;
}

export interface DispatchBatchRow {
  id: number;
  seq: number;
  plannedDate: string;
  qty: number | null;
  remarks: string | null;
  dispatchNoteNo: string | null;
  gatePassNo: string | null;
  vehicleNo: string | null;
  lrNo: string | null;
  releaseApprovedAt: string | null;
  actualDispatchDate: string | null;
  status: DispatchBatchStatus;
  units: DispatchUnitRow[];
}

export interface DispatchPanel {
  batches: DispatchBatchRow[];
  /** Units on this job with a `packageId` set — the add-unit-to-batch picker's source list. */
  packedUnits: DispatchUnitRow[];
}

export async function loadDispatchPanel(actor: Actor, jobId: number): Promise<DispatchPanel | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const [batches, packedUnits] = await Promise.all([
      tx.dispatchBatch.findMany({
        where: { jobId },
        orderBy: { seq: "asc" },
        include: { dispatchBatchUnits: { include: { unit: { select: { id: true, serialNo: true } } } } },
      }),
      // Packed AND not already linked into any batch — once a unit ships it
      // isn't offered again (addUnitToBatch itself doesn't forbid re-adding
      // a unit into a second batch, but that's never the intended flow).
      tx.unit.findMany({
        where: { equipment: { jobId }, packageId: { not: null }, dispatchBatchUnits: { none: {} } },
        select: { id: true, serialNo: true },
        orderBy: { serialNo: "asc" },
      }),
    ]);

    return {
      batches: batches.map((b) => ({
        id: b.id,
        seq: b.seq,
        plannedDate: b.plannedDate.toISOString(),
        qty: b.qty,
        remarks: b.remarks,
        dispatchNoteNo: b.dispatchNoteNo,
        gatePassNo: b.gatePassNo,
        vehicleNo: b.vehicleNo,
        lrNo: b.lrNo,
        releaseApprovedAt: b.releaseApprovedAt?.toISOString() ?? null,
        actualDispatchDate: b.actualDispatchDate?.toISOString() ?? null,
        status: deriveDispatchBatchStatus(b),
        units: b.dispatchBatchUnits.map((dbu) => ({ id: dbu.unit.id, serialNo: dbu.unit.serialNo })),
      })),
      packedUnits,
    };
  });
}
