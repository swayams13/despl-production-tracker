# Phase 2 — Assembly tracking (the vessel, end to end) — Implementation Plan

> Produced per `docs/PHASE-PROMPTS.md` §0/§3. Per-item format follows §0 rule 3 exactly
> (objective · current implementation · required change · files · schema/migration ·
> API/action change · frontend change · tests · rollback · acceptance · complexity).
> **STOP — awaiting approval before any code is written**, per the phase-prompt contract.

**Spec:** `docs/AUDIT-addendum-fabrication-and-assembly.md` §2/§3, `docs/DESPL-320-fabrication-assembly-spec.md`
§2–4, `docs/PHASE-PROMPTS.md` §3 (A1–A8), `docs/ADR-product-family-agnostic-platform-v1.md`.

**Goal:** Every A–Q assembly/weld checkpoint (54/unit, 486 total for DESPL-320) becomes tracked
work — Start/Submit/Verify/Reject, owner, timestamps, audit — the same way Phase 1 did for
fabrication, sharing its state machine. Welding stops being an empty page: logging a joint and
recording NDT results becomes part of the assembly flow and finally has data behind
`welding.read.ts`'s per-welder repair rate. Welder registry gets its first write path.

**Not in this phase (confirmed against the brief before planning, not guessed):**
- **A7 `ComponentConsumption`** — brief says "defer, but leave room." Not building; no schema
  change reserves space for it beyond `AssemblyStep`/`Component` already both existing as FK
  targets, which is enough room.
- **A8 QCP template authoring UI** — brief says "may slip to Phase 4... flag it in the plan if it
  fits; do not skip it silently." It doesn't fit: it's a template-authoring UI, orthogonal to
  everything else here, and nothing in A1–A6 depends on it (DESPL-320's QCP is already seeded).
  Flagging it here, deferring it explicitly rather than silently.
- **F-f (welder list + employee codes) is still unresolved with the floor.** `Welder.employeeCode`
  already exists in the schema (added before this phase), so A5's CRUD mechanism does not need the
  answer to ship — but DESPL-320 cannot get its *real* welders entered until the floor supplies the
  list. The demo will need at least one admin-entered placeholder welder to exercise A6's
  weld-logging UI. Said here per §0 rule 4, not discovered mid-implementation.

---

## Global constraints (carried from CLAUDE.md / §0 — apply to every item below)

- No client timestamps; `startedAt`/`finishedAt`/`recordedAt` server-clock only.
- Maker–checker on verify AND reject: QC role AND `actor != submittedBy`, no admin exception.
- Every mutation inside `withTenant()`, audit row via `audited()` in the same transaction.
- Anchor every new child-table lookup through a tenant-scoped parent (`_shared.ts:264-286` pattern).
- No new literal in `src/` — DESPL-320's A–Q content is data (`seed/*.json`), never a branch.
- Templates are versioned (`TemplateStatus`), never edited in place once `PUBLISHED`.
- Table-driven violation-case tests for every new state-machine/RBAC/audit path.
- Reuse existing error codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `INVALID_STATE_TRANSITION`,
  `NOT_FOUND`, `VALIDATION_FAILED`, `FORBIDDEN`) — none of this phase's items need a new one.

## Two deliberate departures from the addendum's schema sketch (§2), flagged per §0 rule 4

The addendum's `AssemblyTemplateStep`/`AssemblyStep` sketch (addendum §2) omits two things every
other gated entity in this schema has. Both are additive, not a redesign — noting them now so the
approval isn't surprised by them in the diff:

1. **`AssemblyTemplateStep.defaultDepartmentId`** — every other department-scoped mutation gate
   (`TemplateProcess.defaultDepartmentId`, `OperationRef.defaultDepartmentId`) resolves scope this
   way; without it, `startAssemblyStep`/`submitAssemblyStep` have no way to run
   `requireDepartmentScope` and Rule #8 (deny-by-default RBAC, department-scoped) breaks for the
   entire phase.
