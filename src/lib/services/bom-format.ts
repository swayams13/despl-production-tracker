/**
 * Pure, dependency-free — deliberately its own module, not part of `bom.read.ts`.
 * `bom-panel.tsx` (a client component) imports this as a runtime value; `bom.read.ts`
 * is server-only (Prisma, `withTenant`, `authz` → `next/headers`), and a client
 * component importing even one real (non-type) export from a server-only module
 * pulls that module's whole dependency graph into the client bundle — Turbopack then
 * fails to compile the route entirely (`next/headers` used outside a Server Component).
 * Keeping this here instead of inline in `bom-panel.tsx` because `bom.read.ts` needs
 * it too, and duplicating it would let the two copies drift.
 */

/** Quantity cell for the BOM tab: `qtyPer uom` when parsed, else the raw `sourceQty` — never `null`. */
export function formatBomQty(row: { qtyPer: number | null; uom: string | null; sourceQty: string }): string {
  if (row.qtyPer == null) return row.sourceQty;
  return row.uom ? `${row.qtyPer} ${row.uom}` : String(row.qtyPer);
}
