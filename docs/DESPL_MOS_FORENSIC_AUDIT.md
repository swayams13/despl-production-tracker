# DESPL MOS — Forensic Audit

**Repository audited:** `DESPL TRACKER` (git remote `swayams13/despl-production-tracker`), branch `demo`, HEAD `28d7f2f` (2026‑08‑31 09:01 IST). 305 commits. Working tree clean at time of audit.
**Not audited (different repo, same folder tree):** `AI DEVELOPMENT DESPL/DHRUV OS PROTOTYPE` — a separate, much smaller (2‑commit) FastAPI/Next.js scaffold called "EOS — Enterprise Operating System Prototype." It is not the DESPL-320 tracker and is out of scope; it is mentioned only because its `CLAUDE.md` was initially confusable with the real target.
**Method:** static, read‑only inspection of `prisma/schema.prisma` (2,139 lines, 71 models, 21 enums), `src/lib/services/*` (≈40 service/read files), `src/lib/schedule/*`, `src/lib/authz`, `src/app/**`, all `prisma/migrations/*.sql`, `docs/*`, and `progress.md`. No code was run, no database was queried, no file was modified.
**Caveat on scope:** ten independent research passes fed this report; each cites file:line evidence. Two things could not be verified from a read-only static pass: (1) whether the referenced test suites actually pass right now (they were read, not executed); (2) live network state of the `demo`/`origin/demo` remote (the linked machine's shell has no outbound network, so the remote comparison below reflects the last cached fetch, not a live check).

---

## 1. Executive Summary

This is **not** a DESPL‑320 dashboard that got dressed up as a platform. It is a genuinely engineered, single‑tenant‑so‑far manufacturing‑operations core — versioned process templates, a real CPM scheduling engine, server‑enforced maker‑checker and hard sequential gating, an append‑only audit trail enforced at the database grant level, and a deliberate, self‑documented architectural decision (`docs/ADR-product-family-agnostic-platform-v1.md`) to keep the domain model product‑family‑agnostic. The team has already run four of its own audits against itself in the last two weeks and fixed a meaningful share of what those audits found (a fail‑open RLS policy, three cross‑tenant write holes, a CPM envelope‑corruption bug). That level of self‑scrutiny is unusual and is itself evidence of engineering maturity.

At the same time, the honest answer to "is this a company‑wide MOS today" is **no** — it is a very well‑built **production tracker for one product family (pressure vessels) with the schema bones of a multi‑family MOS**, most of which are proven by exactly one family and one pilot job. Bootstrapping a second family (Heat Exchanger, Pipe Spool) still requires a developer to hand‑write JSON and run a seed script — there is no admin UI to create a `ProductFamily`, a component `RouteTemplate`, or a first `QcpTemplate`. Two literal `"PRESSURE_VESSEL"` string couplings sit in live service code (not just seed data), and a hardcoded 25‑stage, pressure‑vessel‑worded stage‑name table drives the flagship "Stage Spine" UI everywhere. The newest work (NCR, paint/DFT, packing, dispatch — "Phase 5") is real, tested at the service layer, and committed to the branch under audit — but has **zero UI**, and is explicitly, deliberately **not active on the one real job in the system** (DESPL‑320 stays pinned to an older template version).

A further finding this audit surfaced that no prior internal audit called out explicitly: the `demo` branch — which carries essentially all of the last two weeks' work (Phases 0 through 5) — is **77 commits ahead of `main`**, and `railway.json`/`CLAUDE.md` both describe production deploys as auto‑deploying from `main`. Unless deploy configuration has changed very recently, most of what this audit describes as "built and tested" has not shipped to the live Railway environment.

## 2. Actual Product Definition

The repository's own accepted ADR states the product correctly: *"a multi‑project, multi‑product‑family manufacturing operations and traceability platform — Pressure Vessel, Heat Exchanger, Pipe Spool, Piping System today, more later — built as one common core with product‑family configuration and extension… DESPL‑320 is the pilot… It calibrates the platform. It is not the platform."* This audit independently re‑verified that framing against the schema and found it substantially, though not completely, true (§8, §36).

## 3. Current System Reality

A single Next.js 15 (App Router) full‑stack application — no separate backend service — with Server Actions doing every mutation, Prisma 6 against PostgreSQL 16, deployed (per config, not necessarily currently) to Railway. `src/lib/services/` (≈40 files) holds essentially all business logic; Server Actions are confirmed thin wrappers (zero direct Prisma calls found in any `src/app/actions/*.ts` file). The domain is deep — 71 Prisma models — and is actively growing: the most recent 15 commits (all dated the audit day) added an entire NCR/paint/packing/dispatch subsystem.

## 4. MOS Maturity Level

Per the audit's own ladder (Level 0 static dashboard → Level 5 intelligent operational platform), this system sits at

> **Level 3 — Integrated departmental operations**, with real Level‑4 (Management Operating System) building blocks already in place but not yet uniformly reachable or proven across more than one project.

Justification: departments are genuinely integrated through one shared DAG/gating engine (not siloed status boards, §17), and there is a real cross‑department command‑center view with "blocking"/"waiting‑on" language sourced from the same computation (§21). What keeps it out of Level 4 today: no scheduled/cron operating rhythm exists yet (the daily digest is a manual "Send now" button, §21.3), KPIs are computed ad hoc per screen rather than through a shared framework (§22), and the system has been operated end‑to‑end by only one real pilot job.

## 5. Architecture Assessment

Backend architecture is disciplined and consistently applied: services own business rules, Server Actions are thin, 48 stable, documented error codes form a real API contract (`src/lib/shared/errors.ts`), every tenant‑scoped operation is funneled through one `withTenant()` transaction wrapper (`src/lib/db.ts`) that both opens a Postgres transaction and sets the RLS session variable — meaning transactionality and tenant isolation are structurally the same code path, not two things a developer must remember to do separately. A prior internal audit's recommendation *not* to split this into microservices is well‑reasoned and evidenced (zero cross‑layer imports found between `lib/` and Next.js/React) and this audit concurs — four of the twelve non‑negotiable invariants (gating, maker‑checker, hold points, same‑transaction audit) depend on single‑Postgres‑transaction atomicity that a service split would have to painstakingly re‑create.

Frontend architecture is transitional: genuine company‑wide (`/dashboard`), per‑project (`/jobs/[id]`), per‑department (`/departments/[id]`, `/command/[dept]`), and cross‑cutting (`/qc`, `/reports`) views exist and are parameterized (not hardcoded to one job) — but `/alerts` and `/board` are literal placeholder stubs ("coming in R2"), and `/workspace`'s default landing page still falls back to a hardcoded `jobNumber: "DESPL-320"` lookup when no job is specified in the URL (§36). Classification: **(E) — a genuine transitional architecture actively moving from production‑tracker toward company‑wide MOS**, not a dressed‑up dashboard and not yet a finished MOS.

## 6. Domain Model Assessment

The domain model is **not** a single linear Project→Job→Equipment→Assembly→Component→Operation→Task chain. It is a `Job` root with three coexisting, independently‑evolving tracks reconciled by a shared numeric code rather than a foreign key:

- **Fabrication track:** `Component` (self‑referencing for multi‑piece sub‑assemblies) → `ComponentOperation` (one route step, maker‑checker, `qtyPlanned/qtyGood/qtyRejected`) → `ComponentOperationRejection` → `Ncr`.
- **Assembly track:** `AssemblyTemplate → AssemblyTemplateVersion → AssemblyTemplateStep` (authored once per family) materialized per `Unit` into `AssemblyStep` → `AssemblyStepRejection` → `Ncr`.
- **Scheduling spine:** `ProcessTemplate → ProcessTemplateVersion → TemplateProcess` (department‑owned, versioned) → `JobProcess` (a job's materialized copy) → `ProcessPlan` (the actually‑schedulable, gated row) with `JobProcessEdge` encoding the CPM DAG.

The join between the execution grain (`ComponentOperation`/`AssemblyStep`) and the schedule grain (`JobProcess`) is a **numeric‑string equality** (`operation.leadTimeProcessSeq == Number(jobProcess.code)`, `_shared.ts:475‑496`), not a relational foreign key. This is a real, named architectural finding — three parallel status tracks kept in sync by convention, not referential integrity, and a reviewer should treat any future refactor of stage numbering as a correctness risk to this join.

Database quality is otherwise strong: extensive use of tenant‑scoped reference tables instead of enums for anything domain‑vocabulary‑shaped (`ComponentTypeRef`, `OperationRef`, `DrawingTypeRef`, `DelayCategoryRef`, `QcpCodeRef`, `Department` — all `@@unique([tenantId, code])`); 139 `@@index` declarations with no missing‑FK‑index pattern found in the models spot‑checked; a `CHECK`-constraint workaround (raw SQL in migrations) used correctly where Prisma has no native XOR support. There is **no soft‑delete convention anywhere** (zero `deletedAt` fields across all 71 models) — lifecycle is expressed via status enums instead, which is a coherent choice but means "undelete" is not a concept the schema supports. `createdAt` exists on only 12 of 71 models and `updatedAt` on exactly one; the team's deliberate substitute is two centralized append‑only ledgers (`AuditLog`, `DomainEvent`), both DB‑grant‑enforced append‑only — a reasoned trade‑off, but it means "when was this row last touched" is unanswerable by querying most tables directly.

## 7. Project / Job / Equipment Assessment

`Project → Job → Equipment → Unit(serial) → Component/AssemblyStep` is real and multi‑instance: `Job.familyId → ProductFamily`, `Equipment.jobId → Job`, `Unit.equipmentId → Equipment` (a `Unit` is one physical serial — the schema comment gives DE0463 as "40 units of one equipment"). Multiple jobs, multiple equipment per job, and multiple units per equipment are all structurally supported and already exercised by the two real jobs in the seed data (DESPL‑320, DE0467/DE0463). What is **not** yet proven at scale: only 27 of 71 models carry `tenantId` directly; the other 44 rely entirely on being reached through a `Job`/`Equipment` FK chain (§26). Job‑to‑job isolation *within* the same tenant has **no schema‑level or RLS enforcement at all** — it rests entirely on every service function remembering to filter by `jobId`. This was independently verified as consistently applied in the files sampled, but it is app discipline, not a database guarantee.

## 8. Product Family Assessment

This is the audit's central question, and the answer is **PARTIALLY** — more real than a skeptical read would assume, less complete than the ADR claims.

**What is genuinely family‑agnostic and does not require a developer once bootstrapped:**
- Process‑route authoring (`createTemplate`/`cloneVersion`/`publishVersion`, `template.service.ts`) has a real admin UI (`/admin/templates`) that iterates families generically and explicitly offers **"Clone one from another family"** for any family with no route yet.
- Equipment‑type catalog management (`admin.service.ts`) takes an arbitrary `familyId`.
- Job intake, scheduling, and day‑to‑day execution tracking are fully data‑driven off `familyId`/`templateVersionId` with no family branching found anywhere in the service layer.
- `Department` is a genuine data row (`Department` model, `@@unique([tenantId, code])`), not a hardcoded enum — adding a 14th department is one `INSERT`, not a migration.

**What still requires a developer:**
- **Creating a `ProductFamily` itself** — zero UI, zero Server Action; the only place a `ProductFamily` row is ever created is `prisma/seed.ts`.
- **`RouteTemplate` authoring** (component‑level operation routes) — zero service function, zero UI; only ever created by `prisma/seed.ts` from `seed/component-routes.json`.
- **A first `QcpTemplate`** for a brand‑new family — the clone mechanism (`cloneQcpTemplate`) can only copy an *existing* QCP; there is no way to author one from nothing except hand‑writing JSON and running a seed script. The ADR itself calls this "the honest gap."
- **Per‑family intake spec fields** (`src/lib/shared/specs.ts`) are a hardcoded `Record` with only `PRESSURE_VESSEL` defined — self‑documented in the code as an accepted "this is a code change anyway" decision.
- The `/admin` standard‑durations screen hardcodes `family: { code: "PRESSURE_VESSEL" }` in its query (`admin.read.ts:63`) — a PIPE_SPOOL admin cannot reach their own template's duration editor through this screen at all.

Family readiness today: **PRESSURE_VESSEL** complete (36‑process template, PUBLISHED); **PIPE_SPOOL** provisional (real route, no confirmed durations, correctly flagged via a `provisional` boolean rather than guessed); **PIPING_SYSTEM** and **HEAT_EXCHANGER** have no template at all. This is fairly characterized as a data gap sitting on top of a real mechanism, not a fake mechanism — but "an engineer authors a template as data" (the ADR's own acceptance‑test framing) is not literally true yet for the three artifacts above; today that step needs a developer.

On the "right level of abstraction" question (§59 in the brief): the evidence favors the team, not the concern. `specs.ts`'s own header comment explicitly rejects an EAV table in favor of a plain typed map, reasoning that a fully generic field system would buy configurability nobody could safely use. `Job.specs` is explicitly walled off from the scheduling/gating path by a schema comment invoking invariant #12 ("the moment a schedule depends on a free‑shaped blob, refusals stop being explainable"). The versioning layer is justified by a named, real invariant (published templates are immutable because jobs pin a version forever). This is a codebase actively resisting over‑abstraction, not reaching for it — the actual risk runs the other way (missing configurability, see the bullet list above), which is the healthier failure mode of the two `docs/ADR` §59 warns against.

## 9. Department‑by‑Department Audit

Departments are discovered from data (`seed/lead-time-model.json`, seeded via `prisma/seed.ts`), not assumed. The 13 seeded departments:

| Department | Exists | Data model | UI | Workflow grain | Own richer model | DESPL‑320 coupling | Maturity |
|---|---|---|---|---|---|---|---|
| PROJECTS | Yes | `Department` row | `/command/PROJECTS` | `ProcessPlan` | — | Data row, generic | Office‑tier |
| ENGINEERING | Yes | `Department` row | `/command/ENGINEERING` | `ProcessPlan` + `AssemblyDrawing`/`DrawingRevision` | Drawing versioning | Data row, generic | Office‑tier, real workflow |
| PLANNING | Yes | `Department` row | `/command/PLANNING` | `ProcessPlan` | — | Data row, generic | Office‑tier |
| PROCUREMENT | Yes | `Department` row | `/command/PROCUREMENT` | `ProcurementEvent` ledger | Yes | Data row, generic | Office‑tier, thin workflow (see §11) |
| STORES | Yes | `Department` row | `/command/STORES` | `StockLot`/`StockTxn` | Yes | Data row, generic | Office‑tier |
| QC | Yes | `Department` row | `/command/QC` **+ dedicated `/qc` cockpit** | `QcpTemplate`/`QcpItem`/`QcpExecution`, `Ncr` | Yes — richest subtree | Data row, generic | Most mature department |
| FABRICATION_PREP | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` | — | Data row, generic | Floor‑tier |
| MACHINE_SHOP | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` | — | Data row, generic | Floor‑tier |
| FABRICATION | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` + `WeldJoint`/`WeldLog`/`NdtResult` | Yes — richest floor subtree | **Code literal**: `welding.service.ts` looks up department by `code:"FABRICATION"` | Floor‑tier |
| HEAT_TREATMENT | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` | No PWHT‑specific model | Data row, generic | Floor‑tier, thin |
| SURFACE_PAINT | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` + `PaintRecord`/`DftReading` | Yes | Gate keyed on `OperationRef.code === "PAINTING"` string, not DESPL‑320‑specific but a literal | Floor‑tier |
| DOCUMENTATION | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` | No dedicated MDR model found | Data row, generic | Floor‑tier, thinnest |
| DISPATCH | Yes | `Department` row | redirects to `/workspace` | `ComponentOperation` + `DispatchBatch`/`DispatchBatchUnit` | Yes | Data row, generic | Floor‑tier, new (Phase 5, no UI yet) |

**Generic access control, hardcoded routing tier.** `requireDepartmentScope` (`src/lib/authz/index.ts`) checks `actor.departmentIds.includes(departmentId)` — fully data‑driven, no department names in the authorization code. But *which* departments get a rich `/command/[dept]` dashboard versus redirect to the generic `/workspace` floor view is a hardcoded TypeScript array, `OFFICE_DEPT_CODES`/`ALL_DEPT_CODES` (`command-center.read.ts:32‑47`), enumerating exactly the 13 seeded codes. A 14th department costs nothing as a data row; giving it its own command‑center‑style dashboard (versus the generic floor workspace) requires a code change to these arrays.

Answering §9's genericity checklist directly: a new project can use any department (yes, generic FK); two projects can use a department differently (yes — each `Job` pins its own `templateVersionId`, so two jobs can route the same department's work differently); a department can define its own tasks (yes, via `OperationRef`/route templates); dependencies, scheduling, delay, blockers, KPIs, alerts, workload — all real, all department‑agnostic in the underlying engine (§17–§23). The workflow *can* change without code for an already‑bootstrapped family; it currently *cannot* for standing up a new family's first route/QCP (§8).

## 10. Engineering Assessment

Engineering is a **real operational department**, not a status label — it runs through the identical generic `ProcessPlan`/`JobProcess`/gating machinery every floor department uses, with its own pipeline vocabulary (`command-center.read.ts:70‑77`: "Waiting on inputs" → "Ready for design calc" → "Drawing in progress" → "Awaiting client approval" → "Drawing approved" mapped onto the same six shared plan states every department uses). Drawing revisioning is real: `createDrawingRevision` enforces strictly increasing revision numbers, flips the prior RELEASED revision to SUPERSEDED rather than mutating it, and is role‑gated. It genuinely **gates downstream fabrication** — `assertDrawingReleased` blocks a CUTTING operation from starting unless its governing drawing's current revision is RELEASED. Gaps: no deadline field on a drawing itself, no maker‑checker on revision issuance (a deliberate choice, documented as "not a process transition"), and no dedicated Engineering→Planning handoff event beyond the implicit `governingDrawingId`/`builtToRevisionId` link.

## 11. Procurement Assessment

Real, but thin, and the weakest link in the material chain. `ProcurementEventType` is a four‑value enum (`INDENT_RAISED | INDENT_APPROVED | PO_PLACED | RECEIPT`) and is, by the code's own comment, the *entire* status model — "there is no separate status enum to keep in sync." **No vendor/supplier field exists anywhere in the schema.** There is no expected‑delivery‑date field, so "pending" can only be inferred from the absence of a `RECEIPT` event and "delayed" cannot be computed at all — no due date exists to compare against. `procurement.service.ts` is 55 lines, a single append‑only event writer with no read/reporting logic of its own; visibility instead comes from `bom.read.ts`'s shortage calculations. Can production automatically detect it's blocked on material? **Partially, and one layer below where the documentation says**: `assertKitReady` (`_shared.ts:684`) does throw `MATERIAL_NOT_AVAILABLE` and is wired into `startComponentOperation` — but it silently no‑ops for any BOM item that has never had a single stock transaction logged, and CLAUDE.md's own invariant #2 still claims material‑dependency gating "is not implemented" a full day after the code that implements it (at the component‑operation grain, not the stage grain CLAUDE.md was describing) was committed. This is real, working documentation drift, not a fabricated gate — flag it to the team.

## 12. Material Assessment

The chain `Job → Equipment → BomItem → ProcurementEvent/StockLot/MaterialIdentification → StockTxn(consumption)` is real and well‑indexed. Quantity is split between a verbatim source string (`BomItem.sourceQty`, e.g. `"40 NOS."`) and a parsed decimal (`qtyPer`) — a reasonable, if slightly unusual, two‑field compromise for messy source data. UoM is free text with no canonicalization anywhere (`"kg"`/`"Kg"`/`"KGS"` all persist as distinct strings). **No required‑by date exists at the material level** — only job‑level `committedDeliveryDate`/`targetDispatchDate`. Available/required/shortage quantities are all computed at read time (`bom.read.ts`), never stored, and the code is explicit that a BOM item with zero stock activity shows `shortage: null` rather than a fabricated zero — a good instinct that avoids false confidence. There is no allocation/reservation model — stock is inherently partitioned by `BomItem`→`Equipment`→`Job`, so there is nothing for two jobs to compete over, which sidesteps rather than solves the allocation problem.

## 13. Production Assessment

This is the system's strongest area. The real hierarchy is `Job → Equipment → Unit(serial) → Component/AssemblyStep → ComponentOperation`, feeding upward into `JobProcess`/`ProcessPlan` for the department/schedule view (§6). **The "what needs to happen today" view the audit brief asks for is genuinely producible today**, not aspirational: `myday.read.ts` returns, per row, process name, serial, stage label/number, department, assignee, planned window, a five‑state status (BLOCKED/READY/IN_PROGRESS/SUBMITTED/ON_HOLD/DONE), overdue flag, critical‑path flag, float days, blocking‑predecessor IDs, and a human‑readable reason string ("Waiting on: X, Y." / "Ready to start — on the critical path." / "Overdue — file a delay reason to continue.") generated from real CPM/gating data, not a template string. There is no numeric "progress %" at the plan grain (status is five discrete states), but `ComponentOperation.qtyGood/qtyRejected` gives real partial‑quantity progress at the granular execution grain.

The execution lifecycle is a genuine, server‑enforced state machine (`start → submit → verify/reject → hold/resume`), row‑locked (`SELECT … FOR UPDATE`) inside the same transaction as the gate check and the audit write — never a client‑settable status field. Assignment, delay‑reason filing, rejection‑with‑NCR‑linkage, and hold/resume are all real, tested code paths. Two explicitly‑flagged gaps: resuming from ON_HOLD always lands on IN_PROGRESS (a prior SUBMITTED state cannot be restored), and delay‑reason review/dispute‑acknowledgement is deferred.

## 14. QC Assessment

QC is the most mature department in the codebase. Inspection plans (`QcpTemplate`/`QcpItem`), multi‑party P/W/H hold‑point codes, execution records with attempt numbering, server‑stamped inspector/timestamp fields, and a full NCR/disposition/rework state machine (`OPEN → REWORK_IN_PROGRESS/DISPOSITIONED → CLOSED`) are all real models with real service functions, not UI‑only status fields. Maker‑checker for QC verification is enforced exactly as CLAUDE.md's invariant #3 states, with **no admin bypass** — verified directly in `assertMakerChecker`. Hold points (H‑coded) are a genuine hard block (`assertNoOpenHoldPoint`, called from `verifyProcess`). **One real gap versus the documented invariant**: witness (W‑coded) waivers are described in the seed data's own legend as needing "Production Head approval, audited" — but `QcpExecution.waiverApprovedBy` is a schema column that is **never written anywhere in the service layer**. Today a W‑checkpoint has no `blocksCompletion` gate at all and no code path stamps or checks a waiver approval; the QC service's own comment says this is deliberately deferred to Phase 2. This is a documented gap, not a silent one, but it means invariant #4 as literally written in CLAUDE.md is only half‑true today.

## 15. Painting / Finishing Assessment

Painting is architecturally generic (a real `Department` row, real `TemplateProcess` rows in the 36‑process spine, fully participating in the same department‑agnostic CPM/gating engine as every other stage — verified: `gating.ts` has zero department‑awareness) but its specific business rule is reached through a hardcoded string comparison, `if (operationCode === "PAINTING")` in `component.service.ts`, rather than a declarative per‑operation‑type rule table. A tenant could name any `OperationRef` row `"PAINTING"` and the gate would activate for it, so this is reusable rather than DESPL‑320‑bound, but it is not abstracted the way the drawing‑release gate's own comment aspires to ("identified by code, never a hardcoded id" — true for *which* operation triggers it, not for *how many* such string‑keyed rules exist). `PaintRecord`/`DftReading` are real, generic, per‑component‑operation models. DFT acceptance is self‑attested with no spec'd micron range to validate against — a real gap the addendum audit already flagged and this audit confirms is still open.

## 16. Dispatch Assessment

Packing (`Package`, `assignUnitToPackage`) and dispatch (`DispatchBatch`, `DispatchBatchUnit`, `createDispatchBatch` → `approveDispatchRelease` → `recordDispatch`, all server‑clock‑stamped, all role‑gated) are real, recently‑added (Phase 5, same‑day commits), department‑agnostic models. **Zero UI exists for any of it** — confirmed by an exhaustive filename search (`*dispatch*`, `*packing*`, `*ncr*`, `*paint*` under `src/app`) turning up nothing, and by `progress.md`'s own session log stating outright that this phase shipped "service‑layer and schema only." Gating is real but **one‑directional and inactive on the pilot job**: `addUnitToBatch` refuses an unpacked unit, but nothing in `dispatch.service.ts` checks QC/NCR status before a unit can be packed or dispatched — the QC↔dispatch link runs the other way (a JobProcess‑level "Dispatch" stage can't be marked COMPLETE without dispatch evidence, `assertEvidenceSatisfied`), and `progress.md` states plainly that DESPL‑320 itself was deliberately **not** re‑pinned to the template version that carries this evidence requirement, so the one real job in the system is not gated by any of this new work.

## 17. Cross‑Department Workflow Assessment

This is the single strongest piece of evidence for MOS‑candidacy in the entire codebase, and it was independently verified, not assumed. The 36‑process spine assigns departments across its full length (`Engineering → Procurement → Stores → Fabrication‑Prep/Machine‑Shop → Fabrication → Heat‑Treatment → QC → Surface‑Paint → QC → Documentation/Dispatch`), connected by `TemplateEdge`/`JobProcessEdge` rows that are **process‑to‑process, not department‑scoped** — a real Kahn's‑algorithm topological sort plus forward/backward CPM pass (`src/lib/schedule/cpm.ts`) computes early/late start/finish, total float, and criticality across the *entire* graph, verified in code comments against the printed 119‑day envelope at all 36 processes. `gating.ts` has zero department‑awareness, meaning a Painting stage is blocked by an unfinished Fabrication stage through exactly the same mechanism a QC stage is blocked by Painting. Crucially, this is surfaced in the UI data layer, not just internally: `command-center.read.ts`'s `CommandCenterView` carries both `blocking` ("other departments' plans that *this* department is blocking") and `waitingOnOthers` ("this department's plans blocked on someone else"), sourced from the same CPM/gating computation — a Painting supervisor's dashboard can genuinely say "you are blocking QC." Material‑to‑production dependency is likewise a real callable function (`assertKitReady`), not an inference a user has to make across two screens.

## 18. Scheduling Assessment

Template‑based, dependency‑based (real CPM, not a Gantt‑chart illusion), and calendar‑aware (working‑day arithmetic, 6‑day week default). **Not capacity‑aware** — no labor/resource‑capacity constraint exists anywhere in the scheduling code. Invariant #10 ("never sum durations") is genuinely implemented, not just documented: the two‑layer model (an authoritative "envelope" read directly from the printed lead‑time table, plus a CPM DAG whose lags are fitted to reproduce that envelope exactly) is real, and a code comment states it was verified to reproduce the printed 119‑day figure at every one of the 36 processes.

## 19. Delay / Dependency Assessment

**Filing a delay reason does not trigger a cascading reschedule.** `fileDelayReason` only writes a `DelayReason` row and clears the "you may not keep working until you explain the delay" gate — it has zero imports from the scheduling engine. Cascading reschedule genuinely exists, and genuinely recomputes CPM and restamps every downstream process's dates — but only through a **separate, manual, Production‑Head/Admin‑only action** (`applyDurationOverride`). There is no automatic trigger connecting the two: a supervisor reporting a 3‑day welding delay does not, by itself, move NDT/QC/Painting/Dispatch dates. A human planner has to notice the slip and manually apply an override for the DAG to re‑date downstream work. This is a real, working engine with a deliberate manual trigger, not a broken one — but it means the audit brief's specific example ("welding delayed 3 days — does NDT/QC/Painting/Dispatch move automatically?") is answered **no, not automatically**.

## 20. BOM Ingestion Assessment

A genuine, working UI upload path exists (client‑side `xlsx` parse → `importBomItemsAction` Server Action → `bom.service.ts`'s `importBomItems`), not just a seed script — confirmed by tracing the exact component (`BomPanel`) into a generic `/jobs/[id]` route reachable by any admin/production‑head user for any job. Header matching is alias‑based and normalization‑tolerant ("Item No"/"item_no"/"ItemNo"/"Sr No" all resolve correctly), and column order is irrelevant. Robustness, checked case by case: a malformed row fails individually with a row number while the rest of the batch still imports (tested); unrecognized extra columns are silently dropped (tested, non‑`.strict()` schema); **duplicate item numbers are not detected** (no dedup check, no DB unique constraint); **only the first sheet in a workbook is ever read** (hardcoded `SheetNames[0]`); **units are free text with no canonicalization**. Bulk‑imported rows also do not get linked to the `ComponentTypeRef` product‑family catalog (the bulk schema has no `componentTypeId` field at all) — a real, if minor, ingestion gap.

## 21. Management / MOS Dashboard Assessment

**Company‑level:** `portfolio.read.ts` genuinely answers "how many ON_TRACK / AT_RISK / DELAYED / ON_HOLD / COMPLETED / active" across every job in the tenant, plus a rolling 24‑hour "what changed" feed (verified, newly overdue, holds opened) built from raw SQL joins across `domain_events`/`process_plans`/hold‑point tables. It does **not** currently answer "due this week/due this month" or "which departments are overloaded" at the portfolio level (that granularity exists only inside per‑department and per‑job views), and there is no dedicated "blocked projects" bucket at the portfolio grain.

**Project/department‑level:** both are real and rich. `workspace.read.ts` computes a genuinely large per‑job KPI object (percent complete, S‑curve, first‑pass yield, cycle‑time‑vs‑standard, throughput vs. target, critical‑path blocking, overdue aging by department). `departments.read.ts` computes real cross‑job department cards (open/overdue counts, on‑time %, rework counts) and drill‑down detail (cycle time, reason breakdown).

**Equipment‑level:** **no dedicated equipment‑level dashboard exists.** Equipment only ever appears as a filter dimension inside job‑scoped views.

**Operating rhythm:** the daily digest's *data pipeline* is real (`loadDailyDigest`, computed from live domain events), but delivery is a **manual "Send now" button** (`publishDigest`, role‑gated), not a scheduled job. There is no cron/queue infrastructure anywhere in the codebase (`package.json` has none), and CLAUDE.md's own claim of "background jobs via Next.js route + cron" describes intent, not fact. Notification reconciliation is explicitly, deliberately lazy (runs opportunistically on every authenticated page load, by design, not oversight) rather than cron‑driven "until load demands it."

## 22. KPI Assessment

A genuine, non‑trivial set of KPIs is already computed from real data — department on‑time %, job‑level first‑pass yield %, QC checkpoint yield %, welder repair rate % (with an alert threshold), welder joints‑vs‑team‑average, 30‑day my‑day on‑time %, cycle‑time delta (working‑day‑aware), weekly throughput and throughput‑target. But the architecture is **ad hoc, not a framework**: there is no KPI registry, no shared calculation function — the same shape of calculation (on‑time %, yield %) is independently re‑implemented in at least four different `.read.ts` files, kept aligned only by cross‑referencing comments, not by a shared function. Adding a new KPI today means writing a new query and calculation in whichever screen owns that view; nothing centralizes definitions, thresholds, or presentation.

## 23. Alert / Notification Assessment

Real, persistent (a genuine `Notification` model with `readAt` acknowledgement), and partially event‑driven: job‑creation, plan‑assignment, QC "nudge," and digest‑published notifications fire synchronously inside their triggering mutation's own transaction. **Overdue‑stage and aged‑hold‑point alerts are computed lazily** on every authenticated page load, not event‑driven — a real, working mechanism, but one whose comment openly flags it as "fine at demo scale," a full‑table scan on every page view. **Delay‑reason filing and NCR opening currently generate no notification at all** — confirmed by grep: neither service calls the notification layer. Alert types are hardcoded string literals scattered per call site, not a configurable table.

## 24. People / Responsibility Assessment

Six real roles exist (`ADMIN, MANAGEMENT, PRODUCTION_HEAD, SUPERVISOR, QC, CLIENT_VIEWER`) — materially different from the generic README's "Director/GM/Department Head/Employee" set, which belongs to the unrelated sibling prototype repo, not this one. `User ↔ Department` is a real many‑to‑many join (`UserDepartment`) used to scope supervisors; there is no separate `Team` model and no manager/supervisor hierarchy FK — a department's "supervisor" is derived at read time by filtering for users holding the SUPERVISOR role in that department, not a first‑class relationship. "Who is responsible for this work right now" resolves to **a department plus an optional named assignee** (`ProcessPlan.assigneeUserId`, set via a real claim/assign/release service) — a plan can legitimately sit unassigned in a department's pool, so the honest answer is "always attributable to a department, not always to a person."

## 25. RBAC / Security Assessment

Session handling is sound: httpOnly, `sameSite=lax`, environment‑conditional `secure` cookie carrying a signed JWT (`jose`, HS256) — **not** localStorage, unlike the unrelated sibling prototype whose CLAUDE.md flags exactly that as a known issue (this repo does not share that problem). Roles/department scope are deliberately re‑fetched from the database on every request rather than embedded in the token, so a revoked role takes effect immediately. Deny‑by‑default is real at two layers (a coarse JWT‑presence check in `middleware.ts`, and a fine‑grained `requireRole`/`requireDepartmentScope` call at the top of essentially every service function). Enforcement is **scattered by convention, not centrally intercepted** — there is no wrapper that automatically applies a role table per route; a new mutation that forgets to call the right `require*` function would ship without an RBAC check and nothing structural would catch it, though a dedicated `authz.test.ts` suite exercises the negative cases that do exist (including "an admin cannot verify their own submission — no exceptions").

Gaps: rate limiting exists only for login and password‑change, not general API‑wide; no CSRF‑token layer beyond the `sameSite` cookie flag and Next.js's framework‑default Server Action origin check; **no CSP, X‑Frame‑Options, or HSTS configured anywhere** (`next.config.ts` is the default scaffold, no `headers()` block).

## 26. RLS Assessment

See §33/§26 combined — treated in full in the dedicated section below.

## 27. Audit Trail Assessment

Genuinely strong. Every mutation writes an `AuditLog` row with before/after JSON inside the same transaction as the mutation (78 call sites confirmed across the service layer); the database role the app connects as has `UPDATE`/`DELETE` explicitly revoked on both `audit_log` and `domain_events` at the SQL grant level (not just an application convention) — verified directly in the migration SQL. Coverage spans schedule overrides, BOM changes, every production state transition, QC/NCR actions, and admin actions. This is a real, structurally‑enforced append‑only audit trail, not a best‑effort log table.

## 28. Document / File Assessment

**No file/attachment storage exists anywhere in the application** — confirmed by an exhaustive grep for multipart handling, `S3Client`, `uploadFile`, or any blob‑storage client. This matches CLAUDE.md's own stated deferral. Every "document" reference in the schema (`MaterialIdentification.mtcRef`, `poRef`, `wpsRef`, `jointRef`, drawing revisions) is a free‑text string field with no validation that it points to a real file — a certificate number can be typed and never checked against anything. For a MOS meant to carry QC certificates, drawings, and photographic evidence, this is a real, currently‑unaddressed capability gap, not a partial implementation.

## 29. Backend Assessment

Covered in §5. To restate the one number that matters most for maintainability: zero Server Action files were found making a direct Prisma call — the service‑layer boundary is real, not aspirational, across every file sampled.

## 30. Frontend Assessment

Covered in §5. Nineteen real `page.tsx` routes exist under `src/app/(app)/`; two (`/alerts`, `/board`) are literal placeholder stubs.

## 31. Shop‑Floor Assessment

More real than a skeptical read of the planning docs would suggest. A responsive shell (three variants — sidebar / icon‑rail / bottom‑nav), CSS‑only breakpoint switching, a `pointer:coarse` density layer, and a reusable `<ResponsiveTable>` primitive are all shipped and used across the actual worker‑facing screens (`/workspace`, `/my-day`), with real incremental commits, not just planning documents. A Playwright viewport‑matrix spec exists and is honest about scope, containing eleven explicit `test.fixme()` markers each naming exactly what work is still pending. Evidence upload (geo‑tagged photo proof) and offline writes are confirmed absent, matching the documented Phase‑2 deferral — a component file even contains a comment explicitly noting the camera/geotag section was "deliberately omitted." A prior specialized audit (cross‑device compatibility) found real P0 defects — most routes unreachable below 1024px width via the rail nav, sign‑out desktop‑only, a QCP grid missing horizontal‑scroll wrapping, and a hard Safari‑pre‑16.4 rendering floor from unguarded `oklch()`/`color-mix()` CSS — none of which this audit found evidence of being fixed in the Phase 0–5 session logs reviewed; treat these as still open until re‑checked.

## 32. Testing Assessment

69 unit test files, 2 Playwright e2e specs. This is not happy‑path‑only testing: `gating.test.ts` is table‑driven across both allowed and refused transitions including a subtle overlap‑lag edge case; `cross-tenant.test.ts` and `authz.test.ts` are built entirely around named refusal scenarios ("refuses an admin verifying their own submission — no exceptions"). No single test is titled around "Project A vs Project B," but the functional equivalent is covered with generic (non‑DESPL‑320) two‑job fixtures in at least four different test files — since every job is created through the same generic `templateVersionId` mechanism, these tests do substantively prove cross‑job independence even without that exact framing. The cross‑tenant negative suite is honestly self‑documented as narrow — four hand‑picked entry points, not a static sweep of every exported function — which is an accurate statement of its own limit, not a hidden one.

## 33. Reliability Assessment

Deliberately engineered, not incidental. BOM import failures are per‑row, never whole‑batch (a partial‑success list is always returned, by explicit design). Concurrent‑write protection exists as a real optimistic‑concurrency pattern (`SELECT … FOR UPDATE` plus an `updatedAt` staleness check throwing `STALE_WRITE`) on template edits. Every tenant‑scoped operation funnels through one transaction‑wrapping function (`withTenant`) that is also where RLS's session variable gets set — meaning "did this write happen in a transaction" and "was this write tenant‑isolated" are the same guarantee, not two separately‑maintained ones. Maker‑checker double‑submission is structurally blocked with no admin bypass. The main residual reliability finding, carried forward from the prior internal architecture audit and not independently re‑verified in full here, is a claimed N+1/2N‑transaction pattern in the main job‑list read path (§35) — this audit's domain‑model pass corroborates the pattern exists in the code today, though it did not re‑measure the prior audit's specific latency numbers.

## 34. Observability Assessment

Thin. No structured logging, no error‑tracking service (Sentry or equivalent), no APM/tracing — confirmed by an exhaustive dependency and grep check finding zero such libraries and only three raw `console.*` calls in all of non‑test `src`. The only operational surface is a basic `/api/health` liveness probe (`SELECT 1`) and the audit‑log/domain‑event tables, which are a compliance record, not an observability tool — they do not tell an operator about a slow query, a failed background reconciliation, or an unhandled exception in production.

## 35. Scalability Assessment

The team's own code comments are unusually candid here and this audit corroborates them rather than discovering them independently: two separate read services (`myday.read.ts`, `command-center.read.ts`) contain comments admitting a per‑active‑job loop pattern ("fine at DESPL's 3–40 concurrently active jobs, batch before a tenant with hundreds"). A genuine N+1 was found in the main job‑list read path: the primary list query is properly batched, but a subsequent `Promise.all` issues 3+ additional queries **per job in the list** to compute hold‑point counts and spine rollups. Most list‑shaped read services (`admin.read.ts`, `command-center.read.ts`, `departments.read.ts`, `gantt.read.ts`, `job-intake.read.ts`, `myday.read.ts`, `portfolio.read.ts`, `stage-detail.read.ts`, `template.read.ts`, and critically `jobs.read.ts`'s own main job list) have **zero pagination** (`take`/`skip`) — some are genuinely small‑bounded (department/role lists), but the job list and portfolio view are not, and both would become materially expensive at "thousands of projects." `BomItem`'s self‑referencing parent tree has no depth limit. None of this is disqualifying at the system's actual current scale (a handful of jobs), but the audit's stated target scale (thousands of projects, millions of BOM items) is well beyond what several read paths currently assume, by the code's own admission.

## 36. DESPL‑320 Coupling Audit

The repository's own ADR claims exactly one literal DESPL‑320 coupling in `src/`. This audit re‑verified that claim against the current tree (eight commits newer than the ADR) and both **confirmed it is still present, unfixed** and **found it is not the only family‑level coupling that matters**:

- **Confirmed, unchanged**: `src/app/(app)/workspace/page.tsx:8‑13` — `pilotJobId()` falls back to `tx.job.findFirst({ where: { jobNumber: "DESPL-320" } })` when the `/workspace` route has no `?job=` parameter. A later planning document (`docs/PHASE-PROMPTS.md`) asserts this was fixed by "Phase 0" — that assertion is **false**: the only commit that ever touched this function added a query‑param override on top of the same hardcoded fallback, without removing it. The standing "no literal in `src/`" rule was written with an inaccurate premise about its own proof point, and no subsequent phase (five have shipped since) has gone back to close it.
- **New finding — a real family‑code literal in live logic, not a job‑number literal**: `src/lib/services/admin.read.ts:63` hardcodes `family: { code: "PRESSURE_VESSEL" }` inside the query powering the `/admin` standard‑durations screen — a PIPE_SPOOL admin cannot reach their own template's duration editor through this screen regardless of how many templates exist for other families.
- **New finding — pressure‑vessel‑worded stage vocabulary baked into a platform‑wide UI primitive**: `src/lib/shared/stage-names.ts` hardcodes exactly 25 stage‑name strings ("Shell Fabrication," "PWHT," "Hydro Test," etc.) and `workspace.read.ts` hardcodes `STAGE_COUNT = 25`, both consumed by the signature "Stage Spine" component rendered on every job page regardless of family. A second family degrades gracefully to a blank rollup rather than crashing, but its stage labeling and progress rollup do not work today.
- **New finding**: `welding.service.ts` looks up the fabrication department by the literal `code: "FABRICATION"` and throws `NOT_FOUND` if a tenant's department taxonomy doesn't use that exact code.
- **New finding (cosmetic only)**: the new‑job intake form's serial‑number field placeholder is `"e.g. 320SR"` — a UI hint, not functional logic.
- Seed/demo data (`prisma/seed.ts`, `scripts/seed-despl320-*.ts`, `seed/despl-320-*.json`) correctly confines pilot‑specific literals to seed/script territory and does not leak into production logic beyond the items above.

**Coupling classification by area:** Routing/process templates — **ORANGE** (generic schema, but the admin durations screen and specs field map are PRESSURE_VESSEL‑only). Department/work‑center definitions — **YELLOW** (generic reference‑table architecture, two call sites hardcode specific department codes). BOM structure — **GREEN**. Scheduling engine itself — **GREEN**; the stage‑reporting layer built on top of it — **YELLOW**. The `/workspace` default‑landing page — **ORANGE**, unchanged since the ADR. Seed/demo data — **GREEN** (as expected). Nothing found rises to **RED** (nothing is structurally incapable of running for a non‑pilot family) — every coupling found is a call‑site literal sitting on top of an otherwise generic schema.

## 37. Feature Inventory

| Feature | Exists | Actually works | Generic | DESPL‑320 coupled | Production‑ready |
|---|---|---|---|---|---|
| Authentication | Yes | Yes, tested | Yes | No | Yes |
| RBAC | Yes | Yes, tested | Yes | No | Yes |
| Projects / Jobs | Yes | Yes, tested | Yes | Cosmetic only | Yes |
| Equipment | Yes | Yes | Yes | No | Yes |
| Product families | Schema yes | Partial — only PV published | Architecture yes, data no | Effectively single‑family today | Not yet, multi‑family |
| Process templates | Yes | Yes, tested | Architecture yes | Two literal couplings (§36) | Yes for PV only |
| BOM | Yes | Yes, extensively tested | Yes | No | Yes |
| BOM ingestion (Excel) | Yes | Yes, tested | Yes | No | Yes |
| Engineering | Yes | Yes, real gating | Yes | No | Partial — no file storage |
| Procurement | Yes | Minimal (event log only) | Yes | No | Partial |
| Material / stock | Yes | Yes, tested | Yes | No | Yes |
| Production tracking | Yes | Yes, extensively tested | Yes | No | Yes — most mature area |
| QC | Yes | Yes, tested | Yes | No | Yes (W‑waiver gap, §14) |
| Painting | Yes | Yes | Yes (string‑keyed) | No | Yes |
| Dispatch | Yes | Yes at service layer | Yes | No | **No UI at all** |
| Scheduling | Yes | Yes, tested | Engine yes; admin view PV‑only | Partial | Yes |
| Alerts | Engine yes, page stub | Engine yes | Yes | No | Engine yes / page no |
| Notifications | Yes | Yes | Yes | No | Yes |
| Dashboards | Yes | Yes | Yes | Minor (stage labels) | Yes |
| KPIs | Yes | Yes, ad hoc | Yes | No | Yes |
| Audit trail | Yes | Yes, DB‑enforced | Yes | No | Yes |
| File/document uploads | **No** | — | — | — | No |
| Reporting | Yes (daily digest only) | Yes | Yes | No | Yes, narrow scope |
| Exports | One route (QCP → xlsx) | Yes | Yes | No | Yes, narrow scope |

## 38. Requirement Traceability Matrix

| MOS requirement | Status | Evidence / gap |
|---|---|---|
| Multi‑project, multi‑family core | PARTIAL | Schema complete for 4 families; only 1 has a published route; family/route/QCP bootstrap needs a developer (§8) |
| Department as reusable capability | COMPLETE (data model) / PARTIAL (routing UI) | `Department` is a data row; office‑vs‑floor dashboard tier is a hardcoded array (§9) |
| BOM upload without developer | COMPLETE | Real UI path, tested (§20) |
| Configurable workflow without code | PARTIAL | True once bootstrapped; not true for a brand‑new family (§8) |
| Cross‑department dependency modeling | COMPLETE | Real CPM DAG spanning all departments (§17) |
| Automatic delay propagation | MISSING | Manual override required; no auto‑trigger from a filed delay (§19) |
| Material‑blocks‑production visibility | PARTIAL | Real gate at component grain; documentation claims it doesn't exist; opt‑in/silent for untracked parts (§11) |
| Management company‑wide dashboard | PARTIAL | Strong at company/department/job grain; no equipment grain; no due‑this‑week/month view (§21) |
| KPI framework | PARTIAL | Real KPIs, no shared framework (§22) |
| Alert engine | PARTIAL | Real model, mixed event‑driven/lazy triggers, two known gaps (delay, NCR) (§23) |
| RBAC deny‑by‑default | COMPLETE | Verified, scattered‑by‑convention but consistently applied and tested (§25) |
| RLS / tenant isolation | PARTIAL | Real and DB‑enforced for tenant‑root tables; job‑level isolation is app‑discipline only (§26/§33) |
| Audit trail | COMPLETE | DB‑grant‑enforced append‑only, broad coverage (§27) |
| Document management | MISSING | No file storage anywhere (§28) |
| Testing proving multi‑project independence | PARTIAL | Real generic fixtures prove it functionally; no test bears that exact name (§32) |
| Scale to thousands of projects | WRONG ARCHITECTURE (for that scale specifically) | Team's own comments admit "hundreds," not "thousands," as the current ceiling; real N+1 found (§35) |
| DESPL‑320 decoupling | DESPL‑320 COUPLED (narrow) | One job‑number literal, one family‑code literal, one stage‑vocabulary coupling, one department‑code literal — all call‑site‑level, not structural (§36) |

## 39. Architecture Maturity Score (0–5)

| # | Area | Score | Note |
|---|---|---|---|
| 1 | MOS architecture | 3 | Real cross‑department DAG; not yet proven beyond one family/job |
| 2 | Domain model | 4 | Deep, well‑normalized; three‑track reconciliation‑by‑convention is the one real flaw |
| 3 | Multi‑project architecture | 3 | Structurally supported; job‑isolation rests on app discipline, not DB enforcement |
| 4 | Job/equipment model | 4 | Genuinely multi‑instance and exercised by two real jobs |
| 5 | Product‑family abstraction | 3 | Real mechanism, single fully‑bootstrapped family, no self‑serve bootstrap UI |
| 6 | Process templates | 4 | Versioned, immutable‑once‑published, cloneable across families |
| 7 | BOM ingestion | 4 | Real UI, tolerant parsing, tested; missing dedup/multi‑sheet/UoM canonicalization |
| 8 | Engineering | 3 | Real gating department; no file storage, thin deadline tracking |
| 9 | Procurement | 2 | Event log only; no vendor, no PO lifecycle, no due dates |
| 10 | Material management | 3 | Real shortage computation; no allocation concept, free‑text UoM |
| 11 | Production tracking | 5 | The system's strongest area; real state machine, real "today" view |
| 12 | QC | 4 | Deep and tested; W‑waiver gate is schema‑only |
| 13 | Painting/finishing | 3 | Real and generic in structure; string‑keyed business rule |
| 14 | Dispatch | 2 | Real service layer; zero UI; inactive on the one real job |
| 15 | Scheduling | 4 | Genuine CPM engine, verified against the printed envelope |
| 16 | Delay propagation | 2 | Real engine exists but is manually triggered, not automatic |
| 17 | Alerts | 3 | Real, persistent, partially lazy; two known non‑triggers |
| 18 | Management dashboard | 3 | Strong company/department/job views; no equipment view, no weekly/monthly cadence |
| 19 | KPI architecture | 2 | Real numbers, no shared framework |
| 20 | Cross‑department workflow | 4 | The system's second‑strongest area |
| 21 | RBAC | 4 | Consistent, tested, no admin bypass on maker‑checker |
| 22 | RLS/security | 3 | Strong where applied; covers under half the schema by table count |
| 23 | Auditability | 4 | DB‑grant‑enforced, broad coverage |
| 24 | Testing | 3 | Good negative‑case discipline; narrow cross‑tenant suite by its own admission |
| 25 | Scalability | 2 | Self‑admitted "hundreds, not thousands" ceiling; real N+1 found |
| 26 | Reliability | 3 | Deliberate, tested failure handling in the paths checked |
| 27 | Observability | 1 | Effectively none beyond a health‑check endpoint |
| 28 | Frontend usability | 3 | Real, parameterized, two stub pages |
| 29 | Shop‑floor usability | 3 | Real responsive work, several prior‑audit P0s unconfirmed‑fixed |
| 30 | Maintainability | 4 | Clean service boundary, stable error codes, disciplined conventions |

## 40. Current vs Target Architecture

**Current:** a single‑tenant‑proven, one‑family‑complete manufacturing core with genuinely generic underlying mechanisms (departments, templates, gating, CPM) and a handful of literal, call‑site‑level couplings to the pilot family and job sitting on top of them.

**Target:** the same core, with (a) an admin surface to author a `ProductFamily`, its `RouteTemplate`s, and a first `QcpTemplate` without a developer; (b) the two remaining family‑literal call sites (`admin.read.ts`, `stage-names.ts`) generalized; (c) an automatic (or at least suggested) delay‑propagation trigger; (d) a real document/file store; (e) pagination and batched reads on the list‑shaped queries the team has already flagged; (f) a scheduled operating‑rhythm job (daily digest, alert reconciliation) instead of manual‑button/lazy‑on‑page‑load.

**Gap:** narrower than the audit brief's worst‑case framing, wider than the ADR's best‑case framing — see §41 for the ranked list.

## 41. Critical Risks (ranked)

1. **The `demo` branch carrying all recent work is 77 commits ahead of `main`, and deploy is configured to auto‑deploy from `main`.** If this hasn't changed very recently, the bulk of what this audit describes as "built" is not live. This is the single highest‑leverage thing to verify before making any other decision about this system.
2. **No self‑serve path to onboard a second product family.** `ProductFamily`, `RouteTemplate`, and a first `QcpTemplate` all require a developer. This directly limits the MOS thesis, not just a feature.
3. **Job‑level (not tenant‑level) data isolation rests entirely on application discipline**, with no schema or RLS backstop — 50 of 71 tables carry no `tenant_id` at all, and there is no equivalent per‑job column anywhere. Consistently applied today, unverified by automation beyond a hand‑picked four‑function test suite.
4. **No document/file storage.** A QC‑heavy manufacturing MOS with no way to attach a certificate, drawing, or photo to a record is a real, not cosmetic, gap.
5. **Scalability ceiling self‑admitted at "hundreds of jobs," not "thousands."** A real N+1 exists in the main job‑list read path today.
6. **Delay propagation is manual, not automatic** — a floor department reporting a delay does not, by itself, move downstream dates.
7. **Zero observability** beyond a health‑check endpoint — a production incident would be diagnosed by reading the audit log, not by any purpose‑built tooling.
8. **Dispatch has no UI and is not gated on the live pilot job** — a real capability exists on paper (in the schema/services) that nobody can currently exercise end‑to‑end.
9. **Two remaining literal family/department‑code couplings in live logic** (`admin.read.ts`, `stage-names.ts`, `welding.service.ts`) — narrow in scope but real, and contradict the codebase's own "no literal in src/" standing rule.
10. **No security headers (CSP/HSTS/X‑Frame‑Options) and no general‑purpose rate limiting.**

## 42. What Should Be Preserved

The service‑layer/thin‑Server‑Action boundary; the `withTenant` transaction+RLS‑session pattern; the versioned‑template‑with‑immutable‑publish design; the CPM scheduling engine and its verified reproduction of the printed envelope; the maker‑checker and hold‑point gating mechanism; the append‑only, DB‑grant‑enforced audit trail; the reference‑table‑not‑enum pattern for domain vocabulary; the team's own habit of writing honest, dated, self‑critical audits and a standing generality rule (even where that rule's own proof point turned out to be wrong) — this is a genuinely rare level of engineering self‑awareness and should not be replaced with a rebuild‑from‑scratch mentality.

## 43. What Should Be Refactored

The three‑track (fabrication/assembly/spine) reconciliation‑by‑numeric‑code should get a real foreign key or a documented, tested invariant guarding the match, before a stage‑renumbering change silently breaks the join. The ad hoc, four‑times‑duplicated KPI calculation pattern should be pulled into one shared function per metric. The hardcoded `OFFICE_DEPT_CODES`/`ALL_DEPT_CODES` routing arrays should become data (a `Department.dashboardTier` field or similar) so a 14th department doesn't need a code change for UI routing. The two literal family‑code call sites (`admin.read.ts`, `stage-names.ts`) should be parameterized by the family actually in view. `CLAUDE.md`'s invariant #2 needs a one‑line correction to reflect that component‑grain material gating now exists.

## 44. What Should Be Rebuilt

Nothing found in this audit rises to "incremental fixes are unlikely to work." Even the weakest areas (procurement, observability, document storage, delay propagation) are additive gaps on top of a sound structure, not structurally wrong designs that need tearing out. The one candidate for a genuine redesign, not just an addition, is the fabrication/assembly/spine reconciliation join (§43) — but "add a real FK and a migration to backfill it" is a refactor, not a rebuild.

## 45. Recommended Target Architecture

Keep the current single‑Next.js‑app, Prisma/Postgres, service‑layer‑owns‑rules architecture. Add: an admin UI layer for family/route/QCP bootstrap (closing §8's gap); a lightweight cron/queue (the team's own CLAUDE.md already names BullMQ/Redis as the fallback "if load demands it" — load already demands it for the digest and notification reconciliation); an object‑storage integration (S3‑compatible, matching the sibling prototype's own existing pattern) for documents; a job‑level scoping column or view‑based enforcement to backstop the current job‑isolation‑by‑convention; and a real observability stack (structured logs + an error tracker) before scaling past the pilot.

## 46. Recommended Development Phases

```
PHASE A   Verify & reconcile branch/deploy state (demo vs main vs Railway) — 
          a decision-blocking prerequisite, not engineering work
          ↓
PHASE B   Close the 4 remaining literal couplings (§36) + correct CLAUDE.md's
          stale invariant #2 + fix PHASE-PROMPTS.md's false "already fixed" claim
          ↓
PHASE C   Family/route/QCP self-serve admin UI (closes the actual MOS gap)
          ↓
PHASE D   Document/file storage (S3-compatible), wired to Engineering/QC/MTC records
          ↓
PHASE E   Scheduled operating rhythm: cron-driven daily digest delivery + 
          notification reconciliation, replacing manual button / lazy page-load
          ↓
PHASE F   Delay-propagation automation (auto-suggest or auto-apply override on
          a filed delay, with human confirmation preserved for the audit trail)
          ↓
PHASE G   Ship the Phase-5 dispatch/NCR/paint UI and re-pin DESPL-320 (or the next
          real job) to the template version that actually gates on it
          ↓
PHASE H   Job-level isolation backstop + expand the cross-tenant test sweep
          beyond its current 4 hand-picked functions
          ↓
PHASE I   Observability (structured logging, error tracking) + the scalability
          fixes the team's own comments already name (pagination, N+1 in jobs.read.ts)
          ↓
PHASE J   Second product family pilot (Pipe Spool is closest — provisional route
          already exists) to prove the Phase C bootstrap UI for real
```

## 47. Priority Matrix

| Priority | Item | Why |
|---|---|---|
| P0 | Verify demo→main→Railway deploy state | Everything else is moot if the audited work isn't live |
| P0 | Fix the two false "already fixed" claims in PHASE-PROMPTS.md re: workspace/page.tsx | Standing rules built on a false premise erode the discipline that makes them valuable |
| P1 | Family/route/QCP bootstrap UI | The actual blocker to the MOS thesis |
| P1 | Document/file storage | Real operational gap for a QC-heavy manufacturing process |
| P2 | Job-level isolation backstop + wider cross-tenant test sweep | Currently fine by discipline; not yet fine by guarantee |
| P2 | Observability | Needed before any real production incident, not before scale |
| P3 | Scheduled operating rhythm, delay-propagation automation, KPI framework consolidation | Real quality-of-life and correctness improvements, not blockers |
| P3 | Ship Phase 5 UI, re-pin the pilot job | Unlocks demoing work already paid for |

## 48. Go / No‑Go Decision

**Go, with conditions.** The architecture is sound enough to keep building on. The conditions are: resolve the branch/deploy question first (§41.1); do not present this system to management or DESPL leadership as "the MOS" until the family‑bootstrap gap (§8) is closed or explicitly scoped out; do not scale user count or job count materially past the pilot until the isolation and scalability findings (§41.3, §41.5) are addressed.

## 49. Final Recommendation

Continue development on the current architecture. Prioritize Phase A (branch/deploy verification) and Phase B (closing the last literal couplings and doc drift) immediately — both are cheap and directly address this audit's most important findings. Treat Phase C (family bootstrap UI) as the real gate before calling this a "company‑wide MOS" in any external‑facing communication; everything up to that point is, honestly and by the team's own best documentation, a very well‑built pressure‑vessel production tracker with MOS‑shaped bones.

---

# CURRENT STATE

A single‑tenant‑proven Next.js/Prisma/Postgres manufacturing‑operations core covering intake, engineering, procurement (thin), material/stock, fabrication, assembly, QC/NCR, painting, packing, and dispatch for one product family (pressure vessels), built around a real versioned‑template system, a real CPM scheduler, and server‑enforced gating/maker‑checker/audit invariants — proven end‑to‑end by exactly one pilot job and one secondary job.

# WHAT IT IS TODAY

**A production tracker with genuine, unusually well‑built MOS bones — not yet a company‑wide MOS, and honestly not quite the "DESPL‑320 prototype" the audit brief worried it might be either.** It sits closer to "integrated operational system, single family, single tenant proven" than to any of the other four options.

# DESPL‑320 DEPENDENCY

Narrow and mostly at the call‑site level, not structural: one unfixed job‑number literal (`workspace/page.tsx`), one family‑code literal in live admin logic, one hardcoded 25‑stage pressure‑vessel vocabulary table driving the flagship UI, and one department‑code literal in the welding service. Nothing found requires DESPL‑320 or PRESSURE_VESSEL to exist for the system to run — but two of these four would misbehave (not crash) for a second family today.

# MOS READINESS

Roughly **35–45%** of the intended MOS capability exists and works, reasoned as: the hardest parts (cross‑department DAG, gating, audit, RBAC, scheduling) are largely done (pulling the estimate up); the parts that make it a *company‑wide* system rather than a *very good single‑family tracker* — self‑serve family onboarding, document storage, a scheduled operating rhythm, KPI/alert frameworks, and proof at more than one job — are mostly missing or manual (pulling the estimate down). This is a reasoned estimate, not a measured one; no test suite or metric in the codebase computes "MOS readiness."

# BIGGEST ARCHITECTURAL PROBLEM

The three‑track (fabrication / assembly / schedule‑spine) reconciliation by numeric‑code equality instead of a foreign key — the single point where a routine change (renumbering a stage) could silently break the whole system's rollup with no referential‑integrity error to catch it.

# BIGGEST PRODUCT PROBLEM

There is no way for DESPL to onboard a second product family without a developer writing JSON and running a script — which means the platform cannot yet do the one thing that would prove it is a company‑wide MOS rather than a very good pressure‑vessel tracker.

# BIGGEST SECURITY/RELIABILITY PROBLEM

Job‑level data isolation within a tenant has no database‑level backstop at all — it depends entirely on every current and future service function remembering to filter by `jobId` through the correct FK chain, checked today by a four‑function hand‑picked test suite that is honest about its own narrowness.

# BIGGEST STRENGTH

The cross‑department dependency engine (§17) — a real, verified CPM DAG spanning every department from Engineering through Dispatch, surfaced in the UI as genuine "you are blocking QC" / "waiting on Painting" language, not a collection of independently‑displaying status boards. This is the load‑bearing piece of evidence that this system is a real candidate for "company‑wide MOS," and it already works.

# RECOMMENDED DECISION

**2 — Refactor core architecture first, on a short, cheap punch list, then continue.** Not option 1 (continue as‑is) because the family‑bootstrap gap and the branch/deploy question are too consequential to build further features on top of unresolved. Not option 3, 4, or 5 (partial/major rebuild, stop and redesign) because nothing found in this audit is structurally wrong — every finding is an addition or a fix, not a redesign. The "refactor" here is intentionally narrow: resolve the branch/deploy state, close the four literal couplings, and build the family‑bootstrap admin UI — then resume normal feature development.

---

# NEXT-PHASE RECOMMENDATION (derived from this audit, not assumed)

```
PHASE 0   Verify demo→main→Railway state; reconcile CLAUDE.md and
          PHASE-PROMPTS.md against what is actually true in the code today
                    ↓
PHASE 1   Close the 4 remaining DESPL-320/PRESSURE_VESSEL literal couplings
                    ↓
PHASE 2   Family/route/QCP self-serve bootstrap UI (the actual MOS gate)
                    ↓
PHASE 3   Document/file storage
                    ↓
PHASE 4   Scheduled operating rhythm (digest delivery, notification
          reconciliation) + delay-propagation automation
                    ↓
PHASE 5   Ship the already-built dispatch/NCR/paint UI; re-pin a real job
          to exercise it end to end
                    ↓
PHASE 6   Job-level isolation backstop + widen the cross-tenant test sweep
                    ↓
PHASE 7   Observability + the scalability fixes already named in the
          team's own code comments
                    ↓
PHASE 8   Second product-family pilot (Pipe Spool) to prove Phase 2 for real
                    ↓
PHASE 9   KPI/alert framework consolidation
                    ↓
PHASE 10  Real-world multi-project pilot at meaningfully greater scale
```

---

*This report reflects a static, read‑only review completed on 2026‑08‑31 against commit `28d7f2f` on branch `demo`. No source file, schema, or database was modified in the course of this audit.*
