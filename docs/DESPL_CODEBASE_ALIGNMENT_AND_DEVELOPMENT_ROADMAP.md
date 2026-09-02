# DESPL CODEBASE ALIGNMENT & DEVELOPMENT ROADMAP

**Audit date:** 2026-09-01
**Repository:** `DESPL TRACKER` (`swayams13/despl-production-tracker`)
**Branch audited:** `chore/B1-docs-drift-corrections`, HEAD `8f81c58` (2 commits ahead of `demo`, 79 ahead of `main`)
**Working tree:** dirty — 6 modified files uncommitted (`assembly.service.ts`, `assembly.service.test.ts`, `bom-route.ts`, `bom-route.test.ts`, `bom.read.ts`, `qcp.service.ts`)
**Method:** read-only forensic inspection. 71 Prisma models, 25 enums, 40 migrations, 281 TS/TSX source files, 70 Vitest files, 2 Playwright specs, 23 `page.tsx` routes, 20 Server Action modules, 7 API routes, all of `docs/mos-blueprint/` (24 documents), `CLAUDE.md`, `railway.json`, `.github/workflows/ci.yml`, `progress.md`. Nine parallel evidence passes, each carrying file:line citations, then a verification pass in which every P0 claim was re-checked by hand against the source.
**Not run:** no test suite executed, no database queried, no build performed, no browser session. Claims that depend on runtime are marked **UNVERIFIED**.
**Nothing was modified.** No source file, schema, migration, or seed script was created, edited, or deleted.

---

## 1. EXECUTIVE SUMMARY

### The one-paragraph answer

The architecture is sound and should be preserved. The engineering discipline inside the service layer — transaction-local RLS, DB-grant-enforced append-only audit, row-locked state machines, maker-checker with no admin exception, a CPM engine verified against a printed 119-day envelope, 49 stable error codes, a boot guard that refuses to start on a privileged DB role — is materially better than typical pre-pilot work and there is nothing here that needs rebuilding. But this audit found **four defects that no previous document in this repository names**, three of them P0, and one of them changes the assessment of what the system currently is:

> **No code path anywhere in `src/` creates a `Component`, a `ComponentOperation`, or an `AssemblyStep`.** Every job created through the application's own intake wizard gets a schedule spine and nothing underneath it. The pilot job works only because a developer ran `scripts/seed-despl320-components.ts` out of band. On a UI-created job, six of the eight cross-stage gates pass unconditionally, per-component progress is empty, and the system degrades from a system of control to a status board.

That single fact invalidates the Master Blueprint's own acceptance-test row *"Generate Work → `JobProcess`/`ComponentOperation`/`AssemblyStep` → **PASS**"* (`reference/19` §1), and it re-prioritises the roadmap: the highest-value next work is not the family-bootstrap UI, it is making a new job actually executable.

### The four findings this audit adds

| # | Severity | Finding | Evidence |
|---|---|---|---|
| **N1** | **P0** | No service or action creates `Component` / `ComponentOperation` / `AssemblyStep`. Only `prisma/seed.ts` and four `scripts/*.ts` do. | `grep` across `src/` returns zero matches for `component.create`, `componentOperation.create`, `assemblyStep.create`; `job-intake.service.ts` creates only Job/JobProcess/JobProcessEdge/Equipment/Unit/QCP-clone/BomItem (lines 145, 169, 202, 221, 231, 442–498, 545) |
| **N2** | **P0** | Excluding an optional process at intake permanently deadlocks every successor of that process. This is the *one* per-job deviation feature the product actually ships, and it bricks the job. | Wizard writes exclusions (`jobs/new/_client.tsx:696`) → `job-intake.service.ts:185` sets `included:false` and copies edges for **all** processes (`:202`) → `computeEnvelope` drops excluded nodes (`envelope.ts:64`) so no `ProcessPlan` row exists → `loadGate` reads **raw** edges with no `bypassExcluded` splice (`process.service.ts:92`) → `loadPredecessorStates` defaults a missing plan to `NOT_STARTED` (`_shared.ts:843`) → `assertCanStart` refuses forever (`gating.ts:49`) |
| **N3** | **CRITICAL (security)** | A shared production password `despl123@` is committed to the repository with `mustChangePassword: false`, for four department accounts — two of which (`fabrication@`, `qc@`) let the same human submit under one login and verify under the other, defeating maker-checker. | `scripts/create-department-accounts.ts:21, 55-62` |
| **N4** | **P0 (latent)** | `PAINTING` operations can be started and submitted but **never verified** — the DFT gate has no UI writer. Together with unreachable packing/dispatch/NCR-disposition services, publishing template v2 (which tags PACKING/DISPATCH evidence) would create permanently un-verifiable terminal stages. | Gate at `component.service.ts:345-367`; writers `recordPaintRecord:466` / `recordDftReading:500` have zero callers; no `actions/paint.ts`, `actions/dispatch.ts`, `actions/packing.ts`, `actions/ncr.ts`, `actions/override.ts` exist (`ls src/app/actions/`) |

### What is true, and worth defending

The blueprint's central claim survives scrutiny: **there is no family-specific branch anywhere in the gating, scheduling, or authorization engines.** `gating.ts` has zero department-awareness. `withTenant()` makes "was this write transactional" and "was it tenant-isolated" the same guarantee. `audited()` makes "every mutation is audited" true by construction rather than by convention. The `ProcessPlan` state machine locks the row, re-reads status from the database, runs the gate, and writes status + audit + domain event in one transaction, every time, with no client-settable status path and no admin bypass on maker-checker. Template versioning has the only correct optimistic-concurrency implementation in the repo. This is a good system.

### Where the project actually is

**STAGE 4–5 (Core Workflow → Department Modules), not Stage 6+.** The count of shipped phases (0 through 5) overstates progress because Phase 5 shipped service-layer-only, and because the execution layer beneath the schedule spine is unreachable from the product. Functional capability, not file count: a pressure-vessel job that a developer seeds runs end-to-end through Finish; a job that a user creates does not.

### Direction verdict

**🟡 PARTIALLY — direction is correct, corrections are required before continuing.** Reasons in §22.

---

## 2. SYSTEM UNDERSTANDING

**What DESPL MOS is.** A single system of record and execution for how Dhruv EPC Solutions takes a fabrication order from intake to dispatch, across every department and (intendedly) every product family, enforcing one shared set of rules — sequencing, maker-checker, hold points, append-only audit — regardless of which product is being built.

**What it actually is today.** A high-integrity, single-tenant, one-family production tracker with genuinely generic underlying mechanisms and a pilot job (DESPL-320) whose execution data was placed by seed scripts rather than by the application.

**Stack (verified, not assumed).** Next.js 15.5 App Router + React 19 + Tailwind v4; Server Actions for every mutation; Prisma 6 against PostgreSQL 16; pnpm; Vitest + Playwright; deployed to Railway with NIXPACKS, `preDeployCommand: pnpm exec prisma migrate deploy`, healthcheck `/api/health`. Single modular monolith, no separate backend service. `src/lib/services/` (24 `*.service.ts` + 22 `*.read.ts`) holds essentially all business logic.

**The domain shape.** Not one linear chain. A `Job` root with **three coexisting tracks**:

```
Fabrication track:   Component → ComponentOperation → ComponentOperationRejection → Ncr
Assembly track:      AssemblyTemplate→Version→Step ⇒ AssemblyStep → AssemblyStepRejection → Ncr
Scheduling spine:    ProcessTemplate→Version→TemplateProcess ⇒ JobProcess → ProcessPlan (+ JobProcessEdge = CPM DAG)
```

reconciled **not by a foreign key** but by numeric-string equality: `operation.leadTimeProcessSeq === Number(jobProcess.code)` (`_shared.ts:479-484`, and in SQL at `20260827040000_v_process_plan_percent/migration.sql:38`).

The "8-stage lifecycle" is a reporting projection: one 36-process DAG (`seed/lead-time-model.json`) crosswalked to a 25-stage display rollup (`TemplateProcess.workOrderStages`).

---

## 3. SOURCE-OF-TRUTH HIERARCHY — AND A CORRECTION TO IT

The brief specifies: **Level 1 codebase → Level 2 Master Blueprint → Level 3 Architectural Decisions 0–20 → Level 4 other docs.** That hierarchy assumes the blueprint and decisions were authored *before* the code and describe intent. **They were not.**

Verified: `docs/mos-blueprint/` is **untracked in git** (`?? docs/mos-blueprint/`), created **2026-09-01 11:26** — six hours before this audit. Its own header states it was produced by *"converting the existing codebase … and the completed forensic audit into a canonical target architecture"* (`DESPL_MOS_BLUEPRINT.md:94`). `docs/DESPL_MOS_FORENSIC_AUDIT.md` is dated 2026-08-31 and is also untracked. "Architectural Decisions 0–20" are not 21 dated ADRs accumulated over the project's life; they are chapters `reference/01`–`20` of that one-day-old document set, plus `reference/20` which contains 15 principles and 7 open decisions (D1–D7).

**The two genuine ADRs** — the only decision records that predate and constrain the code — are `docs/ADR-mobile-and-architecture-v1.md` (18 Aug) and `docs/ADR-product-family-agnostic-platform-v1.md` (26 Aug). `CLAUDE.md`'s twelve invariants are the real, load-bearing decision record: they are dated, referenced from code comments, and enforced by tests.

**Consequence for this audit — stated plainly:** the question *"are we building the system we designed?"* cannot be answered by comparing code to `docs/mos-blueprint/`, because that folder is a description of the code, not a specification for it. Comparing them measures **how accurate the description is**, not whether the build is on-plan. So this audit answers three questions instead:

1. Is the blueprint's description of the code accurate? *(§6 — mostly yes, with 5 identified errors it inherits from its source.)*
2. Do the code and the two real ADRs plus `CLAUDE.md`'s invariants agree? *(§6, §7 — yes on 10 of 12 invariants; two are half-true.)*
3. Is the plan the blueprint proposes the right plan given what the code actually does? *(§25 — directionally yes, sequence wrong in three places.)*

**Recommendation:** commit `docs/mos-blueprint/` and `docs/DESPL_MOS_FORENSIC_AUDIT.md` to git (they are currently untracked and would be lost by a `git clean`), and re-label the reference chapters as what they are — an architecture *description and target*, not decisions. Keep `CLAUDE.md` as the invariant contract.

---

## 4. MASTER BLUEPRINT SUMMARY

`DESPL_MOS_BLUEPRINT.md` (175 lines) plus 20 reference chapters plus 4 execution chapters. Its substantive positions:

| # | Position | This audit's view |
|---|---|---|
| 1 | The product is a multi-family manufacturing MOS; DESPL-320 is the calibration pilot, not the spec. | **Agree.** |
| 2 | Architecture requires **no structural change**; every remaining item is additive. Zero subsystems classified REBUILD. | **Agree**, with one qualification: N1 (no execution-layer materialisation) is not "additive tooling", it is a missing core service. |
| 3 | Preserve the modular monolith — four invariants depend on single-transaction atomicity. | **Strongly agree.** Verified: gating, maker-checker, hold points and same-transaction audit all sit inside one `withTenant` transaction. |
| 4 | Three-layer domain: MOS Core (family-agnostic) → Operational Framework → Product-Specific Execution (data, not code). | **Agree**; the boundary matrix in `reference/16` §3 is accurate against actual code placement. |
| 5 | The single highest-leverage gap is the absence of self-serve family/route/QCP bootstrap. | **Disagree on ranking.** It is the highest-leverage gap *for the multi-family thesis*. It is not the highest-leverage gap for the pilot, which is N1. See §21/§25. |
| 6 | No file storage exists anywhere; this is a total gap. | **Agree, and would raise its severity.** For ASME/PED pressure equipment the MDR *is* the commercial deliverable. |
| 7 | Delay propagation is manual, not automatic. | **Agree, and worse than stated**: the only re-planning path (`applyDurationOverride`) has no Server Action *and* refuses any job with units (`override.service.ts:66-72`) — i.e. every real job. It is not "manual", it is unreachable. |
| 8 | Job-level isolation has no DB backstop. | **Agree.** |
| 9 | Four literal couplings remain. | **Agree on the list; the count is higher** — see §7 and the coupling table. |
| 10 | ~85% of an excellent single-family tracker; ~45% of a company-wide MOS; 12–16 solo engineering weeks remaining (revised to 16–22 in `execution/24`). | **The tracker figure is too high given N1.** ~70–75% of a single-family tracker is defensible once "a user can create a working job" is included in the denominator. The MOS figure (~45%) is fair. |

**Blueprint factual errors found (all inherited from the 31 Aug audit, none newly introduced):**

| Claim | Location | Reality |
|---|---|---|
| "27 of 71 models carry `tenantId`" | `DESPL_MOS_BLUEPRINT.md:170`, `reference/03` §5, `reference/15` | **22 of 71.** `grep -c "tenantId  *Int" prisma/schema.prisma` → 22. |
| "48 stable error codes" | `reference/20` principle 12 | **49** (`src/lib/shared/errors.ts:11-108`). Trivial, but it is a verification claim. |
| "19 real `page.tsx` routes, two stubs" | `reference/16` §4 | **23 routes, three stubs** (`/alerts`, `/board`, `/profile`). |
| Acceptance test: "Generate Work → `ComponentOperation`/`AssemblyStep` → **PASS**" | `reference/19` §1 | **False** — see N1. This is the consequential one. |
| CLIENT_VIEWER is "a reserved but unbuilt role" | `reference/01` §1 | Wrong; the client portal is built. `execution/24` §1 already self-corrects this. |

`execution/24` ("What the Build Plan Does Not Cover") is the strongest document in the set — it identifies that the plan was built from technical evidence and therefore missed the 27 open DESPL business questions in `BUILD-SPEC-v2.md` §7, the absence of any delivery channel for the digest, and the entire adoption/rollout workstream. That self-criticism is correct and this audit adopts it.

---

## 5. "ARCHITECTURAL DECISIONS 0–20" SUMMARY

Reading `reference/01`–`20` as the decision set they are presented as:

**Chapters 01–02 (product & operating model).** Defines the product boundary (starts at `Job`; no Sales, no GL, no PLM, no capacity planning). 13 data-driven departments. Real chain is a 36-process DAG, not the brief's linear default. **Code agrees.**

**Chapter 03 (domain model).** Names the three-track model and the numeric-code join as the single highest silent-break risk. **Code agrees; risk confirmed** — and this audit adds that the join is *fail-open*: a non-numeric `JobProcess.code` makes `assertComponentOpsComplete` and `assertNoOpenNcr` silently return without gating (`_shared.ts:479`, `:552`).

**Chapter 04 (departments).** Department is a data row; dashboard tier is a hardcoded array. **Code agrees.**

**Chapter 05 (project/job/equipment).** `Job` is the project root; no `Project` entity needed (D2). `Equipment → Unit → Component/AssemblyStep`. **Code agrees at the schema level**; `Unit` can only be created at intake — there is no add/remove-unit service.

**Chapter 06 (product family).** Mechanism real, bootstrap absent. **Code agrees, and the gap is wider than stated**: `ProductFamily`, `RouteTemplate`, `AssemblyTemplate` and QCP *authoring* all have zero service functions. Even `createTemplateAction` exists (`actions/template.ts:22`) but is **never imported by any UI**.

**Chapter 07 (workflow/routing).** Gating and scheduling deliberately separate; the 25-stage table should be replaced by a projection of the job's route. **Code agrees; still open** (`stage-names.ts:10-36`, `workspace.read.ts:231`).

**Chapter 08 (BOM/material/procurement).** Procurement is an append-only 4-value event enum with no vendor, no PO, no expected-delivery-date — so "delayed" is not computable. **Code agrees.** Add: **two conflicting definitions of "available stock"** live simultaneously (`bom-explosion.ts:86-91` subtracts SCRAP only; `stock.service.ts:77-82` subtracts ISSUE+SCRAP and adds RETURN).

**Chapter 09 (scheduling).** Real CPM, envelope-verified, not capacity-aware, manual delay propagation. **Code agrees**, except propagation is unreachable rather than manual (see §4 row 7).

**Chapter 10 (production execution).** Scored 5/5, strongest area. **Code agrees at the process grain.** At the component grain it is unreachable on UI-created jobs (N1).

**Chapter 11 (QC/NCR).** Maker-checker and hold points real, no bypass; W-waiver schema-only. **Code agrees.** Add two findings: `verifyAssemblyStep` **auto-writes a `QcpExecution` with `result: "ACCEPTED"`** for INSPECTION steps (`assembly.service.ts:250-256`), so the hold-point gate on the assembly path is satisfied by the same click it was meant to constrain; and `dispositionNcr` has no caller, making `REWORK_IN_PROGRESS` and `DISPOSITIONED` unreachable states.

**Chapter 12 (documents).** Missing entirely. **Confirmed** — zero matches for multipart, S3, presigned, blob upload, or any storage SDK.

**Chapter 13 (people/RBAC).** Six roles, DB-resolved per request, deny-by-default, enforcement scattered by convention. **Code agrees and is better than described**: session versioning invalidates every session on password reset; `requireActor` enforces the forced-password-change lock; `assertMakerChecker` deliberately excludes ADMIN.

**Chapter 14 (management/KPI/alerts).** Real KPIs, no framework, two missing alert triggers. **Code agrees; the duplication is larger than stated** — **41 distinct KPIs** computed across six read files, with ~15 independently reimplemented, including cycle-time computed against **two different calendar-resolution paths**.

**Chapter 15 (data architecture).** 71 models; job-level isolation has no backstop. **Agrees** (with the 22-not-27 correction).

**Chapter 16 (target architecture).** Keep the monolith; name conceptual boundaries; AI stays out of gating/RBAC/audit/scheduling. **Agree in full.**

**Chapter 17 (gap matrix).** 20 rows, severity-ranked. **Directionally right; incomplete** — it does not contain N1, N2, N3 or N4.

