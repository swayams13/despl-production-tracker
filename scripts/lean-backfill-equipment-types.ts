// Lean Core J1: create the pressure-vessel equipment types, the "vertical on
// skirt" assembly template and kit, and link DESPL-320's equipment to the skirt type.
//   npx tsx scripts/lean-backfill-equipment-types.ts            # dry run (default)
//   npx tsx scripts/lean-backfill-equipment-types.ts --apply    # write
// Idempotent. Never re-pins a job: DESPL-320 keeps the assembly template
// version its steps already point at (same content as the skirt copy).
// Production: run from the phone hotspot with the owner role (DIRECT_URL),
// after the J1 migration has been applied. Rehearse on a restored dump first.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensurePvEquipmentTypes, SKIRT_TYPE_CODE } from "../src/lib/services/equipment-type.setup";

const SOURCE = "scripts/lean-backfill-equipment-types.ts";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    await prisma.$transaction(
      async (tx) => {
        const report = await ensurePvEquipmentTypes(tx, org.id, { apply, audit: true, auditSource: SOURCE });
        console.log(`types ${apply ? "created" : "to create"}: ${report.typesCreated.join(", ") || "none"}`);
        console.log(
          `skirt template ${apply ? "created" : "to create"}: ${report.templateCreated ?? "none"}${report.templateCreated ? ` (${report.templateSteps} steps)` : ""}`,
        );
        console.log(`skirt kit ${apply ? "created" : "to create"}: ${report.kitCreated.join(", ") || "none"}`);
        for (const s of report.skipped) console.log(`skipped: ${s}`);

        const job = await tx.job.findFirst({ where: { tenantId: org.id, jobNumber: "DESPL-320" } });
        const equipments = job ? await tx.equipment.findMany({ where: { jobId: job.id, equipmentTypeId: null } }) : [];
        console.log(`DESPL-320 equipment to link to ${SKIRT_TYPE_CODE}: ${equipments.length}`);
        if (apply && report.skirtTypeId != null && equipments.length > 0) {
          for (const e of equipments) {
            await tx.equipment.update({ where: { id: e.id }, data: { equipmentTypeId: report.skirtTypeId } });
            await tx.auditLog.create({
              data: {
                tenantId: org.id,
                action: "setup.equipment.setType",
                entityType: "Equipment",
                entityId: String(e.id),
                before: { equipmentTypeId: null },
                after: { equipmentTypeId: report.skirtTypeId },
                userAgent: SOURCE,
              },
            });
          }
        }
      },
      { timeout: 120_000 },
    );
    if (!apply) console.log("\nRe-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
