# H1 — Job-Level RLS Backstop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give job-level isolation the same kind of DB-enforced backstop tenant isolation already has — a genuinely mismatched `jobId` (e.g. a component-operation id from Job A passed alongside a process id from Job B) becomes an immediate, structural refusal instead of a silent cross-job data leak, without breaking any of the legitimate cross-job reads (dashboard, portfolio, job list, my-day, command-center, notifications).

**Architecture:** Denormalize a `job_id` column onto every child table that is 1–4 joins from `Job` and is read/written in a single-job service context (28 models total). Add a NEW row-level-security policy on those tables, `job_isolation`, that is **permanently fail-open** when a new transaction-local session var `app.job_id` is unset (unlike the tenant policy, which is fail-closed) — this is what lets every existing cross-job read keep working with zero code changes, while a new `withJob()` wrapper lets single-job service functions opt into DB-enforced job scoping. Then convert the highest-risk service call sites (the ones that today only assert *tenant* membership, never that two related ids belong to the *same job*) to set `app.job_id` and pass real `jobId` values through their Prisma queries.

**Tech Stack:** Prisma 6, PostgreSQL 16 (RLS), TypeScript strict, vitest (`pnpm test:db` against `despl_test`).

**Spec:** `docs/mos-blueprint/reference/15_DESPL_MOS_DATA_ARCHITECTURE.md` §4 (the named gap) and `docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md` Phase H, row H1 ("Job-level RLS policy (or enforced views) backstopping the `jobId` filter convention" — acceptance: "A deliberately-unfiltered query cannot read another job's rows"). Research behind this plan: the investigation transcript enumerating all 28 models, their join chains, and the exact call sites below (see this plan's §"Research findings" for the citations pulled from it).

## Global Constraints

- **No client timestamps** — irrelevant here (no new date fields), but every migration must not touch this invariant.
- **Hand-write every migration; never run `prisma migrate dev`.** Show the SQL before applying. Apply to `despl_test` only during this plan — production application follows `docs/mos-execution/MERGE-RUNBOOK.md` at actual deploy time, out of scope for this plan.
- **Never add the RLS constraint before the backfill is verified.** Same non-negotiable sequence as H2: backfill → verify zero violations/mismatches → add `NOT NULL` + FK → add RLS policy. Each is its own migration, its own commit.
- **The new `job_isolation` policy is fail-open on unset `app.job_id`, forever** — this is a deliberate, permanent divergence from the tenant policy's fail-closed history (`prisma/migrations/20260813052000_rls_fail_closed`). Do not "graduate" it to fail-closed in a later task; that would break every cross-job read named in §"Do not touch."
- **`QcpTemplate` library rows (`jobId: null`)** are intentionally cross-tenant-visible reference data (`qcp.service.ts` — the `OR: [{ job: { tenantId } }, { jobId: null }]` pattern). The new `job_id` backfill/RLS work must never force these rows into a single job, and the RLS policy's fail-open-on-NULL semantics already handles this for free — verify it explicitly in Task 4's test.
- **Every change to a gating/RBAC/audit path needs table-driven tests for the violation case, not just the happy path** (CLAUDE.md's Tests convention) — every call-site conversion task includes a "mismatched job id is refused" test, not just a "correct job id still works" test.
- **`pnpm typecheck && pnpm lint && pnpm test` clean, and `pnpm test:db` clean (or only the pre-existing documented `process.service.test.ts` hold-point flake) at the end of every task.**

---

## Research findings (source of truth for every table/chain used below)

**28 models in scope**, split into two migration batches by hop-count (both get the same treatment — the split only affects how the backfill SQL is derived, not the schema shape):

**Batch A — 1 hop from a `jobId`-bearing model** (12 models): `Unit` (via `equipmentId→Equipment`), `BomRevision` (`equipmentId→Equipment`), `BomItem` (`equipmentId→Equipment`), `Component` (`equipmentId→Equipment`), `JobProcessEdge` (`processId→JobProcess`), `ProcessPlan` (`jobProcessId→JobProcess`, cross-checked against `scheduleRunId→ScheduleRun`), `WeldJointWelder` (`weldJointId→WeldJoint`), `NdtResult` (`weldJointId→WeldJoint`), `DrawingRevision` (`assemblyDrawingId→AssemblyDrawing`), `DispatchBatchUnit` (`dispatchBatchId→DispatchBatch`), `InspectionParty` (`qcpTemplateId→QcpTemplate`, nullable job), `QcpItem` (`qcpTemplateId→QcpTemplate`, nullable job).

**Batch B — 2–4 hops** (16 models): `ComponentOperation` (`componentId→Component→Equipment`), `ComponentOperationRejection` (`componentOperationId→ComponentOperation→…`), `PaintRecord` (`componentOperationId→…`), `DftReading` (`componentOperationId→…`), `AssemblyStep` (`unitId→Unit→Equipment`), `AssemblyStepRejection` (`assemblyStepId→AssemblyStep→…`), `Ncr` (XOR FK: `componentOperationRejectionId` OR `assemblyStepRejectionId`), `QcpExecution` (`unitId→Unit→Equipment`, cross-checked against `qcpItemId→QcpItem→QcpTemplate`), `QcpItemProcess` (`qcpItemId→QcpItem→QcpTemplate` OR `jobProcessId→JobProcess`), `QcpItemPartyCode` (`qcpItemId→QcpItem→QcpTemplate`), `DelayReason` (`processPlanId→ProcessPlan→JobProcess`), `StockLot` (`bomItemId→BomItem→Equipment`), `StockTxn` (`stockLotId→StockLot→BomItem→Equipment`), `ProcurementEvent` (`bomItemId→BomItem→Equipment`), `MaterialIdentification` (`bomItemId→BomItem→Equipment`), `ItemTest` (`bomItemId→BomItem→Equipment`).

**Explicitly out of scope (group c — no path to a single Job):** identity/org (`Organization`, `Client`, `User`, `Role`, `UserRole`, `Department`, `UserDepartment`), every reference-vocab table, every template-library table (`ProductFamily` through `AssemblyTemplateStep`), `Welder` (tenant-root by design), `ClientVisibilityPolicy`, `Notification`/`AuditLog`/`DomainEvent`, and `QcpTemplate`/`QcpItem`/`InspectionParty` rows where `jobId IS NULL` (library data).

**Two known dual-path divergence risks to verify, not silently resolve, during backfill:**
- `ProcessPlan` reaches Job via both `jobProcessId→JobProcess.jobId` and `scheduleRunId→ScheduleRun.jobId` — if these ever disagree for a real row, that is a pre-existing data-integrity bug to report to the user, not paper over.
- `QcpExecution` reaches Job via both `unitId→Unit→Equipment.jobId` and `qcpItemId→QcpItem.qcpTemplateId→QcpTemplate.jobId` (when the template row is job-scoped, not library) — same treatment.

**Call sites converted in this plan (the actual point of the exercise) — all currently TENANT-ONLY, meaning they check `...job.tenantId` but never assert that two related ids belong to the *same* job:**
1. `src/lib/services/_shared.ts` — `loadMappedOps`, `assertNoOpenNcr`, `assertNoOpenHoldPoint` (take `jobProcessId`/`unitId` as independent params with no cross-check).
2. `src/lib/services/component.service.ts` — `lockComponentOperationForUpdate` (used by every component-operation mutator).
3. `src/lib/services/assembly.service.ts` — `lockAssemblyStepForUpdate`.
4. `src/lib/services/ncr.service.ts` — `lockNcrForUpdate`, `closeNcr` (the latter has **no tenant filter at all** today, by documented design — relies entirely on callers).
5. `src/lib/services/stock.service.ts` — `receiveStock`, `loadLotForMutation`, `createStockTxn`'s optional `componentId` cross-check.
6. `src/lib/services/_shared.ts` — `lockProcessPlanForUpdate`.
7. `src/lib/services/drawing.service.ts` — `createDrawingRevision`, `assertDrawingReleased` (contrast: `component.service.ts:linkGoverningDrawing` already does this correctly — use it as the pattern to replicate).
8. `src/lib/services/delay.service.ts` — `fileDelayReason`.

**Do not touch — must keep working, cross-job by design, never call `withJob()`:** `jobs.read.ts:loadJobs`, `portfolio.read.ts:loadPortfolio`, `myday.read.ts` (all exports), `command-center.read.ts`, `notifications.read.ts:loadNotifications`, `departments.read.ts:loadDepartmentCards`, `client-snapshot.read.ts`, `admin.read.ts`, `qc-cockpit.read.ts`'s tenant-wide cockpit view.

---

## Task 1: Migration A — add nullable `job_id` to all 28 tables

**Files:**
- Create: `prisma/migrations/<timestamp>_h1_job_id_backstop_add_column/migration.sql`
- Modify: `prisma/schema.prisma` (add `jobId Int? @map("job_id")` + `job Job? @relation(fields: [jobId], references: [id])` + `@@index([jobId])` to all 28 models listed above)

**Interfaces:**
- Produces: every one of the 28 models gains a nullable `jobId` field and `@@index([jobId])`, readable by Task 2's backfill script and Task 3's `NOT NULL` migration.

- [ ] **Step 1: Add the field to `prisma/schema.prisma` for all 28 models**

For each model, add (respecting each model's existing field ordering convention — new FK fields go alongside other FK fields, not appended at the end):

```prisma
jobId Int? @map("job_id")
// ...
job   Job? @relation(fields: [jobId], references: [id])
// ...
@@index([jobId])
```

Apply this to every model named in Batch A and Batch B above. (`ProcessPlan` and `QcpExecution` get the same nullable `jobId` — Task 2 populates both from whichever of their two paths is authoritative, after verifying the two paths agree.)

- [ ] **Step 2: Hand-write the migration SQL**

```sql
-- H1 — job-level RLS backstop, step 1 of 4: add the (nullable) column.
-- See docs/mos-blueprint/reference/15_DESPL_MOS_DATA_ARCHITECTURE.md §4.
-- Nullable and unenforced until Task 3 (NOT NULL) — this migration only
-- adds room for the backfill in Task 2 to write into. No RLS yet (Task 4).

ALTER TABLE "units" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "bom_revisions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "bom_items" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "components" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "job_process_edges" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "process_plans" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "weld_joint_welders" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "ndt_results" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "drawing_revisions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "dispatch_batch_units" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "inspection_parties" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_items" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "component_operations" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "component_operation_rejections" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "paint_records" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "dft_readings" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "assembly_steps" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "assembly_step_rejections" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "ncrs" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_executions" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_item_processes" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "qcp_item_party_codes" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "delay_reasons" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "stock_lots" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "stock_txns" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "procurement_events" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "material_identifications" ADD COLUMN "job_id" INTEGER;
ALTER TABLE "item_tests" ADD COLUMN "job_id" INTEGER;

CREATE INDEX "units_job_id_idx" ON "units"("job_id");
CREATE INDEX "bom_revisions_job_id_idx" ON "bom_revisions"("job_id");
CREATE INDEX "bom_items_job_id_idx" ON "bom_items"("job_id");
CREATE INDEX "components_job_id_idx" ON "components"("job_id");
CREATE INDEX "job_process_edges_job_id_idx" ON "job_process_edges"("job_id");
CREATE INDEX "process_plans_job_id_idx" ON "process_plans"("job_id");
CREATE INDEX "weld_joint_welders_job_id_idx" ON "weld_joint_welders"("job_id");
CREATE INDEX "ndt_results_job_id_idx" ON "ndt_results"("job_id");
CREATE INDEX "drawing_revisions_job_id_idx" ON "drawing_revisions"("job_id");
CREATE INDEX "dispatch_batch_units_job_id_idx" ON "dispatch_batch_units"("job_id");
CREATE INDEX "inspection_parties_job_id_idx" ON "inspection_parties"("job_id");
CREATE INDEX "qcp_items_job_id_idx" ON "qcp_items"("job_id");
CREATE INDEX "component_operations_job_id_idx" ON "component_operations"("job_id");
CREATE INDEX "component_operation_rejections_job_id_idx" ON "component_operation_rejections"("job_id");
CREATE INDEX "paint_records_job_id_idx" ON "paint_records"("job_id");
CREATE INDEX "dft_readings_job_id_idx" ON "dft_readings"("job_id");
CREATE INDEX "assembly_steps_job_id_idx" ON "assembly_steps"("job_id");
CREATE INDEX "assembly_step_rejections_job_id_idx" ON "assembly_step_rejections"("job_id");
CREATE INDEX "ncrs_job_id_idx" ON "ncrs"("job_id");
CREATE INDEX "qcp_executions_job_id_idx" ON "qcp_executions"("job_id");
CREATE INDEX "qcp_item_processes_job_id_idx" ON "qcp_item_processes"("job_id");
CREATE INDEX "qcp_item_party_codes_job_id_idx" ON "qcp_item_party_codes"("job_id");
CREATE INDEX "delay_reasons_job_id_idx" ON "delay_reasons"("job_id");
CREATE INDEX "stock_lots_job_id_idx" ON "stock_lots"("job_id");
CREATE INDEX "stock_txns_job_id_idx" ON "stock_txns"("job_id");
CREATE INDEX "procurement_events_job_id_idx" ON "procurement_events"("job_id");
CREATE INDEX "material_identifications_job_id_idx" ON "material_identifications"("job_id");
CREATE INDEX "item_tests_job_id_idx" ON "item_tests"("job_id");
```

Confirm the exact `@@map`'d table names against `prisma/schema.prisma` before finalizing this file — the names above are read from the research pass; verify each one with `grep '@@map' prisma/schema.prisma` rather than trusting this list blind, since a mismatch here fails the whole migration.

- [ ] **Step 2b: Show this migration SQL to Swayam and confirm before applying**

Per this repo's own convention (`docs/mos-execution/MERGE-RUNBOOK.md`, the D2/D3 blueprint prompt) — hand-written schema migrations get shown before applying, always.

- [ ] **Step 3: Apply to `despl_test` only**

Run: `DATABASE_URL=$DESPL_TEST_URL pnpm prisma migrate deploy` (or the project's equivalent hand-apply step — check `MERGE-RUNBOOK.md` for the exact local convention already in use). Confirm: `pnpm prisma migrate diff --exit-code` → 0 against `despl_test`.

- [ ] **Step 4: Verify build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean (new nullable optional fields don't break existing code — nothing reads them yet).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(H1): add nullable job_id column to 28 job-child tables"
```

---

## Task 2: Backfill script + divergence-check test

**Files:**
- Create: `scripts/h1-backfill-job-ids.ts` (one-off, run against `despl_test` then later production per `MERGE-RUNBOOK.md` — not part of `pnpm db:seed`, matching this repo's existing convention of one-off scripts for exactly this kind of historical backfill, e.g. `scripts/seed-despl320-components.ts`)
- Create: `src/lib/services/__tests__/h1-backfill-consistency.test.ts` (DB-gated)

**Interfaces:**
- Consumes: the 28 nullable `jobId` columns from Task 1.
- Produces: every existing row in `despl_test` (and later production) has its `job_id` populated; a permanent regression test asserting `ProcessPlan`/`QcpExecution`'s two independent paths agree for every row (not just at backfill time — this guards against a future write reintroducing divergence).

- [ ] **Step 1: Write the backfill script**

```typescript
// scripts/h1-backfill-job-ids.ts
// One-off backfill for H1's job_id denormalization. Run against despl_test
// first; production application follows MERGE-RUNBOOK.md at deploy time.
// Not idempotent-safe to re-run blindly against a DB with NEW rows created
// after this script ran once — it only fixes NULLs, so re-running is safe,
// but it is not a substitute for the app writing job_id going forward
// (Task 5+ handles that).
import { PrismaClient } from "@/generated/prisma/client";

const prisma = new PrismaClient();

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
    UNION ALL SELECT 'stock_lots', count(*) FROM stock_lots WHERE job_id IS NULL`;
  console.log("Remaining NULLs (should be zero, or explainable — e.g. library QcpItem/InspectionParty rows):", stillNull);
}

main().finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run against `despl_test`**

Run: `DATABASE_URL=$DESPL_TEST_URL pnpm tsx scripts/h1-backfill-job-ids.ts`
Expected: both mismatch arrays empty; `stillNull` counts are zero except for `QcpItem`/`InspectionParty` rows tied to library templates (`jobId IS NULL` there is correct, not a gap).

If either mismatch array is non-empty: **STOP.** This is a real pre-existing data-integrity bug (two paths from the same row disagreeing about which job it belongs to) — report it to Swayam with the exact row ids before proceeding to Task 3. Do not silently pick one path and move on.

- [ ] **Step 3: Write the permanent consistency test**

```typescript
// src/lib/services/__tests__/h1-backfill-consistency.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";

describe("H1 dual-path job_id consistency", () => {
  it("process_plans.job_id always agrees with its schedule_run's job_id", async () => {
    const mismatches = await prisma.$queryRaw<{ id: number }[]>`
      SELECT p.id FROM process_plans p
      JOIN schedule_runs sr ON p.schedule_run_id = sr.id
      WHERE p.job_id IS DISTINCT FROM sr.job_id`;
    expect(mismatches).toEqual([]);
  });

  it("qcp_executions.job_id always agrees with its qcp_item's job_id (when the item is job-scoped)", async () => {
    const mismatches = await prisma.$queryRaw<{ id: number }[]>`
      SELECT q.id FROM qcp_executions q
      JOIN qcp_items i ON q.qcp_item_id = i.id
      WHERE i.job_id IS NOT NULL AND q.job_id IS DISTINCT FROM i.job_id`;
    expect(mismatches).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it**

Run: `pnpm test:db -- h1-backfill-consistency`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add scripts/h1-backfill-job-ids.ts src/lib/services/__tests__/h1-backfill-consistency.test.ts
git commit -m "feat(H1): backfill job_id across 28 tables + dual-path consistency test"
```

---

## Task 2A: Populate `jobId` at EVERY creation call site, before `NOT NULL` lands

**Real gap found running this plan, 5 Sep 2026:** Tasks 6–10 (further down) only convert *mutation-locking* functions (start/submit/verify a component operation, close an NCR, etc.) to assert job equality on rows that already exist. They never touch the *creation* paths that insert the first row into most of these 28 tables — `createJob`, schedule generation, BOM import, QCP template cloning, weld/NDT recording, stock receipt, procurement events, MTC recording. Once Task 3's `NOT NULL` constraint lands, every one of those creation paths would start failing outright, because nothing populates `jobId` on insert. Backfilling existing rows (Task 2) does nothing for rows created *after* that point. This task closes that gap — it must run, and be verified, before Task 3.

A full repo-wide grep of every `.create(`/`.createMany(`/nested-relation-create for all 28 models (plus `prisma/seed.ts` and every `scripts/seed-despl320-*.ts`) found **33 real creation call sites** and confirmed **zero raw `INSERT INTO` SQL** creates any of these tables outside Prisma. `ItemTest` has **no creation call site anywhere in the codebase today** (an unimplemented write path, referenced only in a comment at `job-intake.service.ts:603`) — nothing to convert for it; its `jobId` stays backfill-only until a real create path is built, which is out of scope here.

**Files to modify** (grouped by call site cluster; each cluster is its own commit within this task so a reviewer can check them independently):

**Cluster 1 — `_shared.ts` + `schedule.service.ts` (ProcessPlan via nested create)**
- `src/lib/services/_shared.ts`: `persistScheduleRun` (~line 291) — `input.jobId` is already a direct parameter (used on the sibling `ScheduleRun` row in the same `data` object). Add `jobId: input.jobId` to each mapped object inside `processPlans: { create: input.plans.map(...) }`.
- `src/lib/services/schedule.service.ts`: `generateSchedule` already has `parsed.jobId` in scope and threads it into `persistScheduleRun`'s `input` — no change needed here, confirm it's already passed through.

**Cluster 2 — `job-intake.service.ts` (Unit, InspectionParty, QcpItem, QcpItemPartyCode, QcpItemProcess, BomItem, Component, ComponentOperation)**
- `createJob` (~line 240): `Unit` via `createManyAndReturn` — add `jobId: job.id` (from the `tx.job.create(...)` a few lines above) to each unit row.
- `cloneQcpTemplate` (~lines 539/547/575/590): already takes `jobId: number` as a param — thread it into the `InspectionParty`, `QcpItem`, `QcpItemPartyCode`, and `QcpItemProcess` creates.
- `copyBom` (~line 637): signature is `copyBom(tx, sourceEquipmentId, targetEquipmentId, tenantId)` with no `jobId` param — add one (its only caller, `createJob`, already has `job.id` in scope; pass it in rather than requerying `Equipment`). Add `jobId` to the `BomItem` `createManyAndReturn` rows.
- `materializeComponentsFromBomItems` (~lines 654/666): signature is `(tx, familyId, equipmentId, bomItemIds)` with no `jobId` param — add one (same reasoning: `createJob` already has `job.id`). Add `jobId` to both the `Component` create and the `ComponentOperation` `createMany`.

**Cluster 3 — `bom.service.ts` (BomItem, BomRevision)**
- The shared `loadEquipment(tx, actor, equipmentId)` helper currently `select`s only `job: { select: { clientId: true } }`. Widen to `job: { select: { clientId: true, id: true } }` — one change serves all three call sites below.
- `createBomItem` (~line 109), `importBomItems` (~line 282), `createBomRevision` (~line 356): each already calls `loadEquipment` — add `jobId: equipment.job.id` to their respective `.create()` calls.

**Cluster 4 — `component.service.ts` (ComponentOperationRejection, Ncr, PaintRecord, DftReading) — overlaps Task 7's `lockComponentOperationForUpdate` conversion**
- Widen `lockComponentOperationForUpdate`'s `include` to also select `component: { select: { equipment: { select: { jobId: true } } } }` (or, simpler, once this task's Cluster 2 work has `ComponentOperation.jobId` populated via Task 2's backfill, just add `jobId: true` to the top-level select — `ComponentOperation` is itself one of the 28 models). This same widening is needed by Task 7 later for its job-equality assertion — do it once, here, and Task 7 reads the already-widened `op.jobId` instead of widening it again.
- `rejectComponentOperation` (~line 447): add `jobId: op.jobId` to the `ComponentOperationRejection` create.
- `rejectComponentOperation` (~line 453): add `jobId: op.jobId` to the `Ncr` create.
- `recordPaintRecord` (~line 529) and `recordDftReading` (~line 564): add `jobId: op.jobId` to both the `create` and `update` branches of each upsert.

**Cluster 5 — `assembly.service.ts` (AssemblyStepRejection, Ncr, AssemblyStep) — overlaps Task 7's `lockAssemblyStepForUpdate` conversion**
- Widen `lockAssemblyStepForUpdate`'s `include`/`select` to also return `jobId` (same reasoning as Cluster 4 — `AssemblyStep` is one of the 28 models, so once backfilled this is a free top-level field). Task 7 reuses this widening.
- `rejectAssemblyStep` (~lines 317/321): add `jobId: step.jobId` to both the `AssemblyStepRejection` and `Ncr` creates.
- `materializeAssemblyStepsFromTemplate` (~line 514): already takes `jobId: number` as an explicit param (used on `tx.job.update(...)` a few lines up) — add `jobId` to each row in the `rows` array passed to the `AssemblyStep` `createMany`.

**Cluster 6 — `welding.service.ts` (WeldJointWelder, NdtResult)**
- `createWeldJointTx` (~lines 108/118): `jobId` already a direct param, already written onto the `WeldJoint` row in the same `data` object — add `jobId` into the nested `welders: { create: fields.welderIds.map((welderId) => ({ welderId, jobId })) }`.
- `recordNdtResultTx` (~line 182): the `joint` row already fetched a few lines up returns `joint.jobId` for free (a real, non-denormalized scalar on `WeldJoint`, no `select` clause restricting it) — add `jobId: joint.jobId` to the `NdtResult` create.

**Cluster 7 — `drawing.service.ts` (DrawingRevision) — overlaps Task 10's `createDrawingRevision` conversion**
- `createDrawingRevision` (~line 65): widen the `drawing` query's `select` from `{ id: true, job: { select: { clientId: true } } }` to also fetch `job: { select: { clientId: true, id: true } } }`, add `jobId: drawing.job.id` to the `DrawingRevision` create. Task 10 reuses this same widened query for its job-equality assertion — do it once, here.

**Cluster 8 — `dispatch.service.ts` (DispatchBatchUnit)**
- `addUnitToBatch` (~line 155): this function ALREADY fetches `unit.equipment.jobId` and cross-checks it against `batch.jobId` (throwing `CROSS_JOB_ASSIGNMENT` on mismatch) a few lines above the create — add `jobId: batch.jobId` to the `DispatchBatchUnit` create. Zero new queries; the existing cross-check already proves it's safe. (This is the pattern every other cluster is reproducing — cite it as the reference example when reviewing this task.)

**Cluster 9 — `qcp.service.ts` (QcpExecution, and the library-authoring exception)**
- `recordQcpExecutionTx` / `recordQcpExecution` (~line 34): the caller already fetches `unit` with no restrictive `select`, so `unit.jobId` (once `Unit.jobId` is backfilled per Task 2) is returned for free — thread it into `recordQcpExecutionTx`'s `args` and onto the `QcpExecution` create. The second call site (inside `assembly.service.ts`'s `verifyAssemblyStep`/`rejectAssemblyStep` QCP sync) uses whatever job id is already resolved there per Cluster 5.
- `addQcpItemToLibraryTemplate` (~lines 188/201): this path is explicitly gated to fire ONLY when `template.jobId === null` (library-authoring — the function throws otherwise). Per this plan's Global Constraints on `QcpTemplate` library rows: leave `jobId` unset (nullable) on these two creates, do **not** try to backfill a job id here. Add a one-line comment at both call sites citing this constraint so a future pass doesn't "fix" it into a `NOT NULL` violation — these are the two models (`QcpItem`, `InspectionParty`) that stay nullable in Task 3.

**Cluster 10 — `procurement.service.ts` (ProcurementEvent) and `mtc.service.ts` (MaterialIdentification)**
- `recordProcurementEvent` (~line 39): same shape as `receiveStock` below — the `bomItem` query selects only `equipment.job.clientId` today; widen to also select `job.id`, add `jobId` to the create.
- `recordMtc` (~line 57): two branches resolve `clientId` today (via `bomItemId` alone, or via `componentId` when supplied) — widen both `findFirst` selects to also grab `job.id`, and use whichever branch actually ran to populate `jobId`. Do not let a `componentId`'s job silently stand in without the same independent verification the file's existing `clientId` logic already documents (per its own B8 comment) — mirror that same discipline for `jobId`.

**Cluster 11 — `stock.service.ts` (StockLot, StockTxn) — overlaps Task 9's conversion**
- `receiveStock` (~line 42): widen the `bomItem` query's select to also grab `job.id`, add `jobId: bomItem.equipment.job.id` to the `StockLot` create.
- `loadLotForMutation`: widen its own select the same way and **return the lot's `jobId`** to its callers (today it only returns `{ available }`) — needed by `createStockTxn` below and by Task 9's job-equality assertion.
- `createStockTxn` (~line 139): add `jobId` (from the now-returned lot data) to the `StockTxn` create.

**Seed data — decision, not a code change:** `prisma/seed.ts` and the three `scripts/seed-despl320-*.ts` files bulk-create nearly every one of these 28 models via the same flat/`createMany` calls, none of which populate `jobId`. Retrofitting `jobId` into every seed call site is a large, low-value diff for synthetic throwaway data (ponytail: YAGNI) — instead, this task wires `pnpm db:seed` to always run `scripts/h1-backfill-job-ids.ts` immediately afterward. `scripts/backfill-bom-revision.ts`, `scripts/backfill-procurement-events.ts`, and `scripts/split-plate-rolling-forming.ts` are historical one-off scripts, not a live app path — same treatment, no direct edit needed.

- [ ] **Step 1: Write failing tests for the 3 highest-value clusters** (the rest follow the identical pattern — these three prove it works before repeating it 8 more times)

```typescript
// job-intake.service.test.ts — add
it("createJob populates jobId on every materialized Unit", async () => {
  const result = await createJob(tx, /* existing fixture input */);
  const units = await tx.unit.findMany({ where: { equipment: { jobId: result.job.id } } });
  expect(units.every((u) => u.jobId === result.job.id)).toBe(true);
});

// dispatch.service.test.ts — add
it("addUnitToBatch populates jobId on the created DispatchBatchUnit", async () => {
  const dbu = await tx.dispatchBatchUnit.findFirst({ where: { dispatchBatchId: batch.id, unitId: unit.id } });
  expect(dbu?.jobId).toBe(batch.jobId);
});

// welding.service.test.ts — add
it("createWeldJointTx populates jobId on every created WeldJointWelder", async () => {
  const welders = await tx.weldJointWelder.findMany({ where: { weldJointId: joint.id } });
  expect(welders.every((w) => w.jobId === joint.jobId)).toBe(true);
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `pnpm test:db -- job-intake.service dispatch.service welding.service`
Expected: FAIL (the `jobId` field doesn't get populated yet).

- [ ] **Step 3: Implement Clusters 1–11** exactly as specified above, one cluster per commit.

- [ ] **Step 4: Add the equivalent create-populates-jobId assertion for every remaining cluster's test file** (`bom.service.test.ts`, `component.service.test.ts`, `assembly.service.test.ts`, `drawing.service.test.ts`, `qcp.service.test.ts`, `procurement.service.test.ts`, `mtc.service.test.ts`, `stock.service.test.ts`, `_shared.test.ts`/`process.service.test.ts` for `ProcessPlan`) — same shape as Step 1's three examples, one assertion per model created in that file.

- [ ] **Step 5: Wire the seed-backfill chain**

Modify `package.json`'s `db:seed` script (or `prisma/seed.ts` itself, whichever this repo's existing convention favors — check how `db:seed` is currently defined before choosing) to run `scripts/h1-backfill-job-ids.ts` immediately after seeding completes, every time.

**Cluster 12 — `process.service.test.ts`'s own fixture helpers (found running this task, 5 Sep 2026)**
- This file creates `ProcessPlan` rows directly via the raw owner Prisma client in 8 places, bypassing `persistScheduleRun` (Cluster 1) entirely and never setting `jobId` — since `despl_test` is shared and `h1-backfill-consistency.test.ts` (Task 2) is a *permanent* regression guard, these rows keep tripping it on every subsequent `test:db` run. `job.id` (or `run.jobId`, both in scope) is already available at every site — add `jobId: job.id` (or the equivalent in-scope variable) to each:
  - The `mkPlan` helper's `owner.processPlan.create()` call (~line 210) — add `jobId` to its `data` object.
  - Three direct `owner.processPlan.create()` calls at ~lines 436, 440, 773 — same fix.
  - Four more at ~lines 864, 1035, 1038, 1041 — same fix.
- This is a test-fixture-only change (no application code) — verify each site's nearest `job`/`run` variable actually resolves to the right id before copy-pasting; don't assume identical variable names across all 8 sites.
- **This exact class of gap (a test file creating one of the 28 models directly, bypassing the service layer, never setting `jobId`) may recur in OTHER test files not surfaced yet.** Per explicit instruction: fix this one now; if Tasks 6–11's own full-suite regression runs surface another file with the same pattern, fix it there when it's found — do not preemptively audit the whole test suite for this in this task.

- [ ] **Step 6: Full regression**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`
Expected: clean (or only the pre-existing documented `process.service.test.ts` hold-point flake). This is the first point in the plan where the FULL `pnpm test:db` suite is safe to run without staleness risk — every creation path now populates `jobId`, so no new NULL rows accumulate from here on. If a DIFFERENT test file surfaces the same "raw-create bypasses the service layer, no jobId" pattern Cluster 12 just fixed, fix it the same way (add `jobId` from whatever's already in scope) and note it in your report — don't block on it, since this is exactly the class of gap the plan already named as acceptable to whack-a-mole rather than pre-audit.

- [ ] **Step 7: Commit** (one per cluster, as noted above; final wrap-up commit for Steps 4–5)

```bash
git add <cluster's files>
git commit -m "fix(H1): populate jobId at creation for <cluster description>"
# ... repeated per cluster ...
git add package.json  # or prisma/seed.ts
git commit -m "chore(H1): chain h1-backfill-job-ids.ts after db:seed"
```

---

## Task 3: Migration B — `NOT NULL` + FK (only after a FRESH backfill is green)

**Real gap found running this plan, 5 Sep 2026 — read before executing this task:** `despl_test` is a shared, persistent database. Between Task 2 committing and Task 3 running, other `pnpm test:db` suites (`job-intake.service.test.ts`, `process.service.test.ts`, etc.) create real `ProcessPlan`/`ScheduleRun`/`QcpExecution`/etc. rows through app code that does not populate `job_id` yet — **this is now fixed by Task 2A**, which must be fully complete (all 11 clusters, Step 6's full regression green) before this task starts. Task 3 must NOT assume Task 2's original backfill result still holds on its own; Task 2A is what makes it durable, and this task's own Step 0 re-verifies once more immediately before migrating, with nothing else touching `despl_test` in between.

**Files:**
- Create: `prisma/migrations/<timestamp>_h1_job_id_backstop_not_null_fk/migration.sql`
- Modify: `prisma/schema.prisma` (flip `jobId Int?` → `jobId Int` and `job Job?` → `job Job` for every model **except** `QcpItem`/`InspectionParty`/`QcpItemPartyCode`, which stay nullable — library rows genuinely have no job)

**Correction found running this task, 5 Sep 2026:** `QcpItemPartyCode` was originally listed among the 26 NOT-NULL models, but it inherits the same "library row, no job" property as its parent `QcpItem` — `migrate deploy` failed with `column "job_id" of relation "qcp_item_party_codes" contains null values`, and the failure was confirmed data-correct: 413 rows, all children of library `QcpItem` rows (`parent.job_id IS NULL`). Move `QcpItemPartyCode` into the nullable-exempt group alongside `QcpItem`/`InspectionParty` (same `onDelete: SetNull` treatment) — this is a 3-model exemption, not 2, everywhere this plan says "except QcpItem/InspectionParty."

**Interfaces:**
- Consumes: a freshly-verified zero-mismatch backfill (re-run in this task's own Step 0, not trusted from Task 2's earlier run).
- Produces: a real FK constraint (`ON DELETE CASCADE`, matching every other job-child table's existing convention, e.g. `Package`/`JobProcess`) — a row can no longer exist with a `job_id` that doesn't point at a real job, or with no `job_id` at all (except the two intentionally-nullable models).

- [ ] **Step 0: Re-run the backfill immediately before migrating, with nothing else touching `despl_test` in between**

Run: `DATABASE_URL=$DESPL_TEST_DIRECT_URL pnpm tsx scripts/h1-backfill-job-ids.ts` (idempotent — it only fixes NULLs, per Task 2) followed immediately by `pnpm test:db -- h1-backfill-consistency` (narrowly, not the full `test:db` suite — running the full suite here would recreate the same race by letting unrelated tests insert new NULL-job_id rows before this task's own migration runs). Do not run any other `pnpm test:db` invocation between this step and Step 3's migration apply. If the consistency test is still red after a fresh backfill run, STOP — this is now a genuine data problem, not a staleness artifact, and needs to be reported rather than migrated around.

- [ ] **Step 1: Update schema.prisma**

For the 25 non-nullable models: `jobId Int @map("job_id")`, `job Job @relation(fields: [jobId], references: [id], onDelete: Cascade)`. For `QcpItem`/`InspectionParty`/`QcpItemPartyCode`: leave `jobId Int?`, add the FK as nullable (`onDelete: SetNull` — matches how `QcpTemplate.jobId` itself already handles the library case).

- [ ] **Step 2: Hand-write the migration SQL**

```sql
-- H1 — job-level RLS backstop, step 2 of 4: NOT NULL + FK, only after
-- scripts/h1-backfill-job-ids.ts confirmed zero NULLs (excluding library
-- QcpItem/InspectionParty/QcpItemPartyCode rows) and zero dual-path mismatches.

ALTER TABLE "units" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "units" ADD CONSTRAINT "units_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;
-- ... repeat the SET NOT NULL + ADD CONSTRAINT pair for every Batch A/B
-- table from Task 1's list, EXCEPT qcp_items, inspection_parties, and
-- qcp_item_party_codes (all three stay nullable, FK added as ON DELETE SET
-- NULL instead — qcp_item_party_codes inherits this from its parent QcpItem,
-- confirmed by a real migrate-deploy failure: 413 library-scoped rows exist):

ALTER TABLE "qcp_items" ADD CONSTRAINT "qcp_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;
ALTER TABLE "inspection_parties" ADD CONSTRAINT "inspection_parties_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;
ALTER TABLE "qcp_item_party_codes" ADD CONSTRAINT "qcp_item_party_codes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;
```

Write out the full 25-table repeat explicitly in the real migration file (do not leave a "repeat for every table" comment in the actual `.sql` — that is a placeholder; this plan step names the pattern once because it is genuinely mechanical, but the committed file must be complete).

- [ ] **Step 3: Show to Swayam, then apply to `despl_test`**

Run: `pnpm prisma migrate deploy` against `despl_test`. Expected: succeeds (Task 2 already guaranteed zero NULLs/mismatches). Confirm `pnpm prisma migrate diff --exit-code` → 0.

- [ ] **Step 4: Typecheck/build**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`

**Correction found running this task, 5 Sep 2026 — this step is NOT expected to be clean on the first try, unlike originally stated.** Two real gaps surfaced here:

1. **`src/lib/services/qcp.service.ts`'s `recordQcpExecutionTx`** — its `args` type has `jobId?: number | null` (optional/nullable) and writes `jobId: args.jobId ?? null` into what is now a `NOT NULL` column. This is NOT a design decision — both real callers (`qcp.service.ts:77`'s own `recordQcpExecution`, passing `unit.jobId`, and `assembly.service.ts`'s two A4-sync call sites at ~254/371, passing `step.jobId`) already have a real, non-null `jobId` in hand every time. Fix: change the type to `jobId: number` (required, non-nullable) and the create call to `jobId: args.jobId` directly (no `?? null`) — a one-line correction to a signature Task 2A's Cluster 9 should have made non-nullable in the first place.
2. **Test-fixture `prisma.<model>.create()` calls across other test files** — the same class of gap Task 2A's Cluster 12 fixed for `process.service.test.ts`, now surfacing in whichever OTHER files' fixtures directly create one of the 28 models without a service-layer call. Fix each one the same mechanical way (add `jobId` from whatever's already in scope in that fixture) — this is exactly the "fix it when it's found" pattern the plan already established, not new scope.

Re-run `pnpm typecheck && pnpm lint && pnpm build && pnpm test` after both fixes.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(H1): make job_id NOT NULL + FK on 25 tables (3 stay nullable for library rows)"
git add src/lib/services/qcp.service.ts
git commit -m "fix(H1): recordQcpExecutionTx's jobId is always available — make it required, not nullable"
git add <whichever test files needed a jobId fixture fix>
git commit -m "fix(H1): populate jobId in <test file>'s fixtures, found via Task 3's typecheck pass"
```

---

## Task 4: RLS policy — `job_isolation`, permanently fail-open

**Files:**
- Create: `prisma/migrations/<timestamp>_h1_job_isolation_rls/migration.sql`
- Create: `src/lib/services/__tests__/h1-job-isolation-rls.test.ts` (DB-gated)

**Interfaces:**
- Consumes: the 28 `job_id` columns, now `NOT NULL` (or nullable for the 2 library-row exceptions).
- Produces: a `job_isolation` RLS policy on each of the 28 tables, enabled but **fail-open** when `app.job_id` is unset — every existing cross-job read (§"Do not touch") continues to see every row exactly as today, because they never set `app.job_id`.

- [ ] **Step 1: Hand-write the migration SQL**

```sql
-- H1 — job-level RLS backstop, step 3 of 4: the actual backstop policy.
--
-- Unlike tenant_isolation (fail-CLOSED as of 20260813052000_rls_fail_closed),
-- job_isolation is fail-OPEN, PERMANENTLY, by design: most reads in this app
-- are intentionally cross-job within a tenant (dashboard, portfolio, job
-- list, my-day, command-center, notifications — see
-- docs/superpowers/plans/2026-09-05-h1-job-level-rls-backstop.md's "Do not
-- touch" list). Only a service function that explicitly calls the new
-- withJob() wrapper (src/lib/db.ts) sets app.job_id, and only then does this
-- policy narrow the result set — catching exactly the "id from Job B passed
-- into a Job A operation" class of bug named in the architecture doc's §4.
DO $$
DECLARE
  t text;
  job_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'inspection_parties', 'qcp_items', 'component_operations',
    'component_operation_rejections', 'paint_records', 'dft_readings',
    'assembly_steps', 'assembly_step_rejections', 'ncrs',
    'qcp_executions', 'qcp_item_processes', 'qcp_item_party_codes',
    'delay_reasons', 'stock_lots', 'stock_txns', 'procurement_events',
    'material_identifications', 'item_tests'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS job_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY job_isolation ON %I
        USING (
          job_id IS NULL
          OR current_setting('app.job_id', true) IS NULL
          OR current_setting('app.job_id', true) = ''
          OR job_id = current_setting('app.job_id', true)::int
        )
        WITH CHECK (
          job_id IS NULL
          OR current_setting('app.job_id', true) IS NULL
          OR current_setting('app.job_id', true) = ''
          OR job_id = current_setting('app.job_id', true)::int
        )
    $f$, t);
  END LOOP;
END
$$;
```

Note the `job_id IS NULL OR ...` clause up front — this is what keeps library `QcpItem`/`InspectionParty` rows visible under any `app.job_id` setting, matching `qcp.service.ts`'s existing `OR jobId: null` application-level convention instead of fighting it.

- [ ] **Step 2: Show to Swayam, apply to `despl_test`**

Run: `pnpm prisma migrate deploy` against `despl_test`.

- [ ] **Step 3: Write the RLS proof test**

```typescript
// src/lib/services/__tests__/h1-job-isolation-rls.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma, withTenant } from "@/lib/db";

describe("H1 job_isolation RLS policy", () => {
  let tenantId: number, jobAId: number, jobBId: number, unitAId: number, unitBId: number;

  beforeAll(async () => {
    // Reuse this test file's existing fixture-creation convention (see any
    // sibling *.test.ts in src/lib/services/__tests__/ for the exact
    // tenant/job/equipment/unit scaffolding helper already in use) to create
    // one tenant with two jobs (Job A, Job B), each with one Equipment and
    // one Unit. Capture jobAId, jobBId, unitAId, unitBId.
  });

  it("with app.job_id unset, a query sees rows from BOTH jobs (fail-open preserved)", async () => {
    await withTenant(tenantId, async (tx) => {
      const units = await tx.unit.findMany({ where: { id: { in: [unitAId, unitBId] } } });
      expect(units).toHaveLength(2);
    });
  });

  it("with app.job_id set to Job A, a query for Job B's unit id returns ZERO rows", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobAId)}, true)`;
      const unit = await tx.unit.findFirst({ where: { id: unitBId } });
      expect(unit).toBeNull();
    });
  });

  it("with app.job_id set to Job A, a query for Job A's own unit still succeeds", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobAId)}, true)`;
      const unit = await tx.unit.findFirst({ where: { id: unitAId } });
      expect(unit?.id).toBe(unitAId);
    });
  });

  afterAll(async () => {
    // Clean up the fixture tenant/jobs/equipment/units created in beforeAll.
  });
});
```

- [ ] **Step 4: Run it**

Run: `pnpm test:db -- h1-job-isolation-rls`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/ src/lib/services/__tests__/h1-job-isolation-rls.test.ts
git commit -m "feat(H1): add fail-open job_isolation RLS policy across 28 tables"
```

---

## Task 5: `withJob()` wrapper in `src/lib/db.ts`

**Files:**
- Modify: `src/lib/db.ts`

**Interfaces:**
- Consumes: `prisma.$transaction`, the `Tx` type already exported.
- Produces: `withJob(tenantId: number, jobId: number, fn: (tx: Tx) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>` — same call shape as `withTenant`, additionally sets `app.job_id`. Every Task 6+ call site uses this instead of `withTenant` when the operation is meant to be scoped to one job.

- [ ] **Step 1: Write the failing test**

```typescript
// Add to an existing db.ts test file, or create src/lib/__tests__/db.test.ts
import { describe, it, expect } from "vitest";
import { withJob } from "@/lib/db";

describe("withJob", () => {
  it("rejects a non-integer or non-positive jobId, matching withTenant's guard", async () => {
    await expect(withJob(1, 0, async () => null)).rejects.toThrow(/invalid jobId/);
    await expect(withJob(1, -3, async () => null)).rejects.toThrow(/invalid jobId/);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm test -- db.test`
Expected: FAIL — `withJob` is not defined.

- [ ] **Step 3: Implement `withJob`**

```typescript
/**
 * Run work with BOTH tenant and job-level isolation enforced by the
 * database. Same transaction-local set_config discipline as withTenant —
 * see that function's doc comment for why set_config must run inside the
 * $transaction callback.
 *
 * Use this instead of withTenant only when the operation is genuinely
 * scoped to ONE job (component-operation/assembly-step/NCR/stock mutations,
 * process-plan gating, drawing linking, delay filing). Cross-job reads
 * (dashboard, portfolio, job list, my-day, command-center, notifications)
 * must keep using withTenant — the job_isolation RLS policy is fail-open
 * when app.job_id is unset, which is exactly what keeps those working.
 */
export async function withJob<T>(
  tenantId: number,
  jobId: number,
  fn: (tx: Tx) => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error(`withJob: invalid jobId ${jobId}`);
  }
  return withTenant(
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.job_id', ${String(jobId)}, true)`;
      return fn(tx);
    },
    opts,
  );
}
```

Note: this delegates to `withTenant` rather than duplicating its transaction/timezone setup — `withTenant`'s callback runs inside the same `$transaction`, so `app.tenant_id`, `TimeZone`, and now `app.job_id` are all set transaction-locally in one place.

- [ ] **Step 4: Run it, confirm it passes**

Run: `pnpm test -- db.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/__tests__/db.test.ts
git commit -m "feat(H1): add withJob() wrapper extending withTenant with job-level RLS"
```

---

## Task 5B: Fix `job_isolation`'s empty-string cast defect (found running Task 6, 5 Sep 2026)

**Real bug found in the Task 4 migration, not a sequencing issue this time.** A Postgres custom GUC like `app.job_id`, once set via `set_config('app.job_id', 'X', true)` (transaction-local) on a pooled/reused connection, does not revert to unset/NULL after that transaction ends — it resets to the empty string `''`. The `job_isolation` policy's guard (`current_setting('app.job_id', true) = ''` as a short-circuit before the cast) does NOT reliably protect the `::int` cast: on any job-scoped table with a btree index on `job_id` (most of them, added by Task 3/4), Postgres's query planner can evaluate `job_id = current_setting(...)::int` as a candidate index condition at PLANNING time, independent of the OR's other branches — so the cast of the literal `''` throws `invalid input syntax for type integer: ""` before the query ever runs. Confirmed by direct `psql` reproduction as `despl_web` (the RLS-subject role — testing as the `postgres` superuser bypasses RLS entirely and hides this). Task 6 is the first real code path that sets `app.job_id` broadly enough (every process start/submit/verify/reject/hold/resume/delay-file call) to hit this at scale across the DB-gated suite; Task 5's own narrow test never exercised enough connections to surface it.

**The fix is a standard, well-known Postgres idiom for exactly this failure mode — not a design decision:** wrap the value in `NULLIF(..., '')` BEFORE casting, so the cast target is either a real digit string or SQL `NULL` — never the literal `''`. `NULLIF(current_setting('app.job_id', true), '')::int` can never throw on empty string, because `NULLIF` converts `''` to `NULL` first, and `NULL::int` is always valid (produces `NULL`, satisfied by the earlier `OR ... IS NULL` branch).

**Files:**
- Create: `prisma/migrations/<timestamp>_h1_job_isolation_rls_nullif_fix/migration.sql` (a NEW forward-only migration — `20260905090000_h1_job_isolation_rls` from Task 4 is already committed and applied to `despl_test`; per this repo's "never edit an applied migration" convention, fix it forward, don't edit that file in place)

- [ ] **Step 1: Hand-write the corrective migration**

```sql
-- H1 — job-level RLS backstop, fixup: the job_isolation policy from
-- 20260905090000 could throw "invalid input syntax for type integer: ''"
-- when app.job_id has reset to the empty string (a pooled-connection GUC
-- reset artifact, not an unset value) on any indexed job_id column, because
-- Postgres's planner can evaluate the ::int cast at plan time independent of
-- the OR's other branches. Fix: NULLIF before cast, so the cast target is
-- never the literal ''.
DO $$
DECLARE
  t text;
  job_tables text[] := ARRAY[
    'units', 'bom_revisions', 'bom_items', 'components',
    'job_process_edges', 'process_plans', 'weld_joint_welders',
    'ndt_results', 'drawing_revisions', 'dispatch_batch_units',
    'inspection_parties', 'qcp_items', 'component_operations',
    'component_operation_rejections', 'paint_records', 'dft_readings',
    'assembly_steps', 'assembly_step_rejections', 'ncrs',
    'qcp_executions', 'qcp_item_processes', 'qcp_item_party_codes',
    'delay_reasons', 'stock_lots', 'stock_txns', 'procurement_events',
    'material_identifications', 'item_tests'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS job_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY job_isolation ON %I
        USING (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
        WITH CHECK (
          job_id IS NULL
          OR NULLIF(current_setting('app.job_id', true), '') IS NULL
          OR job_id = NULLIF(current_setting('app.job_id', true), '')::int
        )
    $f$, t);
  END LOOP;
END
$$;
```

- [ ] **Step 2: Apply to `despl_test`, re-run Task 6's full regression**

Run: `pnpm prisma migrate deploy` against `despl_test`, then re-run `pnpm test:db` (the full suite, not filtered) to confirm the `invalid input syntax for type integer: ""` errors are gone across every file that surfaced them.
Expected: clean (or only the plan's own documented pre-existing flakes — the `process.service.test.ts` hold-point flake and a `portfolio.read.test.ts` timeout already confirmed present before this task's changes).

- [ ] **Step 3: Commit**

```bash
git add prisma/migrations/
git commit -m "fix(H1): job_isolation policy — NULLIF before cast, empty-string GUC reset no longer throws"
```

---

## Task 6: Convert `_shared.ts`'s cross-parameter gates (`loadMappedOps`, `assertNoOpenNcr`, `assertNoOpenHoldPoint`, `lockProcessPlanForUpdate`)

**Files:**
- Modify: `src/lib/services/_shared.ts`
- Test: `src/lib/services/__tests__/_shared.test.ts` (existing file — add to it)

**Interfaces:**
- Consumes: `withJob` (Task 5).
- Produces: these four functions now require a `jobId` parameter (derived by their callers from the entity already in hand — e.g. `jobProcessId`'s own job) and run their query inside `withJob(tenantId, jobId, ...)` instead of `withTenant(tenantId, ...)`. A caller that passes a `unitId`/`processPlanId` from a DIFFERENT job than the `jobId` argument now gets zero rows back (RLS-enforced), not a silently-wrong cross-job rollup.

- [ ] **Step 1: Write the failing test** (the exact scenario named in the research: a `unitId` from Job B passed alongside a `jobProcessId` from Job A)

```typescript
// Add to src/lib/services/__tests__/_shared.test.ts
it("loadMappedOps returns nothing when unitId belongs to a different job than jobProcessId", async () => {
  // Reuse this file's existing fixture helpers to create two jobs (A, B) in
  // the same tenant, each with its own JobProcess (same leadTimeProcessSeq)
  // and its own Unit with a ComponentOperation. Then:
  const opsFromWrongJob = await loadMappedOps(tx, {
    jobProcessId: jobAProcessId,
    unitId: jobBUnitId, // deliberately mismatched
    tenantId,
    jobId: jobAProcessJobId, // the caller asserts "this is Job A's context"
  });
  expect(opsFromWrongJob).toEqual([]);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm test:db -- _shared`
Expected: FAIL (today's `loadMappedOps` has no `jobId` parameter at all, and would actually find Job B's operation via the tenant-only join — the test as written won't even compile until the signature changes, which is itself the point).

- [ ] **Step 3: Add `jobId` param, switch to `withJob`**

For each of the four functions, add a `jobId: number` parameter and wrap the query section in `withJob`. Concretely for `loadMappedOps` (mirror the same pattern for the other three):

```typescript
export async function loadMappedOps(
  tx: Tx,
  args: { jobProcessId: number; unitId: number; tenantId: number; jobId: number },
) {
  return withJob(args.tenantId, args.jobId, async (jobTx) => {
    // ... existing query body, using jobTx instead of tx for the
    // job-scoped portion; keep using the passed-in tx for anything that
    // must run in the caller's existing transaction if a nested
    // transaction isn't possible — check Prisma's interactive-transaction
    // nesting rules before assuming jobTx can simply replace tx here; if
    // Prisma disallows nested $transaction, set app.job_id directly on the
    // existing tx instead (see the two-line pattern in withJob's own body)
    // rather than opening a second transaction.
  });
}
```

**Design note to resolve during implementation, not deferred as a placeholder:** every one of these four functions is currently called *inside* an already-open transaction from `withTenant` (e.g. `startComponentOperation` opens `withTenant(...)` then calls `loadMappedOps(tx, ...)` using that same `tx`). Prisma's `$transaction` does not support nesting a second interactive transaction inside the first. So `withJob` cannot be called from inside these functions as shown above — instead, set `app.job_id` directly on the ALREADY-OPEN `tx` these functions receive:

```typescript
export async function loadMappedOps(
  tx: Tx,
  args: { jobProcessId: number; unitId: number; jobId: number },
) {
  await tx.$executeRaw`SELECT set_config('app.job_id', ${String(args.jobId)}, true)`;
  // ... existing query body using tx, unchanged otherwise
}
```

This is transaction-local exactly like `withTenant`'s own `set_config` calls, so it's safe to call mid-transaction — it does NOT require opening a new transaction, and this is the pattern every Task 6+ call site should actually use (a direct `set_config('app.job_id', ...)` on the existing `tx`, not a nested `withJob`). Update this task's (and every later task's) implementation to this simpler shape; `withJob` (Task 5) remains useful for the handful of top-level service entrypoints that open their OWN fresh transaction rather than receiving one.

- [ ] **Step 4: Run it, confirm it passes**

Run: `pnpm test:db -- _shared`
Expected: PASS.

- [ ] **Step 5: Update every call site of these four functions** to pass the new `jobId` argument (derive it from an entity already in scope — e.g. `startComponentOperation` already loads the `ComponentOperation` row, which now carries `jobId` directly per Task 3's backfill — no new query needed, just read the field that's already denormalized onto the row).

- [ ] **Step 6: Full regression**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`
Expected: clean (or only the pre-existing documented `process.service.test.ts` flake).

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/_shared.ts src/lib/services/__tests__/_shared.test.ts
git commit -m "fix(H1): job-scope loadMappedOps/assertNoOpenNcr/assertNoOpenHoldPoint/lockProcessPlanForUpdate"
```

---

## Task 7: Convert `component.service.ts` (`lockComponentOperationForUpdate` + every mutator), `assembly.service.ts` (`lockAssemblyStepForUpdate`)

**Note: Task 2A's Clusters 4 and 5 already widened `lockComponentOperationForUpdate`/`lockAssemblyStepForUpdate` to return `jobId` (needed there to populate creates like `ComponentOperationRejection`/`AssemblyStepRejection`).** This task only needs to ADD the `set_config`/job-scoping call using that already-available field — do not re-widen the query.

**Files:**
- Modify: `src/lib/services/component.service.ts`, `src/lib/services/assembly.service.ts`
- Test: their existing `__tests__` files

**Interfaces:**
- Consumes: the `set_config('app.job_id', ...)` pattern established in Task 6.
- Produces: `lockComponentOperationForUpdate`/`lockAssemblyStepForUpdate` set `app.job_id` from the row's own (now-denormalized) `jobId` immediately after the initial tenant-scoped lookup, so every subsequent query in the same mutator (e.g. `verifyComponentOperation`'s NCR-opening logic) is automatically job-scoped without each individual mutator needing its own plumbing.

- [ ] **Step 1: Write the failing test**

```typescript
it("startComponentOperation refuses a componentOperationId that belongs to a different job than the actor's declared job context, even within the same tenant", async () => {
  // Fixture: two jobs (A, B) in one tenant, each with a ComponentOperation.
  // Call startComponentOperation with Job B's componentOperationId but
  // asserting jobId: jobAId in the actor/context — expect a refusal (either
  // NOT_FOUND, matching this service's existing not-found convention for a
  // tenant mismatch, or a new structured error — follow whatever
  // lockComponentOperationForUpdate already throws today for a tenant
  // mismatch, just triggered by a job mismatch instead).
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm test:db -- component.service`

- [ ] **Step 3: Implement** — in `lockComponentOperationForUpdate`, after the existing tenant-scoped `findFirst`, add:

```typescript
const op = await tx.componentOperation.findFirst({
  where: { id, component: { equipment: { job: { tenantId } } } },
  include: { /* existing includes */ },
});
if (!op) throw new AppError("NOT_FOUND", /* existing message */);
await tx.$executeRaw`SELECT set_config('app.job_id', ${String(op.jobId)}, true)`;
return op;
```

Apply the identical pattern to `lockAssemblyStepForUpdate` in `assembly.service.ts`, using its own row's denormalized `jobId`.

- [ ] **Step 4: Run it, confirm it passes**

Run: `pnpm test:db -- component.service assembly.service`

- [ ] **Step 5: Full regression + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:db
git add src/lib/services/component.service.ts src/lib/services/assembly.service.ts
git commit -m "fix(H1): job-scope lockComponentOperationForUpdate/lockAssemblyStepForUpdate"
```

---

## Task 8: Convert `ncr.service.ts` (`lockNcrForUpdate`, `closeNcr`)

**Files:**
- Modify: `src/lib/services/ncr.service.ts`
- Test: `src/lib/services/__tests__/ncr.service.test.ts`

**Interfaces:**
- Produces: `lockNcrForUpdate` sets `app.job_id` from the Ncr row's own denormalized `jobId` (populated regardless of which XOR branch it came from, per Task 2's backfill). `closeNcr` — which today has **no tenant filter at all** — gets a real tenant+job filter added, closing the documented weak link named in its own code comment, not just relying on RLS as a silent backstop for a known-bad query shape.

- [ ] **Step 1: Write the failing test**

```typescript
it("closeNcr refuses an ncrId belonging to a different job in the same tenant", async () => {
  // Fixture: Job A and Job B in one tenant, each with an open Ncr.
  // Call closeNcr with jobBNcrId while the calling context is scoped to
  // Job A (via withJob or an explicit jobId argument this task adds to
  // closeNcr's signature) — expect refusal.
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm test:db -- ncr.service`

- [ ] **Step 3: Implement**

`lockNcrForUpdate`: add the same `set_config('app.job_id', ...)` line after its existing OR-branch lookup, using the row's own `jobId`.

`closeNcr`: add an explicit `jobId` parameter and filter:
```typescript
export async function closeNcr(tx: Tx, input: { ncrId: number; jobId: number; /* ...existing fields */ }) {
  const ncr = await tx.ncr.findFirst({ where: { id: input.ncrId, jobId: input.jobId } });
  if (!ncr) throw new AppError("NOT_FOUND", "NCR not found for this job.");
  // ... existing body, unchanged otherwise
}
```
Update `closeNcr`'s two existing callers to pass `jobId` (both already have a job-scoped Ncr/rejection row in hand at the call site — read `.jobId` off it, no new query).

- [ ] **Step 4: Run it, confirm it passes**

Run: `pnpm test:db -- ncr.service`

- [ ] **Step 5: Full regression + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:db
git add src/lib/services/ncr.service.ts
git commit -m "fix(H1): job-scope lockNcrForUpdate; add real tenant+job filter to closeNcr"
```

---

## Task 9: Convert `stock.service.ts` (`receiveStock`, `loadLotForMutation`, `createStockTxn`'s `componentId` cross-check)

**Note: Task 2A's Cluster 11 already widened `receiveStock`'s and `loadLotForMutation`'s queries to return `jobId` (needed there to populate the `StockLot`/`StockTxn` creates).** This task only needs to ADD the `set_config`/job-equality-assertion logic using that already-available field.

**Files:**
- Modify: `src/lib/services/stock.service.ts`
- Test: `src/lib/services/__tests__/stock.service.test.ts`

**Interfaces:**
- Produces: `loadLotForMutation` sets `app.job_id` from the lot's own denormalized `jobId`; `createStockTxn` additionally asserts (not just relies on RLS to silently enforce) that an optional `componentId` argument belongs to the SAME job as the `stockLotId` being mutated — the exact gap named in the research ("an issue against Job A's stock lot could be logged against a component belonging to Job B").

- [ ] **Step 1: Write the failing test**

```typescript
it("createStockTxn refuses a componentId from a different job than the stockLotId's own job", async () => {
  // Fixture: Job A's StockLot + Job B's Component in the same tenant.
  // Call createStockTxn({ stockLotId: jobALotId, componentId: jobBComponentId, ... })
  // expect a structured refusal, not a silently-recorded cross-job link.
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm test:db -- stock.service`

- [ ] **Step 3: Implement**

`loadLotForMutation`: add `set_config('app.job_id', ...)` from the lot's own `jobId` after its existing tenant-scoped lookup.

`createStockTxn`, in the existing `componentId` branch:
```typescript
if (input.componentId != null) {
  const component = await tx.component.findFirst({
    where: { id: input.componentId, jobId: lot.jobId }, // was: equipment: { job: { tenantId } }
  });
  if (!component) throw new AppError("VALIDATION_FAILED", "Component does not belong to this stock lot's job.");
}
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `pnpm test:db -- stock.service`

- [ ] **Step 5: Full regression + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:db
git add src/lib/services/stock.service.ts
git commit -m "fix(H1): job-scope loadLotForMutation; assert componentId/stockLot job match in createStockTxn"
```

---

## Task 10: Convert `drawing.service.ts` (`createDrawingRevision`, `_shared.ts`'s `assertDrawingReleased`) and `delay.service.ts` (`fileDelayReason`)

**Note: Task 2A's Cluster 7 already widened `createDrawingRevision`'s `drawing` query to return `jobId` (needed there to populate the `DrawingRevision` create).** This task only needs to ADD the job-equality-assertion logic using that already-available field.

**Files:**
- Modify: `src/lib/services/drawing.service.ts`, `src/lib/services/_shared.ts`, `src/lib/services/delay.service.ts`
- Test: their existing `__tests__` files

**Interfaces:**
- Produces: `createDrawingRevision` and `assertDrawingReleased` both assert job equality explicitly, following the SAME pattern `component.service.ts:linkGoverningDrawing` already uses correctly (`assemblyDrawing.findFirst({ where: { id, jobId: component.equipment.job.id } })`) — this task replicates an existing-correct pattern into two more call sites, not inventing a new one. `fileDelayReason` sets `app.job_id` from the process plan's own denormalized `jobId` (via `lockProcessPlanForUpdate`, already converted in Task 6).

- [ ] **Step 1: Write the failing tests**

```typescript
// drawing.service.test.ts
it("createDrawingRevision refuses when assemblyDrawingId belongs to a different job than the caller's declared job", async () => {
  // Job A's AssemblyDrawing, called with jobId: jobBId — expect refusal.
});

// _shared.test.ts
it("assertDrawingReleased refuses when the component's job and the drawing's job disagree", async () => {
  // Job A's Component, Job B's AssemblyDrawing linked via a deliberately
  // cross-job governingDrawingId (bypass the normal linkGoverningDrawing
  // guard by writing it directly in the fixture, simulating what H1 exists
  // to backstop against) — expect assertDrawingReleased to refuse rather
  // than silently trusting the stale/cross-job link.
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `pnpm test:db -- drawing.service _shared`

- [ ] **Step 3: Implement**

`createDrawingRevision`, replace the tenant-only lookup:
```typescript
const drawing = await tx.assemblyDrawing.findFirst({
  where: { id: assemblyDrawingId, jobId }, // was: job: { tenantId }
});
if (!drawing) throw new AppError("NOT_FOUND", "Drawing not found for this job.");
```
(caller already has `jobId` in scope — this is the job the drawing revision is being filed under.)

`assertDrawingReleased`, add an explicit equality check between the component's job and the drawing's job before trusting the release status:
```typescript
if (component.jobId !== assemblyDrawing.jobId) {
  throw new AppError("DRAWING_NOT_RELEASED", "Governing drawing does not belong to this component's job.");
}
```

`fileDelayReason`: after `lockProcessPlanForUpdate` (already job-scoping via Task 6), no further change needed here beyond passing the plan's `jobId` through if any subsequent query in this function opens a fresh `withTenant` rather than reusing `tx` — check and fix if so.

- [ ] **Step 4: Run them, confirm they pass**

Run: `pnpm test:db -- drawing.service _shared delay.service`

- [ ] **Step 5: Full regression + commit**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:db
git add src/lib/services/drawing.service.ts src/lib/services/_shared.ts src/lib/services/delay.service.ts
git commit -m "fix(H1): job-scope createDrawingRevision/assertDrawingReleased/fileDelayReason"
```

---

## Task 11: Cross-job independence proof (doubles as groundwork for H4, scoped here to H1's own acceptance test)

**Files:**
- Create: `src/lib/services/__tests__/h1-cross-job-independence.test.ts`

**Interfaces:**
- Consumes: every conversion from Tasks 6–10.
- Produces: the actual acceptance-test artifact for H1 — "a deliberately-unfiltered query cannot read another job's rows" — demonstrated end-to-end against the real service layer (not just the raw-SQL RLS test from Task 4), covering every converted call site in one file so it reads as a single coherent proof.

- [ ] **Step 1: Write the test**

```typescript
// src/lib/services/__tests__/h1-cross-job-independence.test.ts
//
// H1 acceptance test: "Project A vs Project B" — a deliberately-mismatched
// id from one job, passed into an operation scoped to another job in the
// SAME tenant, is refused. This is the concrete demonstration named in
// docs/mos-blueprint/execution/22_DESPL_MOS_BUILD_PLAN.md's H1 acceptance
// criterion.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
// import every converted service function + fixture helpers

describe("H1 — cross-job independence", () => {
  // beforeAll: seed one tenant, two jobs (A, B), each with a full mini-chain
  // (Equipment -> Unit -> Component -> ComponentOperation, AssemblyStep,
  // StockLot, AssemblyDrawing) so every Task 6-10 call site has a real
  // cross-job pair to test against.

  it("loadMappedOps: Job B's unit is invisible when scoped to Job A", async () => { /* ... */ });
  it("startComponentOperation: refuses a Job B componentOperationId when the actor's context is Job A", async () => { /* ... */ });
  it("verifyAssemblyStep: refuses a Job B assemblyStepId under Job A context", async () => { /* ... */ });
  it("closeNcr: refuses a Job B ncrId under Job A context", async () => { /* ... */ });
  it("createStockTxn: refuses a Job B componentId against a Job A stockLotId", async () => { /* ... */ });
  it("createDrawingRevision: refuses a Job B assemblyDrawingId under Job A context", async () => { /* ... */ });
  it("control: every one of the above SUCCEEDS when ids and context genuinely agree", async () => { /* ... */ });

  // afterAll: clean up the fixture tenant/jobs.
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test:db -- h1-cross-job-independence`
Expected: PASS on every case (the refusal cases pass because Tasks 6–10 already made them refuse; the control case proves the conversions didn't break the happy path).

- [ ] **Step 3: Full regression**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:db`
Expected: clean (or only the pre-existing documented `process.service.test.ts` flake). Also re-run the §"Do not touch" smoke check: hit `/jobs`, `/dashboard` (portfolio), `/my-day`, `/command/*`, `/alerts` through the real dev server and confirm they still render every job's data, not just one — this is the actual proof that fail-open held.

- [ ] **Step 4: Commit**

```bash
git add src/lib/services/__tests__/h1-cross-job-independence.test.ts
git commit -m "test(H1): cross-job independence acceptance suite — H1 exit criterion demonstrated"
```

---

## Self-review notes (already applied above, kept here for the record)

- **Spec coverage:** every model in Batch A/B (28 total) is covered by Tasks 1–4; every named risk-area call site (§"Call sites converted") has its own task (6–10); the "do not touch" cross-job reads are explicitly re-verified in Task 11 rather than just asserted once at the top.
- **Placeholder scan:** Task 3's migration SQL names the "repeat for every table" pattern once in the plan text but explicitly instructs the implementer that the committed `.sql` file must spell out all 26 statements — flagged so it isn't mistaken for permission to leave a comment in the real migration.
- **Type consistency:** `withJob(tenantId, jobId, fn, opts)` (Task 5) is defined once and never renamed; Task 6 discovers mid-implementation that most call sites can't actually use `withJob` (nested transaction) and resolves it by using the bare `set_config` pattern instead — this is called out explicitly as a design correction in Task 6, not left as a silent inconsistency between Task 5's wrapper and Tasks 7–10's actual usage. `withJob` itself remains valid for any TOP-LEVEL service entrypoint that opens its own fresh transaction (none of the ones converted in this plan do — they all receive an existing `tx` — so note this for whoever adds the next job-scoped mutation after this plan ships).
