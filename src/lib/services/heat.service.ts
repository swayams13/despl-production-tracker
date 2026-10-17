import { withTenant, type Tx } from "@/lib/db";
import { audited } from "@/lib/audit";
import { assertNotClientUser, requireDepartmentScope, requireRole, ROLES, type Actor } from "@/lib/authz";
import { AppError, ERROR_CODES } from "@/lib/shared/errors";
import { issueStockTx } from "./stock.service";

/**
 * Lean Core L2.13: the heat number of a pressure part, picked where the part is
 * cut. D2's H2 refuses pressure-part cutting until the material is issued and a
 * heat number is picked; until now the only way to pick one was QC's `recordMtc`.
 *
 * A heat number can only come from a lot Stores RECEIVED for that part's BOM line
 * (so it traces to a receipt); there is no free typing. If material is already
 * issued to the part from lots that carry a heat number, the pick must be one of
 * those heats, so the two records cannot disagree. Picking does NOT issue the
 * material: issuing stays with Stores (the Production Head and Admin until Stores
 * has a role). `issueAndPickHeat` does both in ONE transaction, for the Production
 * Head switching an in-flight job over from Excel.
 *
 * Who and when: the cutting department's floor roles, only while the part's
 * cutting is not yet recorded (after that QC corrects a heat number); a part with
 * no cutting operation has no department to scope to, so only the Production Head
 * and Admin may pick for it. Every write holds a per-part advisory lock, so two
 * people picking at once cannot record two heats, nor issue twice.
 *
 * It records the same `MaterialIdentification` row `recordMtc` writes (heat number
 * only; QC adds the MTC reference and PMI result later), so H2's check and every
 * trace read it as they already do.
 */

export const PICK_ROLES = [ROLES.OPERATOR, ROLES.SUPERVISOR, ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;
export const ISSUE_AND_PICK_ROLES = [ROLES.PRODUCTION_HEAD, ROLES.ADMIN] as const;

/** Two-key advisory-lock namespace (with _shared.ts's 1201/1202 and stock.service's one-key lock, a separate keyspace). */
const HEAT_LOCK = 1301;

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
  cuttingStatus: string | null;
  picked: { id: number; heatNumber: string } | null;
  /** Heat numbers of the lots already issued to this part; empty = none issued, or issued from lots with no heat. */
  issuedHeats: Set<string>;
}

async function resolveComponent(tx: Tx, actor: Actor, componentId: number): Promise<Resolved> {
  const c = await tx.component.findFirst({
    where: { id: componentId, equipment: { job: { tenantId: actor.tenantId } } },
    select: { id: true, jobId: true, bomItemId: true, pressureRetaining: true, bomItem: { select: { partName: true, qtyPer: true } } },
  });
  if (!c) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Component", componentId });
  if (!c.pressureRetaining) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Only a pressure part needs a heat number picked." });
  }
  if (c.bomItemId == null || !c.bomItem) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "This part is not linked to a BOM line, so there is no stock to pick a heat number from." });
  }
  const [cutting, picked, issued] = await Promise.all([
    tx.componentOperation.findFirst({
      where: { componentId, operation: { code: "CUTTING" } },
      select: { status: true, operation: { select: { defaultDepartmentId: true } } },
    }),
    tx.materialIdentification.findFirst({ where: { componentId }, orderBy: { id: "asc" }, select: { id: true, heatNumber: true } }),
    tx.stockTxn.findMany({ where: { componentId, type: "ISSUE" }, select: { stockLot: { select: { heatNumber: true } } } }),
  ]);
  return {
    component: { id: c.id, jobId: c.jobId, bomItemId: c.bomItemId, partName: c.bomItem.partName, need: c.bomItem.qtyPer == null ? null : Number(c.bomItem.qtyPer) },
    departmentId: cutting?.operation.defaultDepartmentId ?? null,
    cuttingStatus: cutting?.status ?? null,
    picked,
    issuedHeats: new Set(issued.flatMap((t) => (t.stockLot.heatNumber ? [t.stockLot.heatNumber] : []))),
  };
}

