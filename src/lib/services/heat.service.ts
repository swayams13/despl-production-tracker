import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertNotClientUser, requireDepartmentScope, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { issueStock } from "./stock.service";

/**
 * Lean Core L2.13: the heat number of a pressure part, picked where the part is
 * cut. D2's H2 refuses pressure-part cutting until the material is issued and a
 * heat number is picked; until now the only way to pick one was QC's `recordMtc`.
 *
 * A heat number can only come from a lot Stores RECEIVED for that part's BOM line
 * (so it traces to a receipt); there is no free typing. Picking does NOT issue the
 * material: issuing stays with Stores (the Production Head and Admin until Stores
 * has a role). `issueAndPickHeat` does both in one step, for the Production Head
 * switching an in-flight job over from Excel.
 *
 * It records the same `MaterialIdentification` row `recordMtc` writes (heat number
 * only; QC adds the MTC reference and PMI result later), so H2's check and every
 * trace read it as they already do.
 */

export const PICK_ROLES = [ROLES.OPERATOR, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;
export const ISSUE_AND_PICK_ROLES = [ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;

export interface HeatLot {
  id: number;
  heatNumber: string;
  location: string;
  /** Left in the lot: received, less issued and scrapped, plus returned. */
  available: number;
}

export interface HeatChoices {
  componentId: number;
  partName: string;
  /** Per-part quantity the BOM line asks for, for the issue box; null when the line has none. */
  need: number | null;
  /** Heat number already picked for this part, if any. */
  picked: string | null;
  lots: HeatLot[];
}

interface Resolved {
  component: { id: number; jobId: number; bomItemId: number; partName: string; need: number | null };
  departmentId: number | null;
  picked: { id: number; heatNumber: string } | null;
}

async function resolveComponent(tx: Tx, actor: Actor, componentId: number): Promise<Resolved> {
  const c = await tx.component.findFirst({
    where: { id: componentId, equipment: { job: { tenantId: actor.tenantId } } },
    select: { id: true, jobId: true, bomItemId: true, pressureRetaining: true, tag: true, bomItem: { select: { partName: true, qtyPer: true } } },
  });
  if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
  if (!c.pressureRetaining) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Only a pressure part needs a heat number picked." });
  }
  if (c.bomItemId == null || !c.bomItem) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "This part is not linked to a BOM line, so there is no stock to pick a heat number from." });
  }
  const cutting = await tx.componentOperation.findFirst({
    where: { componentId, operation: { code: "CUTTING" } },
    select: { operation: { select: { defaultDepartmentId: true } } },
  });
  const picked = await tx.materialIdentification.findFirst({ where: { componentId }, orderBy: { id: "asc" }, select: { id: true, heatNumber: true } });
  return {
    component: { id: c.id, jobId: c.jobId, bomItemId: c.bomItemId, partName: c.bomItem.partName, need: c.bomItem.qtyPer == null ? null : Number(c.bomItem.qtyPer) },
    departmentId: cutting?.operation.defaultDepartmentId ?? null,
    picked,
  };
}

/** The cutting department's scope: the same rule recordWork applies to the cutting item itself. */
function scope(actor: Actor, departmentId: number | null) {
  if (departmentId != null) requireDepartmentScope(actor, departmentId);
}

export async function loadHeatChoices(actor: Actor, componentId: number): Promise<HeatChoices> {
  assertNotClientUser(actor);
  requireRole(actor, ...PICK_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const r = await resolveComponent(tx, actor, componentId);
    scope(actor, r.departmentId);
    const lots = await tx.stockLot.findMany({
      where: { bomItemId: r.component.bomItemId, jobId: r.component.jobId, heatNumber: { not: null } },
      orderBy: { id: "asc" },
      select: { id: true, heatNumber: true, location: true, qty: true, txns: { select: { type: true, qty: true } } },
    });
    return {
      componentId,
      partName: r.component.partName,
      need: r.component.need,
      picked: r.picked?.heatNumber ?? null,
      lots: lots.map((l) => ({
        id: l.id,
        heatNumber: l.heatNumber!,
        location: l.location,
        available: Number(l.qty) - l.txns.reduce((n, t) => n + (t.type === "RETURN" ? -Number(t.qty) : Number(t.qty)), 0),
      })),
    };
  });
}

