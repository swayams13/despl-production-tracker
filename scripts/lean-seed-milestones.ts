// Lean Core J8 (D9): create the ten company milestones and the PROVISIONAL
// pressure-vessel process -> milestone map. Ratify with SJ and the MD.
//   npx tsx scripts/lean-seed-milestones.ts            # dry run (default)
//   npx tsx scripts/lean-seed-milestones.ts --apply    # write
// Idempotent; never overwrites an existing milestone or map row.
// Production: phone hotspot, owner role (DIRECT_URL), after the J8 migration;
// rehearse on a restored dump first.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensureMilestones } from "../src/lib/services/milestones.setup";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const report = await prisma.$transaction((tx) => ensureMilestones(tx, org.id, { apply, auditSource: "scripts/lean-seed-milestones.ts" }), { timeout: 120_000 });
    console.log(`milestones ${apply ? "created" : "to create"}: ${report.milestonesCreated.join(", ") || "none"}`);
    for (const m of report.mapsCreated) console.log(`map rows ${apply ? "created" : "to create"} for ${m.family}: ${m.count}`);
    for (const s of report.skipped) console.log(`skipped: ${s}`);
    if (!apply) console.log("\nRe-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
