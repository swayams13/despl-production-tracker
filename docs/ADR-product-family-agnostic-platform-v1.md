# ADR — Product-Family-Agnostic Platform (v1)

**Date:** 2026-08-26 · **Status:** accepted · **Decides:** that the application is a common
manufacturing-operations-and-traceability core with product-family configuration, not a
pressure-vessel application, and what "future-proof for a new family" concretely means.

**Read with:** `docs/PHASE-PROMPTS.md` §0 (the standing generality rule this ADR is the reasoned
basis for), `docs/AUDIT-addendum-fabrication-and-assembly.md` §0b and §2, `docs/CLAUDE.md`'s
generality-related conventions, `docs/AUDIT-master-engineering-review-v1.md` (preserved as-is —
this ADR does not revise its findings).

---

## Decision

The product is a **multi-project, multi-product-family manufacturing operations and traceability
platform** — Pressure Vessel, Heat Exchanger, Pipe Spool, Piping System today, more later — built
as **one common core with product-family configuration and extension**. It is not a set of
separate applications per product type, and it is not a pressure-vessel application that happens
to have some configurable fields.

DESPL-320 (9 HP air receivers, `PRESSURE_VESSEL`) is the pilot being used to finalise the first
manufacturing workflow end to end. It calibrates the platform. It is not the platform.

---

## Project → Product Type model

A **project** in this system is a `Job`. Every `Job` carries a `familyId` pointing at a
`ProductFamily` row. So the model already reads:

- `DESPL-320` / `PRESSURE_VESSEL`
- a future `HX-2027-001` / `HEAT_EXCHANGER`
- a future job / `PIPE_SPOOL`
- a future job / `PIPING_SYSTEM`

No new concept is being introduced here — `Job` and `ProductFamily` are the existing domain names
and this ADR uses them as-is, per the instruction not to invent new vocabulary for something that
already exists.

---

## What is common core

Applies uniformly across every family, with no family-specific branch in the code: projects
(`Job`), customers (`Client`), engineering, drawings and revisions, BOM and revisions, assemblies,
components, quantities and unit of measure, materials, procurement, work orders, operations, work
centres, production events, QC, NCR, rework, surface treatment, packing, dispatch, documents,
notifications, audit and events, users, roles, permissions.

Not every family needs every capability — a pipe spool job may never touch PWHT or hydrostatic
test — but the *mechanism* for each capability (the tables, the state machine, the gating) is
identical across families. What differs is which template rows a family's job pins, not which code
path it runs.

## What varies by family, and how it is expressed today

| Varies by family | Expressed as |
|---|---|
| BOM structure, component types and attributes | `ComponentTypeRef` (tenant-scoped reference table) + `Component` rows keyed to it |
| Operations and their sequence | `RouteTemplate → RouteTemplateVersion → RouteStep`, `@@unique([tenantId, componentTypeId, familyId])` |
| Routing / process spine | `ProcessTemplate → ProcessTemplateVersion → TemplateProcess`, per family, versioned; a `Job` pins `templateVersionId` at intake and materialises `JobProcess` |
| QC and inspection plans | `QcpTemplate` library rows (`jobId: null`), cloned into a job via `createJob(qcpTemplateSourceId)`, matched **by process code, not id** so the clone survives template renumbering |
| Engineering documents | `DrawingTypeRef` (open vocabulary) + `AssemblyDrawing` |
| Material requirements | `MaterialIdentification` keyed off `BomItem`, family-agnostic |
| Production stages | `TemplateProcess.workOrderStages[]` crosswalk — a family need not use the 25-stage reporting view at all |
| Product-specific measurements and compliance | `EquipmentTypeRef.familyId` + `EquipmentTypeRef.defaultSpecs` (JSON), copied into `Job.specs` at intake — display/reference only, never read by scheduling or gating (see schema design note on `Job.specs`) |

Reference vocabularies (`OperationRef`, `ComponentTypeRef`, `DrawingTypeRef`, `DelayCategoryRef`,
`QcpCodeRef`, `TestTypeRef`) are tenant-scoped tables, not enums, specifically so a new family's
vocabulary is a data insert, not a migration (schema design note 4).

---

## The DESPL-320 rule

DESPL-320 data — job numbers, serials, customer names, component tags, operation names, group
codes, family codes as literals — belongs in `seed/`, `scripts/`, and test fixtures. **No such
literal may appear in `src/`.**

`docs/PHASE-PROMPTS.md` §0 already states this rule and credits Phase 0 with removing the one
violation found at the time, `workspace/page.tsx:8-13`. **That credit does not hold as of this
review** — see "DESPL-320 assumption found in `src/`" below; the violation is present again (or
was never fully removed) in the current tree and this ADR flags it as an open item, not a closed
one.

---

## Future-proofing, defined

Future-proofing does **not** mean building Heat Exchanger support today. It means: adding a family
later requires **authoring templates, routes and a QCP as data**, with no change to authentication,
RBAC, BOM, materials, work orders, production, QC, audit, documents, or dispatch.

### The standing acceptance test

> *"If we won an identical heat exchanger tomorrow, what code changes?"*

The answer must be **none**. An engineer authors a `ProcessTemplate` version, a `RouteTemplate` set
and a `QcpTemplate` as data, and the job runs on the existing mechanism. Apply this test at every
phase gate, per `docs/PHASE-PROMPTS.md` §0 rule 5 — if a phase's design makes the answer anything
other than "none", the design is wrong, and that should be said before implementing it, not after.

---

## Consequences

