// Lean Core J2: create the pressure-vessel config questions (the old SPEC_FIELDS)
// and rename legacy camelCase keys in equipment types' default specs.
//   npx tsx scripts/lean-backfill-config-questions.ts            # dry run (default)
//   npx tsx scripts/lean-backfill-config-questions.ts --apply    # write
// Idempotent. Job.specs is left alone (nothing reads it; its column stays).
// Production: phone hotspot, owner role (DIRECT_URL), after the J2 migration;
// rehearse on a restored dump first.
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensurePvConfigQuestions } from "../src/lib/services/config-questions.setup";

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const report = await prisma.$transaction(
      (tx) =>
        ensurePvConfigQuestions(tx, org.id, {
          apply,
          audit: true,
          auditSource: "scripts/lean-backfill-config-questions.ts",
        }),
      { timeout: 120_000 },
    );
    console.log(`questions ${apply ? "created" : "to create"}: ${report.created.join(", ") || "none"}`);
    for (const r of report.renamed) {
      console.log(`default specs ${apply ? "renamed" : "to rename"} on ${r.code}: ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}`);
    }
    if (report.renamed.length === 0) console.log("default specs to rename: none");
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