**Chapter 18 (roadmap).** Phases A–J. **Sequence needs three changes** (§25).

**Chapter 19 (acceptance tests).** Ten self-review questions; 7 pass, 3 partial. **This audit scores 5 pass, 4 partial, 1 fail** (§20).

**Chapter 20 (decisions).** 15 principles, 10 anti-patterns, 7 open decisions D1–D7 with recommendations. **All 15 principles are sound and this audit endorses them unchanged.** Principle 15 — *"build the mechanism ahead of the tooling, but name the tooling debt"* — is the single most useful sentence in the set, and N1 is the case where that debt was not named.

**Dependencies, contradictions, supersessions across 01–20:** because all 24 chapters were authored in one pass, there are **no superseded decisions and no internal contradictions** — the classic ADR-drift failure mode does not exist here. The contradictions that do exist are between the chapters and the **code** (the five errors in §4), and between the chapters and **`CLAUDE.md`** (which still lists the client portal as "do NOT build yet" though it shipped 19 Aug — `execution/24` §1 catches this).

---

## 6. ARCHITECTURE CONSISTENCY AUDIT

### A. Decision ↔ code alignment table

| Decision / principle | Intent | Depends on | Code alignment | Conflict | Action |
|---|---|---|---|---|---|
| P1 Job data never product-hardcoded | `familyId`/`templateVersionId` drive behaviour | — | **ALIGNED** in engines; **VIOLATED** at 5 call sites | `admin.read.ts:63`, `stage-names.ts:10-36`, `workspace.read.ts:231`, `welding.service.ts:24`, `specs.ts:30` | B4/B5/B7 |
| P2 DESPL-320 is data, not architecture | No pilot literal in `src/` | P1 | **VIOLATED** | `workspace/page.tsx:10` — still present after five phases and one false "fixed" claim | B3 |
| P3 Workflows are configuration-driven | Template, not code path | — | **ALIGNED mechanically, UNREACHABLE operationally** | No authoring path for family/route/assembly/QCP | Phase C |
| P4 Templates versioned; publish immutable | New version on edit | — | **ALIGNED** — `template.service.ts:210-225`, the repo's only correct stale-write check | — | Preserve |
| P5 Jobs pin immutable snapshots | Frozen at intake | P4 | **ALIGNED** | — | Preserve |
| P6 Execution is event/audit-driven | Audit in same transaction | — | **ALIGNED, DB-enforced** — `audited()` + `REVOKE UPDATE,DELETE` | — | Preserve |
| P7 Dependencies process-to-process | Department-agnostic gating | — | **ALIGNED** — `gating.ts` has zero department awareness | — | Preserve |
| P8 Management views derive from operational truth | No separate status field | P7 | **ALIGNED** — `blocking`/`waitingOnOthers` from the same CPM data | — | Preserve |
| P9 Security enforced server-side | Never client-trusted | — | **ALIGNED** — 69/69 actions gated; every schema `.strict()`; server-clock timestamps | — | Preserve |
| P10 AI never replaces deterministic rules | — | — | **ALIGNED** (no AI present) | — | Preserve |
| P11 Gating ≠ scheduling | Lags relax dates, never gates | P7 | **ALIGNED in the engine, BROKEN in the wiring** | **N2** — `loadGate` doesn't splice excluded nodes | **P0 fix** |
| P12 Refusals explainable, never silent | 49 named codes | — | **ALIGNED for AppError; VIOLATED for races** — `toActionError` rethrows raw `P2002` (`_action.ts:11`); zero `P2002` handling anywhere | Also `assertKitReady` / `assertDrawingReleased` / `assertComponentOpsComplete` fail **silently open** | P1 fix |
| P13 Vocabularies are data, not enums | Reference tables | — | **ALIGNED** — 7 tenant-scoped ref tables, no exception found across 71 models | — | Preserve |
| P14 Corrections create versions | Nothing overwritten | P4 | **ALIGNED** — zero soft-delete, status-based lifecycle, append-only ledgers | — | Preserve |
| P15 Mechanism before tooling, name the debt | — | — | **PARTIALLY** — debt named for family bootstrap, **not named** for the execution layer (N1) or the Phase-5 UI | — | This audit names it |

### B. `CLAUDE.md`'s twelve invariants — enforcement status

| # | Invariant | Status | Evidence |
|---|---|---|---|
| 1 | No client timestamps | **TRUE** | every request schema `.strict()` (`schemas.ts:26-30`); actuals from server clock (`process.service.ts:125,229`) |
| 2 | Hard sequential gating (+ component-grain material gating) | **TRUE at stage grain; INERT at component grain** — text was corrected by B1 and is now accurate about the no-op, but the no-op is universal because no component rows exist (N1) | `gating.ts`, `_shared.ts:684,690,704` |
| 3 | Maker-checker, no exceptions incl. admins | **TRUE** | `authz/index.ts:144-149`, ADMIN deliberately absent; tested |
| 4 | Hold points block; W waivers need PH approval and are audited | **HALF-TRUE** | `assertNoOpenHoldPoint` real (`_shared.ts:413`); `waiverApprovedBy` **never written by any service**; and `assembly.service.ts:250-256` auto-accepts the checkpoint |
| 5 | Append-only audit, same transaction, no UPDATE/DELETE grant | **TRUE, DB-enforced** | `audited()`; `REVOKE` in `20260813051500` and `20260827180000`; boot guard `db-guard.ts:47` |
| 6 | No destructive edits | **TRUE in practice** | zero `deletedAt`; only two `deleteMany` sites, both scoped |
| 7 | Unfiled delay blocks further work | **TRUE** | `assertNoUnfiledDelayBlock` (`_shared.ts:377`) |
| 9 | Published templates immutable | **TRUE** | `template.service.ts:201-225` |
| 10 | Never sum durations — use the envelope | **TRUE** | `envelope.ts` + `cpm.ts`, verified against printed 119-day figure |
| 11 | Lags relax schedule, never gating | **TRUE in engine, DEFEATED by N2** | `gating.ts:49` vs `process.service.ts:92` |
| 12 | Free-shaped specs never touch scheduling | **TRUE** | `specs.ts` walled off; `Job.specs` unreferenced in schedule code |

*(Invariant 8 is not separately enumerated in the current `CLAUDE.md` numbering.)*

### C. Contradictions, supersessions, violations

- **Contradictions between decisions:** none found (all authored in one pass).
- **Superseded decisions:** none.
- **Unimplemented decisions:** P3 (configuration-driven workflows — no authoring surface), P15's naming obligation for the execution layer.
- **Decisions accidentally violated by current code:** P2 (`workspace/page.tsx:10`), P11 (N2), P12 (raw `P2002` leakage; three silently-open gates), invariant #4 (assembly auto-accept).
- **Decisions that should be revisited on evidence:** **D1** — the blueprint recommends "(b) DB CHECK now, (a) FK later" for the numeric join. Evidence supports **going straight to (a)**: the join is not merely a break risk, it is *actively fail-open* today (`_shared.ts:479`), and it is family-unscoped (`OperationRef` is tenant-scoped while `JobProcess.code` is job-scoped), so a second family will silently pull pressure-vessel mappings. A CHECK constraint does not fix either problem.

---

## 7. CODEBASE FORENSIC AUDIT — DOMAIN MODEL

### What exists, and at what fidelity

| Entity | Exists | Works | Generic | Created by the app? | Verdict |
|---|---|---|---|---|---|
| Organization / Client / User / Role / Department | Yes | Yes | Yes | Yes (admin UI) | COMPLETE |
| ProductFamily | Yes | Yes | Yes | **No — seed only** | PARTIAL |
| ProcessTemplate / Version / TemplateProcess / TemplateEdge | Yes | Yes | Yes | Clone/edit/publish yes; **create-from-nothing no** (action exists, never imported) | MOSTLY COMPLETE |
| RouteTemplate / Version / RouteStep | Yes | Yes | Yes | **No — seed only** | PARTIAL |
| AssemblyTemplate / Version / Step | Yes | Yes | Yes | **No — backfill script only** | PARTIAL |
| QcpTemplate / QcpItem / QcpExecution | Yes | Yes | Yes | Clone-at-intake only; **no authoring** | PARTIAL |
| Job | Yes | Yes | Yes | Yes | COMPLETE except `Job.status` has **no writer at all** |
| Equipment / Unit | Yes | Yes | Yes | Intake only; no add/remove service | PARTIAL |
| BomRevision / BomItem | Yes | Yes | Yes | Yes — manual + Excel import | COMPLETE (no unique constraint — see §8) |
| ProcurementEvent | Yes | Yes | Yes | Yes | PARTIAL — no vendor, no PO, no due date |
| StockLot / StockTxn / MaterialIdentification | Yes | Yes | Yes | Yes | COMPLETE (race on over-issue guard) |
| **Component / ComponentOperation** | Yes (schema) | Yes (services) | Yes | **NO** | **BLOCKED — N1** |
| **AssemblyStep** | Yes | Yes | Yes | **NO** | **BLOCKED — N1** |
| WeldJoint / WeldLog / NdtResult / Welder | Yes | Yes | Yes | Yes | COMPLETE |
| Ncr | Yes | Auto-open/auto-close only | Yes | Partially — **no disposition path** | PARTIAL |
| PaintRecord / DftReading | Yes | Yes (service) | Yes | **NO UI** | **STUB (operationally)** |
| Package / DispatchBatch / DispatchBatchUnit | Yes | Yes (service+tests) | Yes | **NO UI** | **STUB (operationally)** |
| ProcessPlan / ScheduleRun / JobProcess(+Edge) | Yes | Yes | Yes | Yes | COMPLETE |
| DelayReason | Yes | File only | Yes | Yes | PARTIAL — `reviewStatus` dead |
| AuditLog / DomainEvent | Yes | Yes | Yes | Yes | COMPLETE |
| Notification | Yes | Yes | Yes | Yes | MOSTLY COMPLETE — 2 triggers missing |
| ProgressSnapshot / client portal | Yes | Yes | Yes | Yes | MOSTLY COMPLETE |
| **Document / attachment / photo** | **No model at all** | — | — | — | **MISSING** |

### Mis-modelled or dead schema surface

Fields with **no writer anywhere**: `ComponentOperation.sourcing`, `Component.parentComponentId`, `Component.bomItemId` (set only by seed, hardcoded `null` in `seed-despl320-components.ts:107`), `Component.governingDrawingId` (seed only), `ClientVisibilityPolicy.requiresApproval`, `QcpExecution.callGivenOn` / `callAttendedOn` / `waiverApprovedBy`, `DelayReason.reviewStatus` / `reviewedBy`, `Ncr.reworkDueDate` (never read), `TemplateStatus.ARCHIVED`, `BomRevisionStatus.DRAFT`, `Job.priority` (editable, never read by the prioritizer), `JobProcess.included` (written at intake — and see N2).

### Hardcoded couplings in live (non-seed, non-test, non-script) code

| # | Literal | File:line | Impact |
|---|---|---|---|
| 1 | `jobNumber: "DESPL-320"` | `src/app/(app)/workspace/page.tsx:10` | The main shop-floor screen defaults to the pilot job by name. **Still open**, contradicting `PHASE-PROMPTS.md`'s (now-corrected) claim. |
| 2 | `family: { code: "PRESSURE_VESSEL" }` | `src/lib/services/admin.read.ts:63` | A non-PV admin cannot reach their duration editor at all. |
| 3 | `SPEC_FIELDS.PRESSURE_VESSEL` | `src/lib/shared/specs.ts:30` | A new family gets zero spec fields. Documented as an accepted code-change point. |
| 4 | 25-name `STAGE_NAMES` table | `src/lib/shared/stage-names.ts:10-36` | PV vocabulary applied tenant-wide. |
| 5 | `const STAGE_COUNT = 25` | `src/lib/services/workspace.read.ts:231` | A 26th stage renders "Stage 26 of 25". |
| 6 | `OFFICE_DEPT_CODES` | `src/lib/services/command-center.read.ts:35` | A 14th department → `notFound()`. |
| 7 | `ALL_DEPT_CODES` (13 literals) | `command-center.read.ts:42-50` | Same. |
| 8 | `PIPELINE_LABELS` (6×6 strings) | `command-center.read.ts:61+` | 36 English strings keyed to DESPL's codes. |
| 9 | `code: "FABRICATION"` | `src/lib/services/welding.service.ts:24-25` | Throws `NOT_FOUND` for any tenant not using that exact code. |
| 10 | `operationCode === "CUTTING"` | `component.service.ts:203` | Drawing gate keyed to a string. |
| 11 | `operationCode === "PAINTING"` | `component.service.ts:345` | DFT gate keyed to a string (and see N4). |
| 12 | Role codes triplicated | `schemas.ts:345`, `:366`, `admin/employee-csv.ts:16` | Three copies of one 6-value list. |
| 13 | `"QC"` / `"PRODUCTION_HEAD"` string literals in notification routing | `process.service.ts:185`, `notifications.service.ts:79,262,297` | `ROLES` const exists and is bypassed. |
| 14 | `placeholder="e.g. 320SR"` | `jobs/new/_client.tsx:814` | Cosmetic. |

**Blueprint says four; there are fourteen**, of which 9 are functional rather than cosmetic. None is structural — all are call-site literals over a generic mechanism — but the standing "no literal in `src/`" rule is not being enforced by anything, which is why B10 (a CI guard) matters more than any individual fix.

---

## 8. DATABASE AUDIT

**Counts:** 71 models · 25 enums · 40 migrations · 139 `@@index` · 42 `@@unique` · 167 FKs (45 CASCADE / 68 RESTRICT / 54 SET NULL) · 22 models with `tenantId` · 13 models with any timestamp · **1** model with `updatedAt` · **0** soft-delete columns · **0** attachment tables.

### Strengths (preserve)

- **RLS is fail-closed and was deliberately migrated from fail-open.** `20260813052000_rls_fail_closed/migration.sql:29-36`:
  ```sql
  CREATE POLICY tenant_isolation ON %I
    USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::int)
  ```
  Unset GUC → NULL → zero rows on read, rejected on write.
- **Append-only enforced at the grant layer**, not by convention: `REVOKE UPDATE, DELETE ON audit_log, domain_events FROM despl_app` (`20260813051500:43-44`), extended to `procurement_events`, `stock_lots`, `stock_txns` (`20260827180000:9-11`).
- **Views are `security_invoker = true`** — the non-obvious right answer, taken.
- **RLS coverage is machine-verified** by `src/lib/rls-coverage.test.ts:11-38`, which fails CI if any table with a `tenant_id` column lacks a policy.
- **Reference-table-not-enum policy** applied without exception across 71 models.
- **The one destructive migration is exemplary** — `20260827120001` backfills inside the migration, guards before and after, is idempotent, documents its own rollback.
- Real DDL-only constraints where Prisma cannot express them: NCR XOR CHECK, two partial uniques on `ProcessPlan`, equipment-grain partial unique on `Component`.

### Defects

**P0**

- **DB-C1 — The execution↔schedule join is string→int coercion with no FK, no unique key, no referential integrity, and it fails open.** `OperationRef.leadTimeProcessSeq` / `AssemblyTemplateStep.leadTimeProcessSeq` matched against `JobProcess.code` by regex-then-cast (`_shared.ts:479-484`; SQL at `20260827040000:38`). Three failure modes: (i) `OperationRef` is tenant-scoped, `JobProcess.code` is job-scoped — a PIPE_SPOOL job with code `"12"` silently pulls PRESSURE_VESSEL mappings; (ii) a non-numeric code makes `assertComponentOpsComplete` and `assertNoOpenNcr` return without gating; (iii) an orphan seq is a silent no-op. **Neither of the two `lead_time_process_seq` columns is indexed**, and both are the inner predicate of all four correlated subqueries in `v_process_plan_percent`.
- **DB-C2 — `prisma db seed` runs the *demo* seed by default.** `package.json`'s `prisma.seed` points at the unqualified `tsx prisma/seed.ts`; production-safety is gated on `SEED_REFERENCE_ONLY=1`, set only by a separate script. `prisma migrate reset` auto-invokes the seed hook. The demo seed creates users with `mustChangePassword: false` (`seed.ts:917`) and password `despl-dev-only` when `SEED_PASSWORD` is unset (`seed.ts:1489`) — behind only a `console.warn`.

**P1**

- **DB-C3 — Two migrations `GRANT` to `despl_web`, a role no migration creates.** `20260815120000:87` and `20260827040000:66`. `despl_web` is created only by `scripts/provision-db-role.sql`. **On a fresh database `prisma migrate deploy` fails at migration 7 of 40.** CI works around this explicitly (`ci.yml:63-70`); `railway.json`'s `preDeployCommand` does not. **Any new environment — including a staging environment or a restore-drill target — is currently undeployable.**
- **DB-C4 — `QcpTemplate` has no `tenantId` and a nullable `jobId`**, and the application deliberately reads across it: `job-intake.read.ts:90` queries `OR: [{ job: { tenantId } }, { jobId: null }]`, and `job-intake.service.ts:425-428` allows cloning such a template. Every tenant can list and copy every other tenant's orphan QAP.
- **DB-C5 — Hold-point binding resolved by fuzzy string match** against a deliberately non-unique key (`AssemblyTemplateStep.qcpSrNo` → `QcpItem.srNo`, 62 items across 43 sr numbers). `scripts/seed-despl320-assembly-steps.ts:109-127` uses token-overlap scoring with threshold 0.5 and leaves `qcpItemId` null on failure — silently un-gating that hold point, indistinguishable from "no hold point applies".
- **DB-C6 — "One current schedule run per job" is enforced only by an application row lock.** No partial unique on `is_current`; the demote is scoped `(jobId, equipmentId)`, so a job-grain and an equipment-grain run can both be current, and `jobs.read.ts:96-101` double-weights percent-complete across them — feeding every percent surface including the client portal.
- **DB-C7 — `BomItem` has no unique constraint of any kind.** 4 indexes, 0 uniques. A re-run import silently duplicates every line and every downstream quantity. For a traceability system this is the most consequential missing constraint.
- **DB-C8 — Cross-tenant FK combinations are structurally unpreventable.** No table has an `(id, tenant_id)` unique key, so no FK can carry the tenant; FK checks bypass RLS. Cheap to fix now, expensive after tenant #2.
- **DB-C9 — Timestamp coverage is 13 of 71; `updatedAt` exists on one model.** `Job` has no `createdAt`. No incremental-sync cursor exists for the offline outbox the mobile ADR plans.
- **DB-C10 — Three columns added nullable with backfills deferred to scripts the deploy path never runs** (`bom_items.bom_revision_id`, `bom_items.qty_per`/`uom`, `assembly_template_steps.lead_time_process_seq`). Null `lead_time_process_seq` silently returns zero mapped operations — which reads as "nothing to gate".

