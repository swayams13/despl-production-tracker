/**
 * Lean Core L2.14: who may do each Stores action. One table, read by the services
 * (which enforce it) and by the screens (which hide what a role cannot do instead
 * of letting the server refuse). Pure.
 *
 * Stores receives material, records the heat number and MTC reference, and issues
 * and returns it. Scrap, and the indent and PO events (that is Procurement), stay
 * with the Production Head and Admin. QC alone decides PMI (accept / reject).
 */
export const RECEIVE_ROLES = ["ADMIN", "PRODUCTION_HEAD", "STORES"] as const;
/** Issue and return a lot to a part. */
export const ISSUE_ROLES = ["ADMIN", "PRODUCTION_HEAD", "STORES"] as const;
export const SCRAP_ROLES = ["ADMIN", "PRODUCTION_HEAD"] as const;
/** Indent raised / approved and PO placed. */
export const PROCUREMENT_ROLES = ["ADMIN", "PRODUCTION_HEAD"] as const;
/** A RECEIPT event only. */
export const RECEIPT_EVENT_ROLES = ["ADMIN", "PRODUCTION_HEAD", "STORES"] as const;
/** Heat number and MTC reference (an identification record). */
export const IDENTIFY_ROLES = ["QC", "ADMIN", "PRODUCTION_HEAD", "STORES"] as const;
/** Accept or reject the PMI result; everyone else records it as pending or not applicable. */
export const PMI_DECIDE_ROLES = ["QC"] as const;
/** Add the heat number to a lot that was received without one (once). */
export const LOT_HEAT_ROLES = ["ADMIN", "PRODUCTION_HEAD", "STORES"] as const;
/** Add, edit or import BOM lines (enforced by bom.service; the Parts and stock screen hides the controls from everyone else). */
export const BOM_EDIT_ROLES = ["ADMIN", "PRODUCTION_HEAD"] as const;
/** J5a: preview, map and release a BOM revision (this is what creates the floor steps). The planner cannot. */
export const BOM_RELEASE_ROLES = ["ADMIN", "PRODUCTION_HEAD", "ENGINEERING"] as const;
/** J5c: settle a started floor row a BOM re-release flagged (Keep / Replace / Cancel). Not Admin: it decides what the floor builds. */
export const BOM_REVIEW_ROLES = ["PRODUCTION_HEAD", "ENGINEERING"] as const;
/** The cross-job Materials queue. Read only for the planner. */
export const MATERIALS_QUEUE_ROLES = ["STORES", "ADMIN", "PRODUCTION_HEAD", "PLANNER"] as const;

export interface StoresAccess {
  receive: boolean;
  issue: boolean;
  scrap: boolean;
  /** Record an indent / PO event. */
  procurement: boolean;
  /** Record a RECEIPT event. */
  receiptEvent: boolean;
  identify: boolean;
  decidePmi: boolean;
  lotHeat: boolean;
  /** Add, edit or import BOM lines. */
  bomEdit: boolean;
}

const any = (held: readonly string[], allowed: readonly string[]) => held.some((r) => allowed.includes(r));

export function storesAccess(held: readonly string[]): StoresAccess {
  return {
    receive: any(held, RECEIVE_ROLES),
    issue: any(held, ISSUE_ROLES),
    scrap: any(held, SCRAP_ROLES),
    procurement: any(held, PROCUREMENT_ROLES),
    receiptEvent: any(held, RECEIPT_EVENT_ROLES),
    identify: any(held, IDENTIFY_ROLES),
    decidePmi: any(held, PMI_DECIDE_ROLES),
    lotHeat: any(held, LOT_HEAT_ROLES),
    bomEdit: any(held, BOM_EDIT_ROLES),
  };
}

export const NO_STORES_ACCESS: StoresAccess = storesAccess([]);
