# Department Workspaces + Auto-Prioritizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every department functional end-to-end on the DESPL-320 pilot at per-unit grain, with an automatic prioritizer and a management KPI dashboard, showing the integrity refusals firing on screen.

**Architecture:** Thin Server Actions call the already-verified `lib/services/` (extended here from `unitId:null` to per-unit grain). A pure prioritizer ranks each department's plans. Actor-scoped Server Components render the workspace/dashboard; client islands invoke the actions and render refusals inline.

**Tech Stack:** Next.js 15 (App Router, Server Actions), Prisma 6 + PostgreSQL 16, zod, TypeScript strict, Tailwind v4, vitest (node env), Playwright.

**Spec:** `docs/SPEC-department-workspaces-v1.md`

## Global Constraints

- **Invariant #1:** No request schema may contain `actual_*` or `*_at`. Every new zod schema is `.strict()`. Actuals are DB-clock only.
- **Rules live in services.** Server Actions and components are thin callers — never re-implement a gate, never write the DB directly outside a service.
- **Refusals are explainable (#12).** Services throw `AppError(code, detail)`; actions map `code → ERROR_MESSAGES[code]`; the UI shows the sentence. Never swallow an `AppError` into a generic "failed".
- **Per-unit gating reads same-unit predecessors** — a unit waits on *its own* predecessors, never another serial's.
- **Maker–checker (#3) has no admin exception.** `assertMakerChecker` already enforces QC-role + `actor ≠ submittedBy`; do not weaken it.
- **Tests:** any change to state-machine/gating/RBAC/audit needs table-driven violation-case tests, not just happy paths (CLAUDE.md).
- **DB test tier:** run with `set -a && . ./.env && set +a && RUN_DB_TESTS=1 pnpm test` (needs `despl-pg` up + seeded). Pure tier: `pnpm test`.
- **Styling idiom:** follow `src/app/page.tsx` exactly — Tailwind with CSS vars (`border-[var(--hairline)]`, `bg-[var(--surface)]`, `text-[var(--muted-fg)]`, `tabular`). Reuse `src/components/viz/*`. Do not introduce a new design system.
- **Commit to `demo` only.** Never merge to `main` without explicit approval.
- **Model discipline:** Sonnet for these coding tasks.

---

## File Structure

**Modify (backend, Phase 0):**
- `src/lib/services/_shared.ts` — `PlanInput.unitId`; `persistScheduleRun` writes it; `loadPredecessorStates` gains a `unitId` param.
- `src/lib/services/schedule.service.ts` — `generateSchedule` expands plans across the job's units.
- `src/lib/services/process.service.ts` — `loadGate` threads `plan.unitId`.
- `src/lib/schedule/gating.ts` — add pure `startReadiness()` helper; `assertCanStart` delegates to it.

**Create (backend/logic):**
- `scripts/bootstrap-schedule.ts` — generate the DESPL-320 schedule as ADMIN (P1).
- `src/lib/services/prioritizer.ts` — pure ranking (P2).
- `src/lib/services/qcp.service.ts` — `recordQcpExecution` (P5 backend).
- `src/app/actions/_action.ts` — `ActionResult` + `toActionError`.
- `src/app/actions/process.ts`, `src/app/actions/qcp.ts`, `src/app/actions/delay.ts` — Server Actions.

**Create (UI):**
- `src/app/workspace/page.tsx` — actor-scoped workspace (server).
- `src/app/workspace/plan-row.tsx` — client island: transition buttons + inline refusal.
- `src/app/workspace/qcp-clear.tsx` — client island: record execution.
- `src/app/workspace/delay-form.tsx` — client island: file delay reason.
- `src/app/dashboard/page.tsx` — management KPI dashboard (server).
- `src/lib/services/workspace.read.ts` — shared read: load current run + prioritized view for a job (used by workspace + dashboard).

**Modify (UI):**
- `src/app/page.tsx` — role-based landing redirects.
- `src/lib/shared/schemas.ts` — add `recordQcpExecutionSchema`.
- `package.json` — add `db:bootstrap` script.
- `progress.md` — session log (final task).

---

## Phase 0 — Per-unit grain in the services

### Task 1: `PlanInput.unitId` + persist + per-unit predecessor read

**Files:**
- Modify: `src/lib/services/_shared.ts`
- Test: `src/lib/services/_shared.test.ts`

**Interfaces:**
- Produces: `PlanInput` now `{ jobProcessId, ownerDepartmentId, unitId: number|null, baselineStart, baselineFinish, plannedStart, plannedFinish }`; `loadPredecessorStates(tx, scheduleRunId, jobProcessId, unitId: number|null): Promise<PredecessorState[]>`.

- [ ] **Step 1: Edit `PlanInput`** — add `unitId` (the doc comment currently says "unitId is always null"; replace it):

```ts
/** One ProcessPlan to write; unitId null = job/equipment grain, else per-serial. */
export interface PlanInput {
  jobProcessId: number;
  ownerDepartmentId: number;
  unitId: number | null;
  baselineStart: Date | null;
  baselineFinish: Date | null;
  plannedStart: Date | null;
  plannedFinish: Date | null;
}
```

- [ ] **Step 2: `persistScheduleRun` writes the unit** — in the `processPlans.create` map, replace `unitId: null` with `unitId: p.unitId`:

```ts
processPlans: {
  create: input.plans.map((p) => ({
    jobProcessId: p.jobProcessId,
    unitId: p.unitId,
    baselineStart: p.baselineStart,
    baselineFinish: p.baselineFinish,
    plannedStart: p.plannedStart,
    plannedFinish: p.plannedFinish,
    ownerDepartmentId: p.ownerDepartmentId,
    status: "NOT_STARTED",
  })),
},
```

- [ ] **Step 3: `loadPredecessorStates` gains `unitId`** — signature + the `findMany` filter:

```ts
export async function loadPredecessorStates(
  tx: Tx,
  scheduleRunId: number,
  jobProcessId: number,
  unitId: number | null,
): Promise<PredecessorState[]> {
  const edges = await tx.jobProcessEdge.findMany({
    where: { processId: jobProcessId },
    select: { predecessorId: true },
  });
  if (edges.length === 0) return [];

  const predIds = edges.map((e) => e.predecessorId);
  const plans = await tx.processPlan.findMany({
    where: { scheduleRunId, jobProcessId: { in: predIds }, unitId: unitId ?? null },
    select: { jobProcessId: true, status: true },
  });
  const statusByProc = new Map(plans.map((p) => [p.jobProcessId, p.status]));
  return predIds.map((predecessorId) => ({
    predecessorId,
    status: statusByProc.get(predecessorId) ?? "NOT_STARTED",
  }));
}
```

Update its doc comment: remove the `// ponytail: unitId null — job/equipment grain only` note (now parameterised).

- [ ] **Step 4: DB test — per-unit predecessor isolation.** Add to `_shared.test.ts` (skip-gated behind `RUN_DB_TESTS`, following the existing file's pattern). Create a run with two units, mark unit-A's predecessor COMPLETE, assert `loadPredecessorStates(tx, runId, succId, unitB)` returns the predecessor as `NOT_STARTED` while `unitA` returns `COMPLETE`.

- [ ] **Step 5: Run** `set -a && . ./.env && set +a && RUN_DB_TESTS=1 pnpm test src/lib/services/_shared.test.ts` — expect PASS. Then `pnpm typecheck` (Task 2/3 consume the new signature; typecheck will flag callers — that's expected and fixed next).

- [ ] **Step 6: Commit** `git commit -am "feat(services): per-unit PlanInput + predecessor read (grain P0.1)"`

---

### Task 2: `generateSchedule` expands plans across units

**Files:**
- Modify: `src/lib/services/schedule.service.ts`
- Test: `src/lib/services/schedule.service.test.ts`

**Interfaces:**
- Consumes: `PlanInput.unitId` (Task 1).
- Produces: `generateSchedule` writes one plan per (included process × unit); a job with no units falls back to a single `unitId:null` plan per process.

- [ ] **Step 1: Load units and expand.** Replace the current `plans` construction block (the `const deptByProc = ...` through the `const plans: PlanInput[] = envelope.map(...)`) with:

```ts
const deptByProc = new Map(spine.rawProcesses.map((p) => [p.id, p.departmentId]));

// Per-unit grain: one plan per (included process × unit). A job with no units
// (e.g. provisional piping jobs) falls back to a single unitId-null plan/process.
// ponytail: all units share the equipment envelope dates in v1 — per-serial
// stagger is a Phase-2 sequencing concern, not modelled here.
const units = await tx.unit.findMany({
  where: {
    equipment:
      parsed.equipmentId != null
        ? { id: parsed.equipmentId, jobId: parsed.jobId }
        : { jobId: parsed.jobId },
  },
  select: { id: true },
});
const unitIds: (number | null)[] = units.length > 0 ? units.map((u) => u.id) : [null];

const plans: PlanInput[] = unitIds.flatMap((unitId) =>
  envelope.map((e) => ({
    jobProcessId: e.processId,
    ownerDepartmentId: deptByProc.get(e.processId)!,
    unitId,
    baselineStart: e.plannedStartMax,
    baselineFinish: e.plannedFinishMax,
    plannedStart: e.plannedStartMax,
    plannedFinish: e.plannedFinishMax,
  })),
);
```

(`computeEnvelope` returns only included processes, so no extra filter is needed. `EnvelopeDates` fields are `processId`, `plannedStartMax`, `plannedFinishMax` — already used above.)

- [ ] **Step 2: DB test — plan count + grain.** In `schedule.service.test.ts` (skip-gated), generate a FORWARD schedule for DESPL-320 and assert: `run.processPlans.length === 36 * 9`, every plan `status==="NOT_STARTED"`, `unitId` non-null, and the set of distinct `unitId`s has size 9. Add a second assertion that a job with 0 units still yields one plan per included process with `unitId===null` (use an existing unit-less job, or skip if none seeded — note in the test).

- [ ] **Step 3: Run** `RUN_DB_TESTS=1 pnpm test src/lib/services/schedule.service.test.ts` — expect PASS.

- [ ] **Step 4: Commit** `git commit -am "feat(schedule): generate per-unit plans (grain P0.2)"`

---

### Task 3: `process.service` gates per-unit

**Files:**
- Modify: `src/lib/services/process.service.ts`
- Test: `src/lib/services/process.service.test.ts`

**Interfaces:**
- Consumes: `loadPredecessorStates(tx, scheduleRunId, jobProcessId, unitId)` (Task 1).

- [ ] **Step 1: Thread `plan.unitId` into `loadGate`.** In `loadGate`, change the `loadPredecessorStates` call to pass the unit:

```ts
async function loadGate(
  tx: Tx,
  plan: ProcessPlan,
): Promise<{ edges: ScheduleEdge[]; states: PredecessorState[] }> {
  const rawEdges = await tx.jobProcessEdge.findMany({ where: { processId: plan.jobProcessId } });
  const states = await loadPredecessorStates(tx, plan.scheduleRunId, plan.jobProcessId, plan.unitId);
  return { edges: rawEdges.map(jobEdgeToScheduleEdge), states };
}
```

(No other change: `assertNoUnfiledDelayBlock` and `assertNoOpenHoldPoint` already receive `plan.unitId`. The hold-point check now bites because `unitId` is non-null.)

- [ ] **Step 2: DB test — per-unit gating isolation.** Add a skip-gated test: generate DESPL-320, take a FINISH_TO_START pair (predecessor P, successor S). Drive P→COMPLETE on unit-A (start→submit→verify with a QC actor). Assert `startProcess` on S for unit-A succeeds, but `startProcess` on S for unit-B throws `AppError` with code `GATING_BLOCKED`. Use the table-driven style already in this file.

- [ ] **Step 3: DB test — hold point now enforces.** For a process S on unit-A that has a blocking QcpItem (`partyCodes.some.qcpCode.blocksCompletion`), drive S to SUBMITTED, then `verifyProcess` → expect `HOLD_POINT_OPEN`. (If DESPL-320's spine has no blocking checkpoint linked to a schedulable process, assert the no-op path instead and leave a `// TODO(P5 test)` referencing Task 8's clearance test — do NOT fabricate a checkpoint.)

- [ ] **Step 4: Run** `RUN_DB_TESTS=1 pnpm test src/lib/services/process.service.test.ts` — expect PASS. Then full pure + DB suite green, twice.

- [ ] **Step 5: Commit** `git commit -am "feat(process): per-unit gating + live hold points (grain P0.3)"`

---

## Phase 1 — Schedule bootstrap

### Task 4: `scripts/bootstrap-schedule.ts`

**Files:**
- Create: `scripts/bootstrap-schedule.ts`
- Modify: `package.json` (add `"db:bootstrap": "tsx scripts/bootstrap-schedule.ts"`)

**Interfaces:**
- Consumes: `generateSchedule` (Task 2), `getActor`-style Actor construction.

- [ ] **Step 1: Write the script.** Resolve the ADMIN user for the DESPL tenant and generate the pilot schedule:

```ts
import { withTenant } from "@/lib/db";
import { generateSchedule } from "@/lib/services/schedule.service";
import { ROLES, type Actor } from "@/lib/authz";

async function main() {
  // The seed creates a single tenant; resolve it + the admin user + DESPL-320.
  const { tenantId, adminUserId, jobId } = await resolveTargets();
  const admin: Actor = {
    userId: adminUserId,
    tenantId,
    clientId: null,
    name: "bootstrap",
    email: "bootstrap@local",
    roles: [ROLES.ADMIN],
    departmentIds: [],
  };
  const run = await generateSchedule(admin, { jobId, mode: "FORWARD" });
  console.log(`Generated schedule run ${run.id} v${run.version} with ${run.processPlans.length} plans.`);
}

async function resolveTargets() {
  // Bootstrapping runs against the app connection; wrap the lookup in a tenant
  // context using the first organization (single-tenant seed).
  return withTenantBootstrap(async (tx, tenantId) => {
    const admin = await tx.user.findFirst({
      where: { roles: { some: { role: { code: "ADMIN" } } }, active: true },
      select: { id: true },
    });
    const job = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    if (!admin) throw new Error("bootstrap: no ADMIN user found — run pnpm db:seed first");
    if (!job) throw new Error("bootstrap: job DESPL-320 not found — run pnpm db:seed first");
    return { tenantId, adminUserId: admin.id, jobId: job.id };
  });
}

// Resolve the single seeded tenant, then run `fn` inside its RLS context.
async function withTenantBootstrap<T>(
  fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: number) => Promise<T>,
): Promise<T> {
  const anyTenantId = await firstTenantId();
  return withTenant(anyTenantId, (tx) => fn(tx, anyTenantId));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
```

> Implementation note for the executor: `firstTenantId()` must read the organization id **outside** RLS (the tenant guard needs a tenant id to open a context). Reuse whatever `resolveTenantForLogin`/`prisma/seed.ts` uses to get the org id — check `src/lib/auth/tenant-resolution.ts` and `src/lib/db.ts` for the existing owner/direct client, and use the direct (owner) client for this one-row lookup, mirroring how `seed.ts` connects. If a single-tenant helper already exists, use it instead of writing `firstTenantId` from scratch.

- [ ] **Step 2: Run** `pnpm db:bootstrap`. Expected: `Generated schedule run … with 324 plans.`

- [ ] **Step 3: Verify in DB** — `psql`/Prisma studio: `SELECT count(*) FROM process_plans WHERE schedule_run_id = <id>;` → 324, all `NOT_STARTED`.

- [ ] **Step 4: Commit** `git commit -am "feat(scripts): bootstrap DESPL-320 schedule (P1)"`

---

## Phase 2 — Prioritizer

### Task 5: `startReadiness()` pure predicate in gating.ts

**Files:**
- Modify: `src/lib/schedule/gating.ts`, `src/lib/schedule/index.ts`
- Test: `src/lib/schedule/gating.test.ts` (existing)

**Interfaces:**
- Produces: `startReadiness(edges: ScheduleEdge[], predecessorStates: PredecessorState[]): { ready: boolean; blockingPredecessorIds: number[] }`. `assertCanStart` delegates to it.

- [ ] **Step 1: Write the failing test** in `gating.test.ts`:

```ts
import { startReadiness } from "./gating";

test("startReadiness: ready when all FTS predecessors complete", () => {
  const edges = [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }];
  const r = startReadiness(edges, [{ predecessorId: 1, status: "COMPLETE" }]);
  expect(r).toEqual({ ready: true, blockingPredecessorIds: [] });
});

test("startReadiness: blocked names the incomplete predecessor", () => {
  const edges = [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }];
  const r = startReadiness(edges, [{ predecessorId: 1, status: "IN_PROGRESS" }]);
  expect(r).toEqual({ ready: false, blockingPredecessorIds: [1] });
});
```

- [ ] **Step 2: Run** `pnpm test src/lib/schedule/gating.test.ts` → FAIL (`startReadiness` undefined).

- [ ] **Step 3: Implement** in `gating.ts` (add above `assertCanStart`, then refactor `assertCanStart` to reuse it — keeps one source of truth for the FTS/overlap rule):

```ts
/** Non-throwing form of assertCanStart: which predecessors (if any) block a start. */
export function startReadiness(
  edges: ScheduleEdge[],
  predecessorStates: PredecessorState[],
): { ready: boolean; blockingPredecessorIds: number[] } {
  const statusById = new Map(predecessorStates.map((s) => [s.predecessorId, s.status]));
  const blocking = edges.filter((e) => {
    const status = statusById.get(e.predecessorId);
    if (status == null) {
      throw new Error(`startReadiness: no status given for predecessor ${e.predecessorId}`);
    }
    const required =
      e.type === "FINISH_TO_START" ? status === "COMPLETE" : STARTED_STATUSES.includes(status);
    return !required;
  });
  return { ready: blocking.length === 0, blockingPredecessorIds: blocking.map((e) => e.predecessorId) };
}
```

Then replace `assertCanStart`'s body with:

```ts
export function assertCanStart(
  edges: ScheduleEdge[],
  predecessorStates: PredecessorState[],
): void {
  const { ready, blockingPredecessorIds } = startReadiness(edges, predecessorStates);
  if (!ready) {
    throw new AppError(ERROR_CODES.GATING_BLOCKED, {
      reason: "predecessor(s) not sufficiently advanced to start",
      predecessorIds: blockingPredecessorIds,
    });
  }
}
```

Export `startReadiness` from `src/lib/schedule/index.ts` (add to the gating export line).

- [ ] **Step 4: Run** `pnpm test src/lib/schedule/gating.test.ts` → PASS (both new + all existing assertCanStart tests still green).

- [ ] **Step 5: Commit** `git commit -am "feat(schedule): startReadiness predicate for prioritizer (P2.1)"`

---

### Task 6: `prioritizer.ts` pure ranking

**Files:**
- Create: `src/lib/services/prioritizer.ts`, `src/lib/services/prioritizer.test.ts`

**Interfaces:**
- Consumes: `startReadiness` (Task 5); `ProcessPlan`, `ScheduleEdge`, `CpmNode` types.
- Produces: `prioritize(input): Map<number, RankedPlan[]>` (keyed by `ownerDepartmentId`).

- [ ] **Step 1: Write the failing test** `prioritizer.test.ts`:

```ts
import { prioritize, type PrioritizeInput } from "./prioritizer";

const plan = (o: Partial<any>) => ({
  id: o.id, jobProcessId: o.jobProcessId, unitId: 1, ownerDepartmentId: o.dept ?? 10,
  status: o.status ?? "NOT_STARTED", plannedStart: null,
  plannedFinish: o.plannedFinish ?? null, scheduleRunId: 1,
  baselineStart: null, baselineFinish: null, actualStart: null, actualFinish: null,
  submittedBy: null, verifiedBy: null,
}) as any;

test("critical-path READY outranks a nearer-due non-critical READY", () => {
  const input: PrioritizeInput = {
    today: new Date("2026-08-14"),
    plans: [
      plan({ id: 1, jobProcessId: 1, plannedFinish: new Date("2026-09-01") }), // critical
      plan({ id: 2, jobProcessId: 2, plannedFinish: new Date("2026-08-20") }), // nearer due, not critical
    ],
    edges: [],
    floatByProcessId: new Map([[1, { totalFloat: 0, isCritical: true }], [2, { totalFloat: 5, isCritical: false }]]),
    processNameById: new Map([[1, "Shell rolling"], [2, "Painting"]]),
  };
  const ranked = prioritize(input).get(10)!;
  expect(ranked[0].plan.id).toBe(1);
  expect(ranked[0].criticalPath).toBe(true);
});

test("blocked plan names its incomplete predecessor", () => {
  const input: PrioritizeInput = {
    today: new Date("2026-08-14"),
    plans: [
      plan({ id: 1, jobProcessId: 1, status: "IN_PROGRESS" }),
      plan({ id: 2, jobProcessId: 2, status: "NOT_STARTED" }),
    ],
    edges: [{ processId: 2, predecessorId: 1, type: "FINISH_TO_START", lagDays: 0 }],
    floatByProcessId: new Map([[1, { totalFloat: 0, isCritical: true }], [2, { totalFloat: 0, isCritical: true }]]),
    processNameById: new Map([[1, "Shell rolling"], [2, "Long-seam weld"]]),
  };
  const ranked = prioritize(input).get(10)!;
  const blocked = ranked.find((r) => r.plan.id === 2)!;
  expect(blocked.state).toBe("BLOCKED");
  expect(blocked.reasonText).toContain("Shell rolling");
});
```

- [ ] **Step 2: Run** `pnpm test src/lib/services/prioritizer.test.ts` → FAIL.

- [ ] **Step 3: Implement** `prioritizer.ts`:

```ts
import { startReadiness } from "@/lib/schedule";
import type { ScheduleEdge, PredecessorState } from "@/lib/schedule";
import type { ProcessPlan } from "@/generated/prisma/client";

export type PlanState = "BLOCKED" | "READY" | "IN_PROGRESS" | "SUBMITTED" | "ON_HOLD" | "DONE";

export interface RankedPlan {
  plan: ProcessPlan;
  state: PlanState;
  overdue: boolean;
  reasonCode: string;
  reasonText: string;
  criticalPath: boolean;
  floatDays: number;
}

export interface PrioritizeInput {
  plans: ProcessPlan[];
  edges: ScheduleEdge[]; // engine edges for the whole spine (jobEdgeToScheduleEdge)
  floatByProcessId: Map<number, { totalFloat: number; isCritical: boolean }>;
  processNameById: Map<number, string>;
  today: Date;
}

// Rank buckets — lower is higher priority.
function bucket(r: { state: PlanState; overdue: boolean; criticalPath: boolean }): number {
  if (r.state === "DONE") return 6;
  if (r.overdue) return 0;
  const actionable = r.state === "READY" || r.state === "IN_PROGRESS" || r.state === "SUBMITTED";
  if (r.criticalPath && actionable) return 1;
  if (r.state === "READY") return 2;
  if (actionable || r.state === "ON_HOLD") return 3;
  return 4; // BLOCKED
}

export function prioritize(input: PrioritizeInput): Map<number, RankedPlan[]> {
  const { plans, edges, floatByProcessId, processNameById, today } = input;

  // status lookup keyed by (jobProcessId, unitId) for same-unit predecessor reads.
  const key = (jobProcessId: number, unitId: number | null) => `${jobProcessId}:${unitId ?? "null"}`;
  const statusByKey = new Map(plans.map((p) => [key(p.jobProcessId, p.unitId), p.status]));
  const edgesByProc = new Map<number, ScheduleEdge[]>();
  for (const e of edges) (edgesByProc.get(e.processId) ?? edgesByProc.set(e.processId, []).get(e.processId)!).push(e);

  const ranked: RankedPlan[] = plans.map((plan) => {
    const cpm = floatByProcessId.get(plan.jobProcessId);
    const criticalPath = cpm?.isCritical ?? false;
    const floatDays = cpm?.totalFloat ?? 0;
    const overdue =
      plan.plannedFinish != null && plan.plannedFinish < today && plan.status !== "COMPLETE";

    let state: PlanState;
    let reasonCode = plan.status;
    let reasonText: string;

    switch (plan.status) {
      case "COMPLETE": state = "DONE"; reasonText = "Complete."; break;
      case "IN_PROGRESS": state = "IN_PROGRESS"; reasonText = "In progress."; break;
      case "SUBMITTED": state = "SUBMITTED"; reasonText = "Submitted — awaiting QC verification."; break;
      case "ON_HOLD": state = "ON_HOLD"; reasonText = "On hold."; break;
      default: {
        const procEdges = edgesByProc.get(plan.jobProcessId) ?? [];
        const predStates: PredecessorState[] = procEdges.map((e) => ({
          predecessorId: e.predecessorId,
          status: statusByKey.get(key(e.predecessorId, plan.unitId)) ?? "NOT_STARTED",
        }));
        const { ready, blockingPredecessorIds } = startReadiness(procEdges, predStates);
        if (ready) {
          state = "READY"; reasonCode = "READY";
          reasonText = criticalPath ? "Ready to start — on the critical path." : "Ready to start.";
        } else {
          state = "BLOCKED"; reasonCode = "BLOCKED";
          const names = blockingPredecessorIds.map((id) => processNameById.get(id) ?? `#${id}`);
          reasonText = `Waiting on: ${names.join(", ")}.`;
        }
      }
    }
    if (overdue) {
      reasonCode = "OVERDUE";
      reasonText = `Overdue — file a delay reason to continue. ${reasonText}`;
    }
    return { plan, state, overdue, reasonCode, reasonText, criticalPath, floatDays };
  });

  // Group by department, sort within each: bucket, then earliest plannedFinish, then unit.
  const byDept = new Map<number, RankedPlan[]>();
  for (const r of ranked) {
    (byDept.get(r.plan.ownerDepartmentId) ?? byDept.set(r.plan.ownerDepartmentId, []).get(r.plan.ownerDepartmentId)!).push(r);
  }
  for (const list of byDept.values()) {
    list.sort((a, b) => {
      const ba = bucket(a), bb = bucket(b);
      if (ba !== bb) return ba - bb;
      const fa = a.plan.plannedFinish?.getTime() ?? Infinity;
      const fb = b.plan.plannedFinish?.getTime() ?? Infinity;
      if (fa !== fb) return fa - fb;
      return (a.plan.unitId ?? 0) - (b.plan.unitId ?? 0);
    });
  }
  return byDept;
}
```

- [ ] **Step 4: Run** `pnpm test src/lib/services/prioritizer.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(services): pure prioritizer ranking (P2.2)"`

