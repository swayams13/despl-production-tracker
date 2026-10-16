import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { AppError, ERROR_MESSAGES, type ErrorCode } from "@/lib/shared/errors";
import { deriveDispatchBatchStatus, type DispatchBatchStatus } from "./dispatch.service";
import { assertUnitHasNoOpenHoldPoint, assertUnitHasNoOpenNcr, assertUnitProductionComplete } from "./_shared";

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

/**
 * Lean Core L2.8: why a unit cannot ship yet, before anyone tries. Runs the
 * same three gates `addUnitToBatch` / `approveDispatchRelease` / `recordDispatch`
 * run (invariant 2: open NCR, open hold point, incomplete production), so the
 * Dispatch tab and the refusal a click would get always agree. Read-only: the
 * gates only select. Codes and messages are the service's own.
 * ponytail: three small queries per unit, sequential; fine at a job's 9-40 units.
 */
export interface UnitDispatchBlock {
  code: ErrorCode;
  message: string;
}
export interface UnitDispatchReadiness {
  unitId: number;
  serialNo: string;
  packed: boolean;
  /** In a dispatch batch already. */
  batched: boolean;
  blocks: UnitDispatchBlock[];
}

export async function loadDispatchReadiness(actor: Actor, jobId: number): Promise<UnitDispatchReadiness[] | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId } },
      select: { id: true, serialNo: true, packageId: true, _count: { select: { dispatchBatchUnits: true } } },
      orderBy: { serialNo: "asc" },
    });

    const gates = [assertUnitHasNoOpenNcr, assertUnitHasNoOpenHoldPoint, assertUnitProductionComplete];
    const out: UnitDispatchReadiness[] = [];
    for (const u of units) {
      const blocks: UnitDispatchBlock[] = [];
      for (const gate of gates) {
        try {
          await gate(tx, u.id, jobId);
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          blocks.push({ code: e.code, message: ERROR_MESSAGES[e.code] });
        }
      }
      out.push({ unitId: u.id, serialNo: u.serialNo, packed: u.packageId != null, batched: u._count.dispatchBatchUnits > 0, blocks });
    }
    return out;
  });
}
