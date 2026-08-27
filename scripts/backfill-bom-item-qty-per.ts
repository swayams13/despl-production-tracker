// One-off backfill (Phase 4, B1): parses `BomItem.sourceQty` (the raw CSV
// text, e.g. "40 NOS.") into the new numeric `qtyPer`/`uom` columns added by
// migration 20260827060000_bom_item_qty_and_parent. A fresh database picks
// this up automatically once a later dispatch teaches the BOM import path to
// populate `qtyPer`/`uom` at write time; until then, this script catches
// already-imported rows up.
//
// Idempotent — only touches rows where `qtyPer` is still null, so re-running
// is a no-op once every parseable row has been backfilled. Rows whose
// `sourceQty` doesn't match the "N UOM" shape (free text like "As required")
// are left with `qtyPer: null` — never guessed.
//
// Run via `npx tsx scripts/backfill-bom-item-qty-per.ts`.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

const QTY_RE = /^(\d+(?:\.\d+)?)\s*(.*)$/;

/** Parses a raw BOM `sourceQty` string into a numeric quantity + optional
 * unit-of-measure. Returns null when the string isn't a leading-number
 * shape (e.g. free text) — callers must never guess in that case. */
export function parseSourceQty(sourceQty: string): { qtyPer: number; uom: string | null } | null {
  const m = QTY_RE.exec(sourceQty.trim());
  if (!m) return null;
  return { qtyPer: Number(m[1]), uom: m[2].trim() || null };
}

async function main() {
  const rows = await prisma.bomItem.findMany({
    where: { qtyPer: null },
    select: { id: true, sourceQty: true },
  });

  let updated = 0;
  for (const row of rows) {
    const parsed = parseSourceQty(row.sourceQty);
    if (!parsed) continue;
    await prisma.bomItem.update({
      where: { id: row.id },
      data: { qtyPer: parsed.qtyPer, uom: parsed.uom },
    });
    updated++;
  }
  console.log(`Backfilled qtyPer/uom on ${updated} of ${rows.length} unparsed BomItem rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
