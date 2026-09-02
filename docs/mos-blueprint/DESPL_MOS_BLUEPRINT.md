# DESPL MOS — Master Blueprint

**This is the executive source of truth for the DESPL Management Operating System.** It was produced by converting the existing codebase (`despl-production-tracker`, branch `demo`, HEAD `28d7f2f`, 305 commits, verified directly by reading `prisma/schema.prisma`, the service layer, the ADR, and CLAUDE.md on the user's machine) and the completed forensic audit into a canonical target architecture. Every numbered companion document (`01`–`20`) in this folder expands one section below with full evidence, tables, and diagrams. **No source file, schema, or database was read-write-modified in producing this blueprint — this was a read-only architecture pass.**

---

## 1. Product Definition

> **DESPL MOS is the single system of record and execution for how DESPL takes a manufacturing order from intake to dispatch, across every department and every product family the company builds, enforcing one shared set of rules regardless of which product is being built, and giving management, department heads, and the shop floor a live, truthful view of where every job stands and what is blocking it.**

Full definition, boundary statement, and the "if we won a heat exchanger tomorrow" acceptance test: **`01`**.

## 2. Vision

If DESPL-320 disappeared tomorrow, the architecture that would remain is **capable of running the entire company** — the domain model, gating engine, scheduling engine, RBAC, and audit trail are verified family-agnostic with zero branch-on-family-name found anywhere in the service layer. What is missing is not architecture; it is **self-serve tooling** to configure a new family, and a handful of narrow call-site literals still pointing at the pilot. This is a system with a genuinely rare quality: the hard parts (cross-department DAG, gating, audit, RBAC, scheduling) are already done, and the team has audited itself four times in two weeks and fixed a meaningful share of what it found. The vision this blueprint commits to is: **close the tooling gap, not redesign the architecture.**

## 3. Operating Model

Full detail: **`02`**. Verified departments (13, data-driven, not hardcoded), the real cross-department DAG (process-to-process, not department-to-department), the current manual/lazy operating rhythm and its target scheduled form.

## 4. Core Principles

Fifteen canonical principles and the anti-pattern list every future developer must honor: **`20`** §1–2.

## 5. Domain Boundaries

Three layers — MOS Core, Operational Framework, Product-Specific Execution — with a verified boundary matrix mapping every major capability to exactly one layer: **`16`** §3.

## 6. Department Model

Thirteen departments modeled as operational capabilities (purpose, work object, inputs, outputs, dependencies, KPIs), each answered against the brief's own genericity test: **`04`**.

## 7. Project/Job/Equipment Model

`Job` is the project root (no separate `Project` entity exists or is needed); `Equipment` → `Unit` (serial) → `Component`/`AssemblyStep` is real and multi-instance. Full disambiguation table preventing overlapping concepts: **`05`**.

## 8. Product Family Model

The audit's central question, answered: the mechanism is real (`ProductFamily → ProcessTemplate/RouteTemplate/QcpTemplate → Job`, zero family branches in service code); the bootstrap tooling is not (creating a *new* family's first template/route/QCP still requires a developer). This is the single highest-leverage gap in the entire system: **`06`**.

## 9. Workflow Model

Gating and scheduling are deliberately separate concerns (verified, correct). The hardcoded 25-stage "Stage Spine" is the most visible remaining DESPL-320-shaped coupling and should be replaced by a projection of the job's actual route: **`07`**.

## 10. BOM/Material/Procurement

A genuinely working, tested BOM upload pipeline with real gaps (dedup, multi-sheet, UoM canonicalization). Procurement is real but thin — an append-only event ledger with no vendor, PO, or due-date model, which is why "delayed" cannot currently be computed: **`08`**.

## 11. Scheduling

A real, verified CPM engine reproducing the printed 119-day envelope exactly at all 36 processes. Not capacity-aware (a named, deliberate gap). Delay propagation is manual, not automatic — the audit brief's own worked example ("does a welding delay move NDT/QC/Painting/Dispatch automatically?") is answered **no**: **`09`**.

## 12. Production

The system's strongest verified area (Maturity 5/5). A real, row-locked, server-enforced execution state machine, and a genuinely producible "what do I have to do today" view built from live CPM/gating data, not placeholder text: **`10`**.

## 13. Quality

The most mature department. Maker-checker and hold points are real, no-bypass, verified. The one real gap: witness (W) waivers are schema-ready but never wired to an approval action: **`11`**.

## 14. Documents

**Missing entirely** — no file/attachment storage exists anywhere in the application. The metadata discipline around documents (drawing revisioning, MTC references) is already correct; only the file layer itself needs to be added: **`12`**.

## 15. People/RBAC

Six real roles, sound session handling (server-side re-fetch on every request, no embedded claims), deny-by-default at two layers. RBAC enforcement is scattered by convention rather than structurally intercepted — a real but bounded gap: **`13`**.