---

## Phase 3/5 — Backend for actions

### Task 7: `recordQcpExecution` service + schema

**Files:**
- Create: `src/lib/services/qcp.service.ts`, `src/lib/services/qcp.service.test.ts`
- Modify: `src/lib/shared/schemas.ts`

**Interfaces:**
- Produces: `recordQcpExecution(actor, input): Promise<QcpExecution>`; `recordQcpExecutionSchema`, `RecordQcpExecutionInput`.

- [ ] **Step 1: Add the schema** to `schemas.ts` (after `holdProcessSchema`):

```ts
/** QC records a checkpoint result for a unit → clears/opens the hold point (#4). */
export const recordQcpExecutionSchema = z
  .object({
    qcpItemId: id,
    unitId: id,
    result: z.enum(["ACCEPTED", "REJECTED", "NA"]),
    remarks: z.string().trim().optional(),
  })
  .strict();
export type RecordQcpExecutionInput = z.infer<typeof recordQcpExecutionSchema>;
```

(No `*_at`: `recordedAt`/`callAttendedOn` stay DB-clock — invariant #1.)

- [ ] **Step 2: Write the failing test** `qcp.service.test.ts` (skip-gated DB test, following `process.service.test.ts`'s harness): record an ACCEPTED execution on a blocking item+unit, then assert `verifyProcess` on the owning process no longer throws `HOLD_POINT_OPEN`. Also assert a client user is rejected (`FORBIDDEN`) and a non-QC user is rejected.

- [ ] **Step 3: Implement** `qcp.service.ts`:

```ts
import { withTenant } from "@/lib/db";
import { audited } from "@/lib/audit";
import { requireRole, assertNotClientUser, ROLES, type Actor } from "@/lib/authz";
import { recordQcpExecutionSchema, type RecordQcpExecutionInput } from "@/lib/shared/schemas";
import type { QcpExecution } from "@/generated/prisma/client";

/**
 * Minimal QCP checkpoint execution (CLAUDE.md invariant #4). Recording an
 * ACCEPTED/NA result for a unit clears a blocking hold point so the owning
 * process may complete; REJECTED leaves it open (the rework signal). This is
 * the smallest surface that lets per-unit hold points be cleared — TPI
 * call-given/attended and witness-waiver approval stay Phase 2.
 *
 * QC-role-gated: recording an inspection result is inherently a QC act. The
 * maker-checker rule (#3) sits on process verify, not on the execution itself.
 */
export async function recordQcpExecution(
  actor: Actor,
  input: RecordQcpExecutionInput,
): Promise<QcpExecution> {
  const { qcpItemId, unitId, result, remarks } = recordQcpExecutionSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.QC);

  return withTenant(actor.tenantId, async (tx) => {
    // Next attempt number for this (item, unit) — re-inspection after rejection.
    const prior = await tx.qcpExecution.aggregate({
      _max: { attemptNo: true },
      where: { qcpItemId, unitId },
    });
    const attemptNo = (prior._max.attemptNo ?? 0) + 1;

    return audited(tx, actor, async () => {
      const exec = await tx.qcpExecution.create({
        data: {
          qcpItemId,
          unitId,
          attemptNo,
          result,
          clearedBy: actor.userId,
          remarks: remarks ?? null,
          // recordedAt: DB default now() (invariant #1).
        },
      });
      return {
        result: exec,
        audit: {
          action: "qcp.record",
          entityType: "QcpExecution",
          entityId: exec.id,
          after: { qcpItemId, unitId, attemptNo, result },
          eventType: "QcpExecutionRecorded",
          eventPayload: { qcpItemId, unitId, attemptNo, result },
        },
      };
    });
  });
}
```

- [ ] **Step 4: Run** `RUN_DB_TESTS=1 pnpm test src/lib/services/qcp.service.test.ts` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(services): minimal QCP execution recording (P5 backend)"`

---

### Task 8: Server-action layer

**Files:**
- Create: `src/app/actions/_action.ts`, `src/app/actions/process.ts`, `src/app/actions/qcp.ts`, `src/app/actions/delay.ts`

**Interfaces:**
- Produces: `ActionResult`, `toActionError`; the exported actions `startAction/submitAction/verifyAction/holdAction/resumeAction/fileDelayAction/recordQcpAction`, each `(input) => Promise<ActionResult>`.

- [ ] **Step 1: `_action.ts`:**

```ts
import { isAppError, ERROR_MESSAGES, type ErrorCode } from "@/lib/shared/errors";

export type ActionResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** Map an AppError to a UI-safe result; rethrow anything unexpected (→ 500). */
export function toActionError(e: unknown): ActionResult {
  if (isAppError(e)) {
    const code = e.code;
    return { ok: false, code, message: ERROR_MESSAGES[code] ?? "This action could not be completed." };
  }
  throw e;
}
```

- [ ] **Step 2: `process.ts`** — one thin wrapper per transition:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import * as svc from "@/lib/services/process.service";
import { toActionError, type ActionResult } from "./_action";

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/workspace");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}

export async function startAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.startProcess(await requireActor(), { processPlanId }));
}
export async function submitAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.submitProcess(await requireActor(), { processPlanId }));
}
export async function verifyAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.verifyProcess(await requireActor(), { processPlanId }));
}
export async function holdAction(processPlanId: number, reason: string): Promise<ActionResult> {
  return run(async () => svc.holdProcess(await requireActor(), { processPlanId, reason }));
}
export async function resumeAction(processPlanId: number): Promise<ActionResult> {
  return run(async () => svc.resumeProcess(await requireActor(), { processPlanId }));
}
```

- [ ] **Step 3: `delay.ts`:**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { fileDelayReason } from "@/lib/services/delay.service";
import { toActionError, type ActionResult } from "./_action";

export async function fileDelayAction(
  processPlanId: number,
  categoryId: number,
  detail?: string,
): Promise<ActionResult> {
  try {
    await fileDelayReason(await requireActor(), { processPlanId, categoryId, detail });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
```

