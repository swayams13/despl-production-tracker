# SPEC — Department Workspaces + Auto-Prioritizer (v1 prototype)

**Date:** 2026-08-14 · **Status:** draft for review · **Supersedes:** progress.md "What's remaining" items #5–#7 for this slice.

Read alongside `docs/BUILD-SPEC-v2.md` (authoritative on scheduling/grain/stack) and the CLAUDE.md invariants (#1–#12). This spec builds the **UI/Server-Action layer** on top of the already-Postgres-verified `lib/services/`, plus the backend rework the per-unit decision forces.

---

## 1. Goal

Make **every department functional end-to-end** on the DESPL-320 pilot so DESPL's own team can log in and drive real work, and so leadership (MD/CEO/SJ) can watch the workflow move. The prototype must show the integrity refusals *firing on screen*, not just in tests.

**Decisions locked (2026-08-14):**
1. **Per-unit grain** — track the 9 serials 320SR01–09 individually, not at job/equipment grain. Hold points fire per unit.
2. **Prioritizer only** — an automatic "what to work on next, and why" derivation. No workforce-aware assignment this round (blocked on DESPL data + invariant #10).
3. **DESPL-320 only** — the only schedulable job (PRESSURE_VESSEL, real durations). DE0463/DE0467 piping is provisional → shown read-only, not driveable.
4. **Fuller KPI dashboard** for management.

## 2. Why this is achievable, not 13 builds

All 13 seeded departments own real work in the 36-process spine (QC 8, Fabrication 8, Engineering/Procurement/Dispatch 3 each, … Documentation/Stores/Machine-Shop/Heat-Treatment/Planning 1 each — every department non-empty). `lib/services/` is already department-agnostic (`process.service` scopes by `plan.ownerDepartmentId`). **One actor-scoped workspace serves all 13 departments** via the logged-in supervisor's scope; the cross-department handoff (Fabrication finishes → Welding unblocks → QC verifies) is inherent in the DAG. So the finite deliverable is: turn the plan data on, extend the services to per-unit grain, and build the missing UI/action layer.

## 3. Non-goals (explicitly deferred)

- Workforce/crew assignment, load-levelling, throughput-based finish prediction (the "auto-scheduler" half — needs DESPL data, §9).
- Full QCP execution engine: TPI call-given/attended, witness-waiver (W) approval flow, rework-attempt UI beyond a new attempt row. Only the **minimum to clear a blocking hold point** is in scope (§6.5).
- Welding productivity, NDT/repair-rate, notifications, daily brief, client portal content, file uploads, Railway deploy — all remain future sprints.
- `reviewDelayReason` (PH acknowledge/dispute) — service seam already noted, not built.
- Per-serial schedule *stagger* (unit 1 ahead of unit 9). All units share the equipment envelope dates in v1; staggering is a Phase-2 sequencing concern.

---

## 4. Architecture overview

```
Browser (client islands: action buttons, forms)
   │  Server Actions  (src/app/actions/*.ts — "use server", thin)
   ▼        getActor() → service(actor, input) → catch AppError → {ok,code,message} + revalidatePath
lib/services/  (rule-holders — EXTENDED to per-unit grain in P0)
   ├ schedule.service   generate/read (now expands per unit)
   ├ process.service    start/submit/verify/hold/resume (gates per unit)
   ├ delay.service      file reason (unblocks #7)
   ├ qcp.service  (NEW) record execution → clears hold point (#4)
   └ prioritizer  (NEW, pure) rank a department's plans, with reasons
lib/schedule/  (pure engine — unchanged; prioritizer reuses computeCpm for float)
Postgres  (ScheduleRun / ProcessPlan per unit / QcpExecution / DelayReason)
```

**Refusal rendering is the product.** Every `AppError` carries a stable code (§ERROR_CODES) and `ERROR_MESSAGES` already has a human default per code. Server Actions map `error.code → {code, message}`; the UI shows the sentence inline next to the row and, where relevant, the unblock path.

---

## 5. Phase 0 — Per-unit grain in the services (backend, hard dependency)

**This is the riskiest phase and everything downstream depends on it. It lands and is DB-verified before any UI.** The services are currently hardcoded to `unitId: null`; per-unit grain changes the plan-generation and gating reads.

### 5.1 Plan expansion
- `_shared.ts` `PlanInput` gains `unitId: number | null`. `persistScheduleRun` writes `unitId: p.unitId` (drop the hardcoded `null`).
- `schedule.service.generateSchedule` loads the job's units (`tx.unit.findMany` via the job's equipments). For each **included** process × each unit, emit one `PlanInput` carrying that `unitId`; planned/baseline dates are the equipment envelope dates, **identical across units** in v1 (`// ponytail: units share the envelope; per-serial stagger is Phase-2 sequencing`).
  - **Uniform per-unit for all 36 processes**, including batch-level ones (PO Receipt, Engineering, Procurement). This is a deliberate simplification: the alternative (flagging each process batch-vs-unit) needs per-process grain data DESPL hasn't given, and mixed-grain gating is complex. Flagged as open question **C24** (§9). `// ponytail:` comment at the expansion site.
  - Fallback: a job with **0 units** still generates at `unitId: null` (keeps DE0463/DE0467 paths valid). DESPL-320 has 9 units → 36 × 9 = 324 plans.
- `@@unique([scheduleRunId, jobProcessId, unitId])` already supports this.

### 5.2 Per-unit gating
- `loadPredecessorStates(tx, scheduleRunId, jobProcessId, unitId)` — new `unitId` param; filter predecessor plans by the **same** `unitId`. A unit's fabrication waits on *that unit's* predecessors, not another serial's.
- `process.service.loadGate` threads `plan.unitId` into `loadPredecessorStates`.
- `assertNoUnfiledDelayBlock` — already takes `unitId`; keep passing `plan.unitId` (block is per unit).
- `assertNoOpenHoldPoint` — already unit-aware; now that `plan.unitId` is non-null it **starts enforcing** (was a documented no-op). This is intended.

### 5.3 Tests (table-driven, per CLAUDE.md testing convention)
- Unit-scoped gating: unit-1 successor stays `GATING_BLOCKED` while only unit-2's predecessor is COMPLETE; unblocks when unit-1's own predecessor completes.
- Plan count: generating DESPL-320 yields 36 × 9 plans, all `NOT_STARTED`, correct `ownerDepartmentId`, distinct `unitId`.
- Hold point now bites: a process with a blocking checkpoint and no execution on a unit → `verify` throws `HOLD_POINT_OPEN`; clears after an ACCEPTED execution (ties into P5).
- Run the DB tier: `set -a && . ./.env && set +a && RUN_DB_TESTS=1 pnpm test`.

## 6. Phases 1–7 (build order)

### P1 — Schedule bootstrap for DESPL-320
A post-seed script `scripts/bootstrap-schedule.ts`: construct an ADMIN actor for the DESPL tenant, call `generateSchedule(actor, {jobId: <DESPL-320>, mode: "FORWARD"})`. Deterministic, idempotent-ish (each run adds a new version + demotes the prior — fine; document it). Wire a `pnpm db:bootstrap` script. Without this there are **no ProcessPlan rows** to drive.

### P2 — Prioritizer (pure, no new data)
`lib/services/prioritizer.ts` — a **pure function** over the current run's plans + edges + CPM float. No DB writes.
- Input: `{ plans: ProcessPlan[], edges: JobProcessEdge[], today: Date }` (+ float from `computeCpm` on the spine — 36 nodes, cheap; `// ponytail: compute float on read, don't persist a float column until a query needs it`).
- Per plan, derive a **state** and a **reason**:
  - `BLOCKED` — a same-unit predecessor is not COMPLETE → reason names the blocking process.
  - `READY` — NOT_STARTED and all same-unit predecessors COMPLETE (reuse a non-throwing readiness predicate mirroring `assertCanStart`; add `evaluateReadiness()` rather than try/catch the asserting version).
  - `IN_PROGRESS` / `SUBMITTED` / `ON_HOLD` / `DONE` — from status.
  - `OVERDUE` — `plannedFinish < today` and not COMPLETE (overlays state; drives the #7 block).
- **Rank** within a department: on-critical-path (zero float) first, then OVERDUE, then READY-and-due-soon, then READY, then BLOCKED (shown with what they wait on), DONE last.
- Output: `{ departmentId → RankedPlan[] }` where `RankedPlan = { plan, state, reasonCode, reasonText, criticalPath, floatDays }`.
- Tests: ranking order for a hand-built plan set; a critical-path item outranks an earlier-due non-critical one; a BLOCKED item names the correct predecessor.

### P3 — Server Actions
`src/app/actions/process.ts`, `qcp.ts`, `delay.ts` (or one `workspace.ts`). Each action: `"use server"` → `requireActor()` → call the service → `try/catch`. On `AppError` return `{ ok: false, code, message: ERROR_MESSAGES[code] }`; on success `revalidatePath("/workspace")` (and `/dashboard`) and return `{ ok: true }`. Discriminated-union return type shared with the client islands. Actions never re-implement a gate.

### P4 — Supervisor department workspace (`/workspace`)
Server Component, actor-scoped like `page.tsx`:
- `getActor()` → SUPERVISOR: their department's `RankedPlan[]` grouped by unit (or by process with unit chips — see C25 note); PH/ADMIN: all departments (they're unscoped). Mobile-first (CLAUDE.md convention: supervisor → "Today" priority list).
- Each row: process name · unit(s) · state badge · planned dates · the prioritizer reason. Action buttons per state: `READY→Start`, `IN_PROGRESS→Submit / Hold`, `ON_HOLD→Resume`. Buttons are client islands calling P3 actions; refusals render inline (code + sentence).
- Reuse `viz/MilestoneTimeline` for a unit's process spine, `viz/KpiTile` for the department's ready/overdue/blocked counts. Retire the gallery sample data.

### P5 — QC verify queue + minimal QCP clearance
- QC view at `/workspace` (role-branched): SUBMITTED plans across departments → `Verify` (maker-checker fires if verifier == submitter). Plus **open hold points**: blocking QcpItems on units whose latest execution isn't ACCEPTED/NA.
- **NEW `lib/services/qcp.service.ts` `recordQcpExecution(actor, {qcpItemId, unitId, result, remarks?})`** — QC role, `assertNotClientUser`, new `QcpExecution` at `attemptNo = max+1`, `result ∈ {ACCEPTED, REJECTED, NA}`, `recordedAt` server clock, audited in-tx. ACCEPTED/NA clears the hold; REJECTED leaves it open (and is the rework signal). New `.strict()` `recordQcpExecutionSchema` (no `*_at`/client timestamps, invariant #1). **Out of scope:** call-given/attended, W-waiver approval — those stay Phase 2.
- Tests: verify after submit by a *different* QC → COMPLETE; same user → `MAKER_CHECKER_VIOLATION`; verify with an open blocking checkpoint → `HOLD_POINT_OPEN`; after ACCEPTED execution → verify succeeds.

### P6 — Delay filing UI
When the prioritizer marks a department OVERDUE (or a progress action returns `REASON_REQUIRED`), show a delay form: pick a `DelayCategoryRef` + optional detail → P3 action → `delay.service.fileDelayReason`. On success the block clears and the action retries. (Confirm delay categories are seeded; if not, add a seed step. `delay.service` doesn't yet check `DelayCategoryRef.active` — low-priority, note.)

### P7 — Management dashboard (`/dashboard`, fuller KPI)
MANAGEMENT/PH/ADMIN only. Reads the current run's plans across the job. Tiles/charts (reusing `viz/`):
- Company rollup: jobs, units, overall % complete, counts on-track / at-risk / overdue.
- Per-department status matrix (`viz/MatrixHeatmap`, department × status).
- Planned-vs-actual progress (`viz/SCurve`) from plan dates + actuals.
- Critical-path health: count of critical-path plans slipping, worst slippage days.
- Quality: open hold points, delays filed (by category). **No welding/NDT KPIs** (no data yet).
- Landing routing: extend `page.tsx` — SUPERVISOR/QC → `/workspace`, MANAGEMENT → `/dashboard`, ADMIN → choice/overview.

---

## 7. Data flow (the demo narrative it must support)

1. Bootstrap generates 324 unit plans for DESPL-320 (all `NOT_STARTED`).
2. Engineering supervisor starts+submits their processes on a unit; QC verifies (different person). A same-person verify attempt → visible `MAKER_CHECKER_VIOLATION`.
3. Predecessor COMPLETE unblocks the next department's process **on that unit** (BLOCKED→READY in the prioritizer). Another unit stays BLOCKED — proving per-unit gating.
4. Welding reaches a process with an H-point checkpoint → `verify` refused `HOLD_POINT_OPEN` until QC records an ACCEPTED execution for that unit.
5. A process passes its `plannedFinish` → the department is blocked (`REASON_REQUIRED`) until it files a categorised delay; then it flows again.
6. MD/CEO/SJ open `/dashboard` and see all of the above rolled up live.

## 8. Testing & verification
- Every new/changed gating, state-machine, RBAC, audit path gets **table-driven violation-case tests** (CLAUDE.md convention), not just happy paths.
- DB tier (`RUN_DB_TESTS=1`) must stay green, run twice (rerun-safe), after P0 and after P5.
- `/verify`-style end-to-end: drive the actual `/workspace` flow in a browser for one unit through start→submit→verify→hold-clear→delay, and confirm each refusal renders. `pnpm typecheck && pnpm lint && pnpm build` clean.
- Open `/component-gallery` + `/workspace` + `/dashboard` in light **and** dark mode (progress.md #5 folds in here).

## 9. Open questions / DESPL inputs (surface, default in use)
- **C24 (new)** — do batch-level processes (PO Receipt, Engineering, Procurement) belong per-serial or once-per-batch? *Default:* uniform per-unit (redundant but simple). Changing this later is a plan-expansion change, not a schema one.
- **C25 (new)** — floor UX: group the worklist by **unit** (all processes for serial 320SR03) or by **process** (all serials at "Long-seam weld")? *Default:* group by unit; revisit with the DESPL team during the demo.
- Still outstanding (pre-existing): welder list, weld-map joint numbering, department supervisor/representative names (C9), working-vs-calendar days (C1), and — for the Phase-2 auto-scheduler — **per-department capacity/headcount/shift/throughput**, which is the specific data the workforce optimizer needs and cannot be faked against invariant #10.

## 10. Rollout as a dynamic multi-phase workflow
Sequential, because P0 is a hard dependency and each UI phase leans on services verified in place:
1. **P0 backend grain** — implement → adversarial review → fix → **DB-verify** (gate: 324 plans, per-unit gating tests green). Nothing proceeds until this passes.
2. **P1 bootstrap** + **P2 prioritizer** (parallelizable — P2 is pure, P1 is data).
3. **P3 actions**, then **P4 workspace**, **P5 QC+QCP**, **P6 delay** (P4/5/6 fan out on the shared action layer).
4. **P7 dashboard**.
5. Full-suite + browser verification pass; update `progress.md`.

Commit to `demo` only. Do not merge to `main` without explicit approval (project rule).