export async function pickHeatNumber(actor: Actor, input: { componentId: number; stockLotId: number }): Promise<{ heatNumber: string; created: boolean }> {
  assertNotClientUser(actor);
  requireRole(actor, ...PICK_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const r = await resolveComponent(tx, actor, input.componentId);
    scope(actor, r.departmentId);
    const lot = await tx.stockLot.findFirst({
      where: { id: input.stockLotId, bomItemId: r.component.bomItemId, jobId: r.component.jobId },
      select: { id: true, heatNumber: true },
    });
    if (!lot) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "That lot was not received for this part." });
    if (!lot.heatNumber) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "No heat number was recorded when this lot was received. Ask Stores to record it." });
    }
    if (r.picked) {
      if (r.picked.heatNumber === lot.heatNumber) return { heatNumber: lot.heatNumber, created: false };
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        reason: `This part already has heat number ${r.picked.heatNumber} recorded. QC corrects a recorded heat number.`,
      });
    }
    return audited(tx, actor, async () => {
      const row = await tx.materialIdentification.create({
        data: { bomItemId: r.component.bomItemId, componentId: r.component.id, heatNumber: lot.heatNumber!, jobId: r.component.jobId },
        select: { id: true },
      });
      return {
        result: { heatNumber: lot.heatNumber!, created: true },
        audit: {
          action: "heat.pick",
          entityType: "MaterialIdentification",
          entityId: row.id,
          after: { componentId: r.component.id, bomItemId: r.component.bomItemId, stockLotId: lot.id, heatNumber: lot.heatNumber },
          eventType: "HeatNumberPicked",
          eventPayload: { componentId: r.component.id, heatNumber: lot.heatNumber },
        },
      };
    });
  });
}

/**
 * Production Head / Admin: issue `qty` of the lot to the part and record its heat
 * number, so cutting stops being refused for both reasons at once. The two writes
 * are separate transactions (the stock ledger has its own guard), but the checks
 * that can refuse the pick run first, and a pick that already exists is a no-op,
 * so a repeat after a failure finishes the job without issuing twice.
 */
export async function issueAndPickHeat(
  actor: Actor,
  input: { componentId: number; stockLotId: number; qty: number },
): Promise<{ heatNumber: string; issued: boolean }> {
  assertNotClientUser(actor);
  requireRole(actor, ...ISSUE_AND_PICK_ROLES);
  if (!(input.qty > 0)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Enter the quantity to issue." });

  const alreadyIssued = await withTenant(actor.tenantId, async (tx) => {
    const r = await resolveComponent(tx, actor, input.componentId);
    const lot = await tx.stockLot.findFirst({
      where: { id: input.stockLotId, bomItemId: r.component.bomItemId, jobId: r.component.jobId },
      select: { heatNumber: true },
    });
    if (!lot) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "That lot was not received for this part." });
    if (!lot.heatNumber) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "No heat number was recorded when this lot was received. Ask Stores to record it." });
    }
    if (r.picked && r.picked.heatNumber !== lot.heatNumber) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `This part already has heat number ${r.picked.heatNumber} recorded. QC corrects a recorded heat number.` });
    }
    return (await tx.stockTxn.count({ where: { componentId: input.componentId, stockLotId: input.stockLotId, type: "ISSUE" } })) > 0;
  });

  if (!alreadyIssued) await issueStock(actor, { stockLotId: input.stockLotId, qty: input.qty, componentId: input.componentId });
  const picked = await pickHeatNumber(actor, { componentId: input.componentId, stockLotId: input.stockLotId });
  return { heatNumber: picked.heatNumber, issued: !alreadyIssued };
}
