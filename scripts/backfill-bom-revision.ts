// One-off backfill (Phase 4, B3): creates one `BomRevision` per distinct
// `equipmentId` already present in `bom_items`, status RELEASED, and points
// every existing `BomItem` row at it — safe because every current row is
// real, shipped data (the seed's BOM has always been the de-facto released
// one). A later dispatch (BOM authoring) is the first real writer of new
// DRAFT revisions; until then, a fresh import path has nothing to backfill.
//
// Idempotent — only creates a revision for an equipment that doesn't already
// have one, and only touches `BomItem` rows where `bomRevisionId` is still
// null, so re-running is a no-op once every row is backfilled.
//
// Run via `npx tsx scripts/backfill-bom-revision.ts`.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

async function main() {
  const equipmentIds = await prisma.bomItem.findMany({
    where: { bomRevisionId: null },
    select: { equipmentId: true },
    distinct: ["equipmentId"],
  });

  let equipmentsBackfilled = 0;
  let itemsBackfilled = 0;
  for (const { equipmentId } of equipmentIds) {
    const revision =
      (await prisma.bomRevision.findFirst({ where: { equipmentId, revisionNo: 1 } })) ??
      (await prisma.bomRevision.create({
        data: {
          jobId: (await prisma.equipment.findUniqueOrThrow({ where: { id: equipmentId }, select: { jobId: true } })).jobId,
          equipmentId,
          revisionNo: 1,
          status: "RELEASED",
          releasedAt: new Date(),
        },
      }));

    const { count } = await prisma.bomItem.updateMany({
      where: { equipmentId, bomRevisionId: null },
      data: { bomRevisionId: revision.id },
    });
    equipmentsBackfilled++;
    itemsBackfilled += count;
  }
  console.log(
    `Backfilled bomRevisionId on ${itemsBackfilled} BomItem row(s) across ${equipmentsBackfilled} equipment(s).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