- [ ] **Step 4: `qcp.ts`:**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/authz";
import { recordQcpExecution } from "@/lib/services/qcp.service";
import { toActionError, type ActionResult } from "./_action";

export async function recordQcpAction(
  qcpItemId: number,
  unitId: number,
  result: "ACCEPTED" | "REJECTED" | "NA",
  remarks?: string,
): Promise<ActionResult> {
  try {
    await recordQcpExecution(await requireActor(), { qcpItemId, unitId, result, remarks });
    revalidatePath("/workspace");
    return { ok: true };
  } catch (e) {
    return toActionError(e);
  }
}
```

- [ ] **Step 5: Typecheck** `pnpm typecheck` → clean. **Commit** `git commit -am "feat(actions): thin server-action layer over services (P3)"`

---

## Phase 4/6 — Workspace UI

### Task 9: Shared workspace read

**Files:**
- Create: `src/lib/services/workspace.read.ts`

**Interfaces:**
- Produces: `loadPrioritizedJob(actor, jobId): Promise<{ run, rankedByDept, processNameById, departments } | null>` — the current run's prioritized view, computing CPM float once.

- [ ] **Step 1: Implement** — loads the current run, the spine (for edges + names + CPM), computes float, calls `prioritize`:

```ts
import { withTenant } from "@/lib/db";
import { assertClientScope, type Actor } from "@/lib/authz";
import { computeCpm } from "@/lib/schedule";
import { loadJobSpine, getCurrentScheduleRun, jobEdgeToScheduleEdge } from "./_shared";
import { prioritize, type RankedPlan } from "./prioritizer";
import type { Department } from "@/generated/prisma/client";

