// One-off local-dev backfill: the PRESSURE_VESSEL AssemblyTemplate was
// already created on this `despl` DB by Phase 2's seed run, before Phase 3's
// R0 added `AssemblyTemplateStep.leadTimeProcessSeq`. A fresh database picks
// the new column up automatically via `prisma migrate deploy && prisma db
// seed` (prisma/seed.ts's createMany already carries the field); this script
// exists only to catch an already-seeded local `despl` up to match, matching
// by `seq` within the PRESSURE_VESSEL v1 version. Idempotent — re-running
// just overwrites with the same values.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

interface AssemblyTemplateFile {
  steps: { seq: number; leadTimeProcessSeq?: number }[];
}

async function main() {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const family = await prisma.productFamily.findFirstOrThrow({
    where: { tenantId: org.id, code: "PRESSURE_VESSEL" },
  });
  const template = await prisma.assemblyTemplate.findFirstOrThrow({
    where: { tenantId: org.id, familyId: family.id },
  });
  const version = await prisma.assemblyTemplateVersion.findFirstOrThrow({
    where: { templateId: template.id, version: 1 },
  });

  const file = JSON.parse(
    readFileSync(path.join(__dirname, "..", "seed", "assembly-template-pressure-vessel-v1.json"), "utf-8"),
  ) as AssemblyTemplateFile;

  let updated = 0;
  for (const s of file.steps) {
    if (s.leadTimeProcessSeq == null) continue;
    const res = await prisma.assemblyTemplateStep.updateMany({
      where: { versionId: version.id, seq: s.seq },
      data: { leadTimeProcessSeq: s.leadTimeProcessSeq },
    });
    updated += res.count;
  }
  console.log(`Backfilled leadTimeProcessSeq on ${updated} AssemblyTemplateStep rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
