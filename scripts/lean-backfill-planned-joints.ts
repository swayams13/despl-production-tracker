// Lean Core J4a: derive planned joints from the literal joint numbers on a job's assembly
// steps (DESPL-320: LS-1, CS-1, CS-2, nozzle lists ...) and link the rows that name exactly
// one joint, and the as-welded records that carry that number.
//   npx tsx scripts/lean-backfill-planned-joints.ts                      # dry run (default)
//   npx tsx scripts/lean-backfill-planned-joints.ts --apply              # write
//   npx tsx scripts/lean-backfill-planned-joints.ts --job DESPL-320      # one job only
// Idempotent. Joints are IMPORTED and unconfirmed until QC confirms them. A step that names
// several joints (a comma list) keeps its literal jointRef and stays unlinked. No step, seq
// or template changes (invariant 9). Production: hotspot, owner role (DIRECT_URL), after the
// J4a migration is applied; rehearse on a restored dump first.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { backfillPlannedJoints } from "../src/lib/services/planned-joint.setup";

const SOURCE = "scripts/lean-backfill-planned-joints.ts";

async function main() {
  const apply = process.argv.includes("--apply");
  const jobIdx = process.argv.indexOf("--job");
  const jobNumber = jobIdx >= 0 ? process.argv[jobIdx + 1] : undefined;
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})${jobNumber ? ` job ${jobNumber}` : ""}`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const report = await prisma.$transaction(
      (tx) => backfillPlannedJoints(tx, org.id, { apply, audit: true, auditSource: SOURCE, jobNumber }),
      { timeout: 120_000 },
    );
    console.log(`equipment lines with joint numbers: ${report.equipments}`);
    console.log(`planned joints ${apply ? "created" : "to create"}: ${report.jointsToCreate.length}`);
    for (const j of report.jointsToCreate) console.log(`  equipment ${j.equipmentId}: ${j.jointNo} (${j.jointType})`);
    console.log(`steps ${apply ? "linked" : "to link"}: ${report.stepsToLink}`);
    console.log(`weld records ${apply ? "linked" : "to link"}: ${report.weldJointsToLink}`);
    console.log(`steps naming several joints, left as they are: ${report.multiJointSteps}`);
    if (!apply) console.log("\nRe-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
