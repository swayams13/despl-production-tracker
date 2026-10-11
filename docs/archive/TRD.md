# Technical Requirements Document (TRD) & System Architecture
## DESPL Production Tracker — v1

> ⚠️ **Superseded, 26 Aug 2026 (audit §6 / Phase 0 item 0.15):** `docs/BUILD-SPEC-v2.md` supersedes
> this document's scheduling, granularity, and stack sections. In particular: there is no NestJS, no
> separate `api`/`worker` Railway services, no Redis/BullMQ in production, and no `packages/shared` —
> the actual stack is a single Next.js full-stack app (Server Actions + a handful of GET-only route
> handlers), per the root `CLAUDE.md`. Read `BUILD-SPEC-v2.md` first; treat everything else here as
> historical requirements/business context, not current architecture.

| | |
|---|---|
| **Document version** | 1.0 — Draft |
| **Author** | Swayam |
| **Date** | 03 Aug 2026 |
| **Companion doc** | PRD v1.0 (all FR-IDs referenced below map to it) |

---

## 1. Architecture Overview

```
                ┌─────────────────────────────────────────────┐
                │                RAILWAY (prod + staging)      │
                │                                             │
 Supervisor ────┤  ┌───────────┐      ┌──────────────┐        │
 (mobile PWA)   │  │  Next.js  │─────▶│  NestJS API  │        │
 QC Inspector ──┤  │  frontend │ REST │  (Docker)    │        │
 SJ / MD / CEO ─┤  │  (Docker) │      └──────┬───────┘        │
                │  └───────────┘             │                │
                │                     ┌──────┴───────┐        │
                │                     │  PostgreSQL  │        │
                │                     └──────┬───────┘        │
                │  ┌───────────────┐         │                │
                │  │ Worker (BullMQ)│◀───────┤                │
                │  │ daily brief,   │   ┌────┴────┐           │
                │  │ overdue scan,  │◀──│  Redis  │           │
                │  │ notifications  │   └─────────┘           │
                │  └───────────────┘                          │
                └─────────────────────────────────────────────┘
```

Four Railway services per environment: **web** (Next.js), **api** (NestJS), **worker** (same NestJS image, worker entrypoint), **Postgres + Redis** (Railway plugins). Staging and production are separate Railway environments with separate databases.

## 2. Tech Stack (pinned)

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript (strict) end to end | one language, shared types |
| Frontend | Next.js 15 (App Router), React 19 | mobile-first PWA, installable |
| UI | Tailwind CSS v4 + shadcn/ui | professional look fast |
| Data fetching | TanStack Query v5 | caching, optimistic updates |
| Backend | NestJS 11 (REST) | modular monolith |
| ORM | Prisma 6 | migrations, type-safe queries |
| DB | PostgreSQL 16 | Railway plugin |
| Queue/jobs | Redis 7 + BullMQ | scheduled + event jobs |
| Auth | JWT (httpOnly, secure cookies) + refresh rotation | argon2id password hashing |
| Validation | zod (shared schemas in `packages/shared`) | same rules client & server |
| CI/CD | GitHub Actions → Railway deploy | lint, typecheck, test, migrate |
| Monitoring | Sentry (web + api) + Railway logs | error budget for pilot |
| Testing | Vitest (unit), Supertest (API), Playwright (e2e happy paths) | see §12 |

**Monorepo layout** (pnpm workspaces + turborepo):

```
despl-tracker/
├── apps/
│   ├── web/          # Next.js PWA
│   └── api/          # NestJS (also builds the worker entrypoint)
├── packages/
│   ├── shared/       # zod schemas, types, constants (stage codes, roles)
│   └── config/       # eslint, tsconfig presets
├── docs/             # PRD.md, TRD.md, ERD, decisions
├── CLAUDE.md
└── progress.md
```

## 3. Data Model (ERD)

### 3.1 Identity & org

| Table | Key columns | Notes |
|---|---|---|
| `users` | id, name, email, password_hash, is_active | no self-signup |
| `roles` | enum-backed: ADMIN, MANAGEMENT, PRODUCTION_HEAD, SUPERVISOR, QC, VIEWER | |
| `user_roles` | user_id, role | many-to-many |
| `departments` | id, name, code | Engineering, Procurement, Stores, Production, QC/NDT, Painting, Dispatch, Docs |
| `department_members` | department_id, user_id, is_supervisor, **is_representative** | representative = default recipient of dept notifications/escalations (names from DESPL later) |
| `welders` | id, name, employee_code, is_active | assignable to units/jobs via `welder_assignments` |

