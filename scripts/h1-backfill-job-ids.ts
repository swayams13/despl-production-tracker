// One-off backfill for H1's job_id denormalization (28 tables — see
// docs/superpowers/plans/2026-09-05-h1-job-level-rls-backstop.md Task 2).
// Run against despl_test first; production application follows
// MERGE-RUNBOOK.md at actual deploy time.
//
// Not idempotent-safe to re-run blindly against a DB with NEW rows created
// after this script ran once — it only fixes NULLs, so re-running is safe,
// but it is not a substitute for the app writing job_id going forward
// (Task 5+ handles that).
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";

// stock_lots/stock_txns/procurement_events etc. are append-only for the app
// role (despl_web) — see 20260827180000_procurement_stock_append_only_grants.
// This backfill needs UPDATE, so it connects via DIRECT_URL (the owner role),
// same pattern as migration-backfill.test.ts.
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

async function main() {
  // Batch A — one hop.
  await prisma.$executeRaw`
    UPDATE units u SET job_id = e.job_id
    FROM equipments e WHERE u.equipment_id = e.id AND u.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE bom_revisions r SET job_id = e.job_id
    FROM equipments e WHERE r.equipment_id = e.id AND r.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE bom_items i SET job_id = e.job_id
    FROM equipments e WHERE i.equipment_id = e.id AND i.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE components c SET job_id = e.job_id
    FROM equipments e WHERE c.equipment_id = e.id AND c.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE job_process_edges g SET job_id = p.job_id
    FROM job_processes p WHERE g.process_id = p.id AND g.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE weld_joint_welders w SET job_id = j.job_id
    FROM weld_joints j WHERE w.weld_joint_id = j.id AND w.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE ndt_results n SET job_id = j.job_id
    FROM weld_joints j WHERE n.weld_joint_id = j.id AND n.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE drawing_revisions r SET job_id = d.job_id
    FROM assembly_drawings d WHERE r.assembly_drawing_id = d.id AND r.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE dispatch_batch_units u SET job_id = b.job_id
    FROM dispatch_batches b WHERE u.dispatch_batch_id = b.id AND u.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE inspection_parties p SET job_id = t.job_id
    FROM qcp_templates t WHERE p.qcp_template_id = t.id AND p.job_id IS NULL AND t.job_id IS NOT NULL`;
  await prisma.$executeRaw`
    UPDATE qcp_items i SET job_id = t.job_id
    FROM qcp_templates t WHERE i.qcp_template_id = t.id AND i.job_id IS NULL AND t.job_id IS NOT NULL`;

  // Batch B — two hops via Batch A tables (run after Batch A populates).
  await prisma.$executeRaw`
    UPDATE component_operations o SET job_id = c.job_id
    FROM components c WHERE o.component_id = c.id AND o.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE component_operation_rejections r SET job_id = o.job_id
    FROM component_operations o WHERE r.component_operation_id = o.id AND r.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE paint_records p SET job_id = o.job_id
    FROM component_operations o WHERE p.component_operation_id = o.id AND p.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE dft_readings d SET job_id = o.job_id
    FROM component_operations o WHERE d.component_operation_id = o.id AND d.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE assembly_steps s SET job_id = u.job_id
    FROM units u WHERE s.unit_id = u.id AND s.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE assembly_step_rejections r SET job_id = s.job_id
    FROM assembly_steps s WHERE r.assembly_step_id = s.id AND r.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE qcp_item_processes p SET job_id = i.job_id
    FROM qcp_items i WHERE p.qcp_item_id = i.id AND p.job_id IS NULL AND i.job_id IS NOT NULL`;
  await prisma.$executeRaw`
    UPDATE qcp_item_party_codes c SET job_id = i.job_id
    FROM qcp_items i WHERE c.qcp_item_id = i.id AND c.job_id IS NULL AND i.job_id IS NOT NULL`;
  await prisma.$executeRaw`
    UPDATE stock_lots l SET job_id = i.job_id
    FROM bom_items i WHERE l.bom_item_id = i.id AND l.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE procurement_events e SET job_id = i.job_id
    FROM bom_items i WHERE e.bom_item_id = i.id AND e.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE material_identifications m SET job_id = i.job_id
    FROM bom_items i WHERE m.bom_item_id = i.id AND m.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE item_tests t SET job_id = i.job_id
    FROM bom_items i WHERE t.bom_item_id = i.id AND t.job_id IS NULL`;

  // NCR — XOR FK: pull job_id from whichever branch is non-null.
  await prisma.$executeRaw`
    UPDATE ncrs n SET job_id = r.job_id
    FROM component_operation_rejections r
    WHERE n.component_operation_rejection_id = r.id AND n.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE ncrs n SET job_id = r.job_id
    FROM assembly_step_rejections r
    WHERE n.assembly_step_rejection_id = r.id AND n.job_id IS NULL`;

  // Dual-path models: backfill from the "unit"/"jobProcess" path, THEN verify
  // the other path agrees (report only — do not resolve automatically).
  await prisma.$executeRaw`
    UPDATE process_plans p SET job_id = jp.job_id
    FROM job_processes jp WHERE p.job_process_id = jp.id AND p.job_id IS NULL`;
  await prisma.$executeRaw`
    UPDATE qcp_executions q SET job_id = u.job_id
    FROM units u WHERE q.unit_id = u.id AND q.job_id IS NULL`;
  // stock_txns depends on stock_lots already being populated above.
  await prisma.$executeRaw`
    UPDATE stock_txns t SET job_id = l.job_id
    FROM stock_lots l WHERE t.stock_lot_id = l.id AND t.job_id IS NULL`;
  // ponytail: DelayReason (-> ProcessPlan) is in the plan's Batch B research
  // list but was missing from its own backfill script draft — added here,
  // after process_plans.job_id is populated above (this update depends on it).
  await prisma.$executeRaw`
    UPDATE delay_reasons d SET job_id = p.job_id
    FROM process_plans p WHERE d.process_plan_id = p.id AND d.job_id IS NULL`;

  // ---- Divergence report (does not fail the script; surfaces findings) ----
  const processPlanMismatches: { id: number }[] = await prisma.$queryRaw`
    SELECT p.id FROM process_plans p
    JOIN schedule_runs sr ON p.schedule_run_id = sr.id
    WHERE p.job_id IS DISTINCT FROM sr.job_id`;
  const qcpExecutionMismatches: { id: number }[] = await prisma.$queryRaw`
    SELECT q.id FROM qcp_executions q
    JOIN qcp_items i ON q.qcp_item_id = i.id
    WHERE i.job_id IS NOT NULL AND q.job_id IS DISTINCT FROM i.job_id`;

  console.log(`process_plans dual-path mismatches: ${processPlanMismatches.length}`, processPlanMismatches);
  console.log(`qcp_executions dual-path mismatches: ${qcpExecutionMismatches.length}`, qcpExecutionMismatches);

  const stillNull: Array<{ table: string; count: bigint }> = await prisma.$queryRaw`
    SELECT 'units' AS table, count(*) FROM units WHERE job_id IS NULL
    UNION ALL SELECT 'component_operations', count(*) FROM component_operations WHERE job_id IS NULL
    UNION ALL SELECT 'assembly_steps', count(*) FROM assembly_steps WHERE job_id IS NULL
    UNION ALL SELECT 'ncrs', count(*) FROM ncrs WHERE job_id IS NULL
    UNION ALL SELECT 'process_plans', count(*) FROM process_plans WHERE job_id IS NULL
    UNION ALL SELECT 'stock_lots', count(*) FROM stock_lots WHERE job_id IS NULL
    UNION ALL SELECT 'delay_reasons', count(*) FROM delay_reasons WHERE job_id IS NULL`;
  console.log("Remaining NULLs (should be zero, or explainable — e.g. library QcpItem/InspectionParty rows):", stillNull);
}

main().finally(() => prisma.$disconnect());
