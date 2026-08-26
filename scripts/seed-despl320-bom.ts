// Additive, idempotent seed: DESPL-320 small-parts BOM — BomItem rows read
// from seed/despl-320-bom-items.json (extracted from the real GA drawing BOM,
// see docs/DESPL-320-DEV-READY-BOM-SCHEDULE-v1.md §4.2/§4.3).
//
// BomItem is keyed by Equipment (not Unit), so this creates one row per
// entry — shared across all 9 units, same as the drawing's own "Bill of
// Material for One Qty" is shared. No Procurement rows are created: real
// indent/PO/received-status data doesn't exist yet for DESPL-320, and
// inventing it would violate this project's "real data only" mandate
// (CLAUDE.md) — Procurement stays for DESPL to fill in via the app.
//
// Idempotent per (equipmentId, itemNo) — safe to re-run.
//
// Run with: pnpm db:seed:despl320-bom
// (after scripts/seed-despl320-and-de0467.ts has created the DESPL-320 Job/
// Equipment rows — this script errors out clearly if they're missing.)
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

interface BomItemDef {
  itemNo: number;
  partName: string;
  description: string | null;
  material: string | null;
  qty: string;
  unit: string | null;
  remarks: string | null;
}
interface BomItemsFile {
  job: string;
  items: BomItemDef[];
}

async function main() {
  const file = readJson<BomItemsFile>("despl-320-bom-items.json");

  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const job = await prisma.job.findFirst({ where: { tenantId: org.id, jobNumber: file.job } });
  if (!job) {
    throw new Error(`${file.job} not found — run scripts/seed-despl320-and-de0467.ts first`);
  }
  const equipment = await prisma.equipment.findFirst({ where: { jobId: job.id } });
  if (!equipment) throw new Error(`${file.job} has no Equipment row yet`);

  let created = 0;
  let skipped = 0;

  for (const item of file.items) {
    const existing = await prisma.bomItem.findFirst({
      where: { equipmentId: equipment.id, itemNo: item.itemNo },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.bomItem.create({
      data: {
        equipmentId: equipment.id,
        itemNo: item.itemNo,
        partName: item.partName,
        description: item.description,
        material: item.material,
        qty: item.qty,
        unit: item.unit,
        remarks: item.remarks,
      },
    });
    created++;
  }

  console.log(`Seeded ${created} BomItem rows (skipped ${skipped} already present) for ${file.job}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
