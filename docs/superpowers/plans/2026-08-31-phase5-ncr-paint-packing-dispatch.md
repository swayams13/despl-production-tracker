# Phase 5 — NCR, paint, packing, dispatch

**Spec:** `docs/PHASE-PROMPTS.md` §0 (standing rules, binding on every task below) and §6
(PHASE 5 brief: N1-N4, P1, D1-D4). `CLAUDE.md`'s invariants 1-12 are also binding — in
particular invariant #1 (no client timestamps — `actualDispatchDate` etc. are server-clock
only), invariant #9 (templates are versioned, never edited in place), and invariant #12
(stable error codes).

## Global Constraints

- Every mutation runs inside `withTenant()` and writes its audit row via `audited()` from
  `src/lib/audit/index.ts` in the same transaction. `audited<T>(tx, actor, fn)` where `fn`
  returns `{result, audit: {action, entityType, entityId, before?, after?, eventType?,
  eventPayload?}}`. See `src/lib/services/component.service.ts:355-380` for a worked example.
- No request DTO may accept an `actual*` or `*_at` timestamp. All such fields are set from
  `new Date()` / DB `now()` server-side, never from client input. Zod schemas in
  `src/lib/shared/schemas.ts` stay `.strict()`.
- Any child table without `tenant_id` must be anchored through a tenant-scoped parent in every
  query (`_shared.ts:264-286` is the existing pattern). New tables in this plan
  (`Ncr`, `PaintRecord`, `DftReading`, `Package`, `DispatchBatchUnit`) have no `tenant_id` column
  themselves — anchor every lookup through `Job`/`Component`/`Unit`.
- New error codes go in `src/lib/shared/errors.ts`'s `ERROR_CODES` object (never rename existing
  ones) with a message string, and a `409` entry in `src/app/api/_lib.ts`'s status map.
- State-machine additions reuse `assertStateTransition<Status, Action>` from
  `src/lib/services/state-machine.ts:12` — define a typed `TRANSITIONS` table and a thin wrapper,
  matching `process.service.ts:79-81`'s `assertTransition` and
  `component.service.ts`'s `assertComponentOpTransition`.
- Prisma migrations are forward-only, snake_case tables, one migration per task below. Never
  edit an applied migration. Run `pnpm prisma migrate dev` (against local dev DB) to generate;
  do not hand-write migration SQL unless a task says so explicitly.
- Business rules live in `src/lib/services/`; Server Actions/Route Handlers stay thin callers.
- Any change to a state machine, gating, or RBAC path needs table-driven tests for the
  violation cases, not just happy paths — this applies to every task in this plan.
- No literal job number, serial, component tag, or family code enters `src/`. The
  `ProcessEvidenceKind` mechanism (Task 6) exists specifically so Task 6/7 do not hardcode a
  stage number.
- User-facing copy: plain verbs, sentence case, humanised enums, no raw enum values in the UI.

## Task 1 — Schema: `Ncr` + `ProcessEvidenceKind` + `PaintRecord`/`DftReading` + `Package` + `DispatchBatchUnit`

