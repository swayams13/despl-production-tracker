# 00 — SYSTEM INVENTORY

*DESPL Production Tracker · enterprise audit · 7 September 2026*
*Audited at HEAD `dc924c1`. Read-only: no application code was modified.*

---

## 1. What this system is

An end-to-end production tracker for DESPL, a pressure-vessel and heat-exchanger
fabricator. It tracks manufacturing from purchase order to dispatch across ~13
departments: a 36-process spine collapsed onto 25 work-order stages, QCP/ITP
checkpoints with P/W/H hold points, BOM and heat-number traceability, welding
productivity, delay accountability, and a client/TPI portal.

Pilot job: **DESPL-320** (9 HP air receivers). Live jobs: **DE0463** (40 units),
DE0467. The platform is designed to be product-family-agnostic (Pressure Vessel,
Heat Exchanger, Pipe Spool, Piping System) with families authored as data.

---

## 2. Stack and shape

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 15.5.23, App Router | Single full-stack app, not a monorepo |
| Language | TypeScript, strict | |
| UI | Tailwind v4 + shadcn/ui, Radix primitives | Dark industrial theme, 3 palettes incl. outdoor high-contrast |
| Mutations | Server Actions only | 20 action modules, all through one wrapper |
| Reads | Server Components + 9 GET-only route handlers | No TanStack Query, no client data layer |
| ORM | Prisma 6 | Generated client committed under `src/generated/prisma` |
| Database | PostgreSQL 16 | RLS-enforced, app connects as non-owner `despl_web` |
| Background | Next route + external cron | `/api/cron/alerts`, `/api/cron/digest` |
| Deploy | Railway, single `production` env | Auto-deploy from `main`; **migrations applied manually** |
| CI | GitHub Actions | lint → typecheck → migrate → diff → seed → unit → DB → build → e2e |

---

## 3. Code census

| Metric | Count |
|---|---|
| TypeScript/TSX files (total) | 385 |
| Lines of code, excluding `src/generated/` | **55,298** |
| Pages (`page.tsx`) | 26 |
| API route handlers | 9 |
| Server Action modules | 20 (+ `_action.ts` wrapper) |
| Service modules (`src/lib/services/`) | 45 domain services + 40 read models |
| Scheduling engine modules (`src/lib/schedule/`) | 11 |
| Test files | 90 (~750 cases); **54 DB-gated** |
| Playwright specs | 4 projects, 21 tests |
| Prisma migrations | **50** (plus `migration_lock.toml`) |
| `prisma/schema.prisma` | 2,370 lines / 106 KB |
| `prisma/seed.ts` | 67 KB |

---

## 4. Route inventory

### Authenticated app — `src/app/(app)/`

| Route | Purpose today | Read model |
|---|---|---|
| `/dashboard` | Portfolio band + full single-project deep-dive | `portfolio.read`, `workspace.read:loadJobKpis` |
| `/my-day` | Personal work **+ department pool + teammates' work** | `myday.read` |
| `/workspace` | One job's department worklist (pinned to DESPL-320) | `workspace.read` |
| `/command/[dept]` | Cross-job department cockpit — **office departments only** | `command-center.read` |
| `/board` | **Stub** — "coming in R2" | none |
| `/alerts` | Full-page notification history | `notifications.read` |
| `/profile` | **Stub** — "coming in R2" | none |
| `/departments` | Per-department cards (open / on-time% / overdue) | `departments.read` |
| `/departments/[id]` | Open-items table + cycle time + delay reasons | `departments.read` |
| `/jobs` | Paginated project list (50/page) | `jobs.read` |
| `/jobs/[id]` | 9-tab project control centre | `job-detail`, `spine`, `gantt`, `bom`, `assembly`, `qcp-grid`, `packing`, `dispatch`, `events`, `client-snapshot` |
| `/jobs/new` | 5-step intake wizard | `job-intake.read` |
| `/qc` | QC cockpit — verification queue, hold points, NCRs | `qc-cockpit.read` |
| `/welding` | Welder productivity, weld logging, NDT | `welding.read` |
| `/reports` | Daily digest + tomorrow's due list + send history | `reports.read` |
| `/admin`, `/admin/{templates,routes,families,equipment-types,qcp-templates}` | Master data + users | `admin.read`, `template.read` |

