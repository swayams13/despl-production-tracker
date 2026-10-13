// Lean Core M2 (PR A): dry-run of the Standard Parts Master import. READ-ONLY.
// Reads the workbook and the tenant's current master data, prints what an
// apply would create / change / refuse, and every issue with its sheet and
// row. Writes nothing. Apply arrives in M2 PR B.
//
// Run with:
//   pnpm tsx scripts/import-standard-parts-master.ts [--file <xlsx>] [--allow-draft]
//        [--org DESPL] [--json <out.json>] [--examples 5]
//
// --allow-draft  load Draft / Reviewed parts as drafts (staging); without it
//                only "Approved by Production Head" rows are loadable (production).
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { dryRunWithDb } from "../src/lib/services/master-import.service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const DEFAULT_FILE = "docs/lean-core/inputs/2026-10-11-master-list/Standard_Parts_Master_PV_HE_SAMPLE.xlsx";

async function main() {
  if (has("--apply")) {
    console.error("Apply is not part of this PR (M2 PR B). This script only produces the dry-run report.");
    process.exit(2);
  }
  const file = path.resolve(arg("--file") ?? DEFAULT_FILE);
  const orgCode = arg("--org") ?? "DESPL";
  const examples = Number(arg("--examples") ?? 5);
  const allowDraft = has("--allow-draft");

  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: orgCode }, select: { id: true } });
    const report = await dryRunWithDb(prisma, org.id, readFileSync(file), { allowDraft });

    const t = (x: { create: number; update: number; unchanged: number; skipped: number }) =>
      `create ${x.create} · update ${x.update} · unchanged ${x.unchanged} · skipped ${x.skipped}`;
    console.log(`\nStandard Parts Master — dry run (${allowDraft ? "drafts allowed" : "approved rows only"})`);
    console.log(`File: ${file}`);
    console.log(
      `Read: ${report.counts.parts} parts · ${report.counts.routeSteps} route steps · ${report.counts.materialGrades} materials · ` +
        `${report.counts.heStages} HE stages · ${report.counts.assemblyRows} assembly rows · ` +
        `${report.counts.newOperations} proposed operations · ${report.counts.reviewActions} review actions` +
        (report.counts.exampleRowsSkipped ? ` · ${report.counts.exampleRowsSkipped} example rows skipped` : ""),
    );
    console.log("\nPlan");
    console.log(`  Part families   ${t(report.plan.partFamilies)}`);
    console.log(`  Routes          ${t(report.plan.routes)}`);
    console.log(`  Stage mappings  ${report.plan.stageMappingRows} rows`);
    console.log(`  Material grades ${t(report.plan.materialGrades)}`);
    console.log(
      `  HE template     ${report.plan.heStages.stages} stages, ${report.plan.heStages.loadable ? "loadable" : "NOT loadable (errors)"}, ` +
        `${report.plan.heStages.existingTemplates} existing`,
    );

    console.log("\nIssues");
    for (const s of report.issueSummary) console.log(`  ${s.severity.padEnd(7)} ${s.code.padEnd(38)} ${s.count}`);

    for (const s of report.issueSummary) {
      const rows = report.issues.filter((i) => i.code === s.code);
      console.log(`\n${s.severity} ${s.code} (${s.count})`);
      for (const i of rows.slice(0, examples)) {
        console.log(`  ${i.sheet}${i.row != null ? ` row ${i.row}` : ""}${i.partCode ? ` [${i.partCode}]` : ""}: ${i.message}`);
      }
      if (rows.length > examples) console.log(`  … ${rows.length - examples} more (use --examples ${rows.length} or --json)`);
    }

    const out = arg("--json");
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(`\nFull report written to ${out}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