**Objective:** land every new/changed Prisma model this phase needs, in one migration-generating
pass, with zero application-code wiring yet (that's Tasks 2-6). This keeps every later task's
`prisma migrate dev` diff small and reviewable.

**File:** `prisma/schema.prisma`.

Add, near the existing `ComponentOperationRejection`/`AssemblyStepRejection` models
(~line 1318-1634):

```prisma
enum NcrDisposition {
  USE_AS_IS
  REPAIR
  REWORK
  SCRAP
  CONCESSION
}

enum NcrStatus {
  OPEN
  DISPOSITIONED
  REWORK_IN_PROGRESS
  CLOSED
}

/// N1 — layered on top of ComponentOperationRejection/AssemblyStepRejection,
/// not a replacement: the rejection row is the immutable "why reopened"
/// record (F5); Ncr is the disposition/rework workflow that follows it.
/// Exactly one of componentOperationRejectionId/assemblyStepRejectionId is
/// set — enforced by a raw CHECK constraint added in this task's migration
/// (Prisma has no native XOR-column support), plus an app-level assert in
/// ncr.service.ts (Task 2).
model Ncr {
  id                             Int             @id @default(autoincrement())
  componentOperationRejectionId  Int?            @unique @map("component_operation_rejection_id")
  assemblyStepRejectionId        Int?            @unique @map("assembly_step_rejection_id")
  status                         NcrStatus       @default(OPEN)
  disposition                    NcrDisposition?
  dispositionedBy                Int?            @map("dispositioned_by")
  dispositionedAt                DateTime?       @map("dispositioned_at")
  dispositionNotes               String?         @map("disposition_notes")
  reworkOwnerId                  Int?            @map("rework_owner_id")
  reworkDueDate                  DateTime?       @map("rework_due_date")
  /// SERVER CLOCK ONLY (invariant #1) — stamped by Task 2's start/submit hooks.
  reworkStartedAt                DateTime?       @map("rework_started_at")
  /// SERVER CLOCK ONLY (invariant #1)
  reworkFinishedAt               DateTime?       @map("rework_finished_at")
  closedBy                       Int?            @map("closed_by")
  closedAt                       DateTime?       @map("closed_at")

  componentOperationRejection ComponentOperationRejection? @relation(fields: [componentOperationRejectionId], references: [id], onDelete: Cascade)
  assemblyStepRejection       AssemblyStepRejection?       @relation(fields: [assemblyStepRejectionId], references: [id], onDelete: Cascade)
  dispositionedByUser         User?                        @relation("NcrDispositionedBy", fields: [dispositionedBy], references: [id])
  reworkOwner                 User?                        @relation("NcrReworkOwner", fields: [reworkOwnerId], references: [id])
  closedByUser                User?                        @relation("NcrClosedBy", fields: [closedBy], references: [id])

  @@index([status])
  @@map("ncrs")
}
```

Add reverse relations `ncr Ncr?` on `ComponentOperationRejection` and `AssemblyStepRejection`,
and the three named `User` back-relations (`ncrsDispositioned`, `ncrsReworkOwned`, `ncrsClosed`).

Add near `TemplateProcess` (~line 630):

```prisma
enum ProcessEvidenceKind {
  MDR_COMPILED
  PACKING_DONE
  DISPATCH_RECORDED
}
```

Add one nullable column to `TemplateProcess`: `evidenceKind ProcessEvidenceKind? @map("evidence_kind")`.

Add near `ComponentOperation` (~line 1318):

```prisma
/// P1 — paint tracking rides the existing PAINTING ComponentOperation grain
/// (already a per-component RouteStep per seed/component-routes.json); no
/// new grain needed.
model PaintRecord {
  id                   Int    @id @default(autoincrement())
  componentOperationId Int    @unique @map("component_operation_id")
  coatingSystem        String @map("coating_system")
  coatsPlanned         Int?   @map("coats_planned")

  componentOperation ComponentOperation @relation(fields: [componentOperationId], references: [id], onDelete: Cascade)

  @@map("paint_records")
}

/// `accepted` is self-attested by whoever records the reading (open
/// question flagged in the plan's cover note — no DFT spec-range table
/// exists to check against automatically; building one is out of scope
/// unless the floor confirms it's needed).
model DftReading {
  id                   Int      @id @default(autoincrement())
  componentOperationId Int      @map("component_operation_id")
  coatNumber           Int?     @map("coat_number")
  location             String?
  readingMicrons       Int      @map("reading_microns")
  accepted             Boolean
  recordedBy           Int      @map("recorded_by")
  /// SERVER CLOCK ONLY (invariant #1)
  recordedAt           DateTime @default(now()) @map("recorded_at")

  componentOperation ComponentOperation @relation(fields: [componentOperationId], references: [id], onDelete: Cascade)
  recordedByUser     User               @relation(fields: [recordedBy], references: [id])

  @@index([componentOperationId])
  @@map("dft_readings")
}
```

Add near `Unit` (~line 788):

```prisma
/// D1 — a Unit belongs to at most one Package (simplest cardinality that
/// fits "packing list of contents by serial"). D2's DispatchBatchUnit is a
/// separate join because a dispatch batch groups units directly, not via
/// Package.
model Package {
  id                Int      @id @default(autoincrement())
  jobId             Int      @map("job_id")
  packageNo         String   @map("package_no")
  weightKg          Decimal? @map("weight_kg")
  lengthMm          Int?     @map("length_mm")
  widthMm           Int?     @map("width_mm")
  heightMm          Int?     @map("height_mm")
  preservationNotes String?  @map("preservation_notes")
  createdBy         Int      @map("created_by")
  createdAt         DateTime @default(now()) @map("created_at")

  job   Job    @relation(fields: [jobId], references: [id], onDelete: Cascade)
  units Unit[]

  @@unique([jobId, packageNo])
  @@index([jobId])
  @@map("packages")
}
```

Add `packageId Int? @map("package_id")` and `package Package? @relation(fields: [packageId], references: [id])`
to `Unit`.

Extend `DispatchBatch` (~line 1812) with: `dispatchNoteNo String? @map("dispatch_note_no")`,
`gatePassNo String? @map("gate_pass_no")`, `vehicleNo String? @map("vehicle_no")`,
`lrNo String? @map("lr_no")`, `releaseApprovedBy Int? @map("release_approved_by")`,
`releaseApprovedAt DateTime? @map("release_approved_at")`,
`/// SERVER CLOCK ONLY (invariant #1)` `actualDispatchDate DateTime? @map("actual_dispatch_date")`,
plus the `releaseApprovedByUser User?` relation.

Add near `DispatchBatch`:

```prisma
model DispatchBatchUnit {
  id              Int @id @default(autoincrement())
  dispatchBatchId Int @map("dispatch_batch_id")
  unitId          Int @map("unit_id")

  dispatchBatch DispatchBatch @relation(fields: [dispatchBatchId], references: [id], onDelete: Cascade)
  unit          Unit          @relation(fields: [unitId], references: [id])

  @@unique([dispatchBatchId, unitId])
  @@index([dispatchBatchId])
  @@map("dispatch_batch_units")
}
```

**Migration:** run `pnpm prisma migrate dev --name phase5_ncr_evidence_paint_packing_dispatch`
(single migration covering all of the above — additive only, no backfill). After Prisma
generates the SQL, hand-add the CHECK constraint for `Ncr`'s exactly-one-of-two-FKs:

```sql
ALTER TABLE ncrs ADD CONSTRAINT ncr_exactly_one_source CHECK (
  (component_operation_rejection_id IS NOT NULL)::int +
  (assembly_step_rejection_id IS NOT NULL)::int = 1
);
```

**Tests:** none yet (schema only) — but run `pnpm typecheck` to confirm the generated Prisma
client compiles, and `pnpm db:seed` (or the smallest relevant seed step) against `despl_test` to
confirm the migration applies cleanly with no data-loss warnings.

**Rollback:** `prisma migrate resolve --rolled-back` + drop migration file; every column/table
is new, nothing existing is altered destructively.

**Acceptance:** `pnpm typecheck` passes; migration applies cleanly to a fresh `despl_test`
database and to a copy of the seeded dev database with no errors.

---

## Task 2 — `ncr.service.ts`: N1, N2, N4

**Objective:** wire `Ncr` creation into the existing reject flows, add disposition/rework-owner
assignment, and stamp rework timing.

**Files:**
- New: `src/lib/services/ncr.service.ts`
- Edit: `src/lib/services/component.service.ts` (`rejectComponentOperation`, ~line 343-383, and
  the start/submit functions for `ComponentOperation`)
- Edit: `src/lib/services/assembly.service.ts` (the `AssemblyStep` reject/start/submit
  equivalents — same pattern, mirrored)
- Edit: `src/lib/shared/schemas.ts` (new zod schemas for `dispositionNcr`)

**Required change:**

1. `rejectComponentOperation` and its assembly-step equivalent each grow one more `tx.ncr.create`
   inside their existing `audited()` block, immediately after the `ComponentOperationRejection`/
   `AssemblyStepRejection` row is created, using that row's freshly-created id.
2. New `ncr.service.ts` exports:
   - `dispositionNcr(tx, actor, {ncrId, disposition, notes?, reworkOwnerId?, reworkDueDate?})` —
     QC role only (reuse whatever role guard `recordQcpExecution` in `qcp.service.ts` uses).
     Sets `status: disposition === "REWORK" || disposition === "REPAIR" ? "REWORK_IN_PROGRESS" :
     "DISPOSITIONED"`, stamps `dispositionedBy`/`dispositionedAt`. `audited()` call, own event
     type e.g. `"ncr.dispositioned"`.
   - `closeNcr(tx, actor, {ncrId})` — called automatically (not user-facing) from the operation's
     verify flow (see below) when the underlying `ComponentOperation`/`AssemblyStep` reaches
     `COMPLETE` again while it has an open (non-`CLOSED`) `Ncr`. Stamps `closedBy`/`closedAt`,
     `status: "CLOSED"`.
3. `component.service.ts`'s start-operation function: if the operation being started has an
   `Ncr` with `status: "REWORK_IN_PROGRESS"` and no `reworkStartedAt` yet, stamp
   `reworkStartedAt = now()` in the same transaction.
4. `component.service.ts`'s verify-operation function (and the assembly equivalent): after the
   status transition succeeds, if the operation has an open `Ncr` (`status` not `CLOSED`), call
   `closeNcr` and stamp `reworkFinishedAt = now()` on it in the same write.
5. Disposition values `USE_AS_IS`/`SCRAP`/`CONCESSION` do not require rework — `dispositionNcr`
   for these sets `status: "DISPOSITIONED"` directly (no `reworkOwnerId` required); a human closes
   these later via a plain `closeNcr` call surfaced in the UI (Task 2 back-end only — no UI wiring
   required by this task; that is out of scope for Phase 5's plan unless you find an existing UI
   pattern this slots into trivially).

**N2 (visibility) + N4 (dashboard):**

6. Extend `src/lib/services/workspace.read.ts`'s `WsUnitRow` (~line 185) with an
   `openNcrCount: number` field (or similar), computed by joining `Ncr` through
   `ComponentOperationRejection`/`AssemblyStepRejection` back to the unit. Extend `WsCard`
   grouping if a rework filter chip makes sense given the existing cross-filter URL convention
   (`?dept=…&status=…`) — reuse it, do not invent a second filtering mechanism.
7. Extend `src/lib/services/departments.read.ts`'s `DeptOpenItem` (~line 77) or add a sibling
   list for open-rework items scoped to the department owning the rejected operation (via
   `OperationRef`'s department, or the equivalent for assembly steps).
8. Add rework hours/qty aggregation (sum of `reworkFinishedAt - reworkStartedAt` for `CLOSED`
   NCRs with `disposition` in `REPAIR`/`REWORK`) to whichever read model backs the quality
   dashboard (locate it — likely `qc-dashboard.read.ts` or similar; if no such file exists,
   report back rather than guessing which page needs it) and to `DeptCard` (~line 19) as a
   department-load figure.

**Tests:** table-driven for `Ncr` status transitions (illegal transitions rejected), a test that
`dispositionNcr` is refused for non-QC actors, a test that `rejectComponentOperation` and the
assembly equivalent each produce exactly one `Ncr` row linked correctly, a test that verifying a
reworked operation closes its `Ncr` and stamps `reworkFinishedAt`, cross-tenant negative test for
`Ncr` (anchored through its rejection → operation → component/unit → job → tenant chain).

**Rollback:** additive service file + read-model field additions; safe to revert independently
of Task 1's schema (schema stays even if this task is reverted).

**Acceptance:** rejecting a component operation or assembly step creates exactly one open `Ncr`.
QC can disposition it. Assigning `REWORK` and reopening the operation, then verifying it again,
closes the `Ncr` and records elapsed rework time. The workspace and department views show the
open count; the quality dashboard shows rework hours.

---

## Task 3 — `NCR_OPEN` gate on `verifyProcess`

**Objective:** a stage cannot verify while any operation/assembly-step feeding it has an open NCR.

**Files:**
- Edit: `src/lib/services/_shared.ts` (new `assertNoOpenNcr`, sibling to `assertNoOpenHoldPoint`
  at line 413 and `assertComponentOpsComplete` at line 504 — reuse the same
  `(jobProcessId, unitId)` → mapped-operations join logic those two already have)
- Edit: `src/lib/services/process.service.ts` (`verifyProcess`, ~line 209-235 — add the call
  right after `assertNoOpenHoldPoint` at line 220)
- Edit: `src/lib/shared/errors.ts` (add `NCR_OPEN: "NCR_OPEN"` to `ERROR_CODES`, plus a message
  string in the same file near `HOLD_POINT_OPEN`'s and `COMPONENT_OPS_INCOMPLETE`'s)
- Edit: `src/app/api/_lib.ts` (add `NCR_OPEN: 409` to the status map, ~line 40-55)

**Required change:** `assertNoOpenNcr(tx, {jobProcessId, unitId})` — no-op when `unitId` is
`null` (matching the SEAM convention at `_shared.ts:413-417`/`:504-517`), otherwise queries every
`ComponentOperation`/`AssemblyStep` mapped to `(jobProcessId, unitId)` and checks whether any
linked `Ncr` has `status` not `CLOSED`; throws `ERROR_CODES.NCR_OPEN` naming the operation(s) if
so.

**Tests:** violation case — `verifyProcess` refused with `NCR_OPEN` while an `Ncr` is
`OPEN`/`DISPOSITIONED`/`REWORK_IN_PROGRESS`; succeeds once `CLOSED`. Confirm the refusal message
names the blocking operation (per invariant #12, refusals must be explainable).

**Rollback:** one new function + one new call site + one new error code; revert independently.

**Acceptance:** attempting to verify a stage with any open NCR anywhere in its mapped operations
is refused with `NCR_OPEN` and a readable reason; clearing/closing the NCR unblocks it.

---

## Task 4 — P1: Paint / DFT

**Objective:** coating system, planned coats, and DFT readings are recordable per painted
component; the operation cannot verify without accepted DFT coverage.

**Files:**
- Edit: `src/lib/services/component.service.ts` (verify-operation function — add the DFT check
  for `PAINTING` operations)
- New/edit: wherever `PaintRecord`/`DftReading` writes belong — either fold into
  `component.service.ts` as `recordPaintRecord`/`recordDftReading`, or a new
  `paint.service.ts` if `component.service.ts` is already large (check its current line count
  first; if it exceeds ~500 lines, use a new file).
- Edit: `src/lib/shared/schemas.ts` (zod schemas for the two new write actions)

**Required change:** identify the `PAINTING` operation by its `OperationRef.code` (data-driven,
not a stage-number literal — matches how `component-routes.json` already tags it). Before
allowing `PAINTING`'s `ComponentOperation` to transition to `COMPLETE` via verify, require: a
`PaintRecord` exists for it, AND at least one `DftReading` with `accepted: true` per planned coat
(if `coatsPlanned` is set) or at least one `accepted: true` reading if not. Throw a new
`ERROR_CODES.DFT_NOT_ACCEPTED` (add alongside `NCR_OPEN` in Task 3's error-code edits, or here —
whichever lands first; note the addition either way) naming what's missing.

**Open question, do not guess past this:** whether "accepted" needs to be checked against a
spec'd min/max micron range (would need a new range field on `OperationRef` or a coating-system
lookup table) is unresolved — ship the self-attested boolean as scoped, and say so plainly in the
task report rather than inventing a range table.

**Tests:** violation case — verifying `PAINTING` with no `DftReading`, or with readings but none
`accepted: true`, is refused with `DFT_NOT_ACCEPTED`; succeeds once satisfied. A test that
`recordDftReading` is anchored through the operation's own component/unit/job tenant chain.

**Rollback:** additive; the gate only fires for operations whose `OperationRef.code ===
"PAINTING"`, so it cannot affect any other operation even if reverted partially.

**Acceptance:** a supervisor can log a coating system and DFT readings against a component's
Painting operation; verifying that operation without an accepted reading is refused by name.

---

## Task 5 — D1/D2/D3: `packing.service.ts` + `dispatch.service.ts`

**Objective:** packages, dispatch batches, and the release/dispatch workflow become real,
write-backed actions.

**Files:**
- New: `src/lib/services/packing.service.ts`
- New: `src/lib/services/dispatch.service.ts`
- Edit: `src/lib/shared/schemas.ts` (zod schemas for every new action below)

**`packing.service.ts`:**
- `createPackage(tx, actor, {jobId, packageNo, weightKg?, lengthMm?, widthMm?, heightMm?,
  preservationNotes?})` — `audited()`, anchored via `jobId`'s tenant.
- `assignUnitToPackage(tx, actor, {packageId, unitId})` — sets `Unit.packageId`; both must share
  the same tenant/job (assert `unit.equipment.jobId === package.jobId`, mirroring the existing
  cross-tenant-anchoring convention).

**`dispatch.service.ts`** (state machine: `PLANNED → RELEASED → DISPATCHED`, via
`assertStateTransition`):
- `createDispatchBatch(tx, actor, {jobId, seq, plannedDate, remarks?})` — reuses the existing
  `DispatchBatch` model's fields (already has `jobId, seq, plannedDate, qty, remarks`).
- `addUnitToBatch(tx, actor, {dispatchBatchId, unitId})` — creates `DispatchBatchUnit`; **requires
  the unit's `packageId` to be set** (D4's packing-done precondition realized at the unit grain,
  distinct from Task 6's process-level `PACKING_DONE` evidence — both are needed: this one blocks
  adding an unpacked unit to a batch at all, Task 6 blocks the *Packing stage* from verifying).
- `approveDispatchRelease(tx, actor, {dispatchBatchId, dispatchNoteNo?, gatePassNo?, vehicleNo?,
  lrNo?})` — Production Head role only (reuse the role check pattern from `override.service.ts`'s
  Production Head gate for witness waivers). Stamps `releaseApprovedBy`/`releaseApprovedAt`
  (server clock), transitions batch to `RELEASED`.
- `recordDispatch(tx, actor, {dispatchBatchId})` — requires `RELEASED` state; stamps
  `actualDispatchDate = now()` (server clock, invariant #1 — no client date accepted); transitions
  to `DISPATCHED`. This is also the write that satisfies Task 6's `DISPATCH_RECORDED` evidence
  kind for every unit in the batch.

**Tests:** table-driven for the batch state machine's illegal transitions (e.g. `recordDispatch`
before `approveDispatchRelease`), a test that `addUnitToBatch` refuses an unpacked unit, cross-
tenant negative tests for `Package`/`DispatchBatchUnit`, a test confirming `actualDispatchDate`
is never accepted from request input (schema-level `.strict()` check).

**Rollback:** two new service files; no existing service is edited, so reverting this task alone
is a clean file deletion.

**Acceptance:** a package can be created and units assigned to it; a dispatch batch can be
created, units added (only if packed), released by a Production Head with note/gate-pass/vehicle
details, and dispatched — stamping a real server-clock date, not a client-supplied one.

---

## Task 6 — D4: wire `ProcessEvidenceKind` into `verifyProcess`

**Objective:** stages tagged `MDR_COMPILED`/`PACKING_DONE`/`DISPATCH_RECORDED` cannot verify
without the matching evidence — generic, data-driven, no hardcoded stage number in `src/`.

**Files:**
- Edit: `src/lib/services/process.service.ts` (`verifyProcess`, one more check alongside Task 3's
  `assertNoOpenNcr`)
- Edit: `src/lib/services/_shared.ts` (new `assertEvidenceSatisfied`)
- New `ProcessTemplateVersion` for `PRESSURE_VESSEL`: a data change (via whatever
  script/mechanism the repo already uses for template authoring — check
  `scripts/split-plate-rolling-forming.ts` from Phase 1's F6 for the established pattern of
  "new template version via script, not a hand migration") tagging the template processes at
  seq 23 (`MDR_COMPILED`), 24 (`PACKING_DONE`), 25 (`DISPATCH_RECORDED`) with the new
  `evidenceKind` column from Task 1. **Do this by seq/name lookup in the script, never by a
  literal stage number check in `src/` application code** — the version-authoring script itself
  is allowed to reference DESPL-320's concrete template because it's a one-time data-authoring
  step, exactly like F6's precedent; `process.service.ts`'s gate code only ever reads
  `templateProcess.evidenceKind`, never a stage number.

**Required change:** `assertEvidenceSatisfied(tx, {jobProcessId, unitId})` — loads the
`JobProcess`'s `TemplateProcess.evidenceKind`; if null, no-op. If `MDR_COMPILED`: this phase adds
no dedicated "compile MDR" action (out of scope — flag as a gap in the task report: today nothing
sets this evidence, so stage 23 becomes unverifiable until a future phase adds the compile action;
note this explicitly rather than silently leaving a dead-end gate — **recommend to controller
descoping `MDR_COMPILED` enforcement in this task and only wiring `PACKING_DONE`/
`DISPATCH_RECORDED`, which do have real evidence sources from Tasks 5**). If `PACKING_DONE`:
satisfied when every `Unit` for this `(jobProcessId, unitId)` has a non-null `packageId`. If
`DISPATCH_RECORDED`: satisfied when a `DispatchBatchUnit` exists for the unit whose
`DispatchBatch.actualDispatchDate` is non-null.

**Tests:** violation case per evidence kind actually wired (per the descope note above) — stage
24 refuses verify until the unit is packaged; stage 25 refuses until dispatched.

**Rollback:** the `evidenceKind` column defaults to null on every existing `TemplateProcess` row
except the ones the authoring script touches — reverting the script's data change or the gate
code independently is safe.

**Acceptance:** for DESPL-320, the Packing stage cannot verify until its unit is assigned to a
`Package`; the Dispatch stage cannot verify until `recordDispatch` has run for that unit. Report
plainly whether `MDR_COMPILED` shipped or was descoped per the note above — do not silently drop
it without saying so.

---

## Task 7 — Tests, typecheck/lint/build, progress.md

**Objective:** close out the phase per §0's reporting rule.

**Required:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db` (test:db against
`despl_test` only — never `RUN_DB_TESTS` against `despl_demo`) `&& pnpm build`, all clean. Add a
new `## Session —` block at the **top** of `progress.md` (do not append to the existing huge
blocks) covering: what changed, by work item (N1-N4, P1, D1-D4), labeled honestly as
implemented/partially implemented/UI-only/untested/blocked; schema changes; API/service changes;
tests added and their results; the `MDR_COMPILED` descope decision from Task 6 if it happened;
the DFT self-attestation open question from Task 4; remaining limitations (no UI was built this
phase — back-end/service layer only, per this plan's scope); next recommended phase.

**Acceptance:** all verification commands pass; `progress.md` reflects Phase 5 honestly.