export interface PrioritizedJob {
  runId: number;
  rankedByDept: Map<number, RankedPlan[]>;
  departments: Department[];
  processNameById: Map<number, string>;
}

export async function loadPrioritizedJob(actor: Actor, jobId: number): Promise<PrioritizedJob | null> {
  return withTenant(actor.tenantId, async (tx) => {
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { clientId: true } });
    if (!job) return null;
    assertClientScope(actor, job.clientId);

    const run = await getCurrentScheduleRun(tx, jobId, null);
    if (!run) return null;

    const spine = await loadJobSpine(tx, jobId);
    const cpm = computeCpm(spine.processes, spine.edges);
    const floatByProcessId = new Map(cpm.map((n) => [n.processId, { totalFloat: n.totalFloat, isCritical: n.isCritical }]));
    const processNameById = new Map(spine.rawProcesses.map((p) => [p.id, p.name]));

    const rankedByDept = prioritize({
      plans: run.processPlans,
      edges: spine.edges,
      floatByProcessId,
      processNameById,
      today: new Date(),
    });

    const departments = await tx.department.findMany();
    return { runId: run.id, rankedByDept, departments, processNameById };
  });
}
```

- [ ] **Step 2: Typecheck** → clean. **Commit** `git commit -am "feat(services): prioritized-job read for UI (P4.0)"`

---

### Task 10: `/workspace` page + plan-row island

**Files:**
- Create: `src/app/workspace/page.tsx`, `src/app/workspace/plan-row.tsx`

**Interfaces:**
- Consumes: `loadPrioritizedJob` (Task 9), the process actions (Task 8).

- [ ] **Step 1: `plan-row.tsx`** (client island — buttons + inline refusal). Follow page.tsx's class idiom:

```tsx
"use client";
import { useState, useTransition } from "react";
import { startAction, submitAction, holdAction, resumeAction } from "@/app/actions/process";
import type { ActionResult } from "@/app/actions/_action";