**P2/P3 (abbreviated)** — ~30 unindexed FK columns; **38 of 139 indexes (27%) are exact prefixes of another index**; 6 dead single-column enum indexes; `Package.weightKg` emitted as `DECIMAL(65,30)`; polymorphic `aggregate_id` stored as text then joined with `::int` at six call sites, defeating its own index; no soft-delete backstop while `despl_app` holds `DELETE` on every table; `MaterialIdentification.componentId onDelete: SetNull` silently orphans heat-number traceability.

### Migration quality

40 migrations, lexically monotonic, lock file correct. **Two confirmed edited-after-apply** (`20260827120001`, documented in its own header; and the Phase-5 migration, whose first pass used `prisma db push` and required `migrate resolve --applied`, per `progress.md:180-186`). Any environment that applied the pre-edit versions will fail `migrate deploy` with a checksum mismatch (P3009). **Four DB objects exist with no `schema.prisma` counterpart** (two partial uniques on `process_plans`, one on `components`, the NCR CHECK) — real drift that `prisma migrate dev` will offer to DROP. **Two migrations hardcode pilot data**: `WHERE "client_id" = 1` and an unconditional `UPDATE "users" SET theme_preference='DARK'` with no `WHERE` clause at all.

### Scale verdict

**The model graph scales; the read layer on top of it does not.** No redesign needed. What breaks first, in order:

1. **`v_unit_stage_status`** — its `governing` CTE cannot receive the caller's `job_id` predicate, so it sorts `units × job_processes × unnest(work_order_stages)` for the *entire database* on every stage-spine render. O(total DB size) per request. Breaks at ~3,000–10,000 units (~75–250 jobs).
2. **`v_process_plan_percent`** — four correlated subqueries per plan row against two **unindexed** columns, read on the jobs list, workspace, job detail and client snapshot. Breaks at ~50–150 jobs.
3. **`domain_events` `aggregate_id::int` joins** — six call sites, index defeated by the cast. Breaks at ~1–5M events.
4. **`ProgressSnapshot`** — schema comment claims "15M rows collapse to ~50k"; the real grain is `(jobId, unitId, asOf)` with a JSON blob, i.e. 14.6M rows/year at 1,000 jobs on a DAILY cadence, unpartitioned, with no retention policy.
5. `AuditLog`/`DomainEvent` at ~20M rows (correctly anticipated in the schema).

**The one structural gap that will force new tables:** document/photo metadata. When it lands it will be the highest-row-count table in the system and must be designed with `tenant_id` + RLS from day one.

---

## 9. BACKEND AUDIT

### Layering — the strongest thing in the repository

Zero `prisma.*` calls exist outside `src/lib/db.ts`, `db-guard.ts`, `tenant-resolution.ts` and the health probe. Zero direct DB access in any React component. `withTenant()` (`db.ts:71`) opens the transaction, sets `set_config('app.tenant_id', …, true)` (transaction-local — the one correct way with a pooled connection), and pins UTC. `db-guard.ts:48-77` crashes the server at boot if `DATABASE_URL` points at a superuser or a role holding UPDATE/DELETE on `audit_log`.

Four page-level leaks (ad-hoc queries that should be read models): `workspace/page.tsx:9-12`, `my-day/page.tsx:24-27`, `command/[dept]/page.tsx:29-31`, plus the defensible pre-auth `actions/auth.ts:42-87`.

### Module status

| Module | Status | Key file |
|---|---|---|
| Job intake | IMPLEMENTED | `job-intake.service.ts:45` |
| Project/job | IMPLEMENTED (but `Job.status` has no writer) | `jobs.read.ts:57` |
| Equipment/unit | PARTIAL — created only at intake | `job-intake.service.ts:220` |
| Product family | PARTIAL — no create path | `specs.ts:30` |
| Process templates & versioning | IMPLEMENTED (create-from-nothing unwired) | `template.service.ts:201` |
| Scheduling / CPM | IMPLEMENTED | `cpm.ts`, `schedule.service.ts:43` |
| **Gating** | **INCORRECT** — N2 | `gating.ts:38`, `process.service.ts:92` |
| BOM + Excel import | IMPLEMENTED | `bom.service.ts:26,268` |
| Procurement | IMPLEMENTED (thin) | `procurement.service.ts:19` |
| Stock / material | IMPLEMENTED (race on over-issue) | `stock.service.ts:20` |
| **Component ops (fabrication)** | **BLOCKED** — services correct, no rows exist | `component.service.ts:167` |
| **Assembly** | **BLOCKED** — same | `assembly.service.ts:69` |
| Welding / NDT | IMPLEMENTED | `welding.service.ts:121` |
| QC / QCP | IMPLEMENTED | `qcp.service.ts:50` |
| NCR | PARTIAL — `dispositionNcr` has zero callers | `ncr.service.ts:75` |
| Paint / DFT | **BUILT-BUT-UNREACHABLE** | `component.service.ts:466,500` |
| Packing | **BUILT-BUT-UNREACHABLE** (no test file either) | `packing.service.ts:27,69` |
| Dispatch | **BUILT-BUT-UNREACHABLE** (373-line test file, zero callers) | `dispatch.service.ts:68-248` |
| Schedule override | **BUILT-BUT-UNREACHABLE** + refuses jobs with units | `override.service.ts:37,66-72` |
| Delay reasons | PARTIAL — review deferred | `delay.service.ts:31,73` |
| Notifications | IMPLEMENTED (lazy reconciliation) | `notifications.service.ts:33` |
| Digest | PARTIAL — manual, in-app only, **no delivery channel exists anywhere** | `reports.service.ts:17` |
| Admin / users / departments | IMPLEMENTED | `admin.service.ts` |
| Reporting / exports | PARTIAL — one xlsx route | `api/jobs/[id]/qcp/export/route.ts` |

### State machines

Four grains share one matrix checker (`state-machine.ts:12`), each row-locked with `SELECT … FOR UPDATE`, re-read from DB, gate-checked, then written with audit + domain event in one transaction. No client can set a state. Timestamps are server-clock only. Stale-run writes throw `STALE_WRITE`.

Defects: `resume` always lands on `IN_PROGRESS` (a plan held while SUBMITTED loses its submission — documented); `Ncr.REWORK_IN_PROGRESS` and `DISPOSITIONED` are **unreachable states** in the running product; `DispatchBatch`'s entire machine is unreachable.

### Other backend defects (ranked)

- **P1 — Stock over-issue guard is check-then-write with no row lock** (`stock.service.ts:64-114`), unlike every other mutating service. Two concurrent 80 kg issues against a 100 kg lot both pass; the lot goes to −60.
- **P1 — `loadJobs` runs 2N+ transactions and is called from the app shell on every page** (`jobs.read.ts:158-165` + `(app)/layout.tsx:9`). Its own docstring claims "(no N+1)".
- **P1 — Concurrent QCP execution recording collides on the attempt-number unique index** (`qcp.service.ts:21-25`) and surfaces as an unmapped `P2002` 500.
- **P2 — Raw Prisma errors leak past the error contract on every check-then-insert race.** `toActionError` rethrows non-`AppError` (`_action.ts:11`); zero `P2002` handling exists anywhere in `src/`.
- **P2 — Command Center 500s for every office department if any single job has a cyclic spine** (`command-center.read.ts:225` uses bare `computeCpm`, while `myday.read.ts:182` and `workspace.read.ts` both defend with `computeCpmSafe`/`computeOrRefuse`).
- **P2 — Packing/dispatch mutations carry only `assertNotClientUser`** — no role gate on five functions including `recordDispatch`, a commercial act.
- **P2 — No pagination anywhere.** 20 of 22 read models are unbounded; zero cursors; one list has filtering; one has sorting; **no text search exists in the application at all**.
- **P3 — No idempotency or double-submit protection at any entry point.**
- **P3 — Eight raw `Error` throws in `src/lib/schedule/` bypass the error contract.**

**TODO census: 1 TODO, 0 FIXME, 0 HACK across 281 files.** Unusually clean.

---

## 10. FRONTEND AUDIT

**23 `page.tsx` routes.** 20 real and fully wired to real read services; **3 stubs** — `/alerts`, `/board`, `/profile`, all rendering "coming in R2".

**No mock, dummy, or fixture data exists anywhere in `src/app` or `src/components`** — every `placeholder` hit is an HTML input attribute. The one demo scaffold (`/kit`) was deliberately deleted. This is unusually clean and worth stating.

**Architecture is genuinely strong:** exactly one `use client` page in the whole app (`/login`, which must be). Every other page is a server component that authenticates, authorises, reads, and hands typed props to a `_client.tsx` island. Permission booleans are computed server-side and are **purely cosmetic** in the UI — the server re-reads roles from the DB on every request. **No client-side authorization anywhere.**

### Missing UI for existing backend

Four service modules have **zero UI importers**: `dispatch.service`, `packing.service`, `ncr.service`, `override.service`. Plus `recordPaintRecord`/`recordDftReading`. Plus:

- **NCR/rework data is computed on every page load and thrown away.** `qc-cockpit.read.ts:249-262` computes `rework: {openCount, totalReworkHours}` (2 extra queries per `/qc` hit) and `qc/_client.tsx` never renders it. Same for `DeptCard.openReworkCount` and `DeptDetail.openReworkItems`.
- **A dead viz library** — `src/components/viz/*` (6 files, ~680 LOC, 0 importers) including a fully interactive S-curve with keyboard tooltip and sr-only table, while `dashboard/page.tsx:415-482` hand-rolls a worse static one inline.

### Defects

| Sev | Finding | Evidence |
|---|---|---|
| **P0** | **Below 1024px, 8 of 11 real screens have no navigation entry point.** The tablet rail and phone bottom nav share one 4-item array — and **three of those four are the R2 stubs**. A supervisor on a shop-floor tablet can reach My Day and three "coming soon" pages. | `app-shell.tsx:120-125`; `globals.css:753,771-772,805` |
| **P0** | PAINTING can be submitted, never verified — no UI for the gate that blocks it. | `errors.ts:102,176`; `component.service.ts:321,466,500` |
| **P1** | A user's second and later roles are invisible to the shell — `userRole={actor?.roles[0]}` gates the Admin nav, so `["SUPERVISOR","ADMIN"]` sees no Admin nav (pages still work; they're just unreachable). | `(app)/layout.tsx:62`, `app-shell.tsx:216,222` |
| **P1** | NCR disposition unreachable; rejections accumulate with no operator path. | `ncr.service.ts:75` |
| **P1** | The `/jobs` list is completely keyboard-inaccessible — whole-row `onClick`, no `tabIndex`, no focusable element; the `<Link>` was deliberately removed. Same pattern at 8 other sites. | `jobs/_row.tsx:6,12`; `jobs/page.tsx:65` |
| **P1** | No `global-error.tsx`; `/login`, `/portal`, `/account/password` sit outside the only error boundary. | `src/app/(app)/error.tsx` is the sole boundary |
| **P2** | ~110 inputs across the app have decorative `<label>`s with no `htmlFor`. Only 2 files use programmatic labels. | `jobs/new/_client.tsx` 28 inputs / 2 accessible names; `bom-panel.tsx` 28/8 |
| **P2** | Unguarded `oklch()` and `color-mix()` — zero `@supports` in `globals.css`. The sticky topbar background uses `color-mix()`; unsupported → transparent over scrolling content. Breaks below iPadOS 16.2. | `globals.css:54-117, 433, 542, 569-575, 835, 857` |
| **P2** | 20+ wide tables with no overflow container and no card view. | `jobs/page.tsx:47` (9 cols), `qc/_client.tsx:66`, `welding/_client.tsx:164`, `admin/_client.tsx:121,780,849`, etc. |
| **P2** | Invalid DOM nesting — a `<div>` dropdown inside a `<button>` in the notification bell; no outside-click or Escape dismissal on it or the job switcher. | `app-shell.tsx:450-492` |
| **P3** | 29 duplicated local date/format helpers across 20 files; `fmtDate` defined 10 times in 3 different output formats — the same job's due date renders differently on `/jobs` and `/jobs/[id]`. | — |
| **P3** | The whole job list is serialised into the RSC payload of every route, including routes where the switcher is `display:none`. | `(app)/layout.tsx:49`, `jobs.read.ts:59` |

### State handling

**Empty states are systematic and good** (~30 sites, context-specific sentences). **Loading: 3 `loading.tsx` for 23 routes** — the three that exist are excellent skeletons; the 20 that don't include every heavy screen. **Error: toast-only on most screens; `/my-day` is the reference implementation** (inline refusal code + sentence at the row). **`useOptimistic` appears zero times.** The `useRun` hook is reimplemented four times with four different behaviours.

### Shop-floor verdict

The responsive *machinery* is genuinely good — three shell variants, CSS-only breakpoint swaps (no `matchMedia`, so no hydration flash by construction), a coarse-pointer density layer raising controls to 48px and swapping status dots for icon+word, safe-area padding, `prefers-reduced-motion`. The *coverage* is a pilot slice: the nav goes nowhere real below 1024px, `ResponsiveTable` is used in 3 files, and **the e2e viewport suite tests the three stub pages** (`SHELL_PAGES = ["/my-day","/workspace","/board","/alerts","/profile"]`) while never checking `/jobs`, `/qc`, `/dashboard`, `/departments`, `/welding`, `/reports`, `/admin`. The "tablet" Playwright project is configured at 1024×768, which matches the desktop breakpoint — **so the 640–1023px icon-rail band is never exercised**, and the spec says so honestly at `:265-292`.

**Not shop-floor ready.**

---

## 11. AUTHENTICATION / RBAC AUDIT

### Coverage, established mechanically

Every exported function in `src/app/actions/*.ts` and `src/lib/services/*.service.ts` was enumerated by a brace-depth parser and cross-checked by hand:

- **69 Server Actions. 66 call `requireActor()`.** The 3 that do not are correct by design (`login`, `logout`, and `changePassword`, which must run for an actor whose `mustChangePassword` flag `requireActor` would refuse).
- **88 service functions. None reachable over HTTP lacks a check.** 67 carry an explicit `require*`/`assert*`; 15 are pure or read-only; 6 are `tx`-level internal helpers whose every caller was verified to hold the gate first.
- **6 API route handlers, all gated** — 5 via the `route()` wrapper which **blocks client users by default** with an explicit `allowClient` opt-in.

### Genuine strengths

- **Session invalidation without a session table.** `sessionVersion` in the JWT, compared against the live DB value every request; incremented on password change and admin reset. An admin reset kills every existing session for that user.
- **Roles are deliberately not in the token** — re-read from the DB per request with `active: true`, so revocation and deactivation take effect on the next request.
- **The boot-time DB-role guard** converts the most common silent regression in this class of app ("someone pointed prod at the superuser") into a hard boot failure.
- **argon2id** with a `try/catch` that turns a malformed hash into "wrong password" rather than a crash; byte-identical error messages for unknown tenant / unknown user / inactive user / wrong password, with e2e tests asserting it.
- Cookie: `httpOnly`, `sameSite=lax`, `secure` in production, 12-hour `maxAge` matching JWT `exp`.
- **Maker-checker has no admin exception**, and `claimPlan` deliberately avoids `requireDepartmentScope` because that helper lets ADMIN/PH bypass — which would be wrong for claiming into a pool.

### Gaps

- **Enforcement is scattered by convention, not structurally intercepted.** A new mutation that forgets its `require*` call ships with no check and nothing catches it. This is the single most important RBAC improvement available (build item H5).
- **Five dispatch/packing mutations stop at `assertNotClientUser`** — no role, no department scope. Latent only because nothing calls them.
- **Three stub pages omit the client-user redirect** every sibling page has.
- Middleware does not enforce the ≥32-char `AUTH_SECRET` minimum that `session.ts` does.
- Generated temp passwords are ~21.6 bits of entropy (mitigated by the login limiter).

---

## 12. FILE / STORAGE AUDIT

**There is no file storage of any kind. Zero bytes of binary content can enter this system.**

Exhaustive grep: `multipart` → 0. `S3Client` / `@aws-sdk` / `presigned` / `cloudinary` / `uploadthing` → 0. `formData` → 12, all login/password text fields. `blob` → a client-side CSV download. Schema fields matching `photo|image|attach|fileUrl|filePath|mimeType|storageKey` → **0**. `package.json` contains no storage SDK, no multer, no busboy.