2. **`AssemblyStepRejection`** (mirrors `ComponentOperationRejection`) — the brief's acceptance
   criteria require reject-with-reason on assembly steps the same as Phase 1's F5; the addendum's
   sketch names `weldJointId`/`qcpItemId` but not a rejection reason home. Reuses
   `DelayCategoryRef`, same as `ComponentOperationRejection`.

Also narrowing one scope call: **`WeldJoint.componentId` is set by the person logging the joint,
not auto-derived from a joint number.** DESPL-320's spec doesn't give a job-agnostic joint-number →
component mapping (LS-1 "belongs to" SHELL only by convention, not by any field today), and
inventing one would be exactly the kind of DESPL-320-shaped code §0 rule 1 forbids. A component
picker on the joint-log form, defaulting to none, keeps the field generic.

---

## Work items

### A1 — `AssemblyTemplate` → `AssemblyTemplateVersion` → `AssemblyTemplateStep` → `AssemblyStep`

**Objective:** give assembly work a schema home, following the exact three-layer pattern
`ProcessTemplate → JobProcess` and `RouteTemplate → ComponentOperation` already use, so a second
family's assembly sequence is data, not code.

**Current implementation:** none. Assembly today is representable only as `QcpExecution` rows plus
one manual "Final Assembly" `JobProcess` checkbox (addendum §2, "What's missing, precisely").

**Required change:** add the four models below to `prisma/schema.prisma`, plus a new
`AssemblyStepKind` enum (`WORK | INSPECTION`) and `Job.assemblyTemplateVersionId` (nullable —
families without an authored template, e.g. `HEAT_EXCHANGER` today, must still create jobs).

```prisma
enum AssemblyStepKind {
  WORK
  INSPECTION
}

model AssemblyTemplate {
  id       Int    @id @default(autoincrement())
  tenantId Int    @map("tenant_id")
  familyId Int    @map("family_id")
  name     String

  tenant   Organization             @relation(fields: [tenantId], references: [id])
  family   ProductFamily            @relation(fields: [familyId], references: [id])
  versions AssemblyTemplateVersion[]

  @@index([tenantId])
  @@index([familyId])
  @@map("assembly_templates")
}

model AssemblyTemplateVersion {
  id          Int            @id @default(autoincrement())
  templateId  Int            @map("template_id")
  version     Int
  status      TemplateStatus @default(DRAFT)
  publishedAt DateTime?      @map("published_at")
  notes       String?

  template AssemblyTemplate     @relation(fields: [templateId], references: [id])
  steps    AssemblyTemplateStep[]
  jobs     Job[]

  @@unique([templateId, version])
  @@index([templateId])
  @@map("assembly_template_versions")
}

model AssemblyTemplateStep {
  id                  Int              @id @default(autoincrement())
  versionId           Int              @map("version_id")
  seq                 Int
  groupCode           String           @map("group_code")   // "E", "G", "H", ...
  groupName           String           @map("group_name")   // "Shell Sub-Assembly (LS-1)"
  srNo                String           @map("sr_no")         // "4.5" — printed QAP reference
  activity             String
  kind                 AssemblyStepKind
  defaultDepartmentId  Int              @map("default_department_id")
  qcpSrNo              String?          @map("qcp_sr_no")    // resolves to QcpItem.srNo at materialisation
  jointRef             String?          @map("joint_ref")    // "LS-1" — printed weld-map reference

  version           AssemblyTemplateVersion @relation(fields: [versionId], references: [id], onDelete: Cascade)
  defaultDepartment Department              @relation(fields: [defaultDepartmentId], references: [id])
  steps             AssemblyStep[]

  @@unique([versionId, seq])
  @@index([versionId])
  @@map("assembly_template_steps")
}

model AssemblyStep {
  id             Int             @id @default(autoincrement())
  unitId         Int             @map("unit_id")
  templateStepId Int             @map("template_step_id")
  seq            Int
  status         OperationStatus @default(NOT_STARTED)
  startedAt      DateTime?       @map("started_at")   // SERVER CLOCK ONLY
  finishedAt     DateTime?       @map("finished_at")  // SERVER CLOCK ONLY
  performedByWelderId Int?       @map("performed_by_welder_id")
  performedByUserId   Int?       @map("performed_by_user_id")
  submittedBy    Int?            @map("submitted_by")
  verifiedBy     Int?            @map("verified_by")
  weldJointId    Int?            @map("weld_joint_id")
  qcpItemId      Int?            @map("qcp_item_id")
  remarks        String?

  unit         Unit                 @relation(fields: [unitId], references: [id])
  templateStep AssemblyTemplateStep @relation(fields: [templateStepId], references: [id])
  weldJoint    WeldJoint?           @relation(fields: [weldJointId], references: [id])
  qcpItem      QcpItem?             @relation(fields: [qcpItemId], references: [id])
  performedByWelder Welder?         @relation(fields: [performedByWelderId], references: [id])
  performedByUser   User?           @relation(fields: [performedByUserId], references: [id])
  rejections   AssemblyStepRejection[]

  @@unique([unitId, seq])
  @@index([unitId])
  @@index([templateStepId])
  @@index([status])
  @@index([weldJointId])
  @@index([qcpItemId])
  @@map("assembly_steps")
}

model AssemblyStepRejection {
  id             Int      @id @default(autoincrement())
  assemblyStepId Int      @map("assembly_step_id")
  categoryId     Int      @map("category_id")
  detail         String?
  rejectedBy     Int      @map("rejected_by")
  rejectedAt     DateTime @default(now()) @map("rejected_at")

  assemblyStep AssemblyStep     @relation(fields: [assemblyStepId], references: [id], onDelete: Cascade)
  category     DelayCategoryRef @relation(fields: [categoryId], references: [id])

  @@index([assemblyStepId])
  @@index([categoryId])
  @@map("assembly_step_rejections")
}
```

