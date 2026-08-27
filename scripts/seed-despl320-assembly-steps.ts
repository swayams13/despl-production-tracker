// Additive, idempotent materialisation: DESPL-320's 486 AssemblyStep rows
// (54 checkpoints × 9 units), from the PRESSURE_VESSEL AssemblyTemplateVersion
// v1 seeded by prisma/seed.ts / scripts/backfill-assembly-template-v1.ts.
//
// Mirrors scripts/seed-despl320-components.ts's shape: not one big
// transaction (Railway's public Postgres proxy can drop a long-running one
// mid-round-trip — see that script's own comment), idempotent per
// (unitId, seq) — AssemblyStep's own @@unique constraint — so a re-run after
// a partial failure resumes rather than duplicating.
//
// Also sets Job.assemblyTemplateVersionId if it's still null (no intake UI
// pins this yet — see schema.prisma's comment on that column).
//
// qcpItemId resolution: match AssemblyTemplateStep.qcpSrNo to QcpItem.srNo
// within the job's own QcpTemplate — never by id, so it survives QCP
// renumbering (same discipline job-intake.service.ts's cloneQcpTemplate
// uses). Several QcpItem rows can share one srNo (the real QCP has 62 items
// sharing 43 sr numbers — see schema.prisma's QcpItem comment), so a second
// pass disambiguates by normalised activity-text overlap. Where that still
// doesn't resolve to exactly one row, qcpItemId is left null and the
// ambiguity is reported — never guessed (CLAUDE.md §0 rule 4's "do not
// guess" standard, same one F6 followed in Phase 1).
//
// Run with: pnpm db:seed:despl320-assembly-steps
// (after prisma/seed.ts or scripts/backfill-assembly-template-v1.ts has
// created the PRESSURE_VESSEL AssemblyTemplateVersion, and
// scripts/seed-despl320-and-de0467.ts has created the DESPL-320 Job/Unit rows.)
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
});

function normalize(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(" ").filter(Boolean));
  const tb = new Set(normalize(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

async function main() {
  const jobNumber = "DESPL-320";
  const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
  const job = await prisma.job.findFirst({ where: { tenantId: org.id, jobNumber } });
  if (!job) throw new Error(`${jobNumber} not found — run scripts/seed-despl320-and-de0467.ts first`);

  const units = await prisma.unit.findMany({
    where: { equipment: { jobId: job.id } },
    orderBy: { serialNo: "asc" },
  });
  if (units.length === 0) throw new Error(`${jobNumber} has no Unit rows yet`);

  const family = await prisma.productFamily.findFirst({ where: { id: job.familyId } });
  if (!family) throw new Error(`${jobNumber}'s ProductFamily (id ${job.familyId}) not found`);

  const asmTemplate = await prisma.assemblyTemplate.findFirst({
    where: { tenantId: org.id, familyId: job.familyId },
  });
  if (!asmTemplate) {
    throw new Error(
      `No AssemblyTemplate for family "${family.code}" — run scripts/backfill-assembly-template-v1.ts or pnpm db:seed first`,
    );
  }
  const asmVersion = await prisma.assemblyTemplateVersion.findFirst({
    where: { templateId: asmTemplate.id, status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: { steps: { orderBy: { seq: "asc" } } },
  });
  if (!asmVersion) throw new Error(`AssemblyTemplate ${asmTemplate.id} has no PUBLISHED version`);
  if (asmVersion.steps.length === 0) throw new Error(`AssemblyTemplateVersion ${asmVersion.id} has no steps`);

  if (job.assemblyTemplateVersionId == null) {
    await prisma.job.update({ where: { id: job.id }, data: { assemblyTemplateVersionId: asmVersion.id } });
    console.log(`Pinned ${jobNumber} to AssemblyTemplateVersion ${asmVersion.id} (v${asmVersion.version}).`);
  } else if (job.assemblyTemplateVersionId !== asmVersion.id) {
    console.warn(
      `! ${jobNumber} is already pinned to AssemblyTemplateVersion ${job.assemblyTemplateVersionId}, ` +
        `not the latest PUBLISHED version ${asmVersion.id} — leaving as-is (invariant #9: never silently re-pin).`,
    );
  }
  const pinnedVersionId = job.assemblyTemplateVersionId ?? asmVersion.id;
  const templateSteps =
    pinnedVersionId === asmVersion.id
      ? asmVersion.steps
      : (await prisma.assemblyTemplateVersion.findFirstOrThrow({
          where: { id: pinnedVersionId },
          include: { steps: { orderBy: { seq: "asc" } } },
        })).steps;

  // qcpSrNo -> candidate QcpItem[], scoped to this job's own QcpTemplate(s).
  const qcpItems = await prisma.qcpItem.findMany({ where: { qcpTemplate: { jobId: job.id } } });
  const itemsBySrNo = new Map<string, typeof qcpItems>();
  for (const item of qcpItems) {
    const list = itemsBySrNo.get(item.srNo) ?? [];
    list.push(item);
    itemsBySrNo.set(item.srNo, list);
  }

  function resolveQcpItemId(step: (typeof templateSteps)[number]): number | null {
    if (!step.qcpSrNo) return null;
    const candidates = itemsBySrNo.get(step.qcpSrNo) ?? [];
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].id;
    const scored = candidates
      .map((c) => ({ id: c.id, score: tokenOverlap(c.activity, step.activity) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score >= 0.5 && scored[0].score > (scored[1]?.score ?? 0)) return scored[0].id;
    console.warn(
      `! ambiguous QcpItem match for step ${step.seq} (sr ${step.qcpSrNo} "${step.activity}") — ` +
        `${candidates.length} candidates, best score ${scored[0].score.toFixed(2)} — leaving qcpItemId null.`,
    );
    return null;
  }

  let created = 0;
  let skipped = 0;
  let boundToQcp = 0;

  for (const unit of units) {
    for (const step of templateSteps) {
      const existing = await prisma.assemblyStep.findFirst({ where: { unitId: unit.id, seq: step.seq } });
      if (existing) {
        skipped++;
        continue;
      }
      const qcpItemId = resolveQcpItemId(step);
      if (qcpItemId != null) boundToQcp++;
      await prisma.assemblyStep.create({
        data: { unitId: unit.id, templateStepId: step.id, seq: step.seq, qcpItemId },
      });
      created++;
    }
  }

  console.log(
    `Seeded ${created} AssemblyStep rows (skipped ${skipped} already present) for ${jobNumber}, ` +
      `${units.length} units × ${templateSteps.length} steps. ${boundToQcp} bound to a QcpItem.`,
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
