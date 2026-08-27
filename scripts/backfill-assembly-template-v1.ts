// One-off local-dev backfill: prisma/seed.ts's `seedReference` skips its
// entire body (including the new PRESSURE_VESSEL assembly-template block
// added in Phase 2 / A2) once `Organization "DESPL"` already exists — by
// design, reference data changes never "pile on" via a re-run (see
// seedReference's own comment). A truly fresh database picks the new block
// up automatically via `prisma migrate deploy && prisma db seed`; this
// script exists only to catch an already-seeded local `despl` up to match,
// without touching anything else it already has (components, live jobs,
// component-operation state from earlier Phase 1 click-throughs).
//
// Idempotent: no-ops if the PRESSURE_VESSEL AssemblyTemplate already exists.
// Not wired into package.json as a repeatable command — run once via
// `npx tsx scripts/backfill-assembly-template-v1.ts` and delete when no
// longer needed by any environment.
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { TemplateStatus } from "../src/generated/prisma/enums";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

interface AssemblyTemplateFile {
  family: string;
  name: string;
  notes: string;
  steps: {
    seq: number;
    groupCode: string;
    groupName: string;
    srNo: string;
    activity: string;
    kind: "WORK" | "INSPECTION";
    defaultDepartment: string;
    jointRef?: string;
  }[];
}

async function main() {
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const family = await prisma.productFamily.findFirstOrThrow({
    where: { tenantId: org.id, code: "PRESSURE_VESSEL" },
  });

  const existing = await prisma.assemblyTemplate.findFirst({
    where: { tenantId: org.id, familyId: family.id },
  });
  if (existing) {
    console.log("PRESSURE_VESSEL AssemblyTemplate already exists — nothing to backfill.");
    return;
  }

  const file = JSON.parse(
    readFileSync(path.join(__dirname, "..", "seed", "assembly-template-pressure-vessel-v1.json"), "utf-8"),
  ) as AssemblyTemplateFile;

  const departments = await prisma.department.findMany({ where: { tenantId: org.id } });
  const deptIdByCode = new Map(departments.map((d) => [d.code, d.id]));

  const template = await prisma.assemblyTemplate.create({
    data: { tenantId: org.id, familyId: family.id, name: file.name },
  });
  const version = await prisma.assemblyTemplateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      status: TemplateStatus.PUBLISHED,
      publishedAt: new Date(),
      notes: file.notes,
    },
  });
  await prisma.assemblyTemplateStep.createMany({
    data: file.steps.map((s) => ({
      versionId: version.id,
      seq: s.seq,
      groupCode: s.groupCode,
      groupName: s.groupName,
      srNo: s.srNo,
      activity: s.activity,
      kind: s.kind,
      defaultDepartmentId: deptIdByCode.get(s.defaultDepartment)!,
      qcpSrNo: s.srNo,
      jointRef: s.jointRef ?? null,
    })),
  });

  const count = await prisma.assemblyTemplateStep.count({ where: { versionId: version.id } });
  console.log(`Created AssemblyTemplate v1 (${count} steps) for PRESSURE_VESSEL.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
