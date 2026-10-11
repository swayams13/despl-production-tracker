PAUSE Phase 1 implementation. Do not write further Phase 1 code until this task is done
and I have approved the result. This is a DOCUMENTATION AND SCOPE task only.

## Why

DESPL-320 is the pilot being used to finalise the first manufacturing workflow. It is not the
product. The product is a multi-project, multi-product-family manufacturing operations and
traceability platform — Pressure Vessel, Heat Exchanger, Pipe Spool, Piping System today, more
later. I need that to be an explicit, enforced architectural constraint rather than an assumption.

## Read first — this is largely already documented

Some of this landed in the repo recently. Read these before writing anything, and **extend them
rather than writing a parallel statement of the same rule**:

- `docs/PHASE-PROMPTS.md` §0 "Generality: DESPL-320 is the calibration job, not the product"
- `docs/AUDIT-addendum-fabrication-and-assembly.md` §0b (family readiness table) and §2
  (the `AssemblyTemplate → Version → Step → AssemblyStep` design)
- `docs/AUDIT-master-engineering-review-v1.md` — the audit. **Preserve its findings.** Only touch
  what this clarification directly affects.
- `CLAUDE.md`, `docs/PRD.md`, `docs/TRD.md`, `docs/ARCHITECTURE.md`, `docs/BUILD-SPEC-v2.md`,
  and `docs/ADR-mobile-and-architecture-v1.md` (the repo's existing ADR format)

## Facts to verify before proposing anything

Check these in the schema first — I believe they are already true, and I do not want a proposal to
build something that exists:

1. `Job.familyId → ProductFamily`, with `PRESSURE_VESSEL`, `HEAT_EXCHANGER`, `PIPE_SPOOL`,
   `PIPING_SYSTEM` seeded. If so, the "project has a product type" concept already exists — say so.
2. `ProcessTemplate` → `ProcessTemplateVersion` → `TemplateProcess` is per family and versioned,
   and a job pins a version at intake.
3. `RouteTemplate` is `@@unique([tenantId, componentTypeId, familyId])` with a nullable `familyId`.
4. `QcpTemplate` supports library rows (`jobId: null`) and `createJob` accepts `qcpTemplateSourceId`.
5. Tenant RLS plus job scoping already give project independence for most tables.

Report which of these hold. Where the mechanism exists but the **authoring UI** does not — QCP
templates being the known case (PRD FR-M3) — say that plainly; it is the real barrier to onboarding
a new family, not the data model.

## What to write

**One document, not five.** Create `docs/ADR-product-family-agnostic-platform-v1.md` in the same
format as the existing ADR, covering:

- **Decision** — a common manufacturing core with product-family configuration and extension, not
  separate applications per product type, and not a pressure-vessel application.
- **Project → Product Type model** — `DESPL-320 / Pressure Vessel`, `HX-2027-001 / Heat Exchanger`,
  etc. Use the domain's existing names (`Job`, `ProductFamily`) rather than inventing new ones.
- **What is common core** — projects, customers, engineering, drawings and revisions, BOM and
  revisions, assemblies, components, quantities and UoM, materials, procurement, work orders,
  operations, work centres, production events, QC, NCR, rework, surface treatment, packing,
  dispatch, documents, notifications, audit and events, users, roles, permissions. Note that not
  every family needs every capability.
- **What varies by family** — BOM structure, component types and attributes, operations and their
  sequence, routing, QC and inspection plans, engineering documents, material requirements,
  production stages, product-specific measurements and compliance. State how each is expressed
  today: versioned process templates, family-scoped route templates, QCP template libraries,
  reference vocabularies (`OperationRef`, `ComponentTypeRef`), and `EquipmentTypeRef.defaultSpecs`.
- **The DESPL-320 rule** — DESPL-320 data belongs in `seed/`, `scripts/` and test fixtures.
  No job number, serial, customer, component tag, operation name, group code or family code may
  appear in `src/`. Note that `workspace/page.tsx` was the one violation and Phase 0 removed it.
- **Future-proofing, defined** — it does not mean building Heat Exchanger today. It means adding a
  family later requires authoring templates, routes and a QCP **as data**, with no change to
  authentication, RBAC, BOM, materials, work orders, production, QC, audit, documents or dispatch.
- **The standing acceptance test** — *"If we won an identical heat exchanger tomorrow, what code
  changes?"* Answer must be **none**. Apply it at every phase gate.
- **Consequences** — including the honest ones: more deliberate domain modelling, and the QCP
  authoring gap above.
- **Family readiness today** — `PRESSURE_VESSEL` complete; `PIPE_SPOOL` provisional (real sequence,
  no durations, scheduler correctly refuses); `PIPING_SYSTEM` and `HEAT_EXCHANGER` templateless.
  This is a data gap, not an engineering one.

Then make **minimal** edits elsewhere: link the ADR from `CLAUDE.md`, and correct any document that
states or implies the application is pressure-vessel-only or DESPL-320-only. Do not mass-replace
"DESPL-320" — it is correct wherever it names the pilot.

## Phase 1 scope — a decision I need from you, not a change you make

`docs/PHASE-PROMPTS.md` §2 currently scopes Phase 1 as fabrication tracking (~1.5 weeks) and puts
BOM hierarchy, revisions, materials and traceability in Phase 4.

Do **not** move Phase 4 into Phase 1 — that would delay the fabrication deliverable by weeks.

Instead, evaluate and propose only this: **which schema-shape changes are cheap now, while these
tables are near-empty, and expensive later?** My candidates are `BomItem.qtyPer Decimal` + `uom`,
`parentBomItemId`, `parentComponentId`, and the `@@unique([unitId, tag])` change already in Phase 1
as F7. Migration only — no authoring, no revisions, no explosion, no material logic, no UI. Tell me
which of these you would pull forward and which you would leave in Phase 4, with reasoning.

Then update Phase 1's acceptance criteria in `docs/PHASE-PROMPTS.md` §2 to add:

- DESPL-320 is represented as one `Job` of family `PRESSURE_VESSEL`, with nothing about it special-cased.
- Components and operations render from whatever route a component has — a 4-step pipe spool route
  works in the same UI as an 11-step plate route.
- Quantities carry a unit of measure.
- Nothing added this phase would need changing to run a heat exchanger.
- Two projects of different families can coexist with no shared mutable state beyond the tenant.

## Also do

Inspect the Phase 1 work completed so far and report any DESPL-320 or pressure-vessel assumption
that has already reached `src/`. Be specific with `file:line`. If there are none, say so — do not
manufacture findings.

## Output

A short report — not fifteen sections. Cover: which of the five facts above hold; the ADR you
created; the minimal edits you made elsewhere; your recommendation on which schema-shape changes to
pull into Phase 1; any DESPL-320 assumption found in `src/`; and what needs to be true before
Phase 1 resumes.

## Stop condition

No production code. No schema changes. No migrations. No UI work. No implementation of any product
family. Write the documentation, give me the report, and stop. Phase 1 resumes only when I approve.
