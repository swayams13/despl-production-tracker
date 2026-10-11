# 19 — DESPL MOS Acceptance Tests

## 1. "New project tomorrow" acceptance test

| Step | User | Input | Validation | Output | Resulting domain objects | Status today |
|---|---|---|---|---|---|---|
| Create Project | ADMIN/PRODUCTION_HEAD | Client, job number | `DUPLICATE_JOB_NUMBER` check | `Job` row | `Job` | **PASS** — real, tested |
| Create Jobs | Same | (Job *is* the project — `05`) | — | — | — | N/A — no separate step, by design |
| Add Equipment | Same | Equipment type, family | Family/type match | `Equipment` row | `Equipment` | **PASS** |
| Select Product Family | Same | `familyId` | Must have a published `ProcessTemplateVersion` | Pinned family | `Job.familyId` | **PASS for PRESSURE_VESSEL; FAILS for HEAT_EXCHANGER/PIPING_SYSTEM (no template)** |
| Select/Configure Workflow | Same | `templateVersionId` | Version must be PUBLISHED | Pinned template | `Job.templateVersionId` | **PASS**, conditional on a template existing |
| Upload BOM | ADMIN/PRODUCTION_HEAD | Excel file | Row-level validation, alias-based header matching | `BomItem` rows | `BomRevision`/`BomItem` | **PASS** — real, tested UI path |
| Validate BOM | Same | — | Per-row error report | Partial-success import | — | **PASS** |
| Map BOM | Same | Component links | — | `Component.bomItemId` | — | **PARTIAL** — bulk import has no `componentTypeId` field (`08`) |
| Approve BOM | Same | — | `BomRevisionStatus` transition | Approved revision | — | **PASS** |
| Generate Work | System | Template materialization | — | `JobProcess`/`ComponentOperation`/`AssemblyStep` | **PASS** |
| Generate Schedule | System | CPM computation | Verified against printed envelope | `ProcessPlan` dates | **PASS** |
| Assign Departments | System | Template's department assignments | — | — | **PASS** — data-driven |
| Assign Teams | Supervisor | Claim/assign action | Department scope check | `ProcessPlan.assigneeUserId` | **PASS** |
| Start Execution | Floor operator | `start` action | Gating check | `ComponentOperation.IN_PROGRESS` | **PASS** |
| QC | QC inspector | `verify`/`reject` | Maker-checker | `QcpExecution` | **PASS** |
| Rework if required | QC/Production | NCR disposition | State machine | `Ncr` transitions | **PASS** |
| Finish | Floor operator | `complete` | All predecessors COMPLETE | `ComponentOperation.COMPLETE` | **PASS** |
| Dispatch | Production/Admin | Pack, release, dispatch | **No UI** | `DispatchBatch` | **FAILS — zero UI (`04`, `08`)** |
| Close | System | Job status update | — | `Job.status` | **PARTIAL** — no explicit "close" ceremony evidenced beyond status |

**Net result of this acceptance test as run today:** a new project *can* flow end-to-end for `PRESSURE_VESSEL` (the one bootstrapped family) up through Finish; it **fails** at Dispatch (no UI) and **fails to even start** for any family without a published template (which is every family except PRESSURE_VESSEL, and provisionally PIPE_SPOOL).

## 2. Formal acceptance criteria — the ten self-review questions

### Test 1 — Can a new project be created without developer involvement?
**Partially.** Yes for `PRESSURE_VESSEL` today. **No** for any other family — creating the family/route/QCP that a project needs still requires a developer (`06`). Closing Phase C (`18`) makes this fully **Yes**.

### Test 2 — Can a new product family be introduced without rewriting MOS core?
**Yes, mechanically — verified.** No family branch exists anywhere in gating, scheduling, or authorization code. The blocker is tooling (no bootstrap UI), not architecture. This is the single most important verified finding in this blueprint.

### Test 3 — Can two product families have different routes?
**Yes.** `RouteTemplate` is `@@unique([tenantId, componentTypeId, familyId])` with nullable `familyId`; `PIPE_SPOOL`'s route is already structurally distinct from `PRESSURE_VESSEL`'s.

### Test 4 — Can one project contain multiple jobs/equipment?
**Job is the project root (`05`); one Job can contain multiple Equipment, each with multiple Unit serials — verified, exercised by real seed data (DE0467/DE0463).** If "multiple jobs under one project" is meant literally, see `05`'s `DECISION REQUIRED` on whether a `Project` entity above `Job` is needed — not evidenced as necessary today.

### Test 5 — Can departments operate independently but through shared MOS primitives?
**Yes — verified as the system's strongest capability.** `gating.ts` has zero department-awareness; every department's work is a `ProcessPlan`/`ComponentOperation` gated by the same mechanism.

### Test 6 — Can procurement block production?
**Partially.** `assertKitReady` is real and wired into `startComponentOperation`, but silently no-ops for BOM items with no stock-transaction history (`08`). **Answer: yes for tracked material, no enforcement for untracked material** — a real, named gap, not a broken mechanism.

### Test 7 — Can production delays propagate to delivery risk?
**No, not automatically.** `fileDelayReason` has zero scheduling imports; propagation requires a manual `applyDurationOverride` (`09`). This is `17`'s P3 item (Phase F) — a real gap, explicitly scoped for automation.

### Test 8 — Can QC trigger rework?
**Yes — verified, real, tested.** `Ncr` state machine (`OPEN → REWORK_IN_PROGRESS → CLOSED`) with reinspection.

### Test 9 — Can management see the entire company?
**Yes, at company/project/department grain.** **No dedicated equipment-grain view** (`14`) — a real, narrow gap, not a missing capability class.

### Test 10 — Can DESPL-320 run purely as one project instance?
**Almost, not quite.** Four literal couplings remain (`workspace/page.tsx`'s pilot-job fallback, `admin.read.ts`'s family literal, `stage-names.ts`'s 25-stage table, `welding.service.ts`'s department literal) — all narrow, call-site-level, none structural. **Nothing found requires DESPL-320 or PRESSURE_VESSEL to exist for the system to run** — but two of the four would misbehave (not crash) for a second family today. Closing Phase B (`18`) makes this fully **Yes**.

## 3. Multi-project acceptance test

Run simultaneously: Project A (Pressure Vessel), Project B (Heat Exchanger or Pipe Spool), Project C (a third family/workflow shape).

**Verifiable today:** workflows, schedules, BOMs, departments, production, QC, documents(N/A — none exist yet), KPIs, and alerts are all architecturally per-job/per-family — no shared mutable state found between jobs beyond the tenant boundary itself. **Not yet run for real** beyond DESPL-320 and the secondary DE0467/DE0463 job (both PRESSURE_VESSEL) — this blueprint's Phase J (`18`) is exactly this test, using PIPE_SPOOL as Project B.

**No test in the current suite is titled around "Project A vs Project B,"** but the functional equivalent is covered with generic (non-DESPL-320) two-job fixtures in at least four different test files — since every job is created through the same generic `templateVersionId` mechanism, these tests substantively prove cross-job independence even without that exact framing.

---
*Sources: consolidated from `01`–`18`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §32, §57.*
