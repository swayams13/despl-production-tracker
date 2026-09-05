// F6 (26 Aug 2026): the PLATE route's single combined FORMING step becomes
// two floor-tracked steps, ROLLING then FORMING, per
// docs/DESPL-320-fabrication-assembly-spec.md#1 SHELL-01 (seq 5-6) — "Team
// asked to track Rolling and Forming as two separate timed steps", sourced
// from the workbook itself (the spec's own note), not invented. Resolves
// F-a (spec §4 / addendum §5).
//
// This is a template-versioning change, not an in-place edit (CLAUDE.md
// invariant #9: "Edits create a new template_versions row; running units
// keep their pinned version" — running units DON'T apply here since nothing
// has shipped yet, but the mechanism is the same one Phase 4 will lean on).
// Generic across every job using the PLATE component type — not a
// DESPL-320 special case (family readiness rule, docs/ADR-product-family-
// agnostic-platform-v1.md); PLATE's RouteTemplate has no familyId, so this
// reaches every family that uses it.
//
// Idempotent: safe to re-run. Skips a component already pointed at the new
// version, and skips a component that already has a ROLLING op.
//
// Run with: pnpm tsx scripts/split-plate-rolling-forming.ts
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { OperationStatus, TemplateStatus } from "../src/generated/prisma/enums";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

interface RouteOpDef {
  seq: number;
  printed: string;
  operation: string;
}
interface ComponentRoutesFile {
  canonicalOperations: Record<
    string,
    { label: string; dept: string; csvColumn: string | null; leadTimeProcess?: number }
  >;
  routes: { componentType: string; printedRoute: string; operations: RouteOpDef[] }[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

async function main() {
  const file = readJson<ComponentRoutesFile>("component-routes.json");
  const plateRoute = file.routes.find((r) => r.componentType === "PLATE");
  if (!plateRoute) throw new Error("component-routes.json has no PLATE route — nothing to apply");

  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });

  // 1. Ensure the ROLLING OperationRef exists.
  const rollingDef = file.canonicalOperations.ROLLING;
  if (!rollingDef) throw new Error("component-routes.json's canonicalOperations has no ROLLING entry");
  const dept = await prisma.department.findFirstOrThrow({ where: { tenantId: org.id, code: rollingDef.dept } });
  const rolling = await prisma.operationRef.upsert({
    where: { tenantId_code: { tenantId: org.id, code: "ROLLING" } },
    update: {},
    create: {
      tenantId: org.id,
      code: "ROLLING",
      name: rollingDef.label,
      defaultDepartmentId: dept.id,
      sourceColumn: rollingDef.csvColumn,
    },
  });
  // Gate 3 fix: leadTimeProcessSeq is now family-scoped (OperationRefFamilySeq)
  // rather than a bare column on OperationRef — PLATE's route predates any
  // other family having real components, so PRESSURE_VESSEL is the only
  // family this mapping applies to today.
  if (rollingDef.leadTimeProcess != null) {
    const pressureVessel = await prisma.productFamily.findFirstOrThrow({
      where: { tenantId: org.id, code: "PRESSURE_VESSEL" },
    });
    await prisma.operationRefFamilySeq.upsert({
      where: { operationRefId_familyId: { operationRefId: rolling.id, familyId: pressureVessel.id } },
      update: { leadTimeProcessSeq: rollingDef.leadTimeProcess },
      create: {
        tenantId: org.id,
        operationRefId: rolling.id,
        familyId: pressureVessel.id,
        leadTimeProcessSeq: rollingDef.leadTimeProcess,
      },
    });
  }

  // 2. Find PLATE's RouteTemplate and current PUBLISHED version.
  const componentType = await prisma.componentTypeRef.findFirstOrThrow({
    where: { tenantId: org.id, code: "PLATE" },
  });
  const routeTemplate = await prisma.routeTemplate.findFirstOrThrow({
    where: { tenantId: org.id, componentTypeId: componentType.id },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const currentVersion = routeTemplate.versions[0];
  if (!currentVersion) throw new Error("PLATE RouteTemplate has no version to base v2 on");

  // Already migrated? (re-run safety)
  const existingV2 = await prisma.routeTemplateVersion.findFirst({
    where: { routeId: routeTemplate.id, version: currentVersion.version + 1 },
  });

  const operations = await prisma.operationRef.findMany({ where: { tenantId: org.id } });
  const operationIdByCode = new Map(operations.map((o) => [o.code, o.id]));
  operationIdByCode.set("ROLLING", rolling.id);

  const newVersion =
    existingV2 ??
    (await prisma.routeTemplateVersion.create({
      data: {
        routeId: routeTemplate.id,
        version: currentVersion.version + 1,
        status: TemplateStatus.PUBLISHED,
        printedRoute: plateRoute.printedRoute,
        steps: {
          create: plateRoute.operations.map((op) => {
            const operationId = operationIdByCode.get(op.operation);
            if (!operationId) throw new Error(`Unknown operation code ${op.operation} in PLATE route`);
            return { seq: op.seq, operationId, printed: op.printed };
          }),
        },
      },
    }));

  console.log(`PLATE route now at v${newVersion.version} (${plateRoute.operations.length} steps).`);

  // 3. Re-point every PLATE component still on the old version, and add the
  // ROLLING ComponentOperation each one is now missing.
  const componentsToMigrate = await prisma.component.findMany({
    where: { componentTypeId: componentType.id, routeVersionId: currentVersion.id },
    select: { id: true, jobId: true, operations: { select: { seq: true, operationId: true } } },
  });

  let migrated = 0;
  let opsAdded = 0;
  for (const c of componentsToMigrate) {
    await prisma.component.update({ where: { id: c.id }, data: { routeVersionId: newVersion.id } });
    migrated++;

    const alreadyHasRolling = c.operations.some((o) => o.operationId === rolling.id);
    if (!alreadyHasRolling) {
      const nextSeq = Math.max(0, ...c.operations.map((o) => o.seq)) + 1;
      await prisma.componentOperation.create({
        data: { jobId: c.jobId, componentId: c.id, seq: nextSeq, operationId: rolling.id, status: OperationStatus.NOT_STARTED },
      });
      opsAdded++;
    }
  }

  console.log(`Repointed ${migrated} PLATE component(s) to v${newVersion.version}; added ${opsAdded} ROLLING operation row(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
