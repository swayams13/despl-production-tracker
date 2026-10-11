# 01 — DESPL MOS Product Definition

**Status:** Target-state definition, verified against the current repository (`despl-production-tracker`, branch `demo`, HEAD `28d7f2f`, 2026-08-31) and the accepted `docs/ADR-product-family-agnostic-platform-v1.md`.
**Labeling convention used throughout this blueprint:** every claim is marked **CURRENT** (true today, in code), **TARGET** (the state this blueprint defines), **GAP** (the distance between them), or **DECISION REQUIRED** (cannot be settled from evidence alone — see `20_DESPL_MOS_ARCHITECTURAL_DECISIONS.md`).

---

## 1. Canonical definition

> **DESPL MOS is the single system of record and execution for how Dhruv EPC Solutions (DESPL) takes a manufacturing order from intake to dispatch, across every department and every product family the company builds — pressure vessels today, heat exchangers, pipe spools, and piping systems as the company wins that work — enforcing one shared set of rules (sequencing, maker-checker, hold points, audit) regardless of which product is being built, and giving management, department heads, and the shop floor a live, truthful view of where every job stands and what is blocking it.**

Unpacked:

- **Who uses it.** Management (MD/CEO), a Production Head, department supervisors (13 departments today, data-driven — see `04`), floor operators, QC inspectors, and (in a reserved but unbuilt role) client viewers.
- **What problem it solves.** Today DESPL's manufacturing execution — routing, scheduling, QC, material tracking, delay accountability — lived in spreadsheets and verbal handoffs. The MOS replaces that with one system where a stage cannot silently skip QC, a delay cannot go unexplained, and a manager can see the whole company's job book in one place instead of chasing department heads for status. **This is a traceability and accountability system before it is a scheduling system** — the CPM engine (`09`) exists to make dates trustworthy, but the invariants that make the system *credible* (CLAUDE.md's twelve, verified in code: no client timestamps, hard sequential gating, maker-checker, append-only audit) are what management actually bought when they commissioned this.
- **What operational lifecycle it controls.** Job intake → engineering release → procurement/material readiness → fabrication → assembly → QC → surface finishing → documentation → packing → dispatch, with every transition server-enforced, not client-trusted (`CURRENT`, verified: `src/lib/schedule/gating.ts`, `src/lib/services/_shared.ts`'s `assertKitReady`, `src/lib/authz/index.ts`).
- **What management sees.** A company-wide portfolio view (`portfolio.read.ts`), a per-job KPI/S-curve view (`workspace.read.ts`), and per-department command centers that surface not just "my work" but "who I am blocking" and "who is blocking me" (`command-center.read.ts`'s `blocking`/`waitingOnOthers`, verified at `command-center.read.ts:190-367`) — the single strongest piece of evidence that this is more than a dashboard skin (`CURRENT`).
- **What departments execute.** Each of the 13 seeded departments (`PROJECTS, ENGINEERING, PLANNING, PROCUREMENT, STORES, QC, FABRICATION_PREP, MACHINE_SHOP, FABRICATION, HEAT_TREATMENT, SURFACE_PAINT, DOCUMENTATION, DISPATCH` — `seed/lead-time-model.json`) owns a slice of the same shared DAG of `ProcessPlan` rows, gated by the same engine, not a private status board (`CURRENT`).
- **How projects flow through it.** `Project → Job → Equipment → Unit (serial) → Component/AssemblyStep`, materialized from a versioned, family-specific `ProcessTemplate` pinned at intake (`05`, `06`).
- **How production fits into it.** Production is the system's most mature capability today (Maturity 5/5, per the forensic audit §39) — a real, row-locked, server-enforced state machine (`start → submit → verify/reject → hold/resume`), not a status field a client can set (`10`).

## 2. What DESPL MOS is **not**

- It is not a DESPL-320 dashboard with configuration options bolted on. The repository's own accepted ADR states this correctly and this blueprint independently re-verified it against the schema (`prisma/schema.prisma`, 71 models) and service code: the domain model is genuinely family-parametric — `Job.familyId → ProductFamily`, `Job.templateVersionId → ProcessTemplateVersion` — with **no family branch found anywhere in the gating, scheduling, or authorization code** (`gating.ts` has zero department- or family-awareness, verified directly).
- It is not a project-management tool (no Gantt-as-source-of-truth; the CPM engine computes dates from a template, it does not let a planner drag bars) and it is not a generic no-code workflow builder — the workflow vocabulary (operations, departments, hold points, NCRs) is manufacturing-specific by design (ADR: "a fully generic field system would buy configurability nobody could safely use").
- It is not, today, a multi-family system in practice, even though it is one architecturally. **`GAP`**: only `PRESSURE_VESSEL` has a published `ProcessTemplateVersion`; `PIPE_SPOOL` is provisional (no confirmed durations); `PIPING_SYSTEM` and `HEAT_EXCHANGER` have no template at all (`06`).

## 3. The one-sentence acceptance test the codebase already sets for itself

The ADR states it and this blueprint adopts it as the canonical test for "is this MOS, or is this a tracker":

> *"If we won an identical heat exchanger tomorrow, what code changes?"* The answer must be **none** — an engineer authors a `ProcessTemplate` version, a `RouteTemplate` set, and a `QcpTemplate` as data.

**`CURRENT` reality against that test:** the mechanism to run a second family exists and needs no code change for *day-to-day operation* once bootstrapped (job intake, scheduling, gating, production tracking, QC are all family-parametric, verified). **`GAP`:** *bootstrapping* a family's first template, route set, and QCP has no UI or self-serve path today — `ProductFamily`, `RouteTemplate`, and a first `QcpTemplate` are created **only** by `prisma/seed.ts` and hand-written JSON (`seed/component-routes.json`), confirmed by grep: zero service functions and zero UI routes create any of the three. This is `19`'s acceptance test #2 and the single highest-leverage gap this blueprint identifies (see `17`, P1).

## 4. Product boundary statement

DESPL MOS is the operating system for **manufacturing execution of physical, multi-department, multi-week fabrication work** at DESPL. It is explicitly *not* trying to be:

| Not this | Why it stays out of scope |
|---|---|
| A financial/accounting system | No GL, invoicing, or costing model exists or is proposed; `ProcurementEvent` tracks physical material flow, not financial commitments (`08`) |
| A CRM | `Client` exists only as the counterparty on a `Job`; no sales-pipeline concept exists or is needed |
| A generic PLM/PDM | Drawing revisioning exists (`AssemblyDrawing`/`DrawingRevision`) but is scoped to what gates fabrication, not full engineering lifecycle management |
| A capacity-planning / labor-scheduling tool | The CPM engine is dependency-aware, not resource-capacity-aware (`09` — a named, deliberate current gap) |

## 5. Why this definition, not the audit brief's default assumption

The brief that commissioned this blueprint proposed a default department chain (`Sales → Project → Engineering → Procurement → Material → Production → QC → Painting → Dispatch`) and explicitly asked this document to *inspect the repository rather than assume it*. The verified department list and dependency graph (`04`, `17`) show DESPL's actual chain has no `Sales` department in the system at all (a `Job` is created directly by ADMIN/PRODUCTION_HEAD at intake — `job-intake.service.ts`), routes `STORES` and `PROCUREMENT` as two distinct departments rather than one "Material" step, and — critically — is not a strict linear chain but a 36-process DAG with legitimate parallel and overlapping work (verified: `cpm.ts`'s `START_TO_START_WITH_OVERLAP` edge type, and the printed 119-day envelope reproduced exactly by the fitted-lag model). This document and `02` are built from that verified reality, not the brief's illustrative default.

---
*Sources: `prisma/schema.prisma`, `docs/ADR-product-family-agnostic-platform-v1.md`, `CLAUDE.md`, `src/lib/schedule/{gating,cpm}.ts`, `src/lib/services/command-center.read.ts`, `seed/lead-time-model.json`, `docs/DESPL_MOS_FORENSIC_AUDIT.md`.*