type Props = { planId: number; state: string };

export function PlanRow({ planId, state }: Props) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const call = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : r.message);
    });

  const btn = "rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)] disabled:opacity-50";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {state === "READY" && <button disabled={pending} className={btn} onClick={() => call(() => startAction(planId))}>Start</button>}
        {state === "IN_PROGRESS" && <>
          <button disabled={pending} className={btn} onClick={() => call(() => submitAction(planId))}>Submit</button>
          <button disabled={pending} className={btn} onClick={() => call(() => holdAction(planId, "Held from workspace"))}>Hold</button>
        </>}
        {state === "ON_HOLD" && <button disabled={pending} className={btn} onClick={() => call(() => resumeAction(planId))}>Resume</button>}
      </div>
      {error && <p className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</p>}
    </div>
  );
}
```

(Hold reason is a fixed string for v1; a reason prompt is a later refinement — `// ponytail: fixed hold reason; add a prompt when the floor needs categorised holds`.)

- [ ] **Step 2: `page.tsx`** (server, actor-scoped). Supervisors see only their departments; PH/ADMIN/MANAGEMENT see all:

```tsx
import { redirect } from "next/navigation";
import { getActor, ROLES, hasRole } from "@/lib/authz";
import { withTenant } from "@/lib/db";
import { loadPrioritizedJob } from "@/lib/services/workspace.read";
import { PlanRow } from "./plan-row";

async function pilotJobId(tenantId: number): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" }, select: { id: true } });
    return j?.id ?? null;
  });
}

export default async function Workspace() {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");

  const jobId = await pilotJobId(actor.tenantId);
  const data = jobId ? await loadPrioritizedJob(actor, jobId) : null;
  if (!data) {
    return <main className="mx-auto max-w-5xl px-5 py-8"><p className="text-sm text-[var(--muted-fg)]">No current schedule. Run <code>pnpm db:bootstrap</code>.</p></main>;
  }

  const scoped = hasRole(actor, ROLES.ADMIN, ROLES.PRODUCTION_HEAD, ROLES.MANAGEMENT)
    ? data.departments
    : data.departments.filter((d) => actor.departmentIds.includes(d.id));

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <h1 className="text-lg font-semibold tracking-tight">Today · DESPL-320</h1>
      {scoped.map((dept) => {
        const rows = data.rankedByDept.get(dept.id) ?? [];
        if (rows.length === 0) return null;
        return (
          <section key={dept.id} className="mt-6">
            <h2 className="text-sm font-semibold">{dept.name}</h2>
            <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--surface)]">
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.plan.id} className="border-b border-[var(--hairline)] last:border-0">
                      <td className="px-4 py-2">
                        <div className="font-medium">{data.processNameById.get(r.plan.jobProcessId)}</div>
                        <div className="text-xs text-[var(--muted-fg)]">Unit {r.plan.unitId} · {r.reasonText}{r.criticalPath ? " · critical" : ""}</div>
                      </td>
                      <td className="px-4 py-2 text-right"><PlanRow planId={r.plan.id} state={r.state} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </main>
  );
}
```

