// Lean Core L1.2c: backfill the floor facts that recordWork's HARD rules read
// (assembly_steps.role / joint_ref / pressure_part, components.pressure_retaining)
// onto jobs that were created before L1.2b, from the reviewed mapping in
// seed/assembly-step-roles-pv-v1.json.
//
//   npx tsx scripts/lean-backfill-floor-facts.ts            # dry run (default): writes nothing
//   npx tsx scripts/lean-backfill-floor-facts.ts --apply    # write (refuses a DRAFT mapping)
//   ... --allow-draft   apply a DRAFT_NEEDS_SIGNOFF mapping: throwaway local databases only
//   ... --mapping path  use another mapping file
//
// Rules: only jobs pinned to the PRESSURE_VESSEL assembly template v1; fill
// only (null -> value, false -> true), never overwrite a value that is already
// set, so a second run changes nothing; one audit_log row per changed row
// (actor null, script). The published template rows are never touched
// (invariant 9). It prints the requiresQc list that D3's rule derives, for the
// QC head to review; it does not write requiresQc.
//
// Mapping status: DRAFT_NEEDS_SIGNOFF (--apply refuses), REVIEWED_PROVISIONAL (17 Oct
// 2026: recorded by Swayam for SJ and the QC head, ratification pending, like D2; applies,
// and every audit row carries the status) and REVIEWED (both ratified).
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PrismaClient } from "../src/generated/prisma/client";
import { deriveRequiresQc, type AssemblyRole } from "../src/lib/shared/floor-rules";

const ROLE = z.enum(["FIT_UP", "WELD", "NDT", "HEAT_TREATMENT", "FINAL_PWHT", "HYDRO"]);

export const mappingSchema = z.object({
  reviewStatus: z.enum(["DRAFT_NEEDS_SIGNOFF", "REVIEWED_PROVISIONAL", "REVIEWED"]),
  template: z.object({ family: z.string().min(1), assemblyTemplateVersion: z.number().int().positive() }),
  components: z.object({
    appliesToJobNumbers: z.array(z.string().min(1)),
    pressureRetainingByComponentType: z.record(z.string(), z.boolean()),
  }),
  steps: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        role: ROLE.nullable(),
        jointRef: z.string().min(1).nullable(),
        pressurePart: z.boolean(),
        note: z.string().optional(),
      }),
    )
    .min(1),
});
export type Mapping = z.infer<typeof mappingSchema>;

const DEFAULT_MAPPING = path.join(__dirname, "..", "seed", "assembly-step-roles-pv-v1.json");
const TEMPLATE_SEED = path.join(__dirname, "..", "seed", "assembly-template-pressure-vessel-v1.json");

export function loadMapping(file = DEFAULT_MAPPING): Mapping {
  const m = mappingSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
  const seqs = m.steps.map((s) => s.seq);
  if (new Set(seqs).size !== seqs.length) throw new Error(`${file}: duplicate seq in steps`);
  return m;
}

/** Fill-only diff of one assembly step row against its mapped entry; null = nothing to do. */
export function diffStep(
  row: { role: string | null; jointRef: string | null; pressurePart: boolean },
  want: Mapping["steps"][number],
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (row.role === null && want.role !== null) {
    before.role = null;
    after.role = want.role;
  }
  if (row.jointRef === null && want.jointRef !== null) {
    before.jointRef = null;
    after.jointRef = want.jointRef;
  }
  if (!row.pressurePart && want.pressurePart) {
    before.pressurePart = false;
    after.pressurePart = true;
  }
  return Object.keys(after).length ? { before, after } : null;
}

export interface BackfillReport {
  mode: "DRY_RUN" | "APPLIED";
  reviewStatus: Mapping["reviewStatus"];
  jobs: { jobId: number; jobNumber: string; stepChanges: number; componentChanges: number; stepsKept: number; stepsUnmapped: number }[];
  totals: { jobs: number; stepChanges: number; componentChanges: number; auditRows: number };
  unmappedComponentTypes: string[];
  requiresQcSteps: {
    seq: number;
    activity: string;
    stepKind: string;
    role: string | null;
    pressurePart: boolean;
    requiresQc: boolean;
    reason: string;
    appliedAtIntake: boolean;
    note?: string;
  }[];
  requiresQcOps: { componentType: string; opCode: string; pressure: boolean; requiresQc: boolean; reason: string }[];
}

