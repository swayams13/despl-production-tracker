// Pilot readiness (17 Oct 2026): DESPL-320's pressure parts have no stock to pick a heat
// number from, because (a) the shell and the two dished ends are not in the small-parts BOM
// ("not itemized", docs/DESPL-320-DEV-READY-BOM-SCHEDULE-v1.md §4.1) and (b) no component is
// linked to a BOM line (components.bom_item_id is null), so heat.service refuses with "not
// linked to a BOM line" and rule H2 can never be satisfied on cutting.
//
//   npx tsx scripts/link-despl320-bom.ts            # dry run (default): writes nothing
//   npx tsx scripts/link-despl320-bom.ts --apply    # write
//
// Adds BOM items 30-32 (shell, top and bottom dished end: SA 516 Gr 485, one per vessel, from
// the QCP §3.1 / drawing; plate size is NOT known, so none is invented: verify against the
// drawing before it becomes a purchase order) and fills components.bom_item_id (fill only,
// never overwrites). One audit_log row per change (actor null, script). Idempotent.
//
// The links follow seed/despl-320-components.json's own bomStatus notes. One is a judgement:
// N2 is one component fed by five BOM rows; it is linked to item 3 (the 1270 LG pipe, the
// part the PIPE route cuts). The 170 LG pipe (item 4) has no component of its own until
// J5, so its heat is not tracked against N2.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

export interface NewBomItem { itemNo: number; partName: string; description: string; material: string }

/** Main pressure-boundary parts that the small-parts BOM does not list. */
export const NEW_ITEMS: NewBomItem[] = [
  { itemNo: 30, partName: "Shell (single course)", description: "Plate size per GA drawing PN-EM3-HIN-301-MEC-040-DG-4503 Rev A; verify before procurement", material: "SA 516 Gr 485, normalized fine-grain fully killed" },
  { itemNo: 31, partName: "Top Dished End (head)", description: "Per GA drawing; verify before procurement", material: "SA 516 Gr 485" },
  { itemNo: 32, partName: "Bottom Dished End (head)", description: "Per GA drawing; verify before procurement", material: "SA 516 Gr 485" },
];

/** Component tag (per unit) -> BOM item number. SKIRT is a non-pressure assembly of three BOM rows: not linked. */
export const LINKS: Record<string, number> = {
  SHELL: 30,
  "TOP-HEAD": 31,
  "BOTTOM-HEAD": 32,
  N1: 1, // flange
  N2: 3, // pipe, 1270 LG (see header)
  N3: 10, // SRN forging
  N4: 11, // coupling, shared line of 3
  N5: 11,
  N6: 11,
  M1: 12, // manway SRN forging
};

export interface LinkPlan { newItems: NewBomItem[]; links: { componentId: number; tag: string; itemNo: number }[]; unlinkedTags: string[] }

/** Pure: what is missing, given what exists. */
export function planLinks(
  existingItemNos: number[],
  components: { id: number; tag: string; bomItemId: number | null }[],
): LinkPlan {
  const have = new Set(existingItemNos);
  const newItems = NEW_ITEMS.filter((i) => !have.has(i.itemNo));
  const known = new Set([...have, ...NEW_ITEMS.map((i) => i.itemNo)]);
  const links: LinkPlan["links"] = [];
  const unlinkedTags = new Set<string>();
  for (const c of components) {
    // Production's DESPL-320 rows come from an older seed run that suffixed the serial ("N1-320SR01"); the seed now writes "N1".
    const base = c.tag.replace(/-320SR\d+$/, "");
    const itemNo = LINKS[base];
    if (itemNo === undefined || !known.has(itemNo)) { unlinkedTags.add(base); continue; }
    if (c.bomItemId === null) links.push({ componentId: c.id, tag: c.tag, itemNo });
  }
  return { newItems, links, unlinkedTags: [...unlinkedTags].sort() };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const job = await prisma.job.findFirst({ where: { tenantId: org.id, jobNumber: "DESPL-320" } });
    if (!job) throw new Error("DESPL-320 not found");
    const equipment = await prisma.equipment.findFirstOrThrow({ where: { jobId: job.id } });
    const items = await prisma.bomItem.findMany({ where: { equipmentId: equipment.id }, select: { id: true, itemNo: true, bomRevisionId: true } });
    const components = await prisma.component.findMany({ where: { jobId: job.id }, select: { id: true, tag: true, bomItemId: true } });
    const plan = planLinks(items.map((i) => i.itemNo), components);

    console.log(`new BOM items: ${plan.newItems.map((i) => `${i.itemNo} ${i.partName}`).join("; ") || "none"}`);
    console.log(`component links to write: ${plan.links.length} (${[...new Set(plan.links.map((l) => `${l.tag}->${l.itemNo}`))].join(", ") || "none"})`);
    console.log(`tags left unlinked (by design or no BOM line): ${plan.unlinkedTags.join(", ") || "none"}`);
    if (!apply) return void console.log("\nRe-run with --apply to write.");
    if (!plan.newItems.length && !plan.links.length) return void console.log("Nothing to do.");

    const bomRevisionId = items.find((i) => i.bomRevisionId !== null)?.bomRevisionId ?? null;
    const ua = "scripts/link-despl320-bom.ts";
    await prisma.$transaction(async (tx) => {
      const idByNo = new Map(items.map((i) => [i.itemNo, i.id]));
      for (const n of plan.newItems) {
        const row = await tx.bomItem.create({
          data: {
            tenantId: org.id, jobId: job.id, equipmentId: equipment.id, itemNo: n.itemNo, partName: n.partName, description: n.description,
            material: n.material, sourceQty: "1", qtyPer: 1, uom: "NOS", bomRevisionId,
          },
        });
        idByNo.set(n.itemNo, row.id);
        await tx.auditLog.create({ data: { tenantId: org.id, actorId: null, action: "backfill.bomItem", entityType: "BomItem", entityId: String(row.id), before: null as never, after: { itemNo: n.itemNo, partName: n.partName } as never, userAgent: ua } });
      }
      for (const l of plan.links) {
        const bomItemId = idByNo.get(l.itemNo)!;
        await tx.component.update({ where: { id: l.componentId }, data: { bomItemId } });
        await tx.auditLog.create({ data: { tenantId: org.id, actorId: null, action: "backfill.componentBomLink", entityType: "Component", entityId: String(l.componentId), before: { bomItemId: null } as never, after: { bomItemId, tag: l.tag, itemNo: l.itemNo } as never, userAgent: ua } });
      }
    }, { timeout: 120_000 });
    console.log(`APPLIED: ${plan.newItems.length} BOM items, ${plan.links.length} links.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("link-despl320-bom.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
