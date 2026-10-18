// Pilot readiness (18 Oct 2026): component operations of jobs created before L1.2b carry requires_qc = true
// (the column default), because the floor-facts backfill writes assembly steps and component flags but not
// operation requiresQc ("applied at intake"). D3's rule gives RECEIPT and MTC_VERIFICATION false, so a Receipt
// ticked or derived from a stock issue lands SUBMITTED and sits in the QC queue for a verify nobody needs.
//
//   npx tsx scripts/backfill-op-requires-qc.ts                 # dry run (default): writes nothing
//   npx tsx scripts/backfill-op-requires-qc.ts --apply         # write
//   ... --job DESPL-320     the job number (default DESPL-320)
//   ... --ops RECEIPT,MTC_VERIFICATION    operation codes (default these two; the rest of D3's derived list
//                                          waits for the QC head's review)
//
// Rules: only operations that have not yet been submitted (NOT_STARTED or IN_PROGRESS): a SUBMITTED or COMPLETE
// operation is history (QC may be about to verify it), it is reported, never rewritten. Only true -> false where
// D3's rule (`deriveRequiresQc`) says false, so a second run changes nothing and a rule that says true is never
// lowered. One audit_log row per change (actor null, script).
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { deriveRequiresQc } from "../src/lib/shared/floor-rules";

export const DEFAULT_OPS = ["RECEIPT", "MTC_VERIFICATION"];

export interface OpRow {
  id: number;
  opCode: string;
  status: string;
  requiresQc: boolean;
  pressure: boolean;
}

export interface Plan {
  change: OpRow[];
  /** Would change, but already submitted or complete: left alone. */
  history: OpRow[];
  /** Already false. */
  already: number;
  /** D3's rule says true: never lowered. */
  ruleSaysTrue: OpRow[];
}

/** Pure: which rows to lower, given D3's rule and each row's state. */
export function planRequiresQc(rows: OpRow[], ops: string[] = DEFAULT_OPS): Plan {
  const plan: Plan = { change: [], history: [], already: 0, ruleSaysTrue: [] };
  for (const r of rows) {
    if (!ops.includes(r.opCode)) continue;
    if (!r.requiresQc) {
      plan.already++;
      continue;
    }
    if (deriveRequiresQc({ kind: "COMPONENT_OP", opCode: r.opCode, qcpLinked: false, pressure: r.pressure }).requiresQc) {
      plan.ruleSaysTrue.push(r);
      continue;
    }
    (r.status === "NOT_STARTED" || r.status === "IN_PROGRESS" ? plan.change : plan.history).push(r);
  }
  return plan;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const jobNumber = arg("--job") ?? "DESPL-320";
  const ops = arg("--ops")?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_OPS;
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL must be set");
  const target = new URL(url);
  console.log(`target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})  job ${jobNumber}  ops ${ops.join(", ")}`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const org = await prisma.organization.findUniqueOrThrow({ where: { code: "DESPL" } });
    const job = await prisma.job.findFirst({ where: { tenantId: org.id, jobNumber }, select: { id: true } });
    if (!job) throw new Error(`${jobNumber} not found`);
    const found = await prisma.componentOperation.findMany({
      where: { jobId: job.id, operation: { code: { in: ops } } },
      select: { id: true, status: true, requiresQc: true, operation: { select: { code: true } }, component: { select: { pressureRetaining: true } } },
      orderBy: { id: "asc" },
    });
    const rows: OpRow[] = found.map((o) => ({ id: o.id, opCode: o.operation.code, status: o.status, requiresQc: o.requiresQc, pressure: o.component.pressureRetaining }));
    const plan = planRequiresQc(rows, ops);

    const byOp = (rs: OpRow[]) => ops.map((c) => `${c} ${rs.filter((r) => r.opCode === c).length}`).join(", ");
    console.log(`operations found: ${rows.length}`);
    console.log(`to lower to requires_qc = false: ${plan.change.length} (${byOp(plan.change)})`);
    console.log(`already false: ${plan.already}`);
    console.log(`left alone, already submitted or complete: ${plan.history.length}${plan.history.length ? ` (ids ${plan.history.map((r) => `${r.id}:${r.status}`).join(", ")})` : ""}`);
    if (plan.ruleSaysTrue.length) console.log(`left alone, D3's rule says true: ${plan.ruleSaysTrue.length}`);
    if (!apply) return void console.log("\nRe-run with --apply to write.");
    if (!plan.change.length) return void console.log("Nothing to do.");

    const ua = "scripts/backfill-op-requires-qc.ts";
    let written = 0;
    await prisma.$transaction(
      async (tx) => {
        for (const r of plan.change) {
          // The status is part of the filter: an operation submitted since the read is not touched.
          const res = await tx.componentOperation.updateMany({ where: { id: r.id, requiresQc: true, status: { in: ["NOT_STARTED", "IN_PROGRESS"] } }, data: { requiresQc: false } });
          if (res.count !== 1) continue;
          written++;
          await tx.auditLog.create({
            data: {
              tenantId: org.id,
              actorId: null,
              action: "backfill.opRequiresQc",
              entityType: "ComponentOperation",
              entityId: String(r.id),
              before: { requiresQc: true } as never,
              after: { requiresQc: false, opCode: r.opCode, rule: "D3: no QC trigger (handling, non-pressure, preparation)" } as never,
              userAgent: ua,
            },
          });
        }
      },
      { timeout: 120_000 },
    );
    console.log(`APPLIED: ${written} operations${written < plan.change.length ? ` (${plan.change.length - written} changed state since the read and were skipped)` : ""}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("backfill-op-requires-qc.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