| Artifact | Today |
|---|---|
| Production photographs | Nothing. `stage-sheet-launcher.tsx:301-303`: *"Photo evidence … deliberately omitted — R4 scope, blocked on the D20 object-storage decision"* |
| Drawings (PDF/DWG) | A free-text drawing number. `DrawingRevision` has revisionNo, status, three dates — **no file reference at all**. "RELEASED" is a status word attached to nothing. |
| MTC certificates | `MaterialIdentification.mtcRef String?` — a QC user types "MTC-4471" and nothing verifies a document exists |
| BOM workbooks | Parsed client-side into rows; the source workbook is discarded |
| Inspection reports / QCP records | Free text. One outbound xlsx export exists; nothing inbound |
| NDT reports | Result enum + recorder + timestamp. No film, no report |
| DFT readings | Numbers, `accepted` self-attested, with no spec'd range to check against |
| Dispatch paperwork | Four free-text string fields |
| **MDR** | Named as `ProcessEvidenceKind.MDR_COMPILED` with **no producer** — `_shared.ts:645-649` hardcodes `satisfied = false` |

**Assessment.** This is not a scaling problem; it is a categorical gap. For ASME/PED pressure equipment the commercial deliverable at dispatch *is* the MDR — the drawing set, MTCs, WPS/PQR, NDT reports, hydro chart, DFT log, stamped releases. This system can record that those things were *asserted*, never that they *exist*. The traceability chain (`heatNumber` + `mtcRef`) is currently unfalsifiable: a typo, a transposition and an invention are indistinguishable from a correct entry.

`execution/24` §N6 raises the right question and nobody has answered it: **does a maker-checker click satisfy the signature and record-integrity expectations a TPI or client will audit an MDR against?** Ask before Phase D's model is designed, not after.

---

## 13. PRODUCTION WORKFLOW AUDIT

### The actual DAG (36 processes, verified edge by edge from `seed/lead-time-model.json`)

```
1 PO Receipt →FS→ 2 Kick-Off →SS(-1)→ 3 Design Calc
   3 →SS(-3)→ 4 Mfg Drawings
        4 →SS(-1)→  5 CLIENT DRAWING APPROVAL   ◄── LEAF: nothing depends on it
        4 →FS(+10)→ 6 BOM & MTO FINALIZATION    ◄── LEAF: nothing depends on it
        4 →FS→ 8 Procure Pipes/Forgings, 9 Bought-Out Items
   3 →FS→ 7 Procure Plates
10 Material Receipt ← SS(-3) from 7, FS(+4) from 8, FS(+11) from 9
10 →SS(-2)→ 11 Material Identification →SS(-4)→ 12 Cutting
   12 →FS→ 13 Forming, 14 Machining →SS(-4)→ 15 Shell Fit-Up →FS→ 16 Shell Welding
   →SS(-5)→ 17 Weld NDE →SS(-4)→ 18 Head Assy →SS(-5)→ 19 Nozzle Fab
   →FS(+2)→ 20 Nozzle Welding →SS(-5)→ 21 PWHT →SS(-5)→ 22 NDE after PWHT
   →FS→ 23 Attachments →SS(-5)→ 24 Final Assy →SS(-2)→ 25 Dim →26 Visual →27 Hydro
   →SS(-2)→ 28 Drain/Dry →FS(+4)→ 29 Surface Prep →SS(-5)→ 30 Painting
   →FS(+4)→ 31 Final Insp →SS(-1)→ 32 Name Plate →FS→ 33 MDR, 34 Packing
   →SS(-2)→ 35 Dispatch Clearance →SS(-1)→ 36 Dispatch
```

### Two structural findings in the spine itself

1. **Processes 5 (Client Drawing Approval) and 6 (BOM & MTO Finalization) are DAG leaves.** Nothing names either as a predecessor. Procurement (7/8/9) depends on Engineering (3/4), **not on BOM**. So client drawing approval gates nothing, and BOM finalisation gates nothing.
2. **The chain 7→10→11→12 is all negative-lag START_TO_START**, and `gating.ts:49`'s `STARTED_STATUSES` includes `IN_PROGRESS` — so **Cutting may legally start when Procurement of Plates has merely *started*.** There is no material gate in the process spine at all. The only material gate is `assertKitReady` at the component grain, which is inert (below). This is by design per the lag model, but combined with N1 it means **no material control exists on a UI-created job at any grain**.

### Gates: which actually bite

| Gate | Status on live data |
|---|---|
| `assertCanStart` / `assertCanComplete` predecessor gating | **ACTIVE** (and deadlocks on excluded processes — N2) |
| `assertNoUnfiledDelayBlock` | **ACTIVE** |
| `assertMakerChecker` | **ACTIVE** |
| `assertNoOpenHoldPoint` | **ACTIVE at process grain, SELF-SATISFYING on the assembly path** (`assembly.service.ts:250-256` auto-writes ACCEPTED) |
| `assertKitReady` | **INERT** — returns early on null `bomItemId` (never set by any UI) and on zero stock lots |
| `assertDrawingReleased` | **INERT** — returns null on null `governingDrawingId`, which nothing in the app can set |
| `assertComponentOpsComplete` | **INERT on UI-created jobs** — no component rows exist (N1) |
| `assertNoOpenNcr` | **INERT on UI-created jobs** — same cause |
| `assertEvidenceSatisfied` | **INERT on the pilot** — DESPL-320 deliberately pinned to template v1, which carries no evidence tags |
| Paint/DFT gate | **NEVER FIRES on pilot routes; UNSATISFIABLE if it ever does** |

**Net: of ten cross-stage invariant gates, three bite on live data.**

### Cross-module propagation

| Link | Automatic? | Evidence |
|---|---|---|
| Drawing released → unblocks fabrication | **NO** — proc 5 is a leaf; the component-grain gate no-ops on a field nothing sets | `component.service.ts:203`, `_shared.ts:757` |
| Material shortage → blocks production | **NO** — no spine gate; component gate inert | `gating.ts:49`, `_shared.ts:690,704` |
| Filed delay → re-dates downstream | **NO** — `delay.service.ts` has zero scheduling imports; the only re-planning path has no action and refuses jobs with units | `delay.service.ts:47-68`, `override.service.ts:66-72` |
| Open NCR → blocks QC verify | **YES in `verifyProcess`; inert on UI jobs**. **NOT** in `verifyComponentOperation` — that path *closes* NCRs | `process.service.ts:223`; `component.service.ts:384-386` |
| Open NCR → blocks dispatch | **NO** — grep for `Ncr` in `dispatch.service.ts`: zero | — |
| Paint/DFT gates painting completion | YES in code, unreachable | `component.service.ts:345-367` |
| Unit not packed → blocks dispatch | YES in code, unreachable | `dispatch.service.ts:139-141` |
| Submitted → notify QC | **YES, in-transaction** | `process.service.ts:185-199` |
| Reject → notify maker | **YES, in-transaction** | `process.service.ts:285-298` |
| Job created → notify supervisors + PH | **YES, in-transaction** | `notifications.service.ts:65-98` |
| Stage overdue / hold aged | **LAZY** — full table scan on every authenticated page load | `notifications.service.ts:131`, `(app)/layout.tsx:42` |
| **Delay filed → notification** | **ABSENT** | `delay.service.ts` never imports `notify` |
| **NCR opened → notification** | **ABSENT** | `component.service.ts:434` creates the NCR silently |

### Duplicate sources of truth

| # | Fact | A | B | Disagreement |
|---|---|---|---|---|
| D1 | Material received qty | `bom.read.ts:158-166` (sum of RECEIPT events) | `bom-explosion.ts:83-93` (sum of StockLot qty) | `StockLot.sourceProcurementEventId` is optional; nothing reconciles them |
| D2 | "Available" stock | `bom-explosion.ts:86-91` (received − SCRAP) | `stock.service.ts:77-82` (received − ISSUE − SCRAP + RETURN) | Shortage gate and over-issue guard disagree by the issued quantity **by construction** |
| D3 | **Percent complete** | `v_process_plan_percent` (duration-weighted) — internal | `client-snapshot.read.ts:91-93` (unweighted mean of units) — **client portal** | **The client and DESPL see different completion numbers for the same job** |
| D4 | On-time % | 3 independent implementations | | |
| D5 | Cycle vs standard | `workspace.read.ts:715-734` vs `departments.read.ts:240-262` | | **Different calendar-resolution paths for identical arithmetic** |
| D6 | Stage names | `stage-names.ts` TS map | `seed/lead-time-model.json` | Nothing verifies they match |
| D7 | Department codes | `Department` table | `command-center.read.ts:35,42-50` | 14th department → `notFound()` |
| D8 | Stage count 25 | `workspace.read.ts:231` | 25 keys in `stage-names.ts` | Independent literals |

---

## 14. TASK / KPI / WORK MANAGEMENT AUDIT

### Current implementation — genuinely strong

`loadMyDay(actor)` (`myday.read.ts:127`) is the best thing in the product. It returns, per row: process name, serial, stage label and number, department, assignee, planned window, a six-state status (BLOCKED/READY/IN_PROGRESS/SUBMITTED/ON_HOLD/DONE), overdue flag, critical-path flag, float days, blocking-predecessor ids, and a **human sentence generated from real CPM/gating data** ("Waiting on: Shell Welding.", "Overdue — file a delay reason to continue."). Plus four buckets (mine / pool / teamHeld / completed), a scoreboard (30-day on-time %, done-this-week, avg cycle vs standard, first-pass rejects), a week strip, and the delay categories needed for the inline "file reason & start" flow.

Assignment is real (`claimPlan`/`assignPlan`/`releasePlan`, guarded by `NOT_IN_DEPARTMENT`, `ALREADY_ASSIGNED`, `ASSIGNEE_NOT_IN_DEPARTMENT`, `ASSIGNEE_INACTIVE`). Priority is derived by a genuinely good bucketing function (overdue > critical-path-actionable > ready > actionable/hold > blocked > done). Overdue is IST-correct, deliberately avoiding a 05:30 flip.

### Architecture requirement vs current

| Capability | Current | Requirement | Verdict |
|---|---|---|---|
| Employee login → day's work | Real, rich | — | **MEETS** |
| Assignment / claim / release | Real | — | **MEETS** |
| Priority | Derived, good | `Job.priority` exists and is **never read** — a second disconnected notion | **PARTIAL** |
| Progress | `v_process_plan_percent`, duration-weighted, correctly shared | — | **MEETS** |
| Completion | Real at plan/op grain; **absent at job grain — `Job.status` has no writer** | Job close ceremony | **PARTIAL** |
| Overdue | Real | — | **MEETS** |
| Manager visibility | `/dashboard`, `/departments`, `/command/[dept]`, `/reports`, `/qc`, `/jobs/[id]` | Equipment grain | **PARTIAL** |
| Historical performance | `domain_events` real; `ProgressSnapshot` **has zero rows in the seed**, so the digest renders today's live state | Real history | **PARTIAL** |

### KPI architecture

**41 distinct KPIs** are computed across six read files. **There is no framework.** Four islands of correct sharing exist — the `v_process_plan_percent` view, `job-health.ts`, `welding.read.ts:62`, and `lib/schedule/` — and **~15 metrics are independently reimplemented**: on-time % three times, cycle-time three times (two using different calendars), first-pass yield twice, overdue counts four times, rework counts twice, `hotCount` and `clearedToday` twice each.

The codebase knows: `v_process_plan_percent`'s migration comment says *"Every consumer computes its aggregate from THIS view so they can no longer disagree by construction"* — the right instinct, applied to one metric out of forty-one.

---

## 15. SECURITY AUDIT

