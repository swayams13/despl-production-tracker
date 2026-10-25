// Lean Core L1.2h: publish a new version of the PRESSURE_VESSEL assembly template whose steps carry the floor
// facts (role, joint, pressure flag) from the reviewed mapping, so jobs created from now on get the HARD rules
// H1 and H4-H6. Jobs that already exist keep their pin; fix those with lean-backfill-floor-facts.ts.
//
//   pnpm exec tsx scripts/lean-publish-assembly-roles.ts                 # dry run (default): writes nothing
//   pnpm exec tsx scripts/lean-publish-assembly-roles.ts --apply         # write (refuses a DRAFT mapping)
//   ... --allow-draft   apply a DRAFT_NEEDS_SIGNOFF mapping: throwaway local databases only
//   ... --mapping path  use another mapping file
//
// Invariant 9: the published version is never edited; a copy becomes the next version. Idempotent: nothing to do
// once the newest published version has the roles. Run it BEFORE lean-backfill-equipment-types.ts, which copies the
// newest published version into the skirt type's template. Production: owner role (DIRECT_URL) from the phone
// hotspot, after a dump; rehearse on a restored copy first.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { ensureAssemblyRoles } from "../src/lib/services/assembly-roles.setup";
import { mappingSchema } from "./lean-backfill-floor-facts";

const SOURCE = "scripts/lean-publish-assembly-roles.ts";
const DEFAULT_MAPPING = path.join(__dirname, "..", "seed", "assembly-step-roles-pv-v1.json");

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const mappingPath = argv.includes("--mapping") ? argv[argv.indexOf("--mapping") + 1]! : DEFAULT_MAPPING;
  const mapping = mappingSchema.parse(JSON.parse(readFileSync(mappingPath, "utf-8")));
  if (apply && mapping.reviewStatus === "DRAFT_NEEDS_SIGNOFF" && !argv.includes("--allow-draft")) {
    throw new Error("The mapping is DRAFT_NEEDS_SIGNOFF: refusing to apply (--allow-draft is for throwaway local databases only).");
  }
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"}); mapping ${mapping.reviewStatus}, reviewed against v${mapping.template.assemblyTemplateVersion}`);

  let wouldWrite = false;
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    await prisma.$transaction(
      async (tx) => {
        const r = await ensureAssemblyRoles(tx, org.id, { apply, mapping: mapping.steps, mappingStatus: mapping.reviewStatus, audit: true, auditSource: SOURCE });
        wouldWrite = r.newVersion != null;
        for (const s of r.skipped) console.log(`skipped: ${s}`);
        if (r.sourceVersion != null) console.log(`source: v${r.sourceVersion} (newest published family version)`);
        if (r.filled > 0 && r.sourceVersion != null && r.sourceVersion !== mapping.template.assemblyTemplateVersion) {
          console.log(`note: the mapping was reviewed against v${mapping.template.assemblyTemplateVersion}; the step count and seq numbers match, but check the activities before applying`);
        }
        console.log(`steps to fill: ${r.filled}; already complete: ${r.already}`);
        console.log(
          r.newVersion != null
            ? `${apply ? "published" : "would publish"}: v${r.newVersion}`
            : r.skipped.length > 0
              ? "nothing written (see skipped)"
              : "Nothing to do: the newest published version already carries the roles.",
        );
      },
      { timeout: 120_000 },
    );
    if (!apply && wouldWrite) console.log("\nRe-run with --apply to write.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