- [ ] **Step 3: Browser check** — `pnpm dev`, sign in as `sup.fabrication@` (password `despl-dev-only`), open `/workspace`. Expect: the Fabrication department's plans ranked, Start on a READY row works, and a GATING_BLOCKED row (Start attempted on a blocked process — temporarily test by starting an out-of-order one) shows the refusal sentence.

- [ ] **Step 4: Commit** `git commit -am "feat(workspace): department Today worklist + transition islands (P4)"`

---

### Task 11: QC verify queue + hold-point clearance

**Files:**
- Create: `src/app/workspace/qcp-clear.tsx`
- Modify: `src/app/workspace/page.tsx` (add a QC branch), `src/app/workspace/plan-row.tsx` (verify button when `state==="SUBMITTED"` and actor is QC)

**Interfaces:**
- Consumes: `verifyAction` (Task 8), `recordQcpAction` (Task 8).

- [ ] **Step 1: Add a Verify button** to `plan-row.tsx` gated on a `canVerify` prop (passed from the server, true when actor has QC role):

```tsx
{state === "SUBMITTED" && canVerify && (
  <button disabled={pending} className={btn} onClick={() => call(() => verifyAction(planId))}>Verify</button>
)}
```

Add `canVerify?: boolean` to `Props` and import `verifyAction`.