export async function backfillFloorFacts(
  prisma: PrismaClient,
  opts: { mapping: Mapping; apply: boolean; allowDraft?: boolean; jobIds?: number[] },
): Promise<BackfillReport> {
  const { mapping, apply } = opts;
  if (apply && mapping.reviewStatus === "DRAFT_NEEDS_SIGNOFF" && !opts.allowDraft) {
    throw new Error(
      `Refusing --apply: the mapping is ${mapping.reviewStatus}. SJ and the QC head must sign it off (reviewStatus REVIEWED, or REVIEWED_PROVISIONAL on the Production Head's authority) first.`,
    );
  }
  const byseq = new Map(mapping.steps.map((s) => [s.seq, s]));
  const pressureByType = mapping.components.pressureRetainingByComponentType;

  const jobs = await prisma.job.findMany({
    where: {
      ...(opts.jobIds ? { id: { in: opts.jobIds } } : {}),
      assemblyTemplateVersion: {
        version: mapping.template.assemblyTemplateVersion,
        template: { family: { code: mapping.template.family } },
      },
    },
    select: { id: true, tenantId: true, jobNumber: true },
    orderBy: { id: "asc" },
  });

  const report: BackfillReport = {
    mode: apply ? "APPLIED" : "DRY_RUN",
    reviewStatus: mapping.reviewStatus,
    jobs: [],
    totals: { jobs: 0, stepChanges: 0, componentChanges: 0, auditRows: 0 },
    unmappedComponentTypes: [],
    requiresQcSteps: [],
    requiresQcOps: [],
  };
  const unmapped = new Set<string>();
  const opKeys = new Set<string>();

  for (const job of jobs) {
    const steps = await prisma.assemblyStep.findMany({
      where: { jobId: job.id },
      select: { id: true, role: true, jointRef: true, pressurePart: true, templateStep: { select: { seq: true } } },
    });
    const stepWrites: { id: number; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
    let kept = 0;
    let unmappedSteps = 0;
    for (const s of steps) {
      const want = byseq.get(s.templateStep.seq);
      if (!want) {
        unmappedSteps++;
        continue;
      }
      const d = diffStep(s, want);
      if (d) stepWrites.push({ id: s.id, ...d });
      else if ((s.role !== null && want.role !== null && s.role !== want.role) || (s.jointRef !== null && want.jointRef !== null && s.jointRef !== want.jointRef)) {
        kept++;
      }
    }

    const compWrites: { id: number; typeCode: string }[] = [];
    if (mapping.components.appliesToJobNumbers.includes(job.jobNumber)) {
      const comps = await prisma.component.findMany({
        where: { jobId: job.id },
        select: { id: true, pressureRetaining: true, componentType: { select: { code: true } }, operations: { select: { operation: { select: { code: true } } } } },
      });
      for (const c of comps) {
        const code = c.componentType.code;
        if (!(code in pressureByType)) unmapped.add(code);
        // Only ever raise false -> true; a `false` entry is documentation.
        if (pressureByType[code] === true && !c.pressureRetaining) compWrites.push({ id: c.id, typeCode: code });
        for (const o of c.operations) opKeys.add(`${code}\u0000${o.operation.code}`);
      }
    }

    if (apply && (stepWrites.length || compWrites.length)) {
      await prisma.$transaction(
        async (tx) => {
          for (const w of stepWrites) {
            await tx.assemblyStep.update({ where: { id: w.id }, data: w.after });
          }
          for (const w of compWrites) {
            await tx.component.update({ where: { id: w.id }, data: { pressureRetaining: true } });
          }
          const audit = (action: string, entityType: string, entityId: number, before: unknown, after: unknown) => ({
            tenantId: job.tenantId,
            actorId: null,
            action,
            entityType,
            entityId: String(entityId),
            before: before as never,
            after: after as never,
            userAgent: `scripts/lean-backfill-floor-facts.ts (mapping ${mapping.reviewStatus})`,
          });
          await tx.auditLog.createMany({
            data: [
              ...stepWrites.map((w) => audit("backfill.floorFacts", "AssemblyStep", w.id, w.before, w.after)),
              ...compWrites.map((w) =>
                audit("backfill.floorFacts", "Component", w.id, { pressureRetaining: false }, { pressureRetaining: true, componentType: w.typeCode }),
              ),
            ],
          });
        },
        { timeout: 120_000 },
      );
    }

    report.jobs.push({
      jobId: job.id,
      jobNumber: job.jobNumber,
      stepChanges: stepWrites.length,
      componentChanges: compWrites.length,
      stepsKept: kept,
      stepsUnmapped: unmappedSteps,
    });
    report.totals.stepChanges += stepWrites.length;
    report.totals.componentChanges += compWrites.length;
  }
  report.totals.jobs = jobs.length;
  report.totals.auditRows = apply ? report.totals.stepChanges + report.totals.componentChanges : 0;
  report.unmappedComponentTypes = [...unmapped].sort();

  // The D3 list for the QC head: what the rule derives for every mapped step.
  const tpl = JSON.parse(readFileSync(TEMPLATE_SEED, "utf-8")) as { steps: { seq: number; activity: string; kind: "WORK" | "INSPECTION" }[] };
  const tplBySeq = new Map(tpl.steps.map((s) => [s.seq, s]));
  for (const s of [...mapping.steps].sort((a, b) => a.seq - b.seq)) {
    const t = tplBySeq.get(s.seq);
    const stepKind = t?.kind ?? "WORK";
    const d = deriveRequiresQc({
      kind: "ASSEMBLY_STEP",
      stepKind,
      role: s.role as AssemblyRole | null,
      qcpLinked: stepKind === "INSPECTION",
      pressure: s.pressurePart,
    });
    report.requiresQcSteps.push({
      seq: s.seq,
      activity: t?.activity ?? "(not in template seed)",
      stepKind,
      role: s.role,
      pressurePart: s.pressurePart,
      requiresQc: d.requiresQc,
      reason: d.reason,
      // Intake derives only for role-carrying steps; the others keep the template value (true).
      appliedAtIntake: s.role !== null,
      note: s.note,
    });
  }
  for (const key of [...opKeys].sort()) {
    const [componentType, opCode] = key.split("\u0000");
    const pressure = pressureByType[componentType] === true;
    const d = deriveRequiresQc({ kind: "COMPONENT_OP", opCode, pressure, qcpLinked: false });
    report.requiresQcOps.push({ componentType, opCode, pressure, requiresQc: d.requiresQc, reason: d.reason });
  }
  return report;
}

function printReport(r: BackfillReport) {
  const log = console.log;
  log(`\n${r.mode === "APPLIED" ? "APPLIED" : "DRY RUN: nothing written"} (mapping ${r.reviewStatus})`);
  for (const j of r.jobs) {
    log(`  job ${j.jobNumber} (#${j.jobId}): ${j.stepChanges} step rows, ${j.componentChanges} components` +
      (j.stepsKept ? `, ${j.stepsKept} kept (already set differently)` : "") +
      (j.stepsUnmapped ? `, ${j.stepsUnmapped} steps not in mapping` : ""));
  }
  log(`  total: ${r.totals.jobs} jobs, ${r.totals.stepChanges} step rows, ${r.totals.componentChanges} components, ${r.totals.auditRows} audit rows`);
  if (r.unmappedComponentTypes.length) log(`  component types not in the mapping: ${r.unmappedComponentTypes.join(", ")}`);

  log("\nrequiresQc derived by D3's rule, for the QC head to review (assembly steps):");
  log("  seq  QC     intake  role            kind        activity  [reason]");
  for (const s of r.requiresQcSteps) {
    log(
      `  ${String(s.seq).padStart(3)}  ${(s.requiresQc ? "true" : "false").padEnd(5)}  ${(s.appliedAtIntake ? "yes" : "no").padEnd(6)}  ` +
        `${(s.role ?? "-").padEnd(14)}  ${s.stepKind.padEnd(10)}  ${s.activity.slice(0, 56)}  [${s.reason}]${s.note ? `  NOTE: ${s.note}` : ""}`,
    );
  }
  log('  ("intake: no" = the step has no role yet, so new jobs keep the template value, true)');
  if (r.requiresQcOps.length) {
    log("\nrequiresQc derived for component operations (applied at intake once the part family is APPROVED):");
    for (const o of r.requiresQcOps) {
      log(`  ${o.componentType.padEnd(12)} ${o.opCode.padEnd(14)} pressure=${o.pressure ? "yes" : "no "}  QC=${o.requiresQc}  [${o.reason}]`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const report = await backfillFloorFacts(prisma, {
      mapping: loadMapping(arg("--mapping")),
      apply,
      allowDraft: argv.includes("--allow-draft"),
    });
    printReport(report);
    if (!apply) console.log("\nRe-run with --apply to write (needs a REVIEWED or REVIEWED_PROVISIONAL mapping).");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("lean-backfill-floor-facts.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