### 3.2 Jobs & units

| Table | Key columns | Notes |
|---|---|---|
| `clients` | id, name, code | |
| `jobs` | id, job_number, client_id, po_ref, design_code, order_date, delivery_date, priority, status | e.g. DESPL-320 |
| `units` | id, job_id, serial_no, equipment_type_id, template_version_id, kickoff_date, status | e.g. 320SR01 |

### 3.3 Templates (versioned — FR-M4)

| Table | Key columns | Notes |
|---|---|---|
| `equipment_types` | id, name | "Pressure Vessel" first |
| `template_versions` | id, equipment_type_id, version, published_at | running units pin a version |
| `stage_templates` | id, template_version_id, seq, name, department_id, standard_duration_days, is_conditional, condition_label | durations supplied by SJ/team |
| `stage_predecessors` | stage_template_id, predecessor_stage_template_id | explicit DAG → allows parallel stages (nozzle fab ∥ shell fab) |
| `sub_activity_templates` | id, stage_template_id, seq, name | e.g. fit-up → L-seam → RT… |
| `qcp_templates` | id, stage_template_id, seq, activity, characteristics, extent, applicable_doc, acceptance_criteria, record_type, seller_code, buyer_code | codes: P/W/H/R per QCP doc |
| `component_route_templates` | id, template_version_id, component_type (SHELL_COURSE/HEAD/CONE/NOZZLE/MANWAY/SADDLE/SKIRT/PIPE/ACCESSORY…) | per-part operation routes (definitions from SJ/DESPL) |
| `route_operation_templates` | id, component_route_template_id, seq, name, department_id, inspection_required, maps_to_stage_template_id | operations map to a vessel stage → stage % is a roll-up |

### 3.4 Execution (per unit)

| Table | Key columns | Notes |
|---|---|---|
| `unit_stages` | id, unit_id, stage_template_id, status, planned_start, planned_end, baseline_start, baseline_end, actual_start, actual_end, submitted_by, submitted_at, verified_by, verified_at, is_applicable | status enum §4.1; actuals server-set only |
| `unit_sub_activities` | id, unit_stage_id, sub_activity_template_id, done_by, done_at | |
| `unit_components` | id, unit_id, component_type, tag (Shell-1, N1, Top Head…), bom_item_ids[] | component register, auto-generated from BOM, editable |
| `component_operations` | id, unit_component_id, route_operation_template_id, status, done_by, done_at, verified_by, verified_at | floor-level truth; unit_stage %/Submit eligibility derive from these |
| `unit_checkpoints` | id, unit_stage_id, qcp_template_id, result (PENDING/ACCEPTED/REJECTED/NA), remarks, recorded_by, recorded_at | rejection spawns `rework_items` |
| `hold_point_clearances` | id, unit_checkpoint_id, party (TPI/CLIENT/DESPL), call_given_date, call_attended_date, cleared_by_name, recorded_by, remarks, waived, waiver_approved_by | QC records TPI on their behalf (v1) |
| `rework_items` | id, unit_checkpoint_id, description, status, closed_by_checkpoint_id | must close before stage completes |
| `plan_revisions` | id, unit_stage_id, old_start, old_end, new_start, new_end, revised_by, reason, revised_at | baseline never mutates |
| `delay_reasons` | id, unit_stage_id, category, detail, filed_by, filed_at, review_status, reviewed_by | categories per FR-D2 |

### 3.5 BOM & traceability

| Table | Key columns | Notes |
|---|---|---|
| `bom_master_items` | id, category, description, material_spec, default_size, uom, is_active | company-wide master catalog (list from DESPL); keeps naming consistent across projects |
| `bom_items` | id, unit_id, master_item_id (nullable), sr_no, tag, description, qty, material_spec, size, unit_weight_kg | built by selecting from master (with overrides) or import; null master_item_id = custom item flagged for catalog curation |
| `procurement_events` | id, bom_item_id, status (MR/PR/RFQ/PO/RECEIVED/INSPECTED/ACCEPTED/REJECTED/ISSUED), ref_no, event_at, actor_id | append-only chain |
| `material_inspections` | id, bom_item_id, mtc_ref, heat_numbers[], pmi_required, pmi_result, result, inspector_id | heat-number traceability |
| `stage_material_deps` | stage_template_id, bom_category | e.g. Cutting blocked until shell plates ACCEPTED (FR-B4) |

