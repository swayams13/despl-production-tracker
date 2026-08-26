// Additive, idempotent seed: DESPL-320 sub-assembly register — Component +
// ComponentOperation rows for the 11 trackable components x 9 units, read
// from seed/despl-320-components.json.
//
// Deliberately does NOT create BomItem/Procurement rows. Unlike DE0463/
// DE0467, no real procurement BOM CSV export exists yet for DESPL-320 (it
// was only ever seeded from the QCP document header — see
// scripts/seed-despl320-and-de0467.ts's own comments). Inventing BomItem/
// Procurement rows here would put fabricated indent/PO/received-status data
// into a real procurement-tracking table, which this project's "real data
// only" demo mandate (CLAUDE.md) rules out. Component.bomItemId stays null
// until DESPL supplies a real BOM export; material/size/qty stay in
// seed/despl-320-components.json and the companion workbook until then.
//
// Deliberately NOT one big transaction (unlike seed-despl320-and-de0467.ts,
// whose own comment flags the exact failure mode: a long-running
// transaction over Railway's public Postgres proxy can get its connection
// dropped mid-transaction on a slow round trip). 99 rows is enough that a
// single all-or-nothing transaction is asking for the same problem for no
// real benefit — instead this loop is idempotent per (unitId, tag)
// (Component's own @@unique constraint), so re-running after a partial
// failure just resumes from wherever it stopped.
//
// Run with: pnpm db:seed:despl320-components
// (after scripts/seed-despl320-and-de0467.ts has created the DESPL-320 Job/
// Equipment/Unit rows — this script errors out clearly if they're missing.)
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { OperationStatus } from "../src/generated/prisma/enums";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(__dirname, "..", "seed", file), "utf-8")) as T;
}

interface ComponentDef {
  tag: string;
  label: string;
  componentType: string;
  material: string;
}
interface ComponentsFile {
  job: string;
  componentsPerUnit: ComponentDef[];
}

async function main() {
  const file = readJson<ComponentsFile>("despl-320-components.json");

  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const job = await prisma.job.findFirst({ where: { tenantId: org.id, jobNumber: file.job } });
  if (!job) {
    throw new Error(`${file.job} not found — run scripts/seed-despl320-and-de0467.ts first`);
  }
  const equipment = await prisma.equipment.findFirst({ where: { jobId: job.id } });
  if (!equipment) throw new Error(`${file.job} has no Equipment row yet`);
  const units = await prisma.unit.findMany({
    where: { equipmentId: equipment.id },
    orderBy: { serialNo: "asc" },
  });
  if (units.length === 0) throw new Error(`${file.job} has no Unit rows yet`);

  const componentTypes = await prisma.componentTypeRef.findMany({ where: { tenantId: org.id } });
  const typeIdByCode = new Map(componentTypes.map((c) => [c.code, c.id]));

  const routeVersions = await prisma.routeTemplateVersion.findMany({
    where: { route: { tenantId: org.id } },
    include: { route: true, steps: { orderBy: { seq: "asc" } } },
  });
  const routeVersionByTypeId = new Map(routeVersions.map((rv) => [rv.route.componentTypeId, rv]));

  let created = 0;
  let skipped = 0;

  for (const unit of units) {
    for (const comp of file.componentsPerUnit) {
      // Plain tag ("SHELL", not "SHELL-320SR01") — uniqueness is now scoped
      // to (unitId, tag), not (equipmentId, tag), so no per-unit suffix is
      // needed (see schema.prisma's Component.@@unique comment).
      const tag = comp.tag;

      const existing = await prisma.component.findFirst({
        where: { unitId: unit.id, tag },
      });
      if (existing) {
        skipped++;
        continue;
      }

      const typeId = typeIdByCode.get(comp.componentType);
      if (!typeId) {
        throw new Error(
          `componentType "${comp.componentType}" (for ${comp.tag}) not found in ComponentTypeRef — run pnpm db:seed first`,
        );
      }
      const routeVersion = routeVersionByTypeId.get(typeId);

      const component = await prisma.component.create({
        data: {
          equipmentId: equipment.id,
          unitId: unit.id,
          bomItemId: null,
          tag,
          componentTypeId: typeId,
          routeVersionId: routeVersion?.id ?? null,
        },
      });

      if (routeVersion) {
        await prisma.componentOperation.createMany({
          data: routeVersion.steps.map((step) => ({
            componentId: component.id,
            seq: step.seq,
            operationId: step.operationId,
            status: OperationStatus.NOT_STARTED,
          })),
        });
      } else {
        console.warn(`! ${comp.componentType} (${comp.tag}) has no RouteTemplateVersion — Component created with no ops`);
      }

      created++;
    }
  }

  console.log(
    `Seeded ${created} Component rows (skipped ${skipped} already present) for ${file.job}, ${units.length} units.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
