# 15 — DESPL MOS Data Architecture

**Source:** `prisma/schema.prisma`, 2,139 lines, **71 models, 25 enums**, verified by direct grep against the live file (not assumed from the audit) on 2026-08-31.

## 1. Full entity map, grouped by bounded context

### Identity & Organization
`Organization`, `Client`, `User`, `Role`, `UserRole`, `Department`, `UserDepartment`

### Reference vocabularies (tenant-scoped tables, not enums — verified pattern, preserved)
`ComponentTypeRef`, `EquipmentTypeRef`, `OperationRef`, `TestTypeRef`, `DrawingTypeRef`, `DelayCategoryRef`, `QcpCodeRef`, `WorkCalendar`, `Holiday`

### Product Family & Templates
`ProductFamily`, `ProcessTemplate`, `ProcessTemplateVersion`, `TemplateProcess`, `TemplateEdge`, `RouteTemplate`, `RouteTemplateVersion`, `RouteStep`, `AssemblyTemplate`, `AssemblyTemplateVersion`, `AssemblyTemplateStep`

### Project / Job / Equipment
`Job`, `Equipment`, `Unit`, `Package`

### Scheduling Spine
`JobProcess`, `JobProcessEdge`, `ScheduleRun`, `ProcessPlan`

### BOM & Material
`BomRevision`, `BomItem`, `ProcurementEvent`, `MaterialIdentification`, `StockLot`, `StockTxn`

### Fabrication Track
`Component`, `ComponentOperation`, `ComponentOperationRejection`, `PaintRecord`, `DftReading`, `ItemTest`, `Welder`, `WeldJoint`, `WeldJointWelder`, `WeldLog`, `NdtResult`

### Assembly Track
`AssemblyStep`, `AssemblyStepRejection`

### Quality
`Ncr`, `QcpTemplate`, `InspectionParty`, `QcpItem`, `QcpItemProcess`, `QcpItemPartyCode`, `QcpExecution`

### Engineering / Documents
`AssemblyDrawing`, `DrawingRevision`

### Dispatch
`DispatchBatch`, `DispatchBatchUnit`

### Cross-cutting: Delay, Notification, Visibility
`DelayReason`, `Notification`, `ClientVisibilityPolicy`, `ProgressSnapshot`

### Audit (append-only, DB-grant-enforced)
`AuditLog`, `DomainEvent`

## 2. Enum inventory (25 verified)

`ThemePreference`, `JobPriority`, `JobStatus`, `ProcessEdgeType`, `ScheduleMode`, `ScheduleFeasibility`, `ProcessPlanStatus`, `TemplateStatus`, `BomRevisionStatus`, `ProcurementEventType`, `StockTxnType`, `PmiResult`, `Sourcing`, `OperationStatus`, `TestResult`, `QcpItemKind`, `QcpExecutionResult`, `DrawingStatus`, `DelayReviewStatus`, `NcrDisposition`, `NcrStatus`, `ProcessEvidenceKind`, `SnapshotCadence`, `AssemblyStepKind`, `ProgressSnapshotStatus`.

**Design principle, verified consistently applied:** enums are used exclusively for genuine, closed state machines (status fields). Anything that is an open, growable vocabulary (component types, operations, drawing types, delay categories, QCP codes) is a tenant-scoped reference table instead — no exception found in the 71-model schema.

## 3. Multi-tenancy and RLS coverage — the precise, verified numbers

- **27 of 71 models carry `tenantId` directly.** The other 44 rely on being reached through a `Job`/`Equipment` FK chain (the `_shared.ts` parent-join convention, verified consistently applied in every file sampled).
- **RLS policies exist on 3 migrations, 4 `CREATE POLICY` statements** — real and DB-enforced for the tables they cover, fail-closed (`withTenant`'s `set_config('app.tenant_id', ...)`, verified: if unset, queries return zero rows and inserts are rejected — not a silent cross-tenant leak).
- **35 of 56 non-reference tables carry no RLS of their own** (per the ADR's own accounting, independently consistent with the 27/71 tenantId figure) — tenant isolation for these rests on the parent-join convention being followed correctly at every read/write site, not on a database guarantee.
- **139 `@@index` declarations**, no missing-FK-index pattern found in the models spot-checked.
- **No soft-delete convention**: zero `deletedAt` fields across all 71 models (`03` §4).
- **`createdAt` on 12 of 71 models, `updatedAt` on exactly 1** — the deliberate substitute is `AuditLog`/`DomainEvent` (append-only, DB-grant-enforced: `UPDATE`/`DELETE` explicitly revoked at the SQL grant level, verified directly in migration SQL, not just application convention).

## 4. The one real structural gap: job-level isolation

**`GAP`, highest severity in the data architecture:** tenant isolation is a real database guarantee (RLS + `withTenant`). **Job-level isolation within a tenant is not** — no schema-level or RLS enforcement exists for "can user X on Job A's team see Job B's data." It rests entirely on every service function remembering to filter by `jobId` through the correct join chain. This was verified as consistently applied in the files sampled, and is exercised by a real (if narrow) `cross-tenant.test.ts`/`authz.test.ts` suite — but it is application discipline, not a database guarantee, and the negative-test suite itself is self-documented as narrow (four hand-picked entry points, not a static sweep of every exported function).

**`TARGET`:** add a `jobId`-scoped RLS policy (or view-based enforcement) as a backstop, mirroring the tenant-level pattern already proven to work. This is the same mechanism extended one level deeper, not a new mechanism — low architectural risk, meaningful correctness gain. **P2** (`17`).

## 5. Reliability patterns already in place (preserve)

- `withTenant` — transactionality and tenant isolation are the *same code path* (verified: `set_config` for RLS happens inside the same `$transaction` that wraps every mutation), meaning a developer cannot "forget RLS" without also forgetting the transaction wrapper entirely, which would be immediately obvious.
- Optimistic concurrency on template edits: `SELECT … FOR UPDATE` plus an `updatedAt` staleness check throwing `STALE_WRITE` — a real, working pattern.
- Row-locked state transitions on production execution (`10` §3).
- Per-row BOM import failure (never whole-batch abort) — a deliberate reliability choice (`08` §1).

**`GAP`, scalability-adjacent (not a correctness bug):** two read services (`myday.read.ts`, `command-center.read.ts`) contain code comments admitting a per-active-job loop pattern ("fine at DESPL's 3–40 concurrently active jobs, batch before a tenant with hundreds"). A genuine N+1 exists in the main job-list read path: the primary list query is properly batched, but a subsequent `Promise.all` issues 3+ additional queries **per job in the list**. Most list-shaped read services have **zero pagination** (`take`/`skip`) — `admin.read.ts`, `command-center.read.ts`, `departments.read.ts`, `gantt.read.ts`, `job-intake.read.ts`, `myday.read.ts`, `portfolio.read.ts`, `stage-detail.read.ts`, `template.read.ts`, and critically `jobs.read.ts`'s own main job list. None of this is disqualifying at DESPL's actual current scale; the team's own comments already admit "hundreds, not thousands" as the current ceiling. **P2/P3** (`17`) — real, bounded, well-understood work, not an architectural rethink.

---
*Sources: `prisma/schema.prisma` (direct grep, all 71 models and 25 enums), `src/lib/db.ts`, `src/lib/services/_shared.ts`, migration SQL (grant revocation on `audit_log`/`domain_events`), `docs/ADR-product-family-agnostic-platform-v1.md`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §6, §26, §33, §35.*