- [ ] **Step 2: `qcp-clear.tsx`** — a small island to record ACCEPTED/REJECTED/NA for an open blocking checkpoint:

```tsx
"use client";
import { useState, useTransition } from "react";
import { recordQcpAction } from "@/app/actions/qcp";

export function QcpClear({ qcpItemId, unitId }: { qcpItemId: number; unitId: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const btn = "rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs hover:bg-[var(--surface-sunken)] disabled:opacity-50";
  const call = (result: "ACCEPTED" | "REJECTED" | "NA") =>
    start(async () => { const r = await recordQcpAction(qcpItemId, unitId, result); setError(r.ok ? null : r.message); });
  return (
    <div className="flex items-center gap-2">
      <button disabled={pending} className={btn} onClick={() => call("ACCEPTED")}>Accept</button>
      <button disabled={pending} className={btn} onClick={() => call("REJECTED")}>Reject</button>
      <button disabled={pending} className={btn} onClick={() => call("NA")}>N/A</button>
      {error && <span className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 3: QC branch in `page.tsx`.** When `hasRole(actor, ROLES.QC)`, also render a "Verification queue" section listing SUBMITTED plans across all departments (from `data.rankedByDept` flattened, filtered `state==="SUBMITTED"`) with the Verify button, and an "Open hold points" section. For open hold points, query blocking QcpItems + their units whose latest execution isn't ACCEPTED/NA — add a helper `loadOpenHoldPoints(actor, jobId)` to `workspace.read.ts` mirroring `assertNoOpenHoldPoint`'s query (return `{ qcpItemId, activity, unitId, serialNo }[]`), and render a `<QcpClear>` per row. Pass `canVerify={hasRole(actor, ROLES.QC)}` to the relevant `PlanRow`s.

- [ ] **Step 4: Browser check** — sign in as `qc@`, submit a plan as a supervisor in another tab, verify it as `qc@` (works), then submit + try to verify a plan you submitted → `MAKER_CHECKER_VIOLATION` sentence. Clear a hold point via Accept → the owning process verifies.

- [ ] **Step 5: Commit** `git commit -am "feat(workspace): QC verify queue + hold-point clearance (P5)"`

---

### Task 12: Delay filing form

**Files:**
- Create: `src/app/workspace/delay-form.tsx`
- Modify: `src/app/workspace/page.tsx` (render the form on OVERDUE rows), `src/lib/services/workspace.read.ts` (return delay categories)

**Interfaces:**
- Consumes: `fileDelayAction` (Task 8).

- [ ] **Step 1: Return categories** from `loadPrioritizedJob` — add `const delayCategories = await tx.delayCategoryRef.findMany({ where: { active: true } });` to the read and include it in the result type. (If none are seeded, add a seed step in `prisma/seed.ts` with a few categories — MATERIAL, MANPOWER, MACHINE, QUALITY, EXTERNAL — and reseed. Verify first with a count query.)

- [ ] **Step 2: `delay-form.tsx`:**

```tsx
"use client";
import { useState, useTransition } from "react";
import { fileDelayAction } from "@/app/actions/delay";