### 3.6 Welding & NDT

| Table | Key columns | Notes |
|---|---|---|
| `weld_joints` | id, unit_id, joint_no (LS-1, CS-1…), joint_type (BUTT/FILLET/…), size | butt welds tracked per joint |
| `weld_logs` | id, welder_id, unit_id, joint_id (nullable), log_date, hours/qty, logged_by | joint_id null ⇒ day-total entry |
| `ndt_results` | id, joint_id, method (RT/UT/PT/MT/VT/PMI), result (ACCEPT/REPAIR), report_ref, recorded_by, recorded_at | attributed to joint's welder(s) → per-welder repair rate |

### 3.7 Notifications & audit

| Table | Key columns | Notes |
|---|---|---|
| `notifications` | id, user_id, type, entity_ref, title, body, read_at, created_at | in-app only (v1) |
| `daily_briefs` | id, brief_date, payload (jsonb), generated_at | rendered by web; email-ready for Phase 2 |
| `audit_log` | id (bigserial), actor_id, action, entity_type, entity_id, before (jsonb), after (jsonb), ip, user_agent, at | **append-only: no UPDATE/DELETE grants for the app DB role on this table** |

## 4. Core Mechanisms

### 4.1 Stage state machine & gating (FR-S1, S2, S7)

```
NOT_STARTED → IN_PROGRESS → SUBMITTED → COMPLETE
                   ↕ ON_HOLD (reason required)
```

Transition rules, enforced inside a single DB transaction in `StageService`:

1. `start`: allowed only if **every predecessor stage** (via `stage_predecessors` DAG) is COMPLETE, material deps satisfied (FR-B4), and actor is a supervisor of the owning department.
2. `submit`: allowed only if all applicable sub-activities are done, **all component operations mapped to the stage are done** (roll-up from `component_operations`), and no open rework items.
3. `verify` (→ COMPLETE): allowed only if actor has QC role, **actor ≠ submitted_by** (maker–checker, FR-S6), and every H-coded checkpoint has a clearance (or an audited waiver for W-codes, FR-Q4).
4. Every transition writes `audit_log` in the same transaction — if the audit insert fails, the transition rolls back.

Client-supplied dates are rejected at the DTO layer: `actual_*`, `*_at` fields simply don't exist in any request schema; the service sets `now()` from the DB clock (single time authority, IST for display).

### 4.2 Overdue / at-risk engine (FR-D1, D5)

- Nightly BullMQ job (00:05 IST) + on-read computation: `overdue = planned_end < today AND status != COMPLETE`.
- Filing block: middleware rejects new progress writes by a department on a unit while that department has an overdue stage there without a `delay_reasons` row (FR-D2).
- At-risk heuristics v1: predecessor finished late, or elapsed > 70% of duration with < 70% sub-activities done.

### 4.3 Priority list (FR-N2)

Deterministic score per open stage/checkpoint per user: `overdue_days*1000 + due_today*500 + at_risk*250 + job_priority_weight + delivery_proximity_weight`; grouped as Overdue → Due today → At risk → Upcoming. Same engine feeds supervisor and QC lists (QC sees pending verifications + upcoming hold-point calls).

### 4.4 Daily brief (FR-N3)

07:45 IST worker job composes `daily_briefs.payload`: company snapshot, yesterday's movement, exceptions (overdue with reason status), upcoming inspection calls, per-job % complete (duration-weighted). Web renders it; Phase 2 email reuses the same payload.

### 4.5 Escalation chain (FR-D4)

Overdue day 1 → notification to dept supervisor **and department representative**; day 2 → + Production Head(s); day 3+ → flagged in MD/CEO brief and company dashboard. Thresholds in a `settings` table.

## 5. API Design

REST, versioned under `/api/v1`. NestJS modules mirror PRD §6:

`auth` · `users` · `departments` · `templates` · `jobs` · `units` · `stages` · `checkpoints` · `bom` · `welding` · `delays` · `notifications` · `dashboards` · `audit`

Representative endpoints:

```
POST /auth/login                         # sets httpOnly cookie
GET  /units/:id/board                    # stage board (FR-J4)
POST /stages/:id/start | submit | verify # state machine (guards: RBAC + gating)
POST /checkpoints/:id/result             # QC records checkpoint
POST /checkpoints/:id/clearance          # hold/witness clearance incl. TPI-on-behalf
POST /units/:id/bom/import               # column-mapped spreadsheet import
POST /welding/logs                       # per-joint or day-total
POST /stages/:id/delay-reason            # unblocks the filing block
GET  /me/priority-list                   # morning list
GET  /briefs/today                       # daily brief
GET  /dashboards/company|department/:id|quality|welding
```

