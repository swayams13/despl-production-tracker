import type { Tx } from "@/lib/db";

/**
 * J5c (open point 3): a BOM line keeps its identity across revisions as (equipment, item number). Each revision has
 * its own `bom_items` row, so stock lots, heat picks and procurement events recorded against the line in an earlier
 * revision sit on an older id. Readers that total stock for a part ask for every id of its line.
 * Always includes `bomItemId` itself; one query.
 */
export async function lineBomItemIds(tx: Tx, bomItemId: number): Promise<number[]> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT b2.id FROM bom_items b1
    JOIN bom_items b2 ON b2.equipment_id = b1.equipment_id AND b2.item_no = b1.item_no
    WHERE b1.id = ${bomItemId}
    ORDER BY b2.id`;
  return rows.length ? rows.map((r) => r.id) : [bomItemId];
}