export function DelayForm({ planId, categories }: { planId: number; categories: { id: number; name: string }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? 0);
  const [detail, setDetail] = useState("");
  return (
    <form className="flex flex-wrap items-center gap-2"
      action={() => start(async () => { const r = await fileDelayAction(planId, categoryId, detail || undefined); setError(r.ok ? null : r.message); })}>
      <select className="rounded border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs" value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <input className="rounded border border-[var(--hairline)] bg-[var(--surface)] px-2 py-1 text-xs" placeholder="detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <button disabled={pending} className="rounded-lg border border-[var(--hairline)] px-2 py-1 text-xs">File reason</button>
      {error && <span className="text-xs text-[var(--danger-fg,#b91c1c)]">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 3: Render** the `<DelayForm>` under any row where `r.overdue` is true, passing `categories={data.delayCategories}`.

- [ ] **Step 4: Browser check** — force a plan overdue (a bootstrap from an old order date makes early processes overdue), attempt Start → `REASON_REQUIRED`, file a reason → Start now works.

- [ ] **Step 5: Commit** `git commit -am "feat(workspace): delay-reason filing to unblock #7 (P6)"`

---

## Phase 7 — Management dashboard

### Task 13: `/dashboard`

**Files:**
- Create: `src/app/dashboard/page.tsx`
- Modify: `src/lib/services/workspace.read.ts` (add `loadJobKpis(actor, jobId)`)

**Interfaces:**
- Consumes: `loadPrioritizedJob` data + a new KPI aggregation. Reuses `viz/KpiTile`, `viz/MatrixHeatmap`, `viz/SCurve`, `viz/ProgressRing`.

- [ ] **Step 1: `loadJobKpis`** in `workspace.read.ts` — aggregate the current run's plans into: total plans, %complete, counts by state (from `prioritize`), overdue count, open hold-point count, delays filed by category, and a per-department status matrix (`department × {NOT_STARTED, IN_PROGRESS, SUBMITTED, COMPLETE, ON_HOLD}` counts). Compute from `run.processPlans` + `rankedByDept` (no new engine work). Return a plain serialisable object.

```ts
export interface JobKpis {
  totalPlans: number;
  percentComplete: number;
  byState: Record<string, number>;
  overdue: number;
  openHoldPoints: number;
  delaysByCategory: { category: string; count: number }[];
  deptMatrix: { department: string; counts: Record<string, number> }[];
}
```

- [ ] **Step 2: `dashboard/page.tsx`** — MANAGEMENT/PH/ADMIN only (`requireRole` via `getActor` + redirect for others). Render:
  - a KPI tile row (`viz/KpiTile`): % complete, on-track, at-risk (overdue), open hold points;
  - a `viz/ProgressRing` for overall completion;
  - a `viz/MatrixHeatmap` for the department × status matrix;
  - a `viz/SCurve` planned-vs-actual (planned = count of plans whose plannedFinish ≤ each week; actual = count COMPLETE by actualFinish — derive weekly buckets in the loader).
  Every tile labelled from real data (no sample numbers). Follow `component-gallery/page.tsx` for exact `viz` prop shapes.

- [ ] **Step 3: Browser check** — sign in as `md@`, open `/dashboard`, confirm the numbers move after driving a few plans in `/workspace`. Check light + dark mode.

- [ ] **Step 4: Commit** `git commit -am "feat(dashboard): management KPI suite over real plan data (P7)"`

---

### Task 14: Role-based landing

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Redirect by role** — after resolving the actor, before rendering the current job list:

```ts
if (hasRole(actor, ROLES.MANAGEMENT)) redirect("/dashboard");
if (hasRole(actor, ROLES.SUPERVISOR, ROLES.QC)) redirect("/workspace");
// ADMIN / PRODUCTION_HEAD fall through to the existing overview.
```

Import `hasRole, ROLES` from `@/lib/authz`. Add a nav link to `/workspace` and `/dashboard` in the existing header for the fall-through roles.

- [ ] **Step 2: Browser check** — each seeded role lands on the right screen: `md@`→dashboard, `sup.*@`→workspace, `qc@`→workspace, `admin@`→overview.

- [ ] **Step 3: Commit** `git commit -am "feat(app): role-based landing routes (P4/P7)"`

---

## Wrap-up

### Task 15: Full verification + session log

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm build` → all clean.
- [ ] **Step 2:** `pnpm test` (pure) green; `set -a && . ./.env && set +a && RUN_DB_TESTS=1 pnpm test` green, run **twice** (rerun-safe).
- [ ] **Step 3:** End-to-end browser pass on one unit (320SR01): Engineering start→submit→(QC)verify → next dept unblocks → hold point blocks weld verify → QC clears → delay block + file → dashboard reflects it. Confirm each refusal renders its sentence. Light + dark mode on `/workspace`, `/dashboard`, `/component-gallery`.
- [ ] **Step 4:** Update `progress.md`: what shipped (per-unit grain, prioritizer, workspace, QC/QCP, delay UI, dashboard), decisions (C24/C25 defaults), residual seams (TPI call/waiver deferred, per-serial stagger deferred, `reviewDelayReason` still a seam), and next steps. Update the milestones checkboxes this closes.
- [ ] **Step 5: Commit** `git commit -am "docs: session log — department workspaces + prioritizer shipped"`. Do NOT merge to `main`.

---

## Self-Review notes (author)

- **Spec coverage:** P0 grain → Tasks 1–3; P1 bootstrap → Task 4; P2 prioritizer → Tasks 5–6; P3 actions → Tasks 7–8; P4 workspace → Tasks 9–10; P5 QC/QCP → Tasks 7,11; P6 delay → Task 12; P7 dashboard → Tasks 13–14; verification → Task 15. All spec §6 phases covered.
- **C24 (uniform per-unit)** realised in Task 2's `flatMap` (all 36 processes × units). **C25 (group by unit)** realised in Task 10's row label ("Unit N"); regrouping is a Task-10 render change only.
- **Type consistency:** `PlanInput.unitId`, `loadPredecessorStates(…, unitId)`, `startReadiness(...)→{ready,blockingPredecessorIds}`, `prioritize(...)→Map<deptId,RankedPlan[]>`, `ActionResult`, `recordQcpExecution` — names/signatures identical across producing and consuming tasks.
- **Known executor lookups (not placeholders — real, named):** Task 4's `firstTenantId`/owner-client detail (pointer to `src/lib/db.ts` + `seed.ts`); Task 11's `loadOpenHoldPoints` (mirror `assertNoOpenHoldPoint`); Task 13's `viz` prop shapes (pointer to `component-gallery/page.tsx`). Each names the exact existing code to copy from.