## 16. Management Layer

Real, rich views at company/project/department grain; no equipment-grain view exists. The target command-center hierarchy is a composition of data that already exists across four separate read services, not new computation: **`14`**.

## 17. KPI/Alert Architecture

Real KPI numbers, computed independently in at least four places with no shared framework. Real, partially event-driven alerts — two triggers (delay filing, NCR opening) generate no notification today despite the notification layer already existing: **`14`**.

## 18. Data Architecture

71 models, 25 enums, verified directly. 27 of 71 models carry `tenantId` directly; the rest rely on a parent-join convention. Tenant isolation is DB-enforced (RLS, fail-closed); **job-level isolation is not** — the single highest-severity data-architecture gap: **`15`**.

## 19. Security

Sound session/token design; deny-by-default RBAC; no CSP/HSTS/rate-limiting beyond login — a real, bounded hardening gap: **`13`** §4–6.

## 20. AI Boundaries

State transitions, gating, RBAC, audit, and scheduling arithmetic stay deterministic, always. AI is additive on top of already-structured, truthful data (natural-language management queries over the existing `blocking`/`waitingOnOthers` computation is the strongest near-term candidate): **`16`** §6.

## 21. Current → Target Gaps

Full gap matrix, 20 rows, each with severity and recommended action: **`17`**.

## 22. Preserve/Refactor/Extend/Rebuild

**Zero subsystems classified as REBUILD.** Seven PRESERVE (service-layer boundary, `withTenant`, versioned templates, CPM engine, maker-checker/hold points, audit trail, reference-table pattern). Four REFACTOR (dept dashboard-tier routing, four literal couplings, KPI duplication, the fabrication/assembly/spine join). Five EXTEND (procurement, documents, alerts, family bootstrap, observability): **`17`** §3.

## 23. Implementation Roadmap

Ten phases (A–J), sequenced preserve-first, no big-bang rewrite. First development phase: **Phase A** (verify demo→main→Railway deploy state) **+ the documentation-drift half of Phase B** — both cheap, both address this audit's two highest-leverage findings: **`18`**.

## 24. Acceptance Criteria

The "new project tomorrow" test (passes through Finish, fails at Dispatch for lack of UI), the ten self-review questions (7 of 10 fully pass today; 3 partial — family bootstrap, material-block enforcement, delay propagation), and the multi-project test (architecturally sound, not yet run for a second family for real): **`19`**.

## 25. Open Decisions

Seven decisions requiring explicit stakeholder sign-off (the fabrication/assembly join fix approach, whether `Project` needs its own entity, capacity-gate hardness, delay-automation threshold, team/hierarchy modeling, sales-boundary scope, cancellation workflow) — each with a recommended option and confidence level, none hidden: **`20`** §3.

---

## A. What DESPL MOS actually is

A single system of record and execution for DESPL's manufacturing lifecycle, built as one common core with product-family configuration — not a pressure-vessel application with configuration options. Verified: the gating, scheduling, and authorization engines contain zero family-specific branches.

## B. What the current system already gets right

The cross-department dependency engine (a real, verified CPM DAG spanning every department, surfaced as genuine "you are blocking QC" language); the maker-checker/hold-point gating with no admin bypass; the append-only, DB-grant-enforced audit trail; the versioned-template-with-immutable-publish design; the reference-table-not-enum vocabulary pattern; the service-layer/thin-Server-Action boundary (zero violations found).

## C. The biggest architectural changes required

None, structurally. The biggest *changes* required are additive: a self-serve family/route/QCP bootstrap UI, document/file storage, a job-level RLS backstop, and a scheduler. The one genuine data-integrity risk (the fabrication/assembly/spine numeric-code join) needs a foreign key or an enforced invariant, not a redesign.

## D. What should NOT be rebuilt

Everything classified PRESERVE in `17` §3 — the modular monolith, the transaction/RLS pattern, the CPM engine, the gating mechanism, the audit trail, the reference-table pattern. Nothing found in this audit rises to "incremental fixes are unlikely to work."

## E. What should be refactored first

The four literal couplings (DESPL-320 fallback, PRESSURE_VESSEL literal, the 25-stage table, the FABRICATION literal) and the documentation drift in CLAUDE.md — both cheap, both P0/P1, both directly restore the credibility of the codebase's own standing "no literal in `src/`" rule.

## F. What new MOS capabilities are required

A family/route/QCP self-serve bootstrap UI (the actual gate to calling this a company-wide MOS); document/file storage; a scheduler (unblocks the daily digest, alert reconciliation, and future scheduled KPI work); a job-level isolation backstop; a vendor/PO/due-date model for procurement.

## G. How DESPL-320 will be treated going forward