| ID | Severity | Finding | file:line | Attack | Fix |
|---|---|---|---|---|---|
| **S1** | **CRITICAL** | Shared password `despl123@` committed, `mustChangePassword:false`, for 4 department accounts | `scripts/create-department-accounts.ts:21,55-62` | Repo read access → log in as `fabrication@` or `qc@`; the same human holding both **defeats maker-checker** (`assertMakerChecker` compares `userId`, and these are different userIds) — the invariant the QA record's credibility rests on | Delete the constant, take from env, `mustChangePassword:true`, replace shared logins with per-person accounts, rotate |
| **S2** | HIGH | **Zero HTTP security headers** — no CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy | `next.config.ts:3-5` (empty), `middleware.ts:26-60` (only `x-request-id`) | The app is framable → clickjack a supervisor into Verify/Reject; no CSP → any XSS sink becomes session-scoped RCE-in-browser; no HSTS → first-visit downgrade | ~15-line `headers()` block; `poweredByHeader:false` |
| **S3** | HIGH (latent) | 5 dispatch/packing mutations gated only by "is internal" | `dispatch.service.ts:68,108,220`; `packing.service.ts:27,69` | Any internal user marks any unit packed and any batch dispatched — the two evidence sources `assertEvidenceSatisfied` trusts. Unreachable over HTTP today | Add `requireRole(ADMIN, PRODUCTION_HEAD)` **before** wiring UI |
| **S4** | MEDIUM | Login limiter is per-identifier only | `actions/auth.ts:17,47-57,68-70` | (a) lock out any known user with 5 bad passwords; (b) password-spraying across identifiers is unthrottled; (c) unauthenticated flood of `audit_log` rows the app role **cannot delete** | Add an IP-keyed limiter; count pre-auth failures in a prunable table |
| **S5** | MEDIUM | `xlsx@^0.18.5` is knowingly unpatchable (fixes for CVE-2023-30533 and CVE-2024-22363 exist only on SheetJS's CDN); **CI has no dependency, secret or SAST scanning** | `package.json:57`; `ci.yml` | Browser-side `XLSX.read` parses attacker-supplied workbooks; nothing would ever tell you | Repoint at the SheetJS CDN tarball or swap parsers; add `pnpm audit --prod` + Dependabot/gitleaks |
| **S6** | MEDIUM | `pnpm.minimumReleaseAge: 0` disables the install-delay supply-chain guard | `package.json:34` | A freshly-compromised transitive dep is installed with no cooling-off window | Set to 1440 or remove the override |
| **S7** | MEDIUM | Unvalidated FK ids accepted into audited QA records | `qcp.service.ts:54-69` (`qcpItemId` never anchored), `welding.service.ts:161-173`, `component.service.ts:415,429`, `assembly.service.ts:295,317` | A QC user binds another job's inspection item to this unit in a permanent, un-deletable row (FK checks run with row security off). Verified **not** a gate bypass — corruption of the QA record, not a control bypass | Mirror `fileDelayReason`'s pattern: re-read each ref inside the tenant transaction |
| **S8** | MEDIUM | **49 of 71 tables (69%) have no `tenant_id` and no RLS** | `schema.prisma`; the 19-table array in `20260813052000` | One query path that forgets the relation-chain filter reads across tenants and RLS cannot save it — these tables have no policy to fail closed with. Not exploitable at one tenant; load-bearing thereafter | Denormalise `tenant_id` onto child tables before tenant #2, as the migration's own comment already commits to |
| **S9** | LOW | 3 stub pages omit the client-user redirect | `board/`, `alerts/`, `profile/page.tsx:5-6` | A CLIENT_VIEWER renders the internal shell (data is correctly filtered) | Add the redirect |
| **S10** | LOW | Middleware doesn't enforce `AUTH_SECRET` length | `middleware.ts:39` vs `session.ts:27-33` | Fail-closed downstream, but inconsistent | Assert at boot in `instrumentation.ts` |
| **S11** | LOW | ~21.6 bits of entropy in generated temp passwords | `admin.service.ts:50-62` | Impractical online given the limiter | Widen the word list |
| **S12** | LOW | Row lock taken before the tenant check | `_shared.ts:360` and 4 siblings | Lock-contention nuisance; no disclosure | Fold the tenant predicate into the `FOR UPDATE` |

**Explicitly checked and NOT found:** no `$queryRawUnsafe`/`$executeRawUnsafe`, no `Prisma.raw` concatenation (31/31 raw sites parameterized); no committed `.env`; **no `NEXT_PUBLIC_*` variables at all**; no CORS headers (deny-by-default); **no server-side file upload or path handling anywhere** — the whole path-traversal / unsafe-deserialisation class is absent by construction; no stack traces or `AppError.detail` reaching the client.

**RLS coverage: 22 of 71 tables (31%)** — exactly the tables with a `tenant_id` column, and no others. **Job-level isolation: zero database enforcement.** No policy keys on anything but `tenant_id`; no `app.job_id` GUC; no composite FK carries `job_id`. It works today only because every service function re-reads its target through the relation chain to a tenant-scoped root — which was verified as consistently applied, including explicit `CROSS_JOB_ASSIGNMENT` refusals in packing and dispatch.

---

## 16. SCALABILITY AUDIT

The team's own comments are unusually candid and this audit corroborates rather than discovers them:

> `myday.read.ts:26-30` — *"N-jobs-worth of queries (spine + CPM + prioritize per active job) … **fine at DESPL's 3-40 concurrently active jobs, batch before a tenant with hundreds.**"*
> `portfolio.read.ts:16-18` — *"`loadJobs()`'s extras … make this **roughly 2N+3 queries**."*
> `notifications.service.ts:119-121` — *"**a full table scan of current plans/hold-points per call**, fine at demo scale — move to a real cron."*
> `db.ts:61-67` — *"a real BOM workbook runs to hundreds of rows — plausible to exceed 20s … would throw a raw Prisma `P2028` … and roll back the WHOLE batch silently."*

| Sev | Finding | Evidence |
|---|---|---|
| **P0** | `loadMyDay` runs 3 queries + a full CPM computation **per active job** on the primary operator surface | `myday.read.ts:174,175,178,193` |
| **P0** | Identical shape in `loadCommandCenter` | `command-center.read.ts:219-232` |
| **P0** | `syncNotifications` full-table-scans plans + hold points **on every authenticated page load**, in two independent transactions, and re-runs the entire QC cockpit read | `notifications.service.ts:126-128`, `:305`, called from `(app)/layout.tsx:42` |
| **P1** | `loadJobs` opens **2 additional transactions per job** and backs both `/jobs` and `/dashboard` — and its own docstring claims "(no N+1)" | `jobs.read.ts:10,158-165` |
| **P1** | **No pagination on any primary list read** — 16+ unbounded services, zero cursors, one filterable list, no text search anywhere | listed in §9 |
| **P1** | **Prisma connection pool untuned in production.** `connection_limit` appears only in `ci.yml` and `.env.test`. `docs/ARCHITECTURE.md:74` explicitly requires sizing it before go-live | `db.ts:20-27` |
| **P2** | **No caching layer of any kind.** No Redis, no `unstable_cache`, no `revalidate`, no `React.cache`. CPM is recomputed for every active job on every request | absence across `src/` |
| **P2** | BOM import loops single-row inserts (~2 round-trips/row) under a 120s budget and a 1000-row cap — **acceptable by design** (per-row try/catch is what gives per-row failure reporting). Seeding, by contrast, batches correctly with `createMany` throughout | `bom.service.ts:270-313` |
| **P2** | 12 distinct N+1 loops in total (job intake, template clone, stage detail, client snapshot, departments, notifications fan-out) | §9 |

**Verdict:** sound for a 3–40-job pilot by the team's own stated ceiling. **The risk is not that the ceiling exists — it is that nothing measures the approach to it, because there are no metrics.**

---

## 17. DEVOPS AUDIT

### What actually happens on deploy

`railway.json`: NIXPACKS build → `preDeployCommand: pnpm exec prisma migrate deploy` → `pnpm start` → healthcheck `/api/health` (30s) → `restartPolicyType: ON_FAILURE`. **No branch key** — the branch binding lives in the Railway dashboard, so it is **UNVERIFIED from the repo**; `CLAUDE.md:21` ("auto-deploying from `main` — no separate staging environment exists yet") is the only in-repo evidence.

### Is the audited work deployed? — No

From `GIT-INFO.txt`: HEAD `8f81c58` is **79 ahead of `main`, 0 behind**; `demo` is **77 ahead of `main`**; `origin/main` last moved **2026-08-25**. **`main` — the deploy branch — has not moved in a week.**

Everything in **Phase 4** (BOM authoring, spreadsheet import, ProcurementEvent ledger, StockLot/StockTxn, DrawingRevision, append-only grants) and **all of Phase 5** (NCR workflow, ProcessEvidenceKind, paint/DFT gating, packing, dispatch) **is not deployed.** Production is running a codebase that predates the NCR module, the dispatch module, and the BOM import path entirely.

**Corollary — the highest-risk operational event in this project's near future:** when `main` finally advances, a single deploy will apply **~10 unapplied migrations at once**, including the destructive `procurement_events` backfill+drop and the entire Phase-5 schema, **with no staging environment to rehearse against** and **two migrations whose checksums were changed after being applied** elsewhere (P3009 risk). Additionally, **`DB-C3` means a fresh environment cannot run `migrate deploy` at all** — so a restore-drill target or a new staging environment would fail at migration 7 of 40 until that is fixed.

### CI

`ci.yml` triggers on PR→`main` and push→`main`/`demo`: `lint → typecheck → test → DB-gated tests → build`, with `prisma migrate deploy` run against a throwaway Postgres 16 — a step whose own comment says it *"was missing from the production deploy path and caused the 2026-08-24 outage."*

**The gate is genuinely good, and it is not connected to the deploy.** Railway watches the branch, not the CI status: **a red CI run does not block a deploy.** No branch-protection evidence in-repo (UNVERIFIED). **Playwright never runs in CI** — all 21 e2e tests, including the RBAC/client-scoping regression pins, are local-only and manually invoked.

### Environment

- `.env.example` is 4 lines and largely accurate. **`SEED_REFERENCE_ONLY` is undocumented.** **`SEED_PASSWORD` is documented but commented out** and defaults to `despl-dev-only` — if Railway's env does not set it, every seeded account on the pilot instance has a well-known password. **UNVERIFIED; single-command check; catastrophic downside.**
- **`.env.test` does not exist in the tree and there is no `.env.test.example`**, yet `pnpm test:db` hard-requires it and 8 test files reference its contents by name. **A new engineer cannot run the DB test tier** — which is ~60% of the suite's value.
- **`DIRECT_URL` (the table owner, which bypasses RLS *and* the append-only REVOKE) is required in the production runtime environment** because `railway.json` runs migrations there. The team identified this in `PHASE-PROMPTS.md:186` and it is not done. The same note flags "Rotate the Postgres password flagged on 22 Aug" — no evidence of completion.
- **Backups: absent.** No configuration, no `pg_dump` job, no restore procedure anywhere. `docs/ARCHITECTURE.md:95` sets RPO ≤15 min / RTO ≤4 hours via WAL archiving and demands a pass/fail restore drill; `:188` notes PITR needs a Railway plan upgrade **and ~4 weeks for the retention window to fill** — so this must start a month before go-live.

### Observability

| Capability | Status |
|---|---|
| Error tracking (Sentry/Rollbar/OTel/Datadog) | **ABSENT** — zero matches in `src/` or `package.json` |
| Metrics / tracing | **ABSENT** |
| Structured logging | **ABSENT** — **4 `console.*` calls in all of non-test `src/`** |
| Request correlation | **PRESENT** — `x-request-id` stamped in middleware, echoed by API routes |
| Health check | **PRESENT** — real `SELECT 1`, 503 on DB failure |
| Error boundaries | **PARTIAL** — `(app)/error.tsx` only; no `global-error.tsx` |

**What an operator has at 2am.** Almost nothing. The entire logging surface covers the 7 API routes. `src/app/actions/_action.ts` — the error mapper **every one of the 20 Server Action modules** funnels through — logs nothing. Since Server Actions are how *every mutation in this app* is performed, **the primary write path is entirely unlogged.** A failed floor entry produces a toast and an unstructured stack trace in Railway stdout with no request id, no actor, no tenant, no job number. There are no alerts; failures are discovered by a supervisor phoning someone.

---

## 18. TESTING AUDIT

**70 Vitest files (~662 `it()` sites), 2 Playwright specs.** Split is *pure* vs *DB-gated*: 28 pure-only, 42 containing `describe.skipIf(!RUN_DB_TESTS)` (54 blocks). **41 files instantiate a real `PrismaClient`; only 3 use `vi.mock`.** This codebase tests against real Postgres, not mocks — a genuine strength.

### Quality is high where it exists

- **`process.service.test.ts`** (981 lines) declares the legal transition table and then **computes the complement** — every illegal `(action, from)` pair — and asserts `INVALID_STATE_TRANSITION` on each. Same pattern in `ncr.service.test.ts`.
- **`gating.test.ts`** is table-driven across allowed *and* refused transitions, with named regression pins for both zero-lag edge cases.
- **`authz.test.ts`** includes an explicit `"admin is NOT an implicit superuser"` case.
- **`cross-tenant.test.ts`** runs against two real tenants via the owner client, and **honestly self-documents its own narrowness** (`:16-20`: a hand-curated entry-point list, "not a static-analysis sweep").
- **`bom.service.test.ts`** covers 2- and 3-level cycle refusal, cross-tenant create *and* update refusal, row-cap refusal, per-row failure isolation.
- **`rls-coverage.test.ts`** is a meta-test over `pg_class`/`pg_policy` that fails if any `tenant_id` table lacks a policy.

### The gap is scope, not quality

**There is no end-to-end test of Create Project → Unit → Engineering → BOM → Procurement → Production → QC → Dispatch. Proven three ways:**

1. `grep -i "bom|procure|dispatch|ncr|qcp|component|assembly|stock|intake"` across `e2e/*.ts` returns **three matches, all inside code comments**. Zero test bodies.
2. `createJob` is imported by exactly one test file; `dispatch.service` by two. **No file imports both.**
3. No test file imports 3+ of the seven workflow services, and the two that reach 3 build their fixtures with the **raw owner Prisma client**, bypassing `createJob` entirely (`process.service.test.ts:157-238`).

**Every suite verifies its own slice against hand-built fixtures that skip the upstream services. Nothing proves the seams hold.** This is precisely how N1 survived five phases: `job-intake.service.test.ts` asserts what `createJob` *does* write, and no test asserts what a created job needs in order to be executable.

### Other testing findings

- **`pnpm test` alone (the default script) silently skips the DB tier.** A developer without `.env.test` gets a green board that proves almost nothing about persistence, gating-in-transaction, or cross-tenant.
- `portfolio.read.test.ts:133` self-skips when fixture data is absent — a **silent-pass risk**.
- **Playwright: 12 `test.fixme`, 8 `test.fail`, 9 `test.skip`.** Used honestly as a defect ledger, but 4 are live defects on the operator-facing UI: `.btn-accent` at 48px not 56px on coarse pointers; my-day card actions 6px apart; **light-theme `.c-hold` chip at 4.45:1 (needs 4.5)**; **dark-theme spine idle fill at 2.20:1 (needs 3:1)** — two permanent WCAG AA failures with no owner.
- **No test exercises any Server Action through its real boundary.** 20 files carry `"use server"`; only `auth.ts` has a test and it mocks `next/headers`. `_action.ts` — the error mapper for all 20 — has zero tests.
- Migration correctness against production-shaped data: one backfill test for 41 migrations.

---

## 19. BLUEPRINT ↔ CODEBASE GAP MATRIX

| System Area | Blueprint Requirement | Decision ref | Current Implementation | Status | Gap | Sev | Required Action |
|---|---|---|---|---|---|---|---|
| Job intake | Create a job without a developer | `19` T1 | Full wizard, tested | **COMPLETE** for PV | Family must be bootstrapped | P1 | Phase C |
| **Work generation** | "Generate Work → JobProcess/**ComponentOperation/AssemblyStep** → PASS" | `19` §1 | **Only JobProcess. No component/assembly rows are ever created by `src/`** | **MISSING** | The execution layer | **P0** | **New Phase W** |
| Scheduling | CPM from template, envelope-verified | `09` | Real, verified at all 36 processes | **COMPLETE** | Not capacity-aware (accepted) | P3 | D3 |
| Gating | Predecessors gate; lags never relax gating | P11 | Correct engine; **wiring deadlocks on excluded processes** | **INCORRECT** | N2 | **P0** | Splice `bypassExcluded` into `loadGate` |
| Per-job process exclusion | "This client skips PWHT is a data operation" | `schema.prisma:16-18` | Implemented at intake — **and it bricks the job** | **INCORRECT** | N2 | **P0** | Same fix |
| Material gating | Procurement can block production | `19` T6 | `assertKitReady` real; **inert** — `bomItemId` never set | **STUB** | No material control on real jobs | P1 | Phase W + K7 |
| Drawing gate | Engineering release blocks fabrication | `02` §4 | Real; **inert** — `governingDrawingId` never set; proc 5 is a DAG leaf | **STUB** | Same | P1 | Phase W + link service |
| Maker-checker | No bypass incl. admins | Inv #3 | Enforced, tested | **COMPLETE** | Shared credentials defeat it operationally (S1) | **CRIT** | Rotate accounts |
| Hold points | H-coded checkpoints hard-block | Inv #4 | Real at process grain; **auto-satisfied on the assembly path** | **PARTIAL** | `assembly.service.ts:250-256` | P1 | Require explicit `qcpResult` |
| Witness waivers | PH approval, audited | Inv #4 | `waiverApprovedBy` **never written**; no `blocksCompletion` check | **MISSING** | Invariant half-true | P1 | G8 |
| NCR lifecycle | OPEN → disposition → rework → close | `11` | Auto-open + auto-close only; **`dispositionNcr` unreachable** | **PARTIAL** | Two states unreachable | P1 | G3 |
| Paint / DFT | Gate painting on accepted DFT | `11` | Gate exists; **no writer reachable** | **STUB** | N4 | **P0** | G4 |
| Packing / dispatch | Pack → release → dispatch | `04`, `08` | Full service + tests; **zero UI, zero actions** | **STUB** | Blocks end-to-end proof | P1 | G1/G2 |
| Delay propagation | Auto-suggest reschedule | `09`, F1–F3 | `fileDelayReason` has zero scheduling imports; **the only re-planning path has no action and refuses jobs with units** | **MISSING** | Worse than "manual" | P1 | Phase F, lift the unit refusal first |
| Documents / MDR | Object store + `Document` model | `12` | **Nothing. Zero storage of any kind** | **MISSING** | Total; MDR unproducible | P1 | Phase D |
| Product family bootstrap | Author family/route/QCP as data | `06`, `19` T2 | Zero create paths; `createTemplateAction` exists but is never imported | **MISSING** | The MOS gate | P1 | Phase C |
| Stage reporting | Derive stages from the job's route | `07`, B7 | 25 hardcoded names + `STAGE_COUNT = 25` | **INCORRECT** | PV vocabulary tenant-wide | P1 | B7/B8/B9 |
| Departments | Data rows, data-driven UI tier | `04` | Data rows ✅; **dashboard tier is a hardcoded array** | **PARTIAL** | 14th dept → `notFound()` | P2 | J7 |
| RBAC | Deny-by-default, server-side | P9 | 69/69 actions, 88/88 services gated | **COMPLETE** | Scattered by convention, no structural guard | P2 | H5 |
| Tenant isolation | DB-enforced, fail-closed | `15` | RLS fail-closed on **22 of 71** tables | **PARTIAL** | 69% is app discipline | P2 | S8 |
| Job-level isolation | DB backstop | `15` §4 | **None at all** | **MISSING** | Discipline only | P2 | H1 |
| Audit trail | Append-only, DB-enforced | Inv #5 | `audited()` + REVOKE + boot guard | **COMPLETE** | — | — | Preserve |
| Alerts | Event-driven, scheduled reconciliation | `14` | 7 event-driven ✅; overdue/hold **lazy on page load**; **delay + NCR trigger nothing**; `/alerts` is a stub | **PARTIAL** | — | P2 | E3/E4/E5/E7 |
| Digest delivery | Scheduled morning digest | `02` §5 | Manual button; **no email/WhatsApp/SMS integration exists anywhere** | **MISSING** | Delivers to a database | P2 | E1/E2/E9 |
| KPI framework | One shared function per metric | `14`, J6 | 41 KPIs, ~15 duplicated, 2 different calendars | **PARTIAL** | Cycle-time is genuinely wrong in one path | P2 | J6 |
| Client portal | Verified-snapshot-only external view | `execution/24` §1 | Real, tested, verified-only reads | **MOSTLY COMPLETE** | **Shows a different % than the internal dashboard** (D3) | P2 | Use the shared view |
| Procurement depth | Vendor / PO / due date | `08` | 4-value event enum; **none of the three exist** | **MISSING** | "Delayed" is not computable | P2 | Phase K |
| Observability | Structured logs + error tracking | `17` | 4 `console.*`; the entire mutation path is unlogged | **MISSING** | — | P2 | I1/I2 |
| Scalability | Batched reads, pagination | `17` | 12 N+1 loops, 3 on every page load; zero pagination | **PARTIAL** | Self-admitted 3–40-job ceiling | P2 | I3/I4/I5 |
| Security headers | Full header set + rate limiting | `13` | **None** | **MISSING** | Framable, no CSP | **HIGH** | H6/H7 |
| Backups / DR | RPO 15m / RTO 4h + restore drill | `ARCHITECTURE.md:95` | **Nothing configured or documented** | **MISSING** | Unproven restore on a QC system of record | **P0 (ops)** | N1 |
| Deploy hygiene | Deployed code = audited code | `17` | **`main` 79 commits behind HEAD; CI does not gate deploy** | **BLOCKED** | ~10 migrations will land at once | **P0** | Phase A |
| Testing | E2E of the full chain | `19` | **No test crosses more than 2 of the 7 workflow services** | **MISSING** | The seams are unproven | P1 | H4 + one E2E |
| Numeric join integrity | FK or enforced invariant | D1 | String→int coercion, unindexed, **fail-open** | **INCORRECT** | Silent cross-family match | P1 | H2 |
| Job lifecycle | A job can be completed | — | **`Job.status` has no writer anywhere** | **MISSING** | The job list grows forever | P1 | New item |

---

## 20. CURRENT STAGE ASSESSMENT

```
CURRENT STAGE:        STAGE 4 — Core Workflow  (entering STAGE 5 — Department Modules)
CURRENT PHASE:        Phase B (in progress) — B1/B2 landed; B3–B11 open
ESTIMATED COMPLETION: ~60% of Pilot MVP · ~35% of the company-wide MOS
CONFIDENCE:           High on the code findings (file:line verified, P0s re-checked by hand)
                      Medium on deploy state (Railway dashboard not inspected — repo evidence only)
                      Medium on runtime (no test suite executed, no browser session)
```

**Why Stage 4, not Stage 6.** Stage 4 means the core workflow runs end to end. It does — *for a seeded job*. Stage 5 (department modules) is genuinely underway: QC, welding, BOM/stores and procurement all have real department-facing surfaces. But Stage 5 is not complete, because dispatch, packing, NCR disposition and paint have services with no surface at all, and Stage 6 (integration) cannot be claimed while six of ten cross-stage gates are inert and no test crosses more than two workflow services.

**Against the ten self-review questions in `reference/19`** — this audit scores **5 PASS, 4 PARTIAL, 1 FAIL** (the blueprint scored 7/3/0):

| # | Question | Blueprint | This audit |
|---|---|---|---|
| 1 | New project without a developer? | Partial | **FAIL** — a new job is created but is not executable (N1) |
| 2 | New family without rewriting core? | Yes | **PARTIAL** — mechanically yes, no tooling |
| 3 | Two families, different routes? | Yes | **PASS** |
| 4 | One project, multiple jobs/equipment? | Yes | **PASS** |
| 5 | Departments independent via shared primitives? | Yes | **PASS** |
| 6 | Procurement blocks production? | Partial | **PARTIAL** — inert in practice |
| 7 | Delays propagate to delivery risk? | No | **PARTIAL** — the path exists but is unreachable |
| 8 | QC triggers rework? | Yes | **PARTIAL** — auto-open works; disposition unreachable |
| 9 | Management sees the company? | Yes | **PASS** |
| 10 | DESPL-320 as one instance? | Almost | **PARTIAL** — 9 functional literals remain, not 4 |

---

## 21. CURRENT PHASE ASSESSMENT — ARE WE PROGRESSING ACCORDING TO PLAN?

**Against the plan as written: yes, and the plan is being followed carefully.** Phase A items A1/A2 are pending (the deploy question is open). Phase B items B1 and B2 landed on the current branch, correctly, with a good commit message and a `progress.md` entry — exactly as `WALKTHROUGH.md` prescribes. The working tree contains in-flight Phase-B-adjacent work.

**Against reality: no, because the plan is aimed at the wrong first target.** The blueprint's own Phase C ("family bootstrap — *the* MOS gate") builds the on-ramp for a *second* family while the *first* family cannot produce an executable job through the product. Onboarding PIPE_SPOOL through a new admin UI would produce a second family whose jobs are equally un-executable.

**The separation the brief demands:**

| Maturity dimension | Score | Note |
|---|---|---|
| **Architecture maturity** | **8 / 10** | Sound, coherent, defensible. Nothing to rebuild. |
| **Documentation maturity** | **8 / 10** | Exceptional volume and honesty — 24 blueprint documents, 476KB `progress.md`, self-critical audits. Five factual errors, all inherited from one source, one of them consequential. |
| **Implementation maturity** | **5 / 10** | The engine is excellent; the surface is incomplete and the execution layer is unreachable. |
| **Testing maturity** | **5 / 10** | High-quality unit/service tier; no integration across service seams; e2e covers auth + responsive only. |
| **Production readiness** | **2 / 10** | Not deployed, no backups, no restore drill, no observability, no staging, a committed shared credential, and a fresh environment cannot even run migrations. |

**Documentation completion is not product completion.** Twenty-four blueprint documents, twenty numbered chapters, four prior audits and five shipped phases describe a system whose flagship shop-floor screen still defaults to a hardcoded pilot job number.

---

## 22. CORRECT-DIRECTION VERDICT

# 🟡 PARTIALLY — the direction is correct but corrections are required before proceeding

**Why not 🟢.** Four defects invalidate load-bearing claims in the current plan: (i) no code path creates the execution layer, so the plan's own acceptance test is wrong about the system's most important capability; (ii) the one per-job deviation feature the product ships permanently deadlocks the job; (iii) a shared credential committed to the repository operationally defeats the maker-checker invariant the whole QA record rests on; (iv) the audited work is not deployed, and when it is deployed it will apply ~10 migrations at once — including a destructive one and two with altered checksums — into an environment with no backups, no staging, and no proven restore.

**Why not 🔴.** Nothing found is structurally wrong. The domain model is correct. The transaction/RLS/audit substrate is better than most production systems. The gating and CPM engines are right and are verified against a printed schedule. The service boundary is real. Every defect above is a missing service, a missing wire, a missing gate splice, or a missing operational control — additive work on a sound foundation. The team's own habit of writing honest, self-critical, dated audits is rare and is the main reason this system is in good shape.

**What "corrections required" means concretely:** four items must land before any *new feature* work is trustworthy — the execution-layer materialisation (N1), the gating splice (N2), the credential rotation (N3), and the deploy reconciliation (Phase A). Together they are roughly one to two weeks. Everything else can then proceed on the blueprint's sequence, with the three re-orderings in §25.

---

## 23. BLOCKERS — P0 / P1 / P2 / P3

### P0 — must fix immediately (before any further feature development)

| ID | Blocker | Why it blocks | Evidence |
|---|---|---|---|
| **P0-1** | **No execution-layer materialisation.** `createJob` never creates `Component`/`ComponentOperation`/`AssemblyStep` | Every new job is an empty shell; 6 of 10 gates inert; component KPIs empty; the acceptance test is false | `grep` returns zero creates in `src/`; only `prisma/seed.ts` + 4 scripts |
| **P0-2** | **Excluded-process gating deadlock** | The one shipped per-job deviation feature permanently blocks the job | `process.service.ts:92` vs `cpm.ts:91` / `terminal.ts:30` |
| **P0-3** | **Committed shared credential `despl123@`**, `mustChangePassword:false` | Defeats maker-checker; exploitable by anyone with repo access | `scripts/create-department-accounts.ts:21` |
| **P0-4** | **Deploy state unknown/behind.** `main` 79 commits behind HEAD; CI does not gate deploy | Every "already built" claim may describe code nobody can see in production; the eventual merge is a ~10-migration, destructive, unrehearsed deploy | `GIT-INFO.txt`; `CLAUDE.md:21`; `railway.json` |
| **P0-5** | **`GRANT ... TO despl_web` in two migrations for a role no migration creates** | **A fresh environment cannot run `prisma migrate deploy` at all** — no staging, no restore-drill target, no disaster recovery is possible until this is fixed | `20260815120000:87`, `20260827040000:66`; workaround only in `ci.yml:63-70` |
| **P0-6** | **No backups and no proven restore** on a system of record holding QC hold-point and heat-number traceability | Contractual exposure, not inconvenience; PITR needs a plan upgrade **and ~4 weeks of retention fill** | `ARCHITECTURE.md:95,188`; nothing in the repo |
| **P0-7** | **Paint/DFT verify gate unsatisfiable; packing/dispatch/NCR-disposition unreachable** | Publishing template v2 creates permanently un-verifiable terminal stages | `component.service.ts:345`; zero callers for 8 service functions |

### P1 — fix before the dependent feature

| ID | Blocker | Dependent feature |
|---|---|---|
| P1-1 | `assertKitReady` / `assertDrawingReleased` inert — nothing sets `bomItemId` or `governingDrawingId` | Any material or engineering control |
| P1-2 | Numeric-code join has no FK, is unindexed, is family-unscoped and **fails open** | Any second family; any stage renumbering |
| P1-3 | `Job.status` has no writer | Job close, portfolio accuracy, list growth |
| P1-4 | `applyDurationOverride` has no action and refuses jobs with units | Phase F (delay propagation) entirely |
| P1-5 | Assembly-path hold points self-satisfy | Invariant #4 credibility |
| P1-6 | W-waiver never written; no `blocksCompletion` check | Invariant #4 |
| P1-7 | `BomItem` has no unique constraint | Any re-import; all downstream quantities |
| P1-8 | Stock over-issue guard has no row lock | Concurrent stores operations |
| P1-9 | Two conflicting "available stock" formulas; client vs internal % disagree | Material and client-facing correctness |
| P1-10 | No security headers | Pilot exposure |
| P1-11 | Below 1024px the nav reaches 1 real screen | Any shop-floor use |
| P1-12 | No E2E across the 7 workflow services | Every future refactor |
| P1-13 | No delivery channel for the digest (no email/WhatsApp/SMS anywhere) | Phase E |
| P1-14 | Server Action path entirely unlogged | Any incident response |
| P1-15 | `.env.test` missing with no example; `pnpm test` silently skips 60% of the suite | Any new engineer |

### P2 — fix during development

Job-level RLS backstop · `tenant_id` on the 49 uncovered tables · pagination + the 3 page-load N+1s · Prisma pool sizing · structured logging + error tracking · `Department.dashboardTier` · KPI consolidation (start with cycle-time, where the two calendars make it genuinely wrong) · `P2002` mapping in `toActionError` · `computeCpmSafe` in `command-center.read.ts` · procurement vendor/PO/due-date · BOM dedup / multi-sheet / UoM · the 9 remaining literals · role gates on packing/dispatch · IP-keyed login limiter · `pnpm audit` in CI · `minimumReleaseAge` · drop 38 redundant indexes, add ~30 missing FK indexes, index both `lead_time_process_seq` columns · fold the 3 deferred backfills into migrations · `QcpTemplate` tenant scoping.

### P3 — future improvement

Capacity-aware scheduling (D3) · equipment-grain dashboard · portfolio due-this-week / blocked bucket · `/board` and `/profile` · resume-from-hold state restore · DFT spec range · `DelayReason` review workflow · `Job.priority` wired into ranking or removed · `createdAt`/`updatedAt` across mutable tables · `ProgressSnapshot` partitioning + retention · date/format helper consolidation · the dead `viz` library (use or delete) · WCAG AA contrast fixes · i18n infrastructure.

---

## 24. REQUIRED CORRECTIONS — SMALLEST SAFE FIX FOR EACH P0

**P0-1 — Materialise the execution layer.** Add a block to `createJob`'s existing transaction that, for each `BomItem` whose `componentTypeId` resolves to a published `RouteTemplateVersion`, creates the `Component` (with `bomItemId` **set**) and its `ComponentOperation` rows — the loop `scripts/seed-despl320-components.ts:103-121` already runs, moved into the service. Do the same for `AssemblyStep` from `AssemblyTemplateVersion` per `Unit` (pattern at `scripts/seed-despl320-assembly-steps.ts:138`). *Do not* invent a new mechanism; lift the working ones. Setting `bomItemId` here also fixes P1-1's material half for free.

**P0-2 — Splice excluded nodes in the gating path.** In `loadGate` (`process.service.ts:88-95`), load the job's full spine and run `bypassExcluded(spine.processes, spine.edges)` — the exact function `computeCpm` already uses at `cpm.ts:91` and `terminal.ts:30`. It is already exported (`schedule/index.ts:7`) and already tested (`exclude.test.ts`). Take the spliced edge set for `plan.jobProcessId`. Two lines plus a spine load.

**P0-3 — Rotate the shared credential.** Delete the `PASSWORD` constant; read from `process.env`; set `mustChangePassword: true`; replace the four shared logins with per-person accounts before pilot. Then verify `SEED_PASSWORD` is set in Railway's environment, and rotate the Postgres password flagged on 22 Aug.

**P0-4 — Establish deploy truth.** Open Railway, record which branch the production service deploys from. Then decide and record: merge `demo` → `main`, or repoint Railway. **Rehearse the merge deploy against a restored copy of production before doing it** — and note that P0-5 must be fixed first, or the restore target cannot be built.

**P0-5 — Make migrations run on a fresh database.** Wrap both grants in `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='despl_web') THEN … END IF; END $$;` and move the canonical grant to `despl_app`, which the migrations do create. Ten minutes. This unblocks staging, restore drills, and disaster recovery simultaneously.

**P0-6 — Backups.** Enable PITR (Railway plan upgrade), then run one restore to a fresh instance and replay the DE0467 regression scenario against it, with a written pass/fail. Start now — the retention window takes ~4 weeks to fill.

**P0-7 — Wire or fence the unreachable services.** Either add `actions/paint.ts`, `actions/dispatch.ts`, `actions/packing.ts`, `actions/ncr.ts` (thin wrappers in the established `actions/stock.ts` shape) with role gates added first (S3), **or** — as an immediate stopgap — add a publish-time validation in `validateVersionForPublish` refusing any version that tags an evidence kind with no reachable producer, and do not publish or pin template v2 until the UI exists.

---

## 25. PHASE-WISE DEVELOPMENT ROADMAP

The blueprint's Phase A–K structure is sound and is retained. **Three changes:**

1. **Insert PHASE W (Execution Layer) immediately after Phase B**, and before Phase C. Nothing about the multi-family thesis matters while the first family's jobs are not executable.
2. **Promote Phase G (ship the built UI) from P3 to P1** and merge the safety-critical parts of it into Phase W. Paint, packing, dispatch and NCR disposition are not "already paid for, nice to demo" — they are unsatisfiable gates that will brick a job the moment template v2 is published.
3. **Split Phase A into A (deploy truth) and A′ (operational floor)** — backups, the fresh-database migration fix, and minimum logging. A′ is not optional before a pilot, and it currently sits in Phase I.

Phase L (business decisions) and Phase M/N (adoption, ops readiness) from `execution/24` are adopted unchanged and run in parallel on DESPL's calendar, not the developer's.

---

### PHASE 0 — Decisions that gate the build
**Objective.** Close the seven open decisions (D1–D7) plus the demo-vs-thesis fork, so the plan stops branching.
**Inputs.** This document; `reference/20` §3.
**Workstreams.** None — a meeting.
**Decisions.** D1 → **choose (a) real FK**, not (b): the join is fail-open and family-unscoped today, and a CHECK fixes neither. D2 (a) keep `Job` as root. D3 (a) advisory capacity. D4 (a) auto-suggest, human applies. D5 (a) no `Team` model yet. D6 (a) MOS starts at `Job`. D7 (a) defer cancellation. **0.8 — recommend "MOS thesis" ordering, but note that Phase W delivers most of what a demo needs anyway**, which largely dissolves the fork.
**Definition of Done.** Seven decisions recorded in a committed ADR. **Exit gate:** the ADR is in git.

---

### PHASE A — Establish deploy truth
**Objective.** Know with certainty what is running in production.
**Inputs.** Railway dashboard access.
**Workstreams.** Ops only.
- A1 Determine the production deploy branch **in the Railway dashboard**, not from `railway.json`.
- A2 Reconcile: merge `demo`→`main` or repoint Railway. Record the decision.
- A3 Verify `prisma migrate deploy` actually ran — a recent migration is visible in the production `_prisma_migrations` table.
- A4 Confirm lint + typecheck + full suite pass on whichever branch becomes canonical.
- A5 Decide staging: created now, or deferred in writing.
- A6 **Verify `SEED_PASSWORD` is set in the production environment** and that `prisma db seed` has never been run there.

**Files.** `railway.json`, `CLAUDE.md:21`, `.github/workflows/ci.yml`.
**Risks.** The merge applies ~10 migrations at once including a destructive drop and two altered checksums; **do not merge before A′-1**.
**Definition of Done.** A written answer to "what is live", a recorded reconciliation decision, and a production `_prisma_migrations` row from the last deploy.
**Exit gate.** The 79-commit divergence is zero, or is a recorded deliberate decision with a date.

---

### PHASE A′ — Operational floor (runs in parallel with A; blocks the merge)
**Objective.** Make it safe to deploy at all.
**Workstreams.**
- **Infra.** A′-1 fix the `despl_web` grants so a fresh database can migrate (**P0-5**) · A′-2 enable PITR and run one restore drill with a written pass/fail (**P0-6**) · A′-3 size `connection_limit` on the production `DATABASE_URL` · A′-4 remove `DIRECT_URL` from the runtime environment by moving migrations to a release-phase job with its own credentials.
- **Security.** A′-5 rotate the four shared accounts (**P0-3**) · A′-6 add the `headers()` block (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) · A′-7 add an IP-keyed login limiter and stop writing an unprunable `audit_log` row per pre-auth failure.
- **Observability.** A′-8 add logging to `src/app/actions/_action.ts` — one file, the funnel for all 20 action modules — with request id, actor, tenant, error code · A′-9 add error tracking keyed on `x-request-id` · A′-10 add `global-error.tsx`.
- **CI.** A′-11 branch protection so a red CI blocks the deploy · A′-12 add `pnpm e2e` to CI · A′-13 add `pnpm audit --prod` + secret scanning · A′-14 commit `.env.test.example`.

**Definition of Done.** A fresh database migrates cleanly; a restore has been performed and verified; a deliberately-thrown Server Action error appears in the error tracker with its request id; a red CI blocks a deploy.
**Exit gate.** The restore drill's written pass/fail exists.

---

### PHASE B — Truth in documentation, kill the literals
**Objective.** Restore the credibility of the "no literal in `src/`" rule and make it machine-enforced.
**Inputs.** Phase A (know what's live before changing it).
**Status.** B1, B2 landed (`776c0f3`). B3–B11 open.
**Workstreams.**
- **Backend.** B3 remove the `DESPL-320` fallback in `workspace/page.tsx:8-13` → job picker or the actor's most-recent active job · B4 parameterize `admin.read.ts:63` by `familyId` · B5 make `welding.service.ts:24` resolve its department by configuration · B6 replace `operationCode === "PAINTING"` with an `OperationRef` flag.
- **Frontend.** B7 delete `stage-names.ts`'s 25-name table and `STAGE_COUNT = 25`; project `TemplateProcess.name` in `seq` order for the job's own version · B8 `<StageSpine />` takes a route-derived array as props · B9 consume `workOrderStages[]` where a family defines one.
- **CI.** B10 a lint rule or test failing on `DESPL-320` / family-code / department-code literals in `src/`.
- **Docs.** B11 record `specs.ts` as a deliberate, accepted code-change point · B12 **add the third documentation-drift fix** — `CLAUDE.md` still lists the client portal as "do NOT build yet"; it shipped 19 Aug · B13 **commit `docs/mos-blueprint/` and `docs/DESPL_MOS_FORENSIC_AUDIT.md` to git** (both are currently untracked).

**Files.** `src/app/(app)/workspace/page.tsx`, `src/lib/services/admin.read.ts`, `welding.service.ts`, `component.service.ts`, `src/lib/shared/stage-names.ts`, `src/lib/services/workspace.read.ts`, `src/components/industrial/*`, `CLAUDE.md`, `.github/workflows/ci.yml`.
**Parallelizable.** B3–B6 (backend) and B7–B9 (frontend) are independent.
**Risks.** B7 touches the flagship UI; keep the PV labels identical by deriving them from the same seed data they were copied from.
**Definition of Done.** `grep -rn "DESPL-320\|PRESSURE_VESSEL\|\"FABRICATION\"" src/` returns nothing outside test fixtures, **and B10's guard fails the build if that changes**.
**Exit gate.** CI guard green on a deliberately-introduced literal.

---

### PHASE W — Make a created job executable  ★ NEW, and the highest-value phase in this plan
**Objective.** A job created through `/jobs/new` has a real execution layer, and the gates that depend on it actually bite.
**Inputs.** Phase B (so a second family doesn't immediately hit the `admin.read.ts` wall).
**Workstreams.**
- **Backend.** W1 materialise `Component` + `ComponentOperation` from BOM items × `RouteTemplateVersion` inside `createJob`'s transaction, **setting `bomItemId`** (P0-1) · W2 materialise `AssemblyStep` per `Unit` from `AssemblyTemplateVersion` · W3 splice `bypassExcluded` into `loadGate` (P0-2) · W4 add `linkGoverningDrawing(componentId, drawingId)` service + UI select, so `assertDrawingReleased` can bite · W5 fix `assertKitReady`'s silent no-op to distinguish "no BOM link" (legitimate seam) from "never stocked" (should refuse or warn) · W6 add `setJobStatus` with a guard refusing COMPLETE while any current-run plan is incomplete (P1-3) · W7 make `verifyAssemblyStep` require an explicit `qcpResult` instead of auto-writing ACCEPTED (P1-5).
- **Frontend.** W8 surface the materialised route in the BOM panel with real actionable ops (the projection already renders `id: null` for unmatched steps) · W9 job status control on `/jobs/[id]`.
- **Database.** W10 `@@unique([bomRevisionId, itemNo])` on `BomItem` (P1-7) · W11 index both `lead_time_process_seq` columns · W12 `SELECT … FOR UPDATE` in `loadLotForMutation` (P1-8).
- **Testing.** W13 **one DB-gated integration test** driving `createJob` → `generateSchedule` → `importBomItems` → procurement → component start/submit/verify → QC → NCR through the **real service entry points**, not owner-Prisma fixtures. This is the single highest-value test in the repository.
- **Infrastructure.** none.

**Files.** `src/lib/services/job-intake.service.ts`, `process.service.ts`, `_shared.ts`, `component.service.ts`, `assembly.service.ts`, `stock.service.ts`, `bom.service.ts`, `prisma/schema.prisma` + migration, `src/components/industrial/bom-panel.tsx`, new `src/lib/services/job-intake.integration.test.ts`.
**Dependencies.** Phase B for the literals; nothing else.
**Parallelizable.** W1/W2 (materialisation), W3 (gating splice), W10–W12 (database) are three independent tracks.
**Risks.** W1 makes intake meaningfully heavier — a 40-unit job could create thousands of rows in one transaction. Batch with `createMany` (the pattern already used at `job-intake.service.ts:169,202,231`) and measure against `db.ts`'s 20s timeout; consider a per-equipment materialisation step rather than all-in-one.
**Definition of Done.** A job created through the UI, with an excluded optional process, can be executed from Cutting through Final Inspection with material shortage genuinely refusing a start, an unreleased drawing genuinely refusing CUTTING, and an open NCR genuinely refusing a verify — demonstrated once, on screen, not asserted.
**Exit gate.** W13 passes in CI.

---

### PHASE G′ — Ship what is already built (promoted to P1, partly merged into W)
**Objective.** The tested Phase-5 services become reachable, and the gates they define stop being traps.
**Inputs.** Phase A (confirm the code is live), Phase W (so there is something to dispatch).
**Workstreams.**
- **Backend.** G′-1 add role gates to the five ungated packing/dispatch mutations **first** (S3) · G′-2 add `actions/paint.ts`, `actions/dispatch.ts`, `actions/packing.ts`, `actions/ncr.ts`, `actions/override.ts` as thin wrappers in the `actions/stock.ts` shape · G′-3 add the **missing QC→dispatch gate** — refuse packing or dispatch of a unit with an open NCR or an uncleared hold point (today gating runs only dispatch→process) · G′-4 wire the W-waiver approval and the missing `blocksCompletion` check (invariant #4) · G′-5 lift `OVERRIDE_NOT_SUPPORTED_WITH_UNITS` so re-planning works on real jobs · G′-6 add a publish-time validation refusing a template version that tags an evidence kind with no reachable producer.
- **Frontend.** G′-7 paint/DFT entry in the PAINTING op row · G′-8 NCR open/disposition/rework/close, rendered where `openReworkItems` and `cockpit.rework` are **already computed and discarded** · G′-9 packing + dispatch batch/release/record UI · G′-10 DFT acceptance range validated against a spec instead of self-attested.
- **Testing.** G′-11 extend W13 through packing and dispatch.

**Definition of Done.** One unit goes pack → release → dispatch through the UI on a real job re-pinned to the evidence-tagged template version, and a unit with an open NCR is refused at packing.
**Exit gate.** No service function in `src/lib/services/` has zero callers outside its own test file.

---

### PHASE C — Family / route / QCP self-serve bootstrap  ★ the MOS gate
**Objective.** An engineer authors a new family, its route, and its first QCP as data.
**Inputs.** B4 (family literal), Phase W (so a bootstrapped family produces executable jobs).
**Workstreams.**
- **Backend.** C1 `createProductFamily` (mirror `createDelayCategory`) · C2 author a `ProcessTemplate` + first version from scratch — **and wire the already-written `createTemplateAction`, which no UI imports** · C6 `RouteTemplate`/`Version`/`RouteStep` authoring · C7 `QcpTemplate` author-from-scratch including parties, items, P/W/H codes and `QcpItemProcess` mapping · C9 refuse intake against an unpublished version.
- **Frontend.** C3 `TemplateProcess` editor (add/edit/reorder, department, min/max duration, `provisional`) · C4 `TemplateEdge` editor with pre-publish cycle validation surfaced as an error, not a runtime throw · C5 publish flow · C8 **family readiness dashboard** — per family, template/route/QCP status and what blocks job creation · C10 import/export a family config bundle as JSON so seed-authored and UI-authored families share one shape.
- **Database.** none required.
- **Testing.** author HEAT_EXCHANGER end-to-end with zero code changes.

**Risks.** Genuinely new surface. Keep the authored shape identical to the seed JSON shape (C10) so the existing PRESSURE_VESSEL config is a valid import and the two paths cannot diverge.
**Definition of Done.** `reference/19` acceptance test #2 passes for real.
**Exit gate.** A family authored entirely through the UI produces a job that passes Phase W's exit gate.

---

### PHASE D — Document and file storage
**Objective.** The MDR becomes producible; certificates and drawings become real.
**Inputs.** **N6 answered first** — the TPI/ASME record-integrity question. Retrofitting a compliance requirement into a storage model is expensive; designing for it is nearly free.
**Workstreams.**
- **Infrastructure.** D1 provision an S3-compatible store reachable from Railway.
- **Database.** D2 `Document` model **with `tenantId` and an RLS policy from day one** (do not add it to the 49 uncovered tables) — category, storage key, filename, mime, size, checksum, uploadedBy/At · D3 entity links (job, equipment, unit, componentOperation, qcpExecution, drawingRevision, bomItem, ncr, dispatchBatch) · D4 `DocumentCategoryRef` reference table.
- **Backend.** D5 upload with size/mime allowlist and audit in the same transaction · D6 download with permission inherited from the owning entity · D7 supersede semantics reusing `DrawingRevision`'s pattern · D9 keep `mtcRef`/`poRef`/`wpsRef`/`jointRef` and add an optional `documentId` alongside.
- **Frontend.** D8 upload at drawing revision, `QcpExecution`, MTC record, `Ncr`, `DispatchBatch` · D10 MDR manifest/export.

**Parallelizable.** Fully parallel with C.
**Risks.** This is the first table designed for real volume (≈1 row per shop-floor submission). Partition-friendly from the start.
**Definition of Done.** A QC inspector attaches a certificate to a `QcpExecution`; it is retrievable, tenant- and job-scoped, audit-logged; and a user who cannot see the parent cannot fetch the file.
**Exit gate.** MDR manifest exports for one real job.

---

### PHASE E — Scheduled operating rhythm
**Objective.** The system operates on a clock instead of on page loads.
**Inputs.** **L3 answered** (department supervisors and representatives) — a scheduler that notifies nobody in particular is half a feature.
**Workstreams.**
- **Infrastructure.** E1 scheduler (Railway cron → protected route, or BullMQ+Redis per `CLAUDE.md`'s own named fallback) · **E9 choose and integrate a delivery channel — none exists anywhere today.** Email is obvious; **WhatsApp deserves serious consideration for an Indian shop floor where supervisors live in WhatsApp and may never open a web app for a morning digest.**
- **Backend.** E2 scheduled digest, keeping "Send now" as an override · E3 move overdue and aged-hold-point detection out of the per-page-load scan · E4 wire `fileDelayReason` → notification · E5 wire NCR open → notification · E6 replace scattered alert-type literals with a rule/severity table · E8 failed-job visibility · E10 per-user delivery preferences · E11 bounce handling.
- **Frontend.** E7 make `/alerts` real — **the data layer is already built**; `notifications.read.ts` exists and the page is a stub.

**Definition of Done.** The digest arrives without anyone clicking; an overdue stage generates an alert within a bounded window with zero page traffic; filing a delay and opening an NCR each notify a named person.
**Exit gate.** A synthetically-aged hold point produces a delivered alert with no page load.

---

### PHASE H — Isolation, integrity, test depth
**Objective.** Turn discipline into guarantees.
**Inputs.** D1 decision (FK).
**Workstreams.** H1 job-level RLS or enforced views · **H2 the real FK for the `ComponentOperation`/`AssemblyStep` ↔ `JobProcess` join, family-scoped, with migration and backfill** · H3 widen `cross-tenant.test.ts` from 4 hand-picked entry points toward a systematic sweep · H4 a named "Project A vs Project B" suite · **H5 a structural RBAC guard — a wrapper or lint rule so a service function missing its `require*` fails the build** · H8 BOM tree depth limit · plus `tenant_id` + RLS on the highest-risk of the 49 uncovered tables (`process_plans`, `component_operations`, `units`, `equipments`, `bom_items`, `ncrs`, `qcp_executions`).
**Risks.** RLS changes touch every query path — stage carefully behind the restore drill from A′.
**Definition of Done.** A deliberately unfiltered query cannot read another job's rows; a stage renumber fails loudly; a service function without an authz call fails CI.

---

### PHASE I — Observability depth and scale
*(A′ delivered the floor; this is the rest.)*
I3 batch `jobs.read.ts` · I4 pagination on the 16 unbounded list services, starting with `loadJobs` · I5 batch the per-job loops in `myday.read.ts` and `command-center.read.ts` · I6 a CI performance budget on the main list endpoints · plus `computeCpmSafe` in `command-center.read.ts`, `P2002` mapping in `toActionError`, `React.cache` for per-request spine dedup, the 38 redundant index drops and ~30 FK index adds, and the `v_unit_stage_status` rewrite to accept a `job_id` predicate.
**Definition of Done.** The jobs list issues a bounded number of queries regardless of job count, and the CI budget catches a regression.

---

### PHASE F — Delay propagation
**Inputs.** 0.3, 0.4, E1, **G′-5** (the override path must work on jobs with units first).
F1 compute the would-be reschedule without committing · F2 surface a diff — which dates move, by how much, delivery impact · F3 one-click apply preserving `OVERRIDE_REASON_REQUIRED` and the audit entry · F4 delivery-risk signal on `Job` · F5 advisory capacity flagging · F6 wire `DelayReviewStatus`.
**Definition of Done.** A 3-day welding delay produces a proposed reschedule showing the dispatch-date impact, applied by a named human.

---

### PHASE J — Second family and management completeness
J1 author PIPE_SPOOL end-to-end through Phase C — **zero code changes; that is the test** · J2 run a real Pipe Spool job intake→dispatch · J3 the multi-project acceptance test · J4 equipment-grain dashboard · J5 portfolio due-this-week / blocked bucket / department-overload · **J6 KPI consolidation — start with cycle-time, where two calendars make the number genuinely wrong** · J7 `Department.dashboardTier` · J8 `/board` real or removed · **J9 the shop-floor P0s: extend `SHELL_NAV` past 4 items so sub-1024px reaches real screens, wrap the 20 unwrapped wide tables, add `@supports` fallbacks for `color-mix()`/`oklch()`, restore keyboard access to the jobs list, add `htmlFor` to ~110 inputs, and point the e2e viewport suite at real pages instead of the three stubs.**
**Definition of Done.** Two families run concurrently with independent everything, and a supervisor can complete a full shift from a tablet.

---

### PHASE K — Procurement and material depth
K1 vendor · **K2 expected-delivery-date — "delayed" is not computable today for lack of a due date** · K3 lightweight `PurchaseOrder` grouping events without a second status enum · K4 required-by date derived from the consuming operation's scheduled start · K5 shortage → portfolio risk signal · K7 the `assertKitReady` no-op fix (if not already done in W5) · K8 BOM dedup / multi-sheet / UoM canonicalization / `componentTypeId` in the bulk schema · plus reconciling the two "available stock" formulas by naming them `availableForShortage` and `onHandForIssue` and documenting which question each answers.

---

### PHASES L / M / N / O — adopted from `execution/24`, unchanged
**L — Business inputs (owner: you + SJ, not a developer).** C1 working vs calendar days **changes every date in the system**; C21/C22/C23 change feasibility verdicts on live jobs; C9 blocks Phase E's notification routing; C7 and C27; the outstanding master data (welder list, weld-map numbering, department supervisors). **Start L1, L3, L5 this week — they run on DESPL's calendar, not yours.**
**M — Adoption, migration, rollout.** Cutover per department; in-flight job migration; user provisioning at scale; shop-floor password reset; per-role training; a plain-language "why did it refuse me" guide for the 49 error codes; user-acceptance sign-off per department; a feedback loop. **This is the highest-risk unplanned activity in the project** — every engineering item could land perfectly and the project still fails if 13 departments don't switch off their spreadsheets.
**N — Production operations.** Backups + restore drill (moved to A′) · retention/archival · incident runbook · environment strategy · access review · **N6 the ASME/TPI record-integrity question, asked before Phase D is designed.**
**O — Backlog.** i18n Hindi/Gujarati (**may matter more than several scheduled items for an Indian shop floor, and every label is currently a plain TSX literal**) · geo-tagged photo evidence · offline writes · PWA · client-portal enhancements · broader exports · costing (explicitly out of scope).

---

## 26. DEPENDENCY GRAPH

```
PHASE 0 (decisions)
   │
   ├─────────────┐
   ▼             ▼
PHASE A        PHASE A′ ───────── blocks the demo→main merge
(deploy truth) (ops floor: fresh-DB migrations, backups,
   │            credentials, headers, action logging, CI gating)
   │             │
   └──────┬──────┘
          ▼
      PHASE B (docs + literals + CI literal guard)
          │
          ▼
      PHASE W ★ (execution layer, gating splice, integration test)
          │
          ├──────────────┬───────────────┬──────────────┐
          ▼              ▼               ▼              ▼
      PHASE G′ ★     PHASE C ★       PHASE D        PHASE H
      (ship built)   (family        (documents)    (isolation,
          │           bootstrap)         │          FK, RBAC guard)
          │              │               │              │
          │              ▼               ▼              ▼
          │          PHASE J ★       PHASE E ───► PHASE F
          │          (2nd family,    (scheduler,  (delay
          │           mgmt, UX P0s)   delivery)    propagation)
          │              │               │
          └──────────────┴───────┬───────┘
                                 ▼
                             PHASE I (scale)
                                 │
                                 ▼
                             PHASE K (procurement depth)

Running in parallel on DESPL's calendar, not the developer's:
  PHASE L (business inputs) ── L1/L3/L5 BLOCK E and the date model
  PHASE M (adoption)        ── starts before pilot, not after
  PHASE N (ops readiness)   ── N6 blocks PHASE D's design
```

★ = decides whether this is a MOS or a very good tracker.

---

## 27. PARALLEL WORKSTREAMS

```
Track 1 — Platform / data (backend-leaning)
  A′(infra) ─► W3,W10-W12 ─► H1,H2,H5 ─► I3-I6 ─► K1-K5

Track 2 — Product / execution (full-stack)
  B3-B6 ─► W1,W2,W4-W7 ─► G′-1..G′-6 ─► C1,C2,C6,C7,C9

Track 3 — Interface (frontend)
  B7-B9 ─► W8,W9 ─► G′-7..G′-10 ─► C3,C4,C5,C8 ─► J4,J5,J8,J9

Track 4 — Capability additions (either, after B)
  D1-D10 (documents) ─► E1-E11 (scheduler + delivery) ─► F1-F6

Track 5 — Non-engineering (you + SJ) — runs from day one
  L1,L3,L5 ─► L2,L4,L6 ─► M1-M8 ─► N3-N6
```

**Safe to parallelize.** Documents (D) with family bootstrap (C). Database work (W10–W12, H1, H2) with UI work (W8, G′-7..10). Phase L and M with all engineering. Frontend B7–B9 with backend B3–B6.

**Must be serial.** W3 before any excluded-process job is created. A′-1 before any fresh environment, therefore before the restore drill, therefore before the merge. G′-1 (role gates) before G′-2 (actions). W1 before C (a bootstrapped family must produce executable jobs). E9 (delivery channel) before E2 is meaningful. N6 before D2. L1 before any date-model work is trusted. **D1's FK (H2) before a second family goes live**, or PIPE_SPOOL will silently match PRESSURE_VESSEL operation mappings.

---

## 28. PILOT MVP SCOPE

**What DESPL must have to start using this on a real job.**

- Phase A + A′ in full — deployed, backed up, restorable, logged, credentials rotated, headers on.
- Phase B — literals closed and CI-guarded.
- **Phase W in full** — a job created in the product is executable, with material, drawing and NCR gates that actually bite.
- G′-1, G′-2, G′-3, G′-7, G′-8 — paint entry, NCR disposition, and the QC→dispatch gate. **Packing/dispatch UI (G′-9) is pilot-scope only if the pilot job will ship during the pilot**; otherwise it is immediately post-pilot.
- E4, E5, E7 — delay and NCR notifications, and a real `/alerts` page. These do not need the scheduler.
- J9 — the shop-floor P0s. A supervisor on a tablet must be able to reach more than one real screen.
- W13 — the one end-to-end integration test.
- L1, L3, L5 — the date model and the notification routing targets settled.
- M1–M6 — cutover plan, provisioning, password reset, training, and the refusal guide.

**Explicitly not required for pilot:** a second product family; document storage (needed for the *first MDR delivery*, not for the first job's execution — but if the pilot job dispatches during the pilot, D2/D5/D8/D9 for MTC and drawings move into scope); the scheduler; delay-propagation automation; pagination; the equipment dashboard; capacity planning.

---

## 29. POST-PILOT SCOPE

- **Phase C** — family/route/QCP bootstrap, and **Phase J1–J3**, Pipe Spool authored with zero code changes. This is the MOS thesis and it should be proved on the back of a working pilot, not before one.
- **Phase D** in full including the MDR compiler.
- **Phase E** including the delivery channel decision (email vs WhatsApp).
- **Phase H** — job-level RLS, the numeric-join FK, the structural RBAC guard, the widened cross-tenant sweep.
- **Phase I** — pagination and the three page-load N+1s, before a second plant or a second tenant.
- **Phase K** — vendor, PO, due dates; "delayed" becomes computable.
- **Phase F** — delay propagation.
- `tenant_id` + RLS on the remaining child tables — **hard-blocking before tenant #2**.

## FUTURE PLATFORM

Capacity-aware scheduling · AI over the existing `blocking`/`waitingOnOthers` computation (natural-language management queries — a good AI surface precisely *because* the underlying data is already structured and truthful) · document data extraction once documents exist · i18n · offline writes · geo-tagged photo evidence · PWA · costing. **None of these should delay the pilot.**

---

## 30. WHAT NOT TO BUILD YET

| Do not build | Why |
|---|---|
| **A second product family (PIPE_SPOOL/HEAT_EXCHANGER) in production** | Until W1 lands it would produce equally un-executable jobs; until H2 lands it will silently match PRESSURE_VESSEL operation mappings through the unscoped numeric join |
| **The family bootstrap admin UI (Phase C) before Phase W** | It builds an on-ramp to a road that isn't finished |
| **Publishing or pinning template v2 (the packing/dispatch evidence version)** | `assertEvidenceSatisfied` would make two terminal stages permanently un-verifiable — the writers are unreachable |
| **Any new route containing a `PAINTING` operation** | Those operations can be submitted and never verified |
| **Capacity-aware scheduling** | D3 is unresolved and the CPM engine is correct without it; premature complexity |
| **Microservices, or any service split** | Four invariants depend on single-transaction atomicity; the blueprint's reasoning is correct and evidence-backed |
| **A `Project` entity above `Job`** | D2 (a); no evidence DESPL groups jobs this way |
| **A `Team` model / manager hierarchy** | D5 (a); department + role + assignee is sufficient today |
| **Sales / lead / quote / CRM** | D6 (a); out of the product boundary |
| **Costing, GL, invoicing** | Explicitly out of scope in `reference/01` §4 |
| **Fully automatic delay propagation** | D4 (a); auto-suggest with a named human approver preserves the accountability model |
| **An EAV / fully generic field system** | The codebase deliberately rejected this and the reasoning is sound |
| **A KPI framework rewrite before the pilot** | Consolidate cycle-time (where the two calendars make it wrong) and leave the rest until J6 |
| **Redis / BullMQ before E9 is decided** | Choosing the delivery channel may change the infrastructure choice; a Railway cron hitting a protected route may be sufficient |
| **AI anywhere near gating, RBAC, audit or scheduling arithmetic** | Principle 10 |
| **Pagination and caching before the pilot** | Genuinely fine at 3–40 jobs by the team's own measured ceiling — but pair the deferral with A′-9 so you can see the ceiling approaching |
| **A rewrite of anything** | Zero subsystems classify as REBUILD, and this audit confirms it |

---

## 31. PHASE-BY-PHASE DEFINITIONS OF DONE

| Phase | Definition of Done (concrete, testable) | Exit gate |
|---|---|---|
| **0** | Seven decisions recorded in a committed ADR with rationale | ADR merged |
| **A** | A written answer naming the production deploy branch, confirmed in the Railway dashboard; a recorded reconciliation decision; a `_prisma_migrations` row from the last production deploy | Divergence is zero or deliberate, with a date |
| **A′** | A fresh database migrates 40/40 cleanly; a restore to a fresh instance has been performed and the DE0467 regression replayed with a written pass/fail; a thrown Server Action error appears in the error tracker with its request id; a red CI blocks a deploy; the four shared accounts are gone | The restore drill's written result exists |
| **B** | `grep` for the pilot/family/department literals in `src/` returns nothing outside fixtures, **and the CI guard fails a deliberately reintroduced literal** | Guard demonstrated failing |
| **W** | A UI-created job with one excluded optional process runs Cutting → Final Inspection; a material shortage refuses a start; an unreleased drawing refuses CUTTING; an open NCR refuses a verify — all demonstrated on screen | W13 integration test green in CI |
| **G′** | A unit goes pack → release → dispatch through the UI on a job pinned to the evidence-tagged version; a unit with an open NCR is refused at packing; the W-waiver approval writes `waiverApprovedBy` | **No service function in `src/lib/services/` has zero callers outside its own test file** |
| **C** | HEAT_EXCHANGER's family, route and first QCP are authored entirely through the UI with **zero code changes**, and the resulting job passes Phase W's exit gate | `reference/19` test #2 passes for real |
| **D** | A QC inspector attaches a certificate to a `QcpExecution`; it is retrievable, tenant- and job-scoped, audit-logged; a user who cannot see the parent cannot fetch it; an MDR manifest exports for one job | N6 answered before D2 was designed |
| **E** | The digest arrives on schedule through a real delivery channel with nobody clicking; an aged hold point alerts with zero page traffic; filing a delay and opening an NCR each notify a named person; `/alerts` renders real data | A synthetic aged hold point produces a delivered alert |
| **F** | A 3-day welding delay produces a proposed reschedule showing the dispatch-date impact, applied by a named human with an audit entry | `reference/19` test #7 passes |
| **H** | A deliberately unfiltered query cannot read another job's rows; a stage renumber fails loudly; a service function missing its `require*` fails the build | Negative tests green |
| **I** | The jobs list issues a bounded number of queries at any job count; no unbounded list query remains on a growth path | CI performance budget green |
| **J** | A PV job and a Pipe Spool job run concurrently with independent workflows, schedules, BOMs, KPIs and alerts; a supervisor completes a full shift from a tablet | Multi-project acceptance test passes; e2e viewport suite points at real pages |
| **K** | "Which POs are delayed" is answerable from the system | Query returns real, correct rows |
| **L** | C1, C7, C9, C21, C22, C23, C27 answered in writing; master data collected | Answers committed to the repo |
| **M** | Each department has a cutover plan, trained users, and a signed user-acceptance record | Sign-off per department |
| **N** | Runbook, retention policy, access-review cadence, environment strategy, and the ASME/TPI answer all recorded | Documents committed |

---

## 32. IMMEDIATE NEXT 10 ENGINEERING TASKS

These can be started today, in this order. Tasks 1–4 are independent of each other.

---

**Task 1 — Splice `bypassExcluded` into the gating path**
*Why.* The intake wizard lets a user exclude an optional process. Doing so permanently deadlocks every successor of that process, because `loadGate` reads raw edges while the scheduler creates no plan for the excluded node. This is the one per-job deviation feature the product ships, and it bricks the job.
*Affected area.* `src/lib/services/process.service.ts:88-95`; `src/lib/services/_shared.ts:843`; uses `bypassExcluded` from `src/lib/schedule/exclude.ts` (already exported, already tested).
*Dependency.* None.
*Acceptance criteria.* A job created with `excludedProcessCodes: ["21"]` (PWHT) can start, submit and verify process 22 and everything downstream. A new test in `process.service.test.ts` asserts this and fails against the current code.

---

**Task 2 — Rotate the four shared department accounts**
*Why.* `despl123@` is committed to the repository with `mustChangePassword:false`. Anyone with repo access can log in as `fabrication@` and `qc@` — and one person holding both defeats maker-checker, the invariant the entire QA record's credibility rests on.
*Affected area.* `scripts/create-department-accounts.ts:21,55-62`; the four accounts in the production database; Railway env (`SEED_PASSWORD`).
*Dependency.* None.
*Acceptance criteria.* The literal is gone from source; the script reads from `process.env` and sets `mustChangePassword: true`; the four shared accounts are replaced by per-person accounts; `SEED_PASSWORD` is confirmed set in Railway.

---

**Task 3 — Make migrations runnable on a fresh database**
*Why.* Two migrations `GRANT` to `despl_web`, a role no migration creates. `prisma migrate deploy` fails at migration 7 of 40 on any new environment. That means no staging, no restore drill, and no disaster recovery are possible today — and the restore drill is a prerequisite for safely merging 79 commits and ~10 migrations into production.
*Affected area.* `prisma/migrations/20260815120000_v_unit_stage_status/migration.sql:87`; `.../20260827040000_v_process_plan_percent/migration.sql:66`.
*Dependency.* None.
*Acceptance criteria.* `prisma migrate deploy` completes 40/40 against an empty Postgres 16 with no pre-created `despl_web` role, without the `ci.yml:63-70` workaround.

---

**Task 4 — Answer the deploy question**
*Why.* `main` is 79 commits behind HEAD and has not moved since 25 Aug. Everything described as "built" in Phases 4 and 5 — BOM import, procurement ledger, stock, drawing revisions, NCR, paint, packing, dispatch — may not be running in production. No engineering decision is trustworthy until this is known.
*Affected area.* Railway dashboard; `CLAUDE.md:21`; `railway.json`.
*Dependency.* None (but Task 3 gates the *merge*, not the answer).
*Acceptance criteria.* A written note in the repo naming the production deploy branch as confirmed in the dashboard, plus a recorded decision to merge or hold, plus evidence of a recent `_prisma_migrations` row from production.

---

**Task 5 — Materialise `Component` + `ComponentOperation` in `createJob`**
*Why.* No code path anywhere in `src/` creates these rows. Every job created through the product has an empty execution layer, which silently disables the material gate, the drawing gate, the component-completion gate and the NCR gate, and leaves per-component progress empty. The pilot works only because a developer ran a seed script.
*Affected area.* `src/lib/services/job-intake.service.ts` (inside the existing transaction, after `bomItem.createManyAndReturn` at `:545`); lift the loop from `scripts/seed-despl320-components.ts:103-121`; **set `bomItemId`** (the script hardcodes `null`).
*Dependency.* None, but do Task 1 first so the resulting jobs are actually startable.
*Acceptance criteria.* A job created through `/jobs/new` with an imported BOM has `Component` rows linked to their `BomItem` and `ComponentOperation` rows from the matching published `RouteTemplateVersion`; `assertKitReady` refuses a start when the linked BOM item is short; batched with `createMany` and completing inside the 20s transaction budget for a 40-unit job.

---

**Task 6 — Materialise `AssemblyStep` per `Unit` in `createJob`**
*Why.* Same cause, second track. Without it the assembly grain, its hold points and its NCRs do not exist on any real job.
*Affected area.* `src/lib/services/job-intake.service.ts`; pattern at `scripts/seed-despl320-assembly-steps.ts:138`. **Resolve `qcpItemId` by `(qcpTemplateId, sequence)` — which is already unique — rather than the script's 0.5-threshold token-overlap match on the deliberately non-unique `srNo`**, and fail loudly rather than leaving `qcpItemId` null.
*Dependency.* Task 5 (same transaction, same shape).
*Acceptance criteria.* A UI-created job has `AssemblyStep` rows per unit with every INSPECTION step bound to a real `QcpItem`; an unresolvable binding refuses job creation with a named error code rather than silently un-gating.

---

**Task 7 — Write the end-to-end integration test**
*Why.* No test in the repository crosses more than two of the seven workflow services, and the two that reach three build their fixtures with the raw owner Prisma client, bypassing `createJob` entirely. That is precisely how Tasks 1, 5 and 6 survived five phases undetected.
*Affected area.* New `src/lib/services/job-lifecycle.integration.test.ts`, DB-gated like its siblings.
*Dependency.* Tasks 1, 5, 6.
*Acceptance criteria.* One DB-gated test drives `createJob` → `generateSchedule` → `importBomItems` → `recordProcurementEvent` → `receiveStock` → `startComponentOperation` → `submit` → `verify` → a QC reject opening an NCR → re-verify closing it, **through the real service entry points**, and it runs in CI.

---

**Task 8 — Add the security headers block**
*Why.* There are no HTTP security headers at all. The app is framable, so a supervisor can be clickjacked into Verify or Reject; with no CSP any XSS sink becomes session-scoped; with no HSTS a first-visit downgrade strips the `secure` cookie's protection. One afternoon closes a whole risk category.
*Affected area.* `next.config.ts` (currently an empty config).
*Dependency.* None.
*Acceptance criteria.* Production responses carry `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and a starting CSP; `poweredByHeader: false`.

---

**Task 9 — Log the Server Action path**
*Why.* `src/app/actions/_action.ts` is the error funnel for all 20 Server Action modules — i.e. every mutation in the application — and it logs nothing. There are 4 `console.*` calls in all of non-test `src/`, all on the 7 API routes. During an incident the operator has raw Railway stdout and a binary health check.
*Affected area.* `src/app/actions/_action.ts`; `src/middleware.ts:18` supplies the `x-request-id` to key on.
*Dependency.* None.
*Acceptance criteria.* A deliberately thrown error from a Server Action produces one structured log line carrying request id, actor id, tenant id, action name and error code; an unmapped `P2002` is mapped to a domain error code rather than rethrown as a 500.

---

**Task 10 — Extend `SHELL_NAV` so the shop floor can reach real screens**
*Why.* Below 1024px the tablet rail and phone bottom nav share one four-item array, and three of those four items are the "coming in R2" stubs. A supervisor on a factory tablet can reach My Day and three placeholders. The e2e viewport suite tests those same stubs, which is why this has never failed a check.
*Affected area.* `src/components/industrial/app-shell.tsx:120-125`; `e2e/supervisor-viewport.spec.ts:46` (`SHELL_PAGES`).
*Dependency.* None.
*Acceptance criteria.* `/workspace`, `/qc` and `/jobs` are reachable from the rail and bottom nav below 1024px; `SHELL_PAGES` points at those real routes; the horizontal-overflow and touch-target assertions run against them and pass (or fail honestly, exposing the unwrapped tables in J9).

---

## 33. FINAL ENGINEERING VERDICT

# DESPL ENGINEERING AUDIT VERDICT

### Architecture Status — 🟢
Sound, coherent, and better than the norm for this stage. Zero subsystems require a rebuild. The modular-monolith decision is correct and evidence-backed. The three-track domain model is a legitimate modelling choice; only its join needs hardening.

### Implementation Status — 🟡
The engine is excellent and the surface is incomplete. Roughly 1,000 lines of correct, tested service code have no caller, and the layer beneath the schedule spine is never created by the application.

### Codebase Health — 🟢
1 TODO, 0 FIXME, 0 HACK across 281 files. Real service boundary with zero violations. 49 stable error codes. No mock data anywhere in the UI. Honest, self-critical comments that name their own limits — and were right almost every time this audit checked them.

### Blueprint Alignment — 🟡
The blueprint describes the code accurately in 15 of 20 areas. It contains five factual errors, one consequential (the work-generation acceptance test), and it does not contain any of this audit's four new findings — because it was generated from a prior audit rather than authored as a specification.

### Security Readiness — 🔴
A shared production credential is committed to the repository and operationally defeats maker-checker. There are no HTTP security headers. 69% of tables have no RLS. These are all cheap to fix; none is architectural.

### Production Readiness — 🔴
Not deployed. No backups. No proven restore. No staging. No observability on the mutation path. A fresh database cannot even run the migrations. The eventual merge is a ~10-migration, partly destructive, unrehearsed deploy.

### Current Stage
`STAGE 4 — Core Workflow` (entering `STAGE 5 — Department Modules`)

### Current Phase
`PHASE B — Truth in documentation and literal removal` (B1/B2 landed; B3–B11 open)

### Are We Going Correctly?
`PARTIALLY`

### Biggest 5 Problems

1. **No code path creates the execution layer.** `Component`, `ComponentOperation` and `AssemblyStep` are never created by `src/`. Every job made in the product is an empty shell; six of ten cross-stage gates pass unconditionally on it.
2. **Excluding an optional process at intake permanently deadlocks the job** — the one per-job deviation feature that ships is the one that bricks the work.
3. **Production readiness is near zero**: not deployed, no backups, no proven restore, no staging, a fresh database that cannot migrate, and the entire mutation path unlogged.
4. **A shared credential in the repository operationally defeats maker-checker** — the invariant every QC record's credibility depends on.
5. **Nothing is measured or proven across service seams.** No test crosses more than two of the seven workflow services; no metrics exist; there is no file storage, so the MDR — the thing DESPL contractually sells — cannot be produced.

### Top 5 Actions Before Continuing

1. Splice `bypassExcluded` into `loadGate` (Task 1).
2. Rotate the four shared department accounts (Task 2).
3. Fix the `despl_web` grants so a fresh database can migrate, then run one restore drill (Task 3).
4. Answer the deploy question in the Railway dashboard and record it (Task 4).
5. Materialise `Component`/`ComponentOperation`/`AssemblyStep` in `createJob`, and write the one integration test that would have caught its absence (Tasks 5–7).

### Next Development Phase
`PHASE W — Make a created job executable` — inserted between Phase B and Phase C, and the highest-value work available in this codebase today. Everything the blueprint says about the multi-family thesis remains true and remains the right destination; it simply cannot be the next step while the first family's jobs are not executable.

---

*Read-only forensic audit completed 2026-09-01 against HEAD `8f81c58` on `chore/B1-docs-drift-corrections`. No source file, schema, migration, or seed script was created, edited, or deleted. Runtime behaviour, live Railway state, and rendered UI were not observed and are marked UNVERIFIED where relied upon.*
