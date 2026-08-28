# Phase 4 — BOM, materials and procurement — Implementation Plan

> Produced per `docs/PHASE-PROMPTS.md` §0/§5. Per-item format follows §0 rule 3 exactly
> (objective · current implementation · required change · files · schema/migration ·
> API/action change · frontend change · tests · rollback · acceptance · complexity).
> **STOP — awaiting approval before any code is written**, per the phase-prompt contract.

**Spec:** `docs/PHASE-PROMPTS.md` §5 (B1–B10), `docs/AUDIT-master-engineering-review-v1.md` §5
(Domain verdicts — BOM/materials/traceability/drawings rows), §7 (REDESIGN list), §9 (Roadmap
Phase 1's target chain). **Doc-drift note (§0 rule 4):** the brief cites "audit §10, §13" — the
current audit doc only has 11 numbered sections (§10 is "Open questions that block correctness",
which contains nothing specific to BOM/materials; there is no §13). Believing the code/doc as it
stands today rather than the stale cross-reference, per §10's own operating note ("believe the
code... a disagreement is information, not a stop").

**Goal:** `bomItemId` becomes non-null wherever traceability matters, quantities become real
(`Decimal` + `uom`, not a free-text string), procurement and stock become an append-only ledger
that can compute shortage instead of storing a typed status, drawings are versioned rows instead of
a mutated single field, and `startProcess`/`startComponentOperation` gain the kit-readiness gate
that makes `CLAUDE.md` invariant #2's material clause literally true.

## Scope call, made before planning items (§0 rule 4 — flagging up front, not discovering mid-build)

**B4's "master catalog" is descoped from this phase.** The brief lists three BOM-authoring modes:
manual add/edit, spreadsheet import, master catalog. Manual add/edit and spreadsheet import are
both scoped below (B4). "Master catalog" — a cross-job library of standard parts to pull from — has
no spec, no floor input on what belongs in it, and the closest existing mechanism
(`copyBom`, cloning an entire equipment's BOM into a new one) already covers the "reuse what we
built before" need this phase's acceptance criteria actually test. Building a speculative catalog
UI now would be exactly the kind of unrequested feature §0 forbids. Flagged here per the Phase 2
plan's own precedent (A7/A8 were flagged, not silently dropped); can become its own work item once
someone names what "catalog" means for DESPL.

**B6/B7 (`StockLot`/`StockTxn`, kit-readiness gate) follow the existing SEAM pattern**, the same one
`assertNoOpenHoldPoint`, `assertComponentOpsComplete` and `TemplateProcess.provisional` already use:
no stock data recorded for a `BomItem` → the gate does not block. This is not a shortcut around the
acceptance criterion — it is the same governing principle already in the codebase (`lib/schedule/`
"refuses to compute rather than inventing dates"; here, refusing to invent a shortage where nothing
was ever received or issued). Once DESPL starts logging receipts/issues for a part, the gate engages
for that part immediately, no code change.

**B9 needs a link the current schema doesn't have** — which component's fabrication is gated by
which drawing's revision. `AssemblyDrawing` today is job-scoped only (`jobId`), no link to any
`Component`. Rather than guess a DESPL-320-shaped rule (e.g. "the GA drawing always gates the
shell"), this plan adds `Component.governingDrawingId` — nullable, **set by whoever authors the
component's route/BOM link, not auto-derived** — same judgment call already made for
`WeldJoint.componentId` in Phase 2 (A3) for the identical reason (§0 rule 1: no literal, no
job-specific inference in code). Null stays a no-op (SEAM), so DE0463/DE0467 (no components wired to
drawings today) are unaffected.

---

## Global constraints (carried from CLAUDE.md / §0 — apply to every item below)

- No client timestamps; every `receivedAt`/`issuedAt`/`releasedDate`/`builtToRevisionId`-stamp
  moment is server-clock only.
- Every mutation inside `withTenant()`, audit row via `audited()` in the same transaction.
- Anchor every new child-table lookup through a tenant-scoped parent (`_shared.ts:264-286` pattern) —
  `BomItem`, `Procurement`, `MaterialIdentification`, `AssemblyDrawing` all currently carry no
  `tenant_id` and rely on this convention exactly like the audit's C3 finding described for other
  tables.
- No new literal in `src/` — DESPL-320's BOM/drawing content stays in `seed/*.json` / imported data,
  never a branch.
- Forward-only migrations; never edit an applied one. Zero rows today in every touched table
  (`BomItem`, `Procurement`, `MaterialIdentification` are non-zero — see per-item backfill notes),
  so backfill strategy is called out per item, not assumed.
- Table-driven violation-case tests for every new gate/state-machine/RBAC/audit path.
- Reuse existing error codes where the shape matches (`NOT_FOUND`, `VALIDATION_FAILED`,
  `FORBIDDEN`, `GATING_BLOCKED`); this phase needs exactly two new ones — `MATERIAL_NOT_AVAILABLE`
  (B7) and `DRAWING_NOT_RELEASED` (B9) — because neither existing code names the right refusal.
- `Component.parentComponentId` (F7b) and `ComponentOperation.qtyPlanned/qtyGood/qtyRejected` (F4)
  **already exist** — verified in the current schema, not re-added.

---

## Work items

### B1 — `BomItem` real quantities: `qtyPer Decimal` + `uom`, raw string kept as `sourceQty`

**Objective:** make quantity a number the system can do arithmetic on (shortage, explosion), while
keeping the source CSV text for import fidelity per the brief.

**Current implementation:** `prisma/schema.prisma:901` — `qty String` (e.g. `"40 NOS."`), read by
exactly one `<dd>` in the BOM tab (`bom.read.ts` → `BomItemRow.qty`). No numeric field anywhere.

**Required change:**
- Rename `BomItem.qty` → `BomItem.sourceQty` (same column, `@map("qty")` stays so the rename is
  Prisma-model-only — no data movement needed for that half).
- Add `qtyPer Decimal @db.Decimal(12, 3)` (nullable — not every historical row can be parsed) and
  `uom String?`.
- Backfill script parses `sourceQty` with one regex (`/^(\d+(?:\.\d+)?)\s*(.*)$/`) into
  `qtyPer`/`uom` for every existing row; anything that doesn't match (free text like "As required")
  is left `qtyPer: null` — never guessed.

**Files:**
- `prisma/schema.prisma:892-916` (`BomItem`)
- New migration `prisma/migrations/<ts>_bom_item_qty_per_uom/migration.sql`
- New one-off `scripts/backfill-bom-item-qty-per.ts` (same shape as Phase 3's
  `scripts/backfill-assembly-step-lead-time-process-seq.ts` — idempotent, re-runnable)
- `src/lib/services/bom.read.ts` (`BomItemRow` gains `qtyPer`/`uom`, keeps `sourceQty` for display)
- `src/components/industrial/bom-panel.tsx` (render `qtyPer uom` when present, fall back to
  `sourceQty` when not — never show `null`)

**Schema/migration:** additive columns + one rename, both safe on non-empty tables (rename preserves
data; new columns default null). Runs on `despl_demo`'s live `bom_items` rows.

**API/action change:** none new — `bom.read.ts` is a read model, no server action changes shape.

**Frontend change:** BOM tab quantity cell shows `qtyPer uom` (e.g. "40 NOS") when parsed, else the
raw `sourceQty` string, unchanged from today.

**Tests:** `bom.read.test.ts` — row with parsed `qtyPer`/`uom` renders numeric, row with unparsed
`sourceQty` falls back and does not throw. Backfill script: pure unit test on the regex against the
real seed's actual `qty` strings pulled from `despl_demo` as fixtures (not invented strings).

**Rollback:** drop the two new columns; `sourceQty` rename reverts to `qty` in a follow-up migration.
No destructive data loss either direction.

**Acceptance:** every `BomItem` row in DESPL-320's seed shows a parsed `qtyPer`/`uom` in the BOM tab
(11 components' worth are well-formed "N NOS." strings per the addendum's own citations).

**Complexity:** S (small) — one migration, one backfill script, two read/render touch points.

---

### B2 — `BomItem.parentBomItemId` (self-referencing FK)

**Objective:** give the BOM a real tree instead of `GROUP BY componentType.name` (audit §5:
"REDESIGN... tree is a `GROUP BY`"). This is the multi-level hierarchy B3's explosion walks.

**Current implementation:** flat list, `bom.read.ts` groups by `ComponentTypeRef.name` purely for
display; no parent/child relationship stored anywhere.

**Required change:** add `parentBomItemId Int? @map("parent_bom_item_id")`, self-relation
`"BomItemHierarchy"`, same shape as `Component.parentComponentId` (F7b) added in Phase 1. Nullable,
additive, zero rows affected by the FK itself (every existing row's parent stays null — no attempt
to infer a hierarchy from today's flat CSV import, which has no parent signal).

**Files:** `prisma/schema.prisma:892-916`; new migration
`prisma/migrations/<ts>_bom_item_parent_id/migration.sql`.

**API/action change:** B4's create/update actions (below) accept an optional `parentBomItemId`.

**Frontend change:** none yet on its own — B4's authoring UI is the first writer, B3's explosion is
the first reader. Bundled into the same migration as B1 to avoid a second near-empty migration.

**Tests:** schema-level only here (FK constraint, self-reference cycle prevention deferred to B4's
input validation — reject if `parentBomItemId` would create a cycle by walking up before saving).

**Rollback:** drop the column/FK; no data loss (nothing depends on it yet).

**Acceptance:** a `BomItem` can reference another `BomItem` as its parent; B3's explosion can walk
the chain.

**Complexity:** XS — one nullable FK column, folded into B1's migration.

---

### B3 — `BomRevision` + qty explosion

**Objective:** "shortage is a computed number, never typed" needs a *required* quantity to compare
stock against. Today there is no revision concept and no computed total — B1 gives per-row qty, B2
gives the tree, B3 turns the tree into one number per part, per job.

**Current implementation:** none. `Procurement.status`/`receivedStatus` are hand-typed enums with no
relationship to how much is actually needed (audit §5: "`PARTIALLY_RECEIVED` carries no number").

**Required change:**
- `BomRevision` model: `id, equipmentId, revisionNo, status (DRAFT|RELEASED), releasedAt, createdBy`.
  One equipment can have many revisions over time (invariant #9's versioning pattern — a new
  revision is a new row, never an edit to a released one). `BomItem` gains `bomRevisionId Int?`
  (nullable during migration — every existing row is backfilled onto one auto-created "Revision 1,
  RELEASED" row per equipment, since the seed data has always been the de-facto released BOM).
- Pure function `explodeBomItem(bomItem, unitCount): Decimal` in a new
  `src/lib/services/bom-explosion.ts` — walks `parentBomItemId` up to the root, multiplying
  `qtyPer` at each level, then × `unitCount` (the equipment's `Unit` row count — DESPL-320's is 9,
  DE0463's is 40). Pure, no Prisma calls inside the walk itself (same "pure core, thin caller"
  shape as `lib/schedule/`) — takes an already-loaded `Map<bomItemId, BomItem>` so it's unit-testable
  without a DB.
- `requiredQty(bomItemId)` wrapper in `bom.read.ts` that loads the map once per equipment and calls
  the pure function — this is what B6's shortage calc and B7's kit-readiness gate both call.

**Files:**
- `prisma/schema.prisma` — new `BomRevision` model, `BomItem.bomRevisionId`
- New migration `prisma/migrations/<ts>_bom_revision/migration.sql` + backfill (same transaction:
  create one `BomRevision` per distinct `equipmentId` in `bom_items`, status `RELEASED`, then set
  every existing row's `bomRevisionId` to it — safe because every current row is real, shipped data)
- `src/lib/services/bom-explosion.ts` (new, pure)
- `src/lib/services/bom.read.ts` (`requiredQty` wrapper, used by B6)

**Tests:** `bom-explosion.test.ts` — table-driven: flat item (no parent) × unit count; nested
2-level item (sub-assembly qty 2 × bolt qty 4 per sub-assembly × 9 units = 72); cycle guard (a
malformed `parentBomItemId` chain throws rather than infinite-looping — defensive, since B4's create
path is supposed to prevent cycles but a bad direct DB write shouldn't hang the reader).

**Rollback:** drop `BomRevision` + the FK column; `bom.read.ts` reverts to reading `BomItem` with no
revision filter (data loss limited to the revision grouping itself, not the underlying rows).

**Acceptance:** `explodeBomItem` on a real DESPL-320 row returns the same number as manually
multiplying `qtyPer × unitCount` by hand.

**Complexity:** M — new model + backfill migration + one pure module with real test coverage.

---

### B4 — BOM authoring: manual add/edit + spreadsheet import

**Objective:** today's only write path is `copyBom` (clone from an existing equipment at intake).
Give BOM items a direct create/edit path and a CSV/XLSX import, so a part list doesn't require
inventing a donor equipment first.

**Current implementation:** `job-intake.service.ts:515` `copyBom` is the only writer.
`src/app/actions/bom.ts` only has `recordMtcAction`. No `bom.service.ts` exists.

**Required change:**
- New `src/lib/services/bom.service.ts`: `createBomItem`, `updateBomItem` (both audited, tenant-
  anchored through `equipment.job.tenantId` exactly like `recordMtc` already does at
  `mtc.service.ts:29-34`), `importBomItems(actor, equipmentId, rows)` for bulk CSV import.
- Zod schemas in `src/lib/shared/schemas.ts`: `createBomItemSchema`/`updateBomItemSchema` — `.strict()`,
  no `*_at` fields (invariant #1 — `createdAt` etc. are server-set if ever added). Cycle check on
  `parentBomItemId` lives in the service, not the schema (needs a DB read).
- Import reuses the **already-installed** `xlsx` dependency (used today by
  `api/jobs/[id]/qcp/export/route.ts`) to parse an uploaded `.xlsx`/`.csv` — no new dependency,
  per the ladder's rung 5.
- New Server Actions in `src/app/actions/bom.ts`: `createBomItemAction`, `updateBomItemAction`,
  `importBomItemsAction`.

**Files:**
- `src/lib/services/bom.service.ts` (new)
- `src/lib/shared/schemas.ts`
- `src/app/actions/bom.ts`
- `src/components/industrial/bom-panel.tsx` — add-row / edit-row affordance (inline, matching the
  existing panel's row-action pattern, not a new page) + an "Import…" button opening a file picker
  that posts to `importBomItemsAction`

**API/action change:** three new Server Actions, all role-gated (same role the brief's "BOM
authoring" implies — `PRODUCTION_HEAD`/`ADMIN`, matching `createEquipmentType`'s existing gate, not
a new role).

**Frontend change:** `BomPanel` gains inline add/edit for a row and an import control. No new route.

**Tests:** `bom.service.test.ts` — create/update happy path; cycle rejection
(`parentBomItemId` pointing at own descendant refused); cross-tenant create refused (anchors through
`equipment.job.tenantId`, same negative-suite shape Phase 0's 0.3 established); import with one
malformed row reports which row failed rather than silently dropping it or aborting the whole batch.

**Rollback:** the new actions/service are additive; disabling them (removing the UI affordance)
leaves `copyBom` as the sole write path, exactly today's state.

**Acceptance:** a BOM item can be added by hand, edited, and bulk-imported from a spreadsheet; the
existing `copyBom` intake path is unchanged.

**Complexity:** M — new service file, three actions, inline UI, one import parser reusing `xlsx`.

---

### B5 — `ProcurementEvent` (append-only, with quantity), replacing the mutable `Procurement` row

**Objective:** `Procurement.receivedStatus` is a hand-typed enum with no quantity —
`PARTIALLY_RECEIVED` is asserted, never counted. Make receipt an append-only ledger, matching the
architecture's own `AuditLog`/`DomainEvent` precedent, and let "received so far" be a sum instead of
a claim.

**Current implementation:** `prisma/schema.prisma:918-934` — one `Procurement` row per `BomItem`,
mutated in place (`indentDate`, `poDate`, `receivedDate`, `receivedStatus` all overwritten on each
update). No writer exists in `src/` today outside seed (audit §5 confirms: read by zero services
outside `bom.read.ts`).

**Required change:**
- New `ProcurementEvent` model: `id, bomItemId, type (INDENT_RAISED|INDENT_APPROVED|PO_PLACED|
  RECEIPT), qty Decimal? (only meaningful on RECEIPT), refNo String? (indent/PO number, reuses the
  slot `Procurement.indentNo`/`poNo` held), at DateTime @default(now()), by Int` — append-only, no
  update/delete path (same convention as `audit_log`, enforced the same way: the app DB role gets no
  UPDATE/DELETE grant on this table — add it to whatever migration/script manages those grants).
- `Procurement` becomes a derived read, not a stored row: `bom.read.ts` computes
  `receivedQty = sum(ProcurementEvent where type=RECEIPT)`, `status` from the latest event's `type`,
  dates from each event's own `at`. The existing `Procurement` table and model are dropped once the
  read model is repointed — not kept as a second, driftable source of truth (this is the "replacing",
  not "alongside", reading of the brief, and matches the REDESIGN verdict rather than leaving two
  places to update).
- Backfill: for every existing `Procurement` row, synthesize one `ProcurementEvent` per non-null
  date field it carries (`indentDate`→INDENT_RAISED, `approvedDate`→INDENT_APPROVED,
  `poDate`→PO_PLACED, `receivedDate`→RECEIPT with `qty` = the `BomItem`'s `qtyPer` if
  `receivedStatus=RECEIVED`, else left null since "partially received" never had a number to recover)
  — a one-off script, not a migration-embedded `INSERT...SELECT`, so it can be reviewed before
  running against `despl_demo`.

**Files:**
- `prisma/schema.prisma` — new `ProcurementEvent`, remove `Procurement`
- New migration `prisma/migrations/<ts>_procurement_event/migration.sql`
- New `scripts/backfill-procurement-events.ts`
- New `src/lib/services/procurement.service.ts`: `recordProcurementEvent` (audited, tenant-anchored)
- `src/lib/services/bom.read.ts` — `BomItemRow.procurement` becomes a derived summary
  (`{status, receivedQty, requiredQty, events: [...]}` ) instead of a straight `Procurement` read
- `src/app/actions/bom.ts` — `recordProcurementEventAction`

**API/action change:** one new Server Action, role-gated to whoever owns procurement (PRODUCTION_HEAD/
ADMIN, same as B4).

**Frontend change:** BOM panel's procurement cell shows computed status + "N of M received" instead
of a bare enum chip; a small event log (same visual pattern `DelayReason` history already uses in
`StageSheet`) replaces the flat date fields.

**Tests:** `procurement.service.test.ts` — recording a RECEIPT event with qty accumulates correctly
across multiple partial receipts; status derivation table-driven (no events → NOT_STARTED, only
INDENT → INDENT_RAISED, etc.); cross-tenant write refused.

**Rollback:** riskier than most items here since it drops a table. Mitigate: keep the backfill
script's output in a reviewable dry-run mode (print what it would insert before writing) and take
this migration in its own PR/commit, separate from B1–B4, so it can be reverted independently if the
derived read model doesn't match what the floor expects.

**Acceptance:** "N of M received" is a real sum, not an asserted enum; `PARTIALLY_RECEIVED` has a
number behind it.

**Complexity:** L — drops and replaces a live table, needs a careful backfill, touches the read
model's shape.

---

### B6 — `StockLot` + `StockTxn`

**Objective:** give receipt and consumption a real ledger (part + heat + location + qty), so
shortage (B3's required qty vs. what's actually on hand) is computable instead of typed.

**Current implementation:** none. `MaterialIdentification` records a heat number but no quantity or
location; nothing tracks what's been issued to fabrication.

**Required change:**
- `StockLot`: `id, bomItemId, heatNumber String?, location String, qty Decimal, receivedAt
  DateTime, sourceProcurementEventId Int?` (links back to the B5 receipt that created it — nullable,
  since a lot can be logged for stock already on hand before this system existed).
- `StockTxn`: `id, stockLotId, type (ISSUE|RETURN|SCRAP), qty Decimal, at DateTime @default(now()),
  by Int, componentId Int?` (which component the issue went to — nullable, matching `WeldJoint.
  componentId`'s "set by whoever logs it" precedent), `note String?`.
  Receipt itself is `StockLot` creation, not a txn type — avoids a redundant paired row every time
  (rung 6 of the ladder: the simplest representation that's still correct).
- `availableQty(bomItemId)` in `bom.read.ts`: `sum(StockLot.qty where bomItemId) - sum(StockTxn.qty
  where type IN (ISSUE, SCRAP)) + sum(StockTxn.qty where type = RETURN)`.
  **Superseded — do not restore this formula.** The final whole-branch review (see the SDD ledger)
  found this arithmetic wrong: `ISSUE` is consumption *into* the product, not loss, so deducting it
  makes issuing material to production manufacture a false shortage that blocks all further work on
  that part. The shipped formula is `sum(StockLot.qty) - sum(StockTxn.qty where type = SCRAP)` only
  — `ISSUE`/`RETURN` are no-ops for shortage purposes. See `computeAvailableForShortage` in
  `src/lib/services/bom-explosion.ts` for the corrected, single-source-of-truth implementation.
- `shortage(bomItemId, unitCount) = requiredQty(bomItemId, unitCount) - availableQty(bomItemId)`
  (B3's pure function + this one, both in `bom.read.ts`, clamped at 0 for display — a negative
  shortage is surplus, shown as such, not hidden).

**Files:**
- `prisma/schema.prisma` — new `StockLot`, `StockTxn` models
- New migration `prisma/migrations/<ts>_stock_lot_txn/migration.sql`
- New `src/lib/services/stock.service.ts`: `receiveStock` (creates `StockLot`, optionally linked to
  a `ProcurementEvent`), `issueStock`/`returnStock`/`scrapStock` (create `StockTxn`, refuse if it
  would drive available below zero — a real inventory guard, not a display-only warning)
- `src/lib/services/bom.read.ts` — `availableQty`/`shortage` helpers
- `src/components/industrial/bom-panel.tsx` — shortage shown as a computed number next to required
  qty, same status-color convention as everywhere else (`--s-hold`/`--s-overdue` tint, never plain
  text)

**Tests:** `stock.service.test.ts` — receive then issue reduces available; issuing more than
available is refused; scrap and return both move the number correctly; table-driven shortage calc
against B3's explosion output.

**Rollback:** additive tables; dropping them removes the shortage number, `bom.read.ts` falls back
to B3's required-qty-only display (no available/shortage column).

**Acceptance:** shortage for a real DESPL-320 part with logged receipts/issues matches a hand
calculation; a part with no stock activity shows no shortage claim (SEAM — not "0 available", which
would be a false claim, but "not tracked").

**Complexity:** M — two new models, one service, arithmetic-only read helpers (no state machine).

---

### B7 — Kit readiness gates work release

**Objective:** `startProcess`/`startComponentOperation` gain the fourth gate `CLAUDE.md` invariant
#2 has always claimed exists. This is what turns B6's shortage number into an actual refusal.

**Current implementation:** `process.service.ts:102-119` `startProcess` runs three gates
(department scope, unfiled-delay block, predecessor DAG) and no material check — confirmed absent,
matching audit §5's "Correct the doc before someone demos it" finding. `component.service.ts`'s
`startComponentOperation` has the equivalent three-gate shape with no fourth gate either.

**Required change:**
- `assertKitReady(tx, componentId, tenantId)` in `_shared.ts`, same signature shape as
  `assertNoOpenHoldPoint`/`assertComponentOpsComplete`. Walks the component's `bomItemId` (SEAM:
  null → no-op, nothing to check); if set, computes B6's `shortage`. Throws
  `MATERIAL_NOT_AVAILABLE` naming the short part and quantity when shortage > 0; no-ops when the
  part has zero recorded stock activity at all (not the same as zero available — "never tracked"
  stays silent, "tracked and short" blocks, exactly the SEAM principle stated in the scope-call
  section above).
- Wire into `startComponentOperation` (component.service.ts) — this is the grain where a `BomItem`
  link actually exists (`Component.bomItemId`); `ProcessPlan`/`JobProcess` have no direct BOM link,
  so `startProcess` itself is not gated directly. This is a deliberate, narrower reading of B7 than
  "every process start" — flagged here per §0 rule 4, not discovered mid-build: gating at the
  operation grain is where the data lives, and Phase 3's rollup already surfaces component-op
  blockage up through the stage the same way `COMPONENT_OPS_INCOMPLETE` does.

**Files:**
- `src/lib/services/_shared.ts` (new `assertKitReady`, alongside `assertComponentOpsComplete`)
- `src/lib/services/component.service.ts` (`startComponentOperation`, wire the new gate)
- `src/lib/shared/errors.ts` (`MATERIAL_NOT_AVAILABLE` code + message)
- `src/app/api/_lib.ts` (409 status mapping, same tier as `GATING_BLOCKED`)

**API/action change:** `startComponentOperationAction` can now return `MATERIAL_NOT_AVAILABLE`; the
existing toast-refusal UI path (already generic over error codes) needs no new component, just the
new code's message.

**Frontend change:** none beyond the existing generic error-toast rendering already used for every
other refusal code.

**Tests:** `component.service.test.ts` — violation case: component's `bomItem` has shortage > 0,
start refused naming the part; component's `bomItem` has adequate stock, start succeeds; component
with no `bomItemId` or no stock activity at all, start succeeds unchanged (SEAM regression guard —
this is the case most likely to accidentally regress into "block everything").

**Rollback:** remove the `assertKitReady` call from `startComponentOperation`; the gate function
itself can stay dead code or be deleted, no data implication either way.

**Acceptance:** starting a component operation whose part is recorded short is refused, naming what's
missing; the same operation on an untracked or well-stocked part is unaffected.

**Complexity:** M — one new gate function (SEAM pattern, low risk) + wiring + violation tests.

---

### B8 — `MaterialIdentification` moves to `componentId`, gains `qtyIssued`

**Objective:** heat/MTC traceability currently attaches one level above the serial
(`BomItem`, shared across every unit of an equipment) — DE0463's one plate line covers 40 vessels
with a single heat record. Move it to `Component` (already unit-scoped, per Phase 1's `Component.
unitId`) so a heat number traces to the actual serial it entered.

**Current implementation:** `prisma/schema.prisma:938-950` — `MaterialIdentification.bomItemId`,
no `componentId`, no quantity. `recordMtc` (`mtc.service.ts:18-53`) writes against `bomItemId` only.

**Required change:**
- Add `MaterialIdentification.componentId Int? @map("component_id")` (nullable during transition —
  DE0463/DE0467 equipment have `Component.unitId = null` today per `bom.read.ts`'s own doc comment,
  so a heat record on those jobs genuinely has no single component to attach to and stays at
  `bomItemId` grain; DESPL-320's seeded components make the new field meaningful there).
- Add `qtyIssued Decimal?` — how much of this heat went into this component, mirroring B6's `StockTxn`
  shape but scoped to the traceability record rather than the generic ledger (a heat record answers
  "which heat, how much, on which serial"; `StockTxn` answers "how much stock moved, when" — related
  but not the same fact, so not collapsed into one table).
- `recordMtc` accepts an optional `componentId`; when supplied, anchors the tenant check through
  `component.equipment.job.tenantId` instead of `bomItem.equipment.job.tenantId` (same shape,
  different join root).
- Forward trace: "one heat traces forward to every serial it entered" = every
  `MaterialIdentification` row sharing a `heatNumber`, joined to their `componentId`s, i.e. a plain
  `groupBy` in `bom.read.ts` — no new model needed for this half of the acceptance criterion.
- Backward trace: "one serial traces back to every heat in it" = every `MaterialIdentification` row
  for a given `componentId` (or, for the un-migrated `bomItemId`-only rows, every `Component` under
  that `bomItemId`) — same read, reversed filter.

**Files:**
- `prisma/schema.prisma` — `MaterialIdentification` gains `componentId`, `qtyIssued`
- New migration `prisma/migrations/<ts>_material_identification_component/migration.sql`
- `src/lib/shared/schemas.ts` — `recordMtcSchema` gains optional `componentId`
- `src/lib/services/mtc.service.ts` — `recordMtc` anchors through `componentId` when present
- `src/lib/services/bom.read.ts` — new `heatTrace(heatNumber)` / `componentHeats(componentId)`
  read helpers
- `src/components/industrial/bom-panel.tsx` — MTC row gains a "traces to" link when `componentId`
  is set

**Tests:** `mtc.service.test.ts` — recording against a `componentId` anchors tenant check correctly
(cross-tenant `componentId` refused); recording against `bomItemId` only (legacy path) still works
unchanged; `heatTrace`/`componentHeats` return the right rows for a synthetic multi-component heat
fixture.

**Rollback:** `componentId`/`qtyIssued` stay nullable; removing them drops only the new traceability
detail, not the existing `bomItemId`-grain records.

**Acceptance:** for a DESPL-320 heat number recorded against multiple components, forward trace
lists every one of them; each component's page shows every heat that went into it.

**Complexity:** M — additive schema change, service anchor-path branch, two new read helpers.

---

### B9 — `DrawingRevision` as child rows; gate cutting on RELEASED

**Objective:** stop mutating `AssemblyDrawing.revisionNo`/`status` in place (destroys Rev A per
audit §5), and make `RELEASED` actually gate something, per invariant #9's versioning pattern.

**Current implementation:** `prisma/schema.prisma:1543-1560` — one row per drawing, `revisionNo`/
`status`/`approvedDate`/`releasedDate`/`revisedDate` all flat fields, overwritten on each revision.
Zero readers/writers outside seed and tests (confirmed by grep — audit's "REDESIGN... RELEASED gates
nothing" is accurate as of today).

**Required change:**
- New `DrawingRevision` model: `id, assemblyDrawingId, revisionNo, status (DRAFT|RELEASED|
  SUPERSEDED), releasedAt, createdAt @default(now())`. `AssemblyDrawing` keeps its identity fields
  (`jobId`, `drawingTypeId`, `drawingNo`) and drops `revisionNo`/`status`/`approvedDate`/
  `releasedDate`/`revisedDate` (moved onto the revision rows — this table has zero real rows in
  `despl_demo` today, confirmed by the audit's "zero readers, zero writers" finding, so this is a
  clean model change, not a backfill migration).
- `Component.governingDrawingId Int? @map("governing_drawing_id")` (nullable FK to
  `AssemblyDrawing`, judgment call explained in the scope-call section above) and
  `Component.builtToRevisionId Int? @map("built_to_revision_id")` (nullable FK to `DrawingRevision`,
  server-stamped — see below).
- `component.service.ts`'s `startComponentOperation`: when the operation's `OperationRef` is
  `CUTTING` and the component has a `governingDrawingId`, require that drawing's current (highest
  `revisionNo`) `DrawingRevision.status = RELEASED`; refuse with `DRAWING_NOT_RELEASED` naming the
  drawing and its current status otherwise. On success, stamp `Component.builtToRevisionId` to that
  revision's id (server-clock/server-derived, same invariant #1 discipline as `actualStart`) — this
  is what answers "units record which revision they were built to."
- New `src/lib/services/drawing.service.ts`: `createDrawingRevision` (audited; if a prior revision
  on the same drawing was `RELEASED`, it flips to `SUPERSEDED` in the same transaction — never
  deleted, "Rev A intact and visible").

**Files:**
- `prisma/schema.prisma` — `DrawingRevision` new model, `AssemblyDrawing` field removal,
  `Component.governingDrawingId`/`builtToRevisionId`
- New migration `prisma/migrations/<ts>_drawing_revision/migration.sql`
- `src/lib/services/drawing.service.ts` (new)
- `src/lib/services/component.service.ts` (`startComponentOperation` gate + stamp)
- `src/lib/shared/errors.ts` (`DRAWING_NOT_RELEASED`)
- `src/app/api/_lib.ts` (409 mapping)
- `src/app/actions/bom.ts` or new `src/app/actions/drawing.ts` — `createDrawingRevisionAction`
- Minimal UI: a drawing revision list on the equipment/component view (reuses `StageSheet`'s history-
  list visual pattern) — no full drawing-management page, since nothing in this phase's acceptance
  criteria asks for one beyond "issuing Rev B leaves Rev A intact and visible."

**Tests:** `drawing.service.test.ts` — creating Rev B supersedes Rev A, both remain queryable;
`component.service.test.ts` — CUTTING refused when governing drawing's current revision isn't
RELEASED, succeeds and stamps `builtToRevisionId` when it is, unaffected when `governingDrawingId`
is null (SEAM regression guard, same shape as B7's).

**Rollback:** drop `DrawingRevision`, revert `AssemblyDrawing` fields, drop the two `Component`
columns and the gate call. Zero real data at risk (confirmed zero rows today).

**Acceptance:** issuing Rev B keeps Rev A queryable; starting Cutting on a component whose drawing
isn't RELEASED is refused; once released, the component records which revision it was built to.

**Complexity:** M — schema redesign of an already-dead table (low risk, no backfill) + one new gate.

---

### B10 — Missing actor FKs + partial unique index for null-grain `ProcessPlan`

**Objective:** close the remaining "~12 missing actor FKs" the brief names, and fix the unique
constraint that currently lets duplicate null-`unitId` `ProcessPlan` rows exist (Postgres treats
`NULL <> NULL`, so `@@unique([scheduleRunId, jobProcessId, unitId])` does not actually prevent two
unit-less plans for the same job process).

**Current implementation:** scanned the full schema for `*By`/`*ById` integer fields with no
`@relation` to `User` — found 15 candidates beyond `AuditLog.actorId`/`DomainEvent.actorId` (both
deliberately left FK-free, matching the append-only/decoupled-infrastructure convention those two
tables already follow — not a gap):

| Model | Field |
|---|---|
| `ScheduleRun` | `createdBy` |
| `ProcessPlan` | `submittedBy`, `verifiedBy` |
| `ComponentOperation` | `submittedBy`, `verifiedBy` |
| `ComponentOperationRejection` | `rejectedBy` |
| `WeldJoint` | `loggedBy` |
| `WeldLog` | `loggedBy` |
| `AssemblyStep` | `submittedBy`, `verifiedBy` |
| `AssemblyStepRejection` | `rejectedBy` |
| `QcpExecution` | `clearedBy` |
| `DelayReason` | `filedBy`, `reviewedBy` |
| `ProgressSnapshot` | `verifiedBy` |

**Required change:** add `@relation(fields: [X], references: [id])` + the matching `User?` relation
field for each row above (all nullable already, so this is FK-constraint-only, no data change).
`ProcessPlan`: replace `@@unique([scheduleRunId, jobProcessId, unitId])` with a plain unique on
`[scheduleRunId, jobProcessId, unitId]` for the non-null case plus a **partial unique index**
(`CREATE UNIQUE INDEX ... ON process_plans (schedule_run_id, job_process_id) WHERE unit_id IS NULL`,
raw SQL in the migration since Prisma's schema DSL can't express a partial index directly — same
mechanism the codebase already uses wherever a partial index exists, e.g. check
`v_process_plan_percent`'s migration for the raw-SQL precedent).

**Files:**
- `prisma/schema.prisma` — 15 new relation declarations + the `ProcessPlan` unique-index change
- New migration `prisma/migrations/<ts>_actor_fks_and_partial_unique/migration.sql`

**API/action change:** none — these are read-side relations and a constraint, no service logic
changes shape.

**Frontend change:** none directly; `StageSheet`/audit-history displays *can* now `include` the
actor's name instead of a bare id, but that's a nice-to-have follow-up, not required by this item's
acceptance criterion.

**Tests:** one DB-gated test asserting the partial unique index actually rejects a second null-`unitId`
`ProcessPlan` for the same `(scheduleRunId, jobProcessId)` — this is the regression test that proves
the fix, since the bug is invisible without hitting Postgres directly (pure/unit tests can't see
constraint enforcement).

**Rollback:** drop the 15 relations (FK constraints only, reversible with no data implication) and
revert the unique index to its current (broken) form.

**Acceptance:** a second `ProcessPlan` insert with `unitId: null` for an existing
`(scheduleRunId, jobProcessId)` pair fails at the DB, proven by a test that would pass today (i.e.
currently succeeds when it shouldn't).

**Complexity:** S — mechanical relation additions + one raw-SQL partial index + one regression test.

---

## Suggested execution order (not a re-ordering of the brief's B-numbers, just the dependency chain)

B1/B2 (schema, no dependents) → B3 (needs B1/B2) → B5 (independent of B1-B3, can run in parallel) →
B6 (needs B3's `requiredQty`, B5's `ProcurementEvent` for lot provenance) → B7 (needs B6) → B8
(independent) → B9 (independent) → B4 (authoring UI — last, since it's the write path for data the
other items just made meaningful) → B10 (mechanical, no dependency, can run anytime — doing it last
here only because it's the lowest-risk item to slot wherever time allows).

## Acceptance criteria (from the brief, mapped to the items that satisfy them)

- **"One heat number traces forward to every serial it entered; one serial traces back to every
  heat in it."** → B8.
- **"Shortage is a computed number, never typed."** → B3 (required qty) + B6 (available qty) +
  their combination in `bom.read.ts`.
- **"A work order cannot be released without its kit, and the refusal names what is missing."** →
  B7, narrowed to the component-operation grain per the flagged scope call above.
- **"Issuing Rev B of a drawing leaves Rev A intact and visible, and units record which revision
  they were built to."** → B9.

## Complexity summary

XS: B2 · S: B1, B10 · M: B4, B6, B7, B8, B9 · L: B5 · Descoped: B4's "master catalog" sub-item.