As **one real project instance running on DESPL MOS** — exactly the ADR's own framing, independently re-verified as substantially true. Once Phase B's four literal fixes land, DESPL-320 will have no special-case code path left anywhere in `src/`.

## H. The target architecture in bullets

- Single Next.js modular monolith, preserved — four non-negotiable invariants depend on single-transaction atomicity.
- Three-layer domain: MOS Core (family-agnostic) → Operational Framework (reusable, configurable) → Product-Specific Execution (data, not code).
- Departments are data rows with a configurable dashboard tier, not a hardcoded array.
- Gating and scheduling stay separate concerns, composed, never merged.
- Templates are versioned; running jobs pin immutable snapshots, forever.
- Every mutation is transaction-local, tenant-RLS-scoped, and audit-logged in the same transaction.
- A new product family is authored as data (template, route, QCP) through a self-serve UI, not seeded by a developer.
- Document storage is a new bounded-context service, with permissions inherited from the owning entity's existing scoping.
- A lightweight scheduler replaces manual/lazy triggers for digest delivery and alert reconciliation.
- Job-level isolation gets a database backstop, extending the same RLS pattern already proven at the tenant level.
- KPIs consolidate into one shared calculation per metric shape, consumed by every dashboard.
- AI is additive on top of deterministic, auditable data — never a replacement for gating, RBAC, or audit.
- The Stage Spine (and any future stage-reporting UI) derives from the job's actual route, never a hardcoded stage table.
- No microservice split — the monolith's transactional guarantees are load-bearing, not incidental.
- Zero subsystems require a rebuild.

## I. P0/P1/P2 roadmap

- **P0:** Verify demo→main→Railway deploy state; correct CLAUDE.md's stale invariant #2 and PHASE-PROMPTS.md's false "already fixed" claim.
- **P1:** Close the four literal couplings; build the family/route/QCP bootstrap UI; add document/file storage; wire the QC witness-waiver gate.
- **P2:** Job-level isolation backstop; scheduled operating rhythm; observability; procurement vendor/PO/due-date fields; scalability fixes (named N+1, pagination); security headers/rate limiting; dept dashboard-tier field.
- **P3:** Delay-propagation automation; ship the Phase-5 dispatch UI and re-pin a real job; KPI framework consolidation; equipment-grain dashboard; portfolio due-this-week/blocked-projects rollup.

## J. The first development phase

**Phase A + the documentation-drift half of Phase B (`18`):** confirm what's actually live on Railway, and fix the two places where the team's own documentation no longer matches its own code. Both are cheap. Both directly address this audit's two highest-leverage findings. Nothing else should be prioritized ahead of knowing, with certainty, what is actually running in production today.

## K. Confirmation

**No code was modified.** This was a read-only architecture and documentation pass: `prisma/schema.prisma`, the service layer, `docs/ADR-product-family-agnostic-platform-v1.md`, `CLAUDE.md`, and the git history were read directly to verify (and in several places sharpen or correct) the forensic audit's findings — no source file, migration, schema, or seed script was created, edited, or deleted. This folder (`docs/mos-blueprint/`) is the only new content, and it is documentation.

---

**Companion documents in this folder:**
`01_DESPL_MOS_PRODUCT_DEFINITION.md` · `02_DESPL_MOS_OPERATING_MODEL.md` · `03_DESPL_MOS_DOMAIN_MODEL.md` · `04_DESPL_MOS_DEPARTMENT_CAPABILITY_MODEL.md` · `05_DESPL_MOS_PROJECT_JOB_EQUIPMENT_MODEL.md` · `06_DESPL_MOS_PRODUCT_FAMILY_MODEL.md` · `07_DESPL_MOS_WORKFLOW_AND_ROUTING_MODEL.md` · `08_DESPL_MOS_BOM_MATERIAL_PROCUREMENT_MODEL.md` · `09_DESPL_MOS_SCHEDULING_MODEL.md` · `10_DESPL_MOS_PRODUCTION_EXECUTION_MODEL.md` · `11_DESPL_MOS_QC_NCR_REWORK_MODEL.md` · `12_DESPL_MOS_DOCUMENT_MODEL.md` · `13_DESPL_MOS_PEOPLE_RBAC_MODEL.md` · `14_DESPL_MOS_MANAGEMENT_KPI_ALERT_MODEL.md` · `15_DESPL_MOS_DATA_ARCHITECTURE.md` · `16_DESPL_MOS_TARGET_ARCHITECTURE.md` · `17_DESPL_MOS_CURRENT_TO_TARGET_GAP.md` · `18_DESPL_MOS_IMPLEMENTATION_ROADMAP.md` · `19_DESPL_MOS_ACCEPTANCE_TESTS.md` · `20_DESPL_MOS_ARCHITECTURAL_DECISIONS.md`