/** Serialise every pick and issue-and-pick on one part until the transaction ends. */
async function lockPart(tx: Tx, componentId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HEAT_LOCK}::int, ${componentId}::int)`;
}

/**
 * The cutting department's scope, the rule recordWork applies to the cutting item.
 * A part with no cutting operation has no department: only the Production Head and Admin.
 */
function scope(actor: Actor, departmentId: number | null) {
  if (departmentId != null) return requireDepartmentScope(actor, departmentId);
  requireRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD);
}

/** After the cutting is recorded, a heat number is QC's to correct, not the floor's to add. */
function assertNotCut(r: Resolved) {
  if (r.cuttingStatus != null && r.cuttingStatus !== "NOT_STARTED" && r.cuttingStatus !== "IN_PROGRESS") {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "The cutting of this part is already recorded. QC corrects a heat number after that." });
  }
}

async function preparePick(tx: Tx, actor: Actor, input: { componentId: number; stockLotId: number }) {
  await lockPart(tx, input.componentId);
  const r = await resolveComponent(tx, actor, input.componentId);
  scope(actor, r.departmentId);
  assertNotCut(r);
  const lot = await tx.stockLot.findFirst({
    where: { id: input.stockLotId, bomItemId: r.component.bomItemId, jobId: r.component.jobId },
    select: { id: true, heatNumber: true },
  });
  if (!lot) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "That lot was not received for this part." });
  if (!lot.heatNumber) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "No heat number was recorded when this lot was received. Ask Stores to record it." });
  }
  if (r.picked && r.picked.heatNumber !== lot.heatNumber) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: `This part already has heat number ${r.picked.heatNumber} recorded. QC corrects a recorded heat number.` });
  }
  if (r.issuedHeats.size > 0 && !r.issuedHeats.has(lot.heatNumber)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      reason: `Material from heat ${[...r.issuedHeats].join(", ")} was issued to this part, so that is the heat to pick.`,
    });
  }
  return { r, lot: { id: lot.id, heatNumber: lot.heatNumber } };
}

async function writePick(tx: Tx, actor: Actor, r: Resolved, lot: { id: number; heatNumber: string }): Promise<{ heatNumber: string; created: boolean }> {
  if (r.picked) return { heatNumber: lot.heatNumber, created: false };
  return audited(tx, actor, async () => {
    const row = await tx.materialIdentification.create({
      data: { bomItemId: r.component.bomItemId, componentId: r.component.id, heatNumber: lot.heatNumber, jobId: r.component.jobId },
      select: { id: true },
    });
    return {
      result: { heatNumber: lot.heatNumber, created: true },
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
}

export async function loadHeatChoices(actor: Actor, componentId: number): Promise<HeatChoices> {
  assertNotClientUser(actor);
  requireRole(actor, ...PICK_ROLES);
  return withTenant(actor.tenantId, async (tx) => {
    const r = await resolveComponent(tx, actor, componentId);
    scope(actor, r.departmentId);
    if (!r.picked) assertNotCut(r);
    const lots = await tx.stockLot.findMany({
      where: { bomItemId: r.component.bomItemId, jobId: r.component.jobId, heatNumber: r.issuedHeats.size ? { in: [...r.issuedHeats] } : { not: null } },
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
    const { r, lot } = await preparePick(tx, actor, input);
    return writePick(tx, actor, r, lot);
  });
}

/**
 * Production Head / Admin: issue `qty` of the lot to the part and record its heat
 * number, so cutting stops being refused for both reasons at once. One transaction:
 * the checks that can refuse run first, then the issue and the pick commit together
 * or not at all. An issue already made from this lot to this part is not repeated.
 */
export async function issueAndPickHeat(
  actor: Actor,
  input: { componentId: number; stockLotId: number; qty: number },
): Promise<{ heatNumber: string; issued: boolean }> {
  assertNotClientUser(actor);
  requireRole(actor, ...ISSUE_AND_PICK_ROLES);
  if (!(input.qty > 0)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, { reason: "Enter the quantity to issue." });

  return withTenant(actor.tenantId, async (tx) => {
    const { r, lot } = await preparePick(tx, actor, input);
    const already = (await tx.stockTxn.count({ where: { componentId: input.componentId, stockLotId: input.stockLotId, type: "ISSUE" } })) > 0;
    if (!already) await issueStockTx(tx, actor, { stockLotId: input.stockLotId, qty: input.qty, componentId: input.componentId });
    await writePick(tx, actor, r, lot);
    return { heatNumber: lot.heatNumber, issued: !already };
  });
}