Also: `Job.assemblyTemplateVersionId Int? @map("assembly_template_version_id")`, FK to
`AssemblyTemplateVersion`, nullable.

**Files affected:** `prisma/schema.prisma` (new models + enum + `Job`/`Unit`/`Welder`/`User`/
`WeldJoint`/`QcpItem`/`DelayCategoryRef` back-relations), new migration.

**Schema change / migration:** one forward-only migration,
`prisma/migrations/<ts>_assembly_tracking/migration.sql` (generated via `prisma migrate dev`).
Purely additive — no existing table altered except `jobs` (new nullable column) and the six models
gaining a back-relation array (no column change on those). Zero data loss risk; nothing to backfill
since no `AssemblyStep` rows exist yet.

**API / server-action change:** none in this item — schema only, mirrors how F7b landed schema-only
in Phase 1.

**Frontend change:** none.

**Tests:** none beyond `prisma migrate dev` succeeding and `pnpm typecheck` picking up the new
generated client types. (Behavioural tests land with A2/A6's service layer.)

**Rollback:** drop the migration before any `AssemblyStep` row exists (trivial — this item ships
before A2 populates anything). After A2, forward-only per invariant #9 — a correction would be a
new template version, never an edit.

**Acceptance:** `pnpm prisma migrate dev` applies cleanly against `despl` and `despl_test`;
`pnpm typecheck` passes; `Job.assemblyTemplateVersionId` is nullable and every existing job still
loads.

**Complexity:** M (schema-only, but touches 8 files' worth of relation wiring).

---

### A3 — `WeldJoint.componentId`

**Objective:** make a weld joint referenceable to the `Component` it's on, per addendum §2 ("What
this makes real"), and lay the FK `AssemblyStep.weldJointId` (A1) actually resolves against.

**Current implementation:** `WeldJoint` (`schema.prisma:1165-1185`) has `jobId`/`unitId` but no
component link.

**Required change:** `WeldJoint.componentId Int? @map("component_id")`, FK to `Component`,
nullable (per the scope note above — set by the logger, not derived). Extend
`logWeldJointSchema` (`src/lib/shared/schemas.ts`, next to `logWeldJointSchema`'s existing fields)
with optional `componentId`. Extend `logWeldJoint` (`src/lib/services/welding.service.ts:36-85`) to
validate `componentId` belongs to the same job (`component.equipment.jobId === jobId`) when
provided, and persist it.

**Files affected:** `prisma/schema.prisma` (same migration as A1 — bundle it, one migration for the
whole schema layer), `src/lib/shared/schemas.ts`, `src/lib/services/welding.service.ts`.

**Schema change / migration:** additive column, bundled into A1's migration.

**API / server-action change:** `logWeldJoint`'s existing Server Action (`src/app/actions/
welding.ts`) gains the pass-through field; no new action.

**Frontend change:** the Welding page's joint-log form (`src/app/(app)/welding/_client.tsx`) gains
a component picker (optional, searchable-by-tag select scoped to the job/unit already selected in
that form). Also wired into A6's inline weld-log form on the assembly panel.

**Tests:** `welding.service.test.ts` — new case: `componentId` from a different job is rejected with
`NOT_FOUND`; a valid `componentId` persists and round-trips.

**Rollback:** drop the column; no other table depends on it (nullable, no cascade concerns).

**Acceptance:** logging a joint with a component set persists and displays it; a cross-job
`componentId` is refused.

**Complexity:** S.

---

### A2 — Author the PRESSURE_VESSEL assembly template v1 and materialise it for DESPL-320

**Objective:** get the 54-step A–Q sequence (spec §2) into the database as versioned template data,
then instantiate it for DESPL-320's 9 already-existing units — through the normal
template-version-pin mechanism, not a bespoke per-unit seed (§0 rule 2).

**Current implementation:** `prisma/seed.ts:600-655` shows the exact precedent
(`ProcessTemplate`/`ProcessTemplateVersion`/`TemplateProcess`/`TemplateEdge` for PRESSURE_VESSEL,
driven by `seed/lead-time-model.json`). No assembly-template equivalent exists.
`scripts/seed-despl320-components.ts` shows the precedent for materialising per-unit rows against
already-existing `Unit`s outside the main seed run (idempotent, additive, keyed by
`(unitId, seq)`/`(unitId, tag)`).

**Required change, two parts:**

1. **Library data** (family-scoped, tenant-wide): a new `seed/assembly-template-pressure-vessel-v1.json`
   transcribing spec §2's 54 rows verbatim (groupCode/groupName/srNo/activity/kind/qcpSrNo/jointRef —
   `jointRef` populated only for the six weld groups E/G/H/J/K/L per spec §3), loaded by
   `prisma/seed.ts` in the same block as the PRESSURE_VESSEL process template
   (`prisma/seed.ts:600-655`), creating `AssemblyTemplate` → `AssemblyTemplateVersion` (v1,
   `PUBLISHED`) → 54 `AssemblyTemplateStep` rows. `defaultDepartmentId` per group resolved the same
   way `TemplateProcess.defaultDepartmentId` is (`deptIdByCode.get(...)`) — needs the WORK/INSPECTION
   split and department mapping confirmed against the floor before authoring, per the brief's own
   caveat on A2. **This is the one open input this item genuinely needs** (not F-f — a
   department-per-group mapping, e.g. is PAUT/TOFD QC's department or FABRICATION's).
2. **Per-unit materialisation for DESPL-320**: new `scripts/seed-despl320-assembly-steps.ts`,
   modelled directly on `scripts/seed-despl320-components.ts` — finds the DESPL-320 `Job` by
   `jobNumber`, sets `Job.assemblyTemplateVersionId` if null, then for each of its 9 `Unit`s creates
   54 `AssemblyStep` rows from the template steps (idempotent on `(unitId, seq)`), resolving
   `qcpItemId` by matching `AssemblyTemplateStep.qcpSrNo` to `QcpItem.srNo` within that job's
   `QcpTemplate` — same match-by-code discipline `cloneQcpTemplate` already uses (never by id, so it
   survives renumbering). `weldJointId` stays null until A6's UI logs one.

**Files affected:** `seed/assembly-template-pressure-vessel-v1.json` (new),
`prisma/seed.ts` (new block, mirrors lines 600-655), `scripts/seed-despl320-assembly-steps.ts` (new),
`package.json` (new `db:seed:despl320-assembly-steps` script, mirrors the existing
`db:seed:despl320-components` entry).

**Schema change / migration:** none beyond A1 — this item is data only.

**API / server-action change:** none.

**Frontend change:** none.

**Tests:** `prisma/seed.ts`'s existing seed-idempotency test path (if one exists — verify) or a new
assertion that re-running `pnpm db:seed` doesn't duplicate `AssemblyTemplateStep` rows. A DB-gated
test asserting the materialisation script is idempotent (0 created / 486 skipped on a second run),
same shape as the F1 session's verification of `seed-despl320-components.ts`.

**Rollback:** both scripts are additive/idempotent; a bad run is fixed by a corrective migration or
a `DELETE ... WHERE unit_id IN (...)` scoped to DESPL-320, never a schema rollback.

**Acceptance:** DESPL-320's 9 units each have exactly 54 `AssemblyStep` rows (486 total), grouped
A–Q in order; every weld-group step (E/G/H/J/K/L) carries the right `jointRef`; every step whose
`qcpSrNo` matches an existing `QcpItem` carries a non-null `qcpItemId`.

**Complexity:** M — mechanical once the department-per-group question is answered; the data
transcription (54 rows × verbatim spec text) is the bulk of the effort, not the logic.

---

### A6 (before A5's dependents) — reuse `assertStateTransition` for `AssemblyStep`

**Objective:** F8's generic transition helper (`src/lib/services/state-machine.ts` — already shipped
in Phase 1, comment at line 7 already names `AssemblyStep` as its third consumer) gets its third
caller. Start/Submit/Verify/Reject, department-scoped, maker–checker on verify and reject — the
exact shape of `component.service.ts` (read in full above), adapted for the two field differences:
`kind` (WORK vs INSPECTION) doesn't change the state machine, only what the submit form collects;
`weldJointId`/`qcpItemId` are bound, not entered as free text.

**Current implementation:** `component.service.ts` (full file, `src/lib/services/component.service.ts`)
is the direct template — `COMPONENT_OP_TRANSITIONS`, `lockComponentOperationForUpdate`,
`requireOperationDepartment`, `start`/`submit`/`verify`/`reject` functions. `AssemblyStep` has no
predecessor DAG requirement the way `ComponentOperation` does (its "previous op" is
`RouteStep.seq`) — for `AssemblyStep`, ordering gate is `AssemblyTemplateStep.seq - 1` on the same
`unitId`, i.e. simpler than `component.service.ts`'s route-aware lookup, closer to a flat sequence
check.

**Required change:** new `src/lib/services/assembly.service.ts`:

- `ASSEMBLY_STEP_TRANSITIONS` — identical shape to `COMPONENT_OP_TRANSITIONS`
  (`start: NOT_STARTED→IN_PROGRESS`, `submit: IN_PROGRESS→SUBMITTED`, `verify: SUBMITTED→COMPLETE`,
  `reject: SUBMITTED→IN_PROGRESS`).
- `assertAssemblyStepTransition` — one-line wrapper via `assertStateTransition`, same as
  `assertComponentOpTransition`.
- `lockAssemblyStepForUpdate` — `FOR UPDATE` lock + tenant-scoped re-read (join through
  `unit.equipment.job.tenantId`) + previous-step lookup (`AssemblyStep` on the same `unitId` with
  `templateStep.seq = current.templateStep.seq - 1`) + `defaultDepartmentId` from the template step.
- `startAssemblyStep(actor, {assemblyStepId})` — same shape as `startComponentOperation`, gate:
  previous step (if any) must be `COMPLETE`.
- `submitAssemblyStep(actor, {assemblyStepId, performedByWelderId?, performedByUserId?, remarks?})`
  — for WORK steps whose template step carries `jointRef`, submission requires (schema-enforced,
  see below) either an existing `weldJointId` already logged via the Welding page for this
  unit/job, or inline joint fields (`jointType`, `weldSize?`, `wpsRef?`, `welderIds`) which get
  created via a new shared helper extracted from `welding.service.ts`'s `logWeldJoint` (rename its
  body to `createWeldJointTx(tx, actor, jobId, unitId, componentId, fields)`, called from both the
  existing `logWeldJoint` action and this one — no duplicated joint-creation logic). Either path
  sets `AssemblyStep.weldJointId`.
- `verifyAssemblyStep(actor, {assemblyStepId})` — same maker–checker shape as
  `verifyComponentOperation`. For INSPECTION steps with a bound `weldJointId`, verify does **not**
  auto-create an `NdtResult` — that stays QC's separate explicit action via the existing
  `recordNdtResult` (A4 wires the two together for display, not by coupling the writes).
- `rejectAssemblyStep(actor, {assemblyStepId, categoryId, detail?})` — same shape as
  `rejectComponentOperation`, writes `AssemblyStepRejection` instead of
  `ComponentOperationRejection`. If the step has a bound `weldJointId`, this is where "PAUT/TOFD
  reject shows against the welder's repair rate" becomes true: the reject flow additionally requires
  (schema) a `testTypeId` and calls the same NDT-recording path with `result: "REJECT"` — so a
  reject on an NDT-kind step is one action, not two, from the QC user's side, while still landing in
  the same `NdtResult` table `welding.read.ts`'s repair-rate calc already reads.

New zod schemas in `src/lib/shared/schemas.ts`, next to the `ComponentOperation` block:
`startAssemblyStepSchema`, `submitAssemblyStepSchema` (with the weldJoint union described above —
`.strict()`, discriminated by presence of `weldJointId` vs the inline-joint fields), `verifyAssemblyStepSchema`,
`rejectAssemblyStepSchema` (base fields + optional `testTypeId` for NDT-kind steps).

**Files affected:** `src/lib/services/assembly.service.ts` (new),
`src/lib/services/welding.service.ts` (extract `createWeldJointTx`), `src/lib/shared/schemas.ts`,
`src/app/actions/assembly.ts` (new Server Actions, mirrors `src/app/actions/component.ts`'s shape).

**Schema change / migration:** none — consumes A1's tables.

**API / server-action change:** four new Server Actions
(`startAssemblyStepAction`/`submitAssemblyStepAction`/`verifyAssemblyStepAction`/
`rejectAssemblyStepAction`), thin wrappers per repo convention (business rules stay in the service).

**Frontend change:** none in this item — A6 (below) wires the UI.

**Tests:** `assembly.service.test.ts`, table-driven, mirroring `component.service.test.ts`'s shape —
every violation case: out-of-sequence start, wrong department, maker–checker on verify and on
reject (submitter cannot reject/verify own work), reject without a reason category, cross-tenant
access on `assemblyStepId`, submitting a `jointRef` step with neither an existing joint nor inline
joint fields (should be a `VALIDATION_FAILED`, not a silent skip).

**Rollback:** new file, no shared code touched except the `welding.service.ts` extraction — revert
by reverting that one commit; `logWeldJoint`'s external behaviour is unchanged by the extraction
(covered by `welding.service.test.ts`'s existing tests, which must still pass unmodified).

**Acceptance:** starting step 2 before step 1's `COMPLETE` is refused `GATING_BLOCKED`; verify/reject
enforce maker–checker; a WORK step with `jointRef` cannot be submitted without a joint bound.

**Complexity:** L — the largest single item, but almost entirely a scaled copy of proven Phase 1
code, not new design.

---

### A5 — Welder registry CRUD

**Objective:** give `Welder` its first write path — today only seedable (addendum §2, "no write
path at all").

**Current implementation:** `Welder` (`schema.prisma:1141-1160`) has every field A5 needs already
(`name`, `employeeCode`, `active`, `departmentId`) — this is schema-complete, write-path-empty, the
same shape Phase 1 found for `ComponentOperation.reject` before F5.

**Required change:** `createWelder`/`updateWelder`/`deactivateWelder` in a new
`src/lib/services/welder.service.ts` (small enough not to bloat `welding.service.ts`, but same
file-per-domain convention). `createWelder`/`updateWelder`: `requireRole(actor, ROLES.ADMIN,
ROLES.PRODUCTION_HEAD)` (registry-level data, not a floor action — matches how `Department`/
`OperationRef` vocabulary edits are gated elsewhere... **verify this against the actual admin
service's role gate before implementing**, noted here as an assumption, not a confirmed fact).
`deactivateWelder` sets `active: false` — never a hard delete (append-only spirit; a deactivated
welder's historical `ComponentOperation`/`AssemblyStep`/`WeldJointWelder` rows must keep resolving).
`@@unique([tenantId, employeeCode])` already enforces no duplicate codes; service surfaces that as
`VALIDATION_FAILED` with a readable message, not a raw Postgres constraint error.

**Files affected:** `src/lib/services/welder.service.ts` (new), `src/lib/shared/schemas.ts`
(`createWelderSchema`/`updateWelderSchema`/`deactivateWelderSchema`), `src/app/actions/welder.ts`
(new).

**Schema change / migration:** none.

**API / server-action change:** three new Server Actions.

**Frontend change:** a welder-management panel — smallest reasonable home is a new tab or section
on the Welding page (`src/app/(app)/welding/_client.tsx`, currently 342 lines covering joint-log +
NDT), not a new top-level route (avoids adding a sidebar item for a registry this small; revisit if
it grows). Table: name, employee code, department, active toggle, add/edit form.

**Tests:** `welder.service.test.ts` — duplicate employee code refused; non-admin/PH refused;
deactivate preserves historical FK references (a `ComponentOperation` still resolves
`performedByWelder` after its welder is deactivated).

**Rollback:** new file, no existing behaviour touched.

**Acceptance:** a welder can be created, edited (name/department), and deactivated in the app; an
inactive welder still shows correctly on historical records; a duplicate employee code is refused
with a readable error.

**Complexity:** S.

---

### A6 — Assembly UI

**Objective:** the A–Q sequence per unit, same action set as fabrication's `<BomPanel />`, weld
joints inline on weld steps, NDT results attached.

**Current implementation:** `src/components/industrial/bom-panel.tsx` (539 lines) is the direct
precedent — route-step list, Start/Submit/Verify buttons, inline submit form (operator/welder
select, remarks, qty), inline reject form (category + detail). `src/app/(app)/jobs/[id]/_client.tsx`
(`:37-146`) shows the tab-wiring pattern to copy (`?tab=assembly` alongside the existing
`overview|gantt|bom|qcp|activity|client`).

**Required change:**
- `src/lib/services/assembly.read.ts` (new) — projects `AssemblyStep` + `AssemblyTemplateStep` per
  unit into a `AssemblyGroup[]` (grouped by `groupCode`/`groupName`, ordered by `seq`), same shape
  `bom.read.ts` produces for the BOM tree; includes bound `WeldJoint`/`NdtResult`/`QcpItem` summary
  fields for display.
- `src/components/industrial/assembly-panel.tsx` (new) — collapsible group sections (A–Q), each row:
  status chip, Start/Submit/Verify/Reject per A6's service, WORK weld-group rows get the inline
  joint-log form (existing-joint picker OR inline create, per A6's schema), INSPECTION rows with a
  bound `weldJointId` show/allow recording an `NdtResult` (reuses the existing
  `recordNdtResultAction`, not a new one).
- Wire into `src/app/(app)/jobs/[id]/_client.tsx` (new `tab === "assembly"` branch) and
  `src/app/(app)/jobs/[id]/page.tsx` (fetch `assembly.read.ts`'s projection alongside `bom`/`qcp`,
  same pattern as the existing `Promise.all` of reads there).

**Files affected:** `src/lib/services/assembly.read.ts` (new), `src/components/industrial/
assembly-panel.tsx` (new), `src/app/(app)/jobs/[id]/_client.tsx`, `src/app/(app)/jobs/[id]/page.tsx`.

**Schema change / migration:** none.

**API / server-action change:** none new — wires A6's four actions plus the existing
`recordNdtResultAction`/`logWeldJointAction`.

**Frontend change:** as above. Keyboard-operable (repo convention), loading skeleton matching final
layout, empty state ("No assembly template pinned for this job's family yet" for a job whose
`assemblyTemplateVersionId` is null — real for every non-PRESSURE_VESSEL job until a template is
authored, not a hypothetical).

**Tests:** `assembly.read.ts` gets a pure projection test (grouping, ordering, join shape) mirroring
`bom-route.test.ts`. No component-level UI test framework exists in this repo today (confirmed by
absence in the file listing) — verified live in the browser instead, per CLAUDE.md's frontend rule
and the Agent-conduct rule (real `/login`, never a forged session).

**Rollback:** new files + one new tab branch; revertible without touching `bom`/`qcp` tabs.

**Acceptance (from the phase brief, verbatim):**
- Unit 320SR01 shows all 54 assembly steps in order, grouped A–Q, document gate through MDR, no
  group collapsed into a single summary row.
- Logging weld LS-1 records its welders and appears on the assembly step and in the welding module.
- A PAUT/TOFD reject on LS-1 shows against the welder's repair rate and flags the step.
- Pre-PWHT clearance, heat treatment, post-PWHT NDT, hydrostatic test, painting, nameplate each
  individually startable/submittable/verifiable.
- An H-coded checkpoint not ACCEPTED still blocks its process completing (unchanged — this item
  doesn't touch `assertNoOpenHoldPoint`).
- A welder can be created, edited, deactivated in the app.
- Violation-case tests for out-of-sequence assembly steps and maker–checker on assembly verify.

**Complexity:** L.

---

## Sequencing

**A1 → A3 (same migration) → A2 → A5 (independent, can run parallel to A2) → A6-service (state
machine) → A6-UI.** A2 cannot start until A1's schema exists (needs `AssemblyTemplateStep` to seed
into); A6-service needs A2's data to test against meaningfully; A6-UI needs A6-service's actions to
call. A5 has no dependency on A1–A3 and can run in parallel with A2 if useful, but its UI slot (on
the Welding page) is small enough not to warrant splitting into its own session.

## Open input still needed before A2 can be authored for real

**Department-per-group mapping for the A–Q sequence** (which department owns document gates vs.
welds vs. heat treatment vs. hydro vs. paint vs. final documentation) — not previously asked, needed
for `AssemblyTemplateStep.defaultDepartmentId`. Flagging this now, before implementation, rather
than guessing a plausible-looking department code the way §0 rule 4 forbids. If the floor input
isn't available yet, the fallback is FABRICATION for all groups (matches how welding's
`fabricationDepartmentId` already defaults today) with `provisional`-style acknowledgement — worth a
one-line confirmation before I start on A2's data specifically, not the whole phase.

## Reporting at phase end (§0)

Will follow §0's exact template — what changed / why / files / schema / API / frontend / tests
added / tests executed + results / remaining limitations / risks / acceptance-criteria status per
item (implemented / partially implemented / UI-only / untested / blocked) / next recommended phase —
and update `progress.md` at the top per the session-discipline convention.