### Outside the app group

| Route | Purpose |
|---|---|
| `/login` | Credential form (the only authentication entry point) |
| `/account/password` | Forced password change |
| `/portal` | Client/TPI portal — VERIFIED progress snapshots only |
| `/` | Role-based redirect |

### API — all GET except cron

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | **public** | Compares `prisma/migrations/` to `_prisma_migrations`; 503 when pending |
| `GET /api/jobs` | staff | Paginated, clamped at 200 |
| `GET /api/events` | staff | Activity feed (UNION over `domain_events`) |
| `GET /api/jobs/[id]/spine` | staff | Stage spine |
| `GET /api/jobs/[id]/stage` | staff | Stage detail |
| `GET /api/jobs/[id]/qcp/export` | staff | Excel export; bypasses the shared wrapper, re-checks by hand |
| `GET /api/welding/joints` | staff | |
| `POST /api/cron/alerts` | `CRON_SECRET` bearer | Overdue + aged-hold notifications |
| `POST /api/cron/digest` | `CRON_SECRET` bearer | Daily management digest |

---

## 5. Database inventory *(measured on a live PostgreSQL 16 build from all 50 migrations)*

| Object | Count |
|---|---|
| Tables | **73** |
| Views | **2** — `v_unit_stage_status`, `v_process_plan_percent` (both plain, both `security_invoker=true`) |
| Materialised views | 0 |
| Indexes | **297** |
| Unique indexes (incl. PKs) | 126 |
| Foreign keys | **199** — 71 RESTRICT, 71 CASCADE, 57 SET NULL; all 199 `ON UPDATE CASCADE` |
| Enum types | **25** |
| CHECK constraints | **1** (`ncr_exactly_one_source`) |
| Triggers | **0** |
| Stored functions | **0** |
| Rules | **0** |
| Tables with RLS enabled | **52** (0 FORCED) |
| Tables with no RLS | **21** |
| Distinct RLS policy shapes | 2 — `tenant_isolation` (24 tables, fail-closed), `job_isolation` (28 tables, **fail-open by design**) |

**Structural fact that matters most:** the two policy sets are **disjoint**. All 28
job-grain tables have no `tenant_id` column and no tenant policy. See `12_SECURITY_RBAC.md`.

### Core domain model

```
Organization (tenant)
└── Client ──────────────────────────── ClientVisibilityPolicy
└── Job ── ProcessTemplateVersion (pinned)
    ├── Equipment ── Unit ── (serialNo)
    ├── JobProcess (36) ── JobProcessEdge (39: 16 FTS, 23 overlap)
    ├── ScheduleRun (isCurrent) ── ProcessPlan (per process × unit)
    │                              ├── DelayReason
    │                              └── assigneeUserId (NULL = pool)
    ├── BomRevision ── BomItem ── StockLot ── StockTxn
    │                          └── ProcurementEvent, MaterialIdentification
    ├── Component ── ComponentOperation ── ComponentOperationRejection ── Ncr
    │             └── PaintRecord ── DftReading
    ├── AssemblyStep ── AssemblyStepRejection ── Ncr
    ├── QcpTemplate ── QcpItem ── QcpItemPartyCode ── QcpCodeRef (P/W/H)
    │                          └── QcpExecution (attemptNo)
    ├── WeldJoint ── WeldJointWelder, WeldLog, NdtResult
    ├── Package ── DispatchBatch ── DispatchBatchUnit
    ├── AssemblyDrawing ── DrawingRevision
    └── ProgressSnapshot (PUBLISHED → VERIFIED → client portal)

AuditLog, DomainEvent — tenant-grain, append-only, no FK to Job
```