Guards stack per route: `JwtGuard → RolesGuard → DepartmentScopeGuard → (service-level gating)`. All mutations pass through an `AuditInterceptor` capturing before/after.

## 6. Frontend Architecture

- **Screens (v1):** Login · Company dashboard (MD/CEO) · Daily brief · Job list/overview (unit×stage matrix) · Unit stage board · Stage detail (sub-activities, submit) · QC verify queue · Checkpoint/hold-point entry · BOM & material readiness · Welding log + distribution view · Delay reason modal + review queue · Priority list ("Today") · Notification center · Admin (users, departments+representatives, templates, welders, settings) · Audit viewer.
- Mobile-first: supervisor/QC flows designed for one-hand phone use; dashboards optimized for desktop.
- PWA: installable, app shell cached; **no offline writes in v1** (integrity > convenience; offline queue is a Phase 2 decision).
- Role-based routing: users land on their home screen (supervisor → Today list; MD → company dashboard).

## 7. Security

TLS (Railway-managed); httpOnly + Secure + SameSite cookies; argon2id; login rate limiting; RBAC on every endpoint (deny by default); department scoping server-side; zod validation on all inputs; no client-supplied timestamps or IDs of other actors; Postgres app role has no UPDATE/DELETE on `audit_log`; secrets in Railway env vars; daily automated DB backups + pre-pilot restore drill.

## 8. Environments, CI/CD & Migrations

- **Environments:** `staging` (auto-deploy on merge to `main`) and `production` (manual promote). Separate DBs, seeded staging with demo data.
- **CI (GitHub Actions):** lint → typecheck → unit tests → API tests against ephemeral Postgres → build → deploy. `prisma migrate deploy` runs as a Railway pre-deploy step; migrations are forward-only, reviewed in PR.
- Docker images for api/web/worker → nothing Railway-specific; future AWS move is re-deploy only.

## 9. Seed & Import Plan

1. Seed script: departments, roles, delay-reason categories, admin user.
2. **Pressure Vessel template v1**: 25 stages + sub-activities + predecessor DAG + durations (from SJ — pending input), QCP checkpoints transcribed from QCP DESPL-320-01 to 09.
3. DESPL-320 pilot: job + 9 units + BOM import from the existing sheet + weld joint list from weld map.

## 10. Performance & Capacity

Target: 50 concurrent users, 50 jobs × 10 units live. Worst-case hot query is the company dashboard (~10k unit_stages aggregate) — served by indexed queries + 60s cache; p95 < 500 ms API, dashboards < 2 s. Postgres on Railway's base plan is comfortably 100× this load; no premature optimization (no sharding, no microservices).

## 11. Error Handling & Observability

Problem-details JSON errors with stable codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `REASON_REQUIRED`, `HOLD_POINT_OPEN`…) so the UI explains *why* an action was refused — this is part of the demo story. Sentry on web+api; structured pino logs; health endpoints per service; Railway alerts on crash loops.

## 12. Testing Strategy

- **Unit:** state machine transitions, gating DAG, priority scoring, overdue computation — exhaustive table-driven tests (this is where fake entries would sneak in, so it gets the densest coverage).
- **API:** auth/RBAC matrix (role × endpoint), maker–checker violations, filing-block behavior, audit-row-per-mutation invariant.
- **E2E (Playwright):** the pilot narrative — create job → run a unit through 3 stages incl. a hold point → attempt violations (skip stage, self-verify, back-date) and assert refusal.
- Definition of done per sprint includes green CI + demo script updated.

## 13. Technical Risks & Open Items

| Item | Status |
|---|---|
| Standard stage durations | **Pending from SJ/DESPL team** — blocks schedule engine seed, not development (use placeholders) |
| Department representatives & supervisor names | **Pending from DESPL** — schema ready (`department_members.is_representative`) |
| Welder list + weld map joint numbering convention | Pending — needed for pilot seed, not for build |
| Parallel-stage predecessor rules | Draft DAG from the work-order doc; confirm with SJ in Week 0 review |
| Offline shop-floor connectivity | v1 requires connectivity for writes; revisit after pilot feedback |