- **More deliberate domain modelling.** Every new capability has to be asked "is this a template
  row, a reference-table row, or a code branch?" before it's built — the discipline the addendum's
  `AssemblyTemplate → Version → Step → AssemblyStep` design (§2) exercises for assembly. This is
  slower than hand-seeding a DESPL-320 special case and is the correct tradeoff.
- **The honest gap: QCP authoring has no UI.** The clone-by-code mechanism (`qcpTemplateSourceId`,
  `cloneQcpTemplate`) exists and works. What does not exist is a UI for building a `QcpTemplate`
  library row from scratch (PRD FR-M3). Until it exists, onboarding a new family's QCP means
  hand-authoring JSON and running it through a script — which is the real barrier to "we won a heat
  exchanger, what changes?", not the data model. This is tracked as A8 in
  `docs/PHASE-PROMPTS.md` §3 and should not be allowed to slip silently past Phase 4.
- **RLS is thin; the parent-join convention is the real boundary for most tables.** Tenant RLS
  policies exist on 3 migrations covering a handful of tables; 35 of 56 tables have no RLS of their
  own (per `docs/PHASE-PROMPTS.md` §0's own count) and rely on being anchored through a
  tenant-scoped parent (`_shared.ts:264-286`'s pattern). This is a correctness discipline to keep
  enforcing, not a mechanism this ADR can claim is complete — see "facts checked" below.

---

## Family readiness today

| Family | Status |
|---|---|
| `PRESSURE_VESSEL` | Complete — 36-process template v1, 25-route library, DESPL-320 pinned to it |
| `PIPE_SPOOL` | Provisional — real sequence sourced from two piping QAPs, no confirmed durations; `lib/schedule/` correctly refuses to compute a plan rather than guessing (`TemplateProcess.provisional`) |
| `PIPING_SYSTEM` | No template yet |
| `HEAT_EXCHANGER` | No template yet |

This is a **data gap**, not an engineering one — the mechanism these three would need already
exists and is exercised by `PRESSURE_VESSEL` and partially by `PIPE_SPOOL`.

---

## Facts checked against the schema (2026-08-26)

| # | Claim | Holds? |
|---|---|---|
| 1 | `Job.familyId → ProductFamily`, with `PRESSURE_VESSEL`, `HEAT_EXCHANGER`, `PIPE_SPOOL`, `PIPING_SYSTEM` seeded | **Yes.** `schema.prisma:657,687`; all four seeded in `prisma/seed.ts:588-594`. |
| 2 | `ProcessTemplate → ProcessTemplateVersion → TemplateProcess` is per family and versioned, job pins a version at intake | **Yes.** `schema.prisma:544-624`; `Job.templateVersionId` (`schema.prisma:658`). |
| 3 | `RouteTemplate` is `@@unique([tenantId, componentTypeId, familyId])` with nullable `familyId` | **Yes.** `schema.prisma:940-958`, exactly that unique constraint, `familyId Int?`. |
| 4 | `QcpTemplate` supports library rows (`jobId: null`) and `createJob` accepts `qcpTemplateSourceId` | **Yes**, mechanism-wise. `QcpTemplate.jobId Int?` (`schema.prisma:1234`); `qcpTemplateSourceId` flows through `src/lib/shared/schemas.ts:491` → `src/lib/services/job-intake.service.ts:237-238` → `cloneQcpTemplate` (`job-intake.service.ts:414`), matched by process code. **But the authoring UI does not exist** (see Consequences) — the mechanism is real, the on-ramp for a new family's QCP is not. |
| 5 | Tenant RLS plus job scoping already give project independence for most tables | **Partially.** Tenant RLS is real for the tables it covers (3 migrations, 4 `CREATE POLICY` statements), but per `docs/PHASE-PROMPTS.md` §0's own accounting, 35 of 56 tables carry no RLS and depend entirely on the parent-join convention being followed correctly at every read/write site. Project independence holds today because that convention has been followed, not because RLS enforces it everywhere. Treat this as a discipline to keep verifying (0.3's negative cross-tenant suite in Phase 0), not a closed mechanism. |

---

## DESPL-320 assumption found in `src/`

One, contradicting `docs/PHASE-PROMPTS.md` §0's claim that Phase 0 removed it:

- **`src/app/(app)/workspace/page.tsx:8-13`** — `pilotJobId()` falls back to
  `tx.job.findFirst({ where: { jobNumber: "DESPL-320" } })` whenever no `?job=` query param is
  present. `/workspace?job=<id>` itself works correctly (the parameterised path §0 and Phase 0's
  acceptance criteria describe), but the *default* landing view for `/workspace` with no param
  still special-cases the pilot job by literal string. This is the one violation this review found;
  no other `src/` file (excluding `.test.ts` files, which are permitted fixtures, and comments that
  merely cite DESPL-320 as a worked example in `bom.read.ts` and `workspace.read.ts`) contains a
  DESPL-320/serial/job-number literal.

This is left for the team to fix as ordinary Phase 0/1 follow-through, not fixed by this
documentation-only session — see Stop condition.

---

## Minimal edits made elsewhere

- `CLAUDE.md` — added a pointer to this ADR alongside the existing invariants (see diff).
- No other document was found stating or implying the application is pressure-vessel-only or
  DESPL-320-only. `docs/PRD.md`'s background section describes DESPL's *business* (ASME pressure
  equipment) as of 03 Aug 2026 — that is historical company context, already banner-superseded by
  `docs/BUILD-SPEC-v2.md`, and is correct to leave as written; it does not claim the software is
  restricted to that family. No mass replacement of "DESPL-320" was performed — every remaining
  occurrence found names the pilot correctly (seed files, scripts, test fixtures, and doc
  cross-references).