---

## 6. Roles as implemented

`src/lib/authz/index.ts:6-13` — six roles, no more:

`ADMIN` · `MANAGEMENT` · `PRODUCTION_HEAD` · `SUPERVISOR` · `QC` · `CLIENT_VIEWER`

There is **no operator/employee role**. `prisma/seed.ts:1476-1483` creates one user
per department and grants each `SUPERVISOR`. See `02_ROLE_MODEL.md`.

---

## 7. Enforcement layers

| Control | Where | Verified |
|---|---|---|
| Authentication | `src/lib/auth/session.ts` — HS256 JWT, httpOnly, 12h, `sessionVersion` revocation | ✅ |
| Authorization | `src/lib/authz/index.ts` — deny-by-default, no implicit admin | ✅ |
| Validation | `src/lib/shared/schemas.ts` — 86 zod schemas, 84 `.strict()` | ✅ |
| Tenant isolation | RLS `tenant_isolation`, transaction-local GUC, fail-closed | ✅ on 24 tables, **absent on 28** |
| Job isolation | RLS `job_isolation`, fail-open by design | ⚠️ see AUD-001 |
| Append-only audit | `REVOKE UPDATE, DELETE` from `despl_app`; boot-checked by `assertDbRole` | ✅ proven live |
| Gating | `src/lib/schedule/gating.ts`, called in-transaction after a row lock | ✅ |
| Maker–checker | `assertMakerChecker` — QC role + actor ≠ submitter, no ADMIN branch | ✅ |
| Concurrency | `SELECT … FOR UPDATE` on the mutated row; advisory lock on stock lots | ✅ for the subject row, ✗ for gate predicates |
| Business rules in DB | 1 CHECK, 0 triggers | ❌ |

---

## 8. Documentation already in the repo

`docs/` holds 33 documents including `BUILD-SPEC-v2.md` (authoritative on scheduling
and granularity), `DESIGN_SPEC.md` (the frontend execution contract),
`ADR-product-family-agnostic-platform-v1.md`, five prior `AUDIT-*.md` files,
`DESPL_MOS_TRANSFORMATION_PLAN.md` (the Gate 0–4 structure this audit's roadmap
maps onto), `DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md`, and
`mos-execution/` (PROMPTS-v4, LEDGER, MERGE-RUNBOOK).

`progress.md` is 683 KB and is the canonical session log.

**This audit read all of them and does not re-report anything they have already
closed.** Where a known issue is worse than previously documented, that is stated
explicitly in the finding.

---

## 9. How this audit was conducted

1. **Static analysis** of every route, action, service, read model, migration,
   component and test — seven parallel expert passes.
2. **Live database evidence.** All 50 migrations were applied from scratch to a
   fresh PostgreSQL 16 cluster with a non-superuser `despl_web` role configured
   exactly as `scripts/provision-db-role.sql` does. Checksums of the migration
   stream and `schema.prisma` were verified byte-for-byte against the repo.
   RLS policies, grants, constraints and impossible states were then probed with
   real SQL, and the results are quoted verbatim in `11_DATABASE_AUDIT.md`.
3. **No application code was modified.** Nothing in `src/`, `prisma/` or `docs/`
   was written to. This `audit/` directory is the only addition.

---

## 10. Reader's guide

| If you want | Read |
|---|---|
| The five-minute version | `01_EXECUTIVE_AUDIT.md` |
| What ships first | `20_REMEDIATION_ROADMAP.md` |
| Every finding, sortable | `19_MASTER_ISSUE_REGISTER.md` |
| Why the screens feel wrong | `03_INFORMATION_ARCHITECTURE.md`, then `04`–`09` |
| The compliance exposure | `10_BUSINESS_LOGIC.md` §2, `12_SECURITY_RBAC.md` §1 |
| Proof rather than assertion | `11_DATABASE_AUDIT.md` — every claim is a quoted query and its real output |
