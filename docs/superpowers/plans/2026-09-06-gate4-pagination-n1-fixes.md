# Gate 4 — Pagination + Page-Load N+1s Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four per-job DB fan-outs (`jobs.read.ts`, `command-center.read.ts`, `myday.read.ts`, `client-snapshot.read.ts`) with grouped batch queries, and add real pagination to the two human-facing job-list consumers (`/jobs` page, `/api/jobs`).

**Architecture:** For each fan-out, add a new batched sibling function next to the existing single-job function (never delete the singular — it has 8+ other call sites out of scope here). Each batched function takes `jobIds: number[]` and returns a `Map<number, T>`, built from one `WHERE x = ANY(${jobIds}::int[])` (or `{ in: jobIds }`) query per inner query the singular version made, reusing the pattern already proven in `portfolio.read.ts:47-99`. Call-site loop bodies keep their exact business logic; only the data source changes from an awaited call to a map lookup. Pagination is added as an optional third param on `loadJobs`, defaulting to today's unpaginated full-list behavior so the six non-UI callers are untouched.

**Tech Stack:** TypeScript, Next.js (App Router), Prisma, PostgreSQL, Vitest (`describe.skipIf(!process.env.RUN_DB_TESTS)` for DB-gated tests, run via `pnpm test:db` — never `RUN_DB_TESTS` against `despl_demo`).

**Spec:** `docs/superpowers/specs/2026-09-06-gate4-pagination-n1-fixes.md`

## Global Constraints

- Every batch function groups strictly by the DB row's own `job_id`/`jobId` column — never by array index or insertion order (cross-job data bleeding is the one unacceptable failure mode here, given this session cycle's H1 job-isolation work).
- Every batched function ships with a regression test using ≥2 jobs carrying deliberately different data, asserting each job's map entry is *that job's own* data, not just "some non-empty result."
- No behavior change for existing single-job call sites or the 6 non-`/jobs`-page `loadJobs` callers — this is a performance refactor, not a feature change, except where the spec explicitly calls out a new capability (pagination on `/jobs` + `/api/jobs`).
- `pnpm typecheck && pnpm lint && pnpm test` must stay clean after every task; `pnpm test:db` must stay at its current pass count (1029/1030, per `progress.md`) or better.

---

### Task 1: `getCurrentScheduleRunsBatch`

**Files:**
- Modify: `src/lib/services/_shared.ts` (add function near `getCurrentScheduleRun` at line 335)
- Test: `src/lib/services/_shared.test.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: `Tx` type, `ScheduleRunWithPlans` type (both already exported from `_shared.ts`)
- Produces: `getCurrentScheduleRunsBatch(tx: Tx, jobIds: number[], equipmentId?: number | null): Promise<Map<number, ScheduleRunWithPlans>>` — used by Task 6 (command-center.read.ts) and Task 7 (myday.read.ts)

- [ ] **Step 1: Check for an existing `_shared.test.ts`**

Run: `ls src/lib/services/_shared.test.ts 2>/dev/null || echo "none"`

If it exists, add the new `describe` block to it. If not, create it with the imports below plus a top `describe` block.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { getCurrentScheduleRunsBatch } from "./_shared";

describe.skipIf(!process.env.RUN_DB_TESTS)("getCurrentScheduleRunsBatch (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("keys each job's current run to that job, not another job's", async () => {
    const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

    const map = await owner.$transaction(async (tx) => getCurrentScheduleRunsBatch(tx, [jobA.id, jobB.id], null));

    const runA = await owner.scheduleRun.findFirst({ where: { jobId: jobA.id, equipmentId: null, isCurrent: true } });
    const runB = await owner.scheduleRun.findFirst({ where: { jobId: jobB.id, equipmentId: null, isCurrent: true } });

    expect(map.get(jobA.id)?.id).toBe(runA?.id);
    expect(map.get(jobB.id)?.id).toBe(runB?.id);
    // The two jobs' runs must not be the same row, or the assertions above are vacuous.
    expect(runA?.id).not.toBe(runB?.id);

    await owner.$disconnect();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/_shared.test.ts`
Expected: FAIL with "getCurrentScheduleRunsBatch is not a function" or similar.

- [ ] **Step 4: Implement**

Add directly below `getCurrentScheduleRun` in `_shared.ts`:

```typescript
/** Batched sibling of getCurrentScheduleRun — one query for every job's current run, grouped by jobId. */
export async function getCurrentScheduleRunsBatch(
  tx: Tx,
  jobIds: number[],
  equipmentId?: number | null,
): Promise<Map<number, ScheduleRunWithPlans>> {
  if (jobIds.length === 0) return new Map();
  const runs = await tx.scheduleRun.findMany({
    where: { jobId: { in: jobIds }, equipmentId: equipmentId ?? null, isCurrent: true },
    include: { processPlans: true },
  });
  return new Map(runs.map((r) => [r.jobId, r]));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/_shared.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/_shared.ts src/lib/services/_shared.test.ts
git commit -m "perf: add batched getCurrentScheduleRunsBatch for Gate 4 N+1 fix"
```

---

### Task 2: `loadJobSpinesBatch` (JobSpine — processes/edges/calendar)

**Files:**
- Modify: `src/lib/services/_shared.ts` (add function near `loadJobSpine` at line 157)
- Test: `src/lib/services/_shared.test.ts`

**Interfaces:**
- Consumes: `Tx`, `JobSpine` type, `jobProcessToScheduleProcess`, `jobEdgeToScheduleEdge`, `DEFAULT_CALENDAR` (all already in `_shared.ts`)
- Produces: `loadJobSpinesBatch(tx: Tx, jobIds: number[]): Promise<Map<number, JobSpine>>` — a job absent from a bad-data edge case is simply omitted from the map (never throws). Used by Task 6, Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
import { loadJobSpinesBatch } from "./_shared";

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobSpinesBatch (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("each job's spine has only that job's own processes", async () => {
    const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

    const map = await owner.$transaction(async (tx) => loadJobSpinesBatch(tx, [jobA.id, jobB.id]));

    const rawA = await owner.jobProcess.findMany({ where: { jobId: jobA.id } });
    const rawB = await owner.jobProcess.findMany({ where: { jobId: jobB.id } });

    expect(map.get(jobA.id)?.rawProcesses.map((p) => p.id).sort()).toEqual(rawA.map((p) => p.id).sort());
    expect(map.get(jobB.id)?.rawProcesses.map((p) => p.id).sort()).toEqual(rawB.map((p) => p.id).sort());
    expect(rawA.length).toBeGreaterThan(0);
    expect(rawB.length).toBeGreaterThan(0);

    await owner.$disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/_shared.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Add below `loadJobSpine` in `_shared.ts`:

```typescript
/**
 * Batched sibling of loadJobSpine. Unlike the singular version (which throws
 * NOT_FOUND for a missing job), a job missing from `jobIds` is simply absent
 * from the returned map — callers source jobIds from loadJobs()'s output,
 * which only ever lists jobs that exist and are visible.
 */
export async function loadJobSpinesBatch(tx: Tx, jobIds: number[]): Promise<Map<number, JobSpine>> {
  if (jobIds.length === 0) return new Map();

  const jobs = await tx.job.findMany({ where: { id: { in: jobIds } } });
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // orderBy jobId first so each job's bucket keeps loadJobSpine's own
  // seq-ascending order after grouping (audit 0.9's tie-break requirement).
  const rawProcesses = await tx.jobProcess.findMany({
    where: { jobId: { in: jobIds } },
    orderBy: [{ jobId: "asc" }, { seq: "asc" }],
  });
  const rawEdges = await tx.jobProcessEdge.findMany({ where: { process: { jobId: { in: jobIds } } }, include: { process: { select: { jobId: true } } } });

  const processesByJob = new Map<number, typeof rawProcesses>();
  for (const p of rawProcesses) {
    const bucket = processesByJob.get(p.jobId);
    if (bucket) bucket.push(p);
    else processesByJob.set(p.jobId, [p]);
  }
  const edgesByJob = new Map<number, typeof rawEdges>();
  for (const e of rawEdges) {
    const jobId = e.process.jobId;
    const bucket = edgesByJob.get(jobId);
    if (bucket) bucket.push(e);
    else edgesByJob.set(jobId, [e]);
  }

  // Calendar resolution, batched: one lookup per distinct explicit calendarId,
  // plus one shared tenant-default fetch — never one query per job.
  const calendarIds = [...new Set(jobs.map((j) => j.calendarId).filter((id): id is number => id != null))];
  const explicitCalendars = calendarIds.length
    ? await tx.workCalendar.findMany({ where: { id: { in: calendarIds } }, include: { holidays: true } })
    : [];
  const explicitCalendarById = new Map(explicitCalendars.map((c) => [c.id, c]));
  const defaultCalendar = await tx.workCalendar.findFirst({ where: { isDefault: true }, include: { holidays: true } });

  const resolveCalendar = (job: (typeof jobs)[number]): WorkCalendarInput => {
    const cal = (job.calendarId != null ? explicitCalendarById.get(job.calendarId) : null) ?? defaultCalendar;
    return cal ? { weekOffDays: cal.weekOffDays, holidays: cal.holidays.map((h) => h.date) } : DEFAULT_CALENDAR;
  };

  const out = new Map<number, JobSpine>();
  for (const jobId of jobIds) {
    const job = jobById.get(jobId);
    if (!job) continue; // missing/invisible job — omitted, not thrown (see doc comment)
    const rawProcessesForJob = processesByJob.get(jobId) ?? [];
    out.set(jobId, {
      job,
      processes: rawProcessesForJob.map(jobProcessToScheduleProcess),
      edges: (edgesByJob.get(jobId) ?? []).map(jobEdgeToScheduleEdge),
      calendar: resolveCalendar(job),
      rawProcesses: rawProcessesForJob,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/_shared.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (watch for the `rawEdges` include shape — `jobEdgeToScheduleEdge` must still accept the same row shape; if TS complains about the extra `process` field, map to strip it before calling: `edgesByJob.get(jobId)?.map((e) => jobEdgeToScheduleEdge(e))` already works since extra fields on an object don't break structural typing, but confirm).

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/_shared.ts src/lib/services/_shared.test.ts
git commit -m "perf: add batched loadJobSpinesBatch for Gate 4 N+1 fix"
```

---

### Task 3: `loadUnitSpinesBatch` (UnitSpine[] — per-unit stage rows)

**Files:**
- Modify: `src/lib/services/spine.read.ts` (add function near `loadJobSpines` at line 29)
- Test: `src/lib/services/spine.read.test.ts`

**Interfaces:**
- Consumes: `Actor`, `assertClientScope`, `loadWorkOrderStageNames`, `workOrderStageName`, `UnitSpine` type (already in file/imports)
- Produces: `loadUnitSpinesBatch(actor: Actor, jobIds: number[]): Promise<Map<number, UnitSpine[]>>` — a job invisible to the actor or missing is omitted from the map (callers use `map.get(id) ?? []`, replacing today's `(await loadJobSpines(...)) ?? []`). Used by Task 5.

- [ ] **Step 1: Write the failing test**

```typescript
import { loadUnitSpinesBatch } from "./spine.read";
import { ROLES, type Actor } from "@/lib/authz";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadUnitSpinesBatch (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("each job's unit spines belong to that job's own units, not another job's", async () => {
    const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

    const map = await loadUnitSpinesBatch(actor({ tenantId: jobA.tenantId }), [jobA.id, jobB.id]);

    const unitsA = await owner.unit.findMany({ where: { equipment: { jobId: jobA.id } }, select: { id: true } });
    const unitsB = await owner.unit.findMany({ where: { equipment: { jobId: jobB.id } }, select: { id: true } });

    const unitIdsA = new Set(unitsA.map((u) => u.id));
    const unitIdsB = new Set(unitsB.map((u) => u.id));

    for (const spine of map.get(jobA.id) ?? []) expect(unitIdsA.has(spine.unitId)).toBe(true);
    for (const spine of map.get(jobB.id) ?? []) expect(unitIdsB.has(spine.unitId)).toBe(true);
    // Sanity: the two jobs' unit sets don't overlap, or the assertions above are vacuous.
    expect([...unitIdsA].some((id) => unitIdsB.has(id))).toBe(false);

    await owner.$disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/spine.read.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Add below `loadJobSpines` in `spine.read.ts`:

```typescript
interface BatchRow extends Row {
  job_id: number;
}

/**
 * Batched sibling of loadJobSpines. A job invisible to the actor or with no
 * v_unit_stage_status rows is simply absent from the map — callers replace
 * today's `(await loadJobSpines(...)) ?? []` with `map.get(id) ?? []`.
 */
export async function loadUnitSpinesBatch(actor: Actor, jobIds: number[]): Promise<Map<number, UnitSpine[]>> {
  if (jobIds.length === 0) return new Map();

  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, clientId: true, familyId: true } });
    for (const job of jobs) assertClientScope(actor, job.clientId);
    const familyIdByJob = new Map(jobs.map((j) => [j.id, j.familyId]));

    // Stage names are keyed by family, not job — one call per distinct family.
    const distinctFamilyIds = [...new Set(jobs.map((j) => j.familyId))];
    const stageNamesByFamily = new Map(
      await Promise.all(distinctFamilyIds.map(async (familyId) => [familyId, await loadWorkOrderStageNames(tx, actor.tenantId, familyId)] as const)),
    );

    const visibleJobIds = jobs.map((j) => j.id);
    const rows = await tx.$queryRaw<BatchRow[]>`
      SELECT v.job_id, v.unit_id, u.serial_no, v.stage_no, v.fill_status,
             v.is_overdue, v.is_rejected, v.governing_plan_id
      FROM v_unit_stage_status v
      JOIN units u ON u.id = v.unit_id
      WHERE v.job_id = ANY(${visibleJobIds}::int[])
      ORDER BY v.job_id, u.serial_no, v.stage_no
    `;

    const byJob = new Map<number, Map<number, UnitSpine>>();
    for (const r of rows) {
      const stageNames = stageNamesByFamily.get(familyIdByJob.get(r.job_id)!) ?? new Map();
      let byUnit = byJob.get(r.job_id);
      if (!byUnit) {
        byUnit = new Map();
        byJob.set(r.job_id, byUnit);
      }
      let spine = byUnit.get(r.unit_id);
      if (!spine) {
        spine = { unitId: r.unit_id, serialNo: r.serial_no, segments: [] };
        byUnit.set(r.unit_id, spine);
      }
      spine.segments.push({
        stageNo: r.stage_no,
        stageName: workOrderStageName(stageNames, r.stage_no),
        status: r.fill_status,
        overdue: r.is_overdue,
        rejected: r.is_rejected,
        governingPlanId: r.governing_plan_id ?? undefined,
      });
    }

    const out = new Map<number, UnitSpine[]>();
    for (const [jobId, byUnit] of byJob) out.set(jobId, Array.from(byUnit.values()));
    return out;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/spine.read.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/spine.read.ts src/lib/services/spine.read.test.ts
git commit -m "perf: add batched loadUnitSpinesBatch for Gate 4 N+1 fix"
```

---

### Task 4: `loadOpenHoldPointsBatch`

**Files:**
- Modify: `src/lib/services/workspace.read.ts` (add function near `loadOpenHoldPoints` at line 79)
- Test: `src/lib/services/workspace.read.test.ts`

**Interfaces:**
- Consumes: `Actor`, `assertClientScope`, `OpenHoldPoint` type (already in file)
- Produces: `loadOpenHoldPointsBatch(actor: Actor, jobIds: number[]): Promise<Map<number, OpenHoldPoint[]>>` — used by Task 5.

- [ ] **Step 1: Write the failing test**

```typescript
import { loadOpenHoldPointsBatch } from "./workspace.read";
import { ROLES, type Actor } from "@/lib/authz";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadOpenHoldPointsBatch (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("agrees with the singular loadOpenHoldPoints, per job, not cross-attributed", async () => {
    const { loadOpenHoldPoints } = await import("./workspace.read");
    const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

    const a = actor({ tenantId: jobA.tenantId });
    const [singleA, singleB] = await Promise.all([loadOpenHoldPoints(a, jobA.id), loadOpenHoldPoints(a, jobB.id)]);
    const map = await loadOpenHoldPointsBatch(a, [jobA.id, jobB.id]);

    const norm = (list: { qcpItemId: number; unitId: number; status: string }[]) =>
      list.map((x) => `${x.qcpItemId}:${x.unitId}:${x.status}`).sort();

    expect(norm(map.get(jobA.id) ?? [])).toEqual(norm(singleA));
    expect(norm(map.get(jobB.id) ?? [])).toEqual(norm(singleB));

    await owner.$disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/workspace.read.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Add below `loadOpenHoldPoints` in `workspace.read.ts`:

```typescript
/** Batched sibling of loadOpenHoldPoints — same blocking/latest-attempt logic, grouped by jobId. */
export async function loadOpenHoldPointsBatch(actor: Actor, jobIds: number[]): Promise<Map<number, OpenHoldPoint[]>> {
  if (jobIds.length === 0) return new Map();

  return withTenant(actor.tenantId, async (tx) => {
    const jobs = await tx.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, clientId: true } });
    for (const job of jobs) assertClientScope(actor, job.clientId);
    const visibleJobIds = jobs.map((j) => j.id);

    const units = await tx.unit.findMany({
      where: { equipment: { jobId: { in: visibleJobIds } } },
      select: { id: true, serialNo: true, equipment: { select: { jobId: true } } },
    });
    if (units.length === 0) return new Map();
    const jobIdByUnit = new Map(units.map((u) => [u.id, u.equipment.jobId]));

    const blockingItems = await tx.qcpItem.findMany({
      where: {
        processLinks: { some: { jobProcess: { jobId: { in: visibleJobIds } } } },
        partyCodes: { some: { qcpCode: { blocksCompletion: true } } },
      },
      select: {
        id: true,
        srNo: true,
        activity: true,
        partyCodes: { where: { qcpCode: { blocksCompletion: true } }, select: { qcpCode: { select: { code: true, requiresCall: true } } } },
        // Earliest-by-seq linked process PER JOB — a template-level QcpItem can
        // link to more than one job's own JobProcess rows, so this can't be a
        // single take:1 across jobs the way the singular per-job query gets it
        // for free; every link is fetched, then reduced to earliest-per-job below.
        processLinks: {
          select: { jobProcess: { select: { id: true, seq: true, jobId: true } } },
          orderBy: { jobProcess: { seq: "asc" } },
        },
      },
    });
    if (blockingItems.length === 0) return new Map();

    // Earliest-linked process per (item, job) — replaces the singular version's take:1.
    const linkedProcessByItemJob = new Map<string, number>();
    for (const item of blockingItems) {
      for (const link of item.processLinks) {
        const key = `${item.id}:${link.jobProcess.jobId}`;
        if (!linkedProcessByItemJob.has(key)) linkedProcessByItemJob.set(key, link.jobProcess.id);
      }
    }

    const itemIds = blockingItems.map((i) => i.id);
    const unitIds = units.map((u) => u.id);
    const execs = await tx.qcpExecution.findMany({
      where: { unitId: { in: unitIds }, qcpItemId: { in: itemIds } },
      orderBy: { attemptNo: "desc" },
      select: { qcpItemId: true, unitId: true, result: true, recordedAt: true },
    });
    const latestByKey = new Map<string, { result: string; recordedAt: Date }>();
    for (const e of execs) {
      const k = `${e.qcpItemId}:${e.unitId}`;
      if (!latestByKey.has(k)) latestByKey.set(k, { result: e.result, recordedAt: e.recordedAt });
    }

    const allLinkedProcessIds = [...new Set([...linkedProcessByItemJob.values()])];
    const plans = await tx.processPlan.findMany({
      where: { unitId: { in: unitIds }, jobProcessId: { in: allLinkedProcessIds }, scheduleRun: { isCurrent: true } },
      select: { jobProcessId: true, unitId: true, plannedStart: true },
    });
    const plannedStartByKey = new Map(plans.map((p) => [`${p.jobProcessId}:${p.unitId}`, p.plannedStart]));

    const itemById = new Map(blockingItems.map((i) => [i.id, i]));
    const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));
    const now = new Date();

    const out = new Map<number, OpenHoldPoint[]>();
    for (const jobId of visibleJobIds) out.set(jobId, []);

    const unitsByJob = new Map<number, number[]>();
    for (const u of units) {
      const bucket = unitsByJob.get(jobIdByUnit.get(u.id)!);
      if (bucket) bucket.push(u.id);
      else unitsByJob.set(jobIdByUnit.get(u.id)!, [u.id]);
    }

    for (const jobId of visibleJobIds) {
      const jobUnitIds = unitsByJob.get(jobId) ?? [];
      if (jobUnitIds.length === 0) continue;
      const open: OpenHoldPoint[] = [];
      for (const itemId of itemIds) {
        const jpId = linkedProcessByItemJob.get(`${itemId}:${jobId}`);
        if (jpId == null) continue; // this blocking item has no link on this job
        const item = itemById.get(itemId)!;
        const blockingCode = item.partyCodes[0]?.qcpCode;
        const classCode = blockingCode?.code ?? "?";
        const requiresCall = blockingCode?.requiresCall ?? false;

        for (const unitId of jobUnitIds) {
          const attempt = latestByKey.get(`${itemId}:${unitId}`);
          const r = attempt?.result;
          if (r === "ACCEPTED" || r === "NA") continue;

          let status: string;
          let ageRef: Date | null;
          if (!attempt) {
            status = requiresCall ? "Awaiting TPI" : "Pending";
            ageRef = plannedStartByKey.get(`${jpId}:${unitId}`) ?? null;
          } else if (r === "REJECTED") {
            status = "Reinspect";
            ageRef = attempt.recordedAt;
          } else {
            status = "QC review";
            ageRef = attempt.recordedAt;
          }
          const ageDays = ageRef ? Math.max(0, Math.floor((now.getTime() - ageRef.getTime()) / 864e5)) : 0;

          open.push({
            qcpItemId: itemId,
            activity: item.activity,
            unitId,
            serialNo: serialByUnit.get(unitId)!,
            srNo: item.srNo,
            classCode,
            awaitingTpi: status === "Awaiting TPI",
            status,
            ageDays,
          });
        }
      }
      out.set(jobId, open);
    }
    return out;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/workspace.read.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/workspace.read.ts src/lib/services/workspace.read.test.ts
git commit -m "perf: add batched loadOpenHoldPointsBatch for Gate 4 N+1 fix"
```

---

### Task 5: Rewire `jobs.read.ts` to use the batched extras

**Files:**
- Modify: `src/lib/services/jobs.read.ts:156-165`
- Test: create `src/lib/services/jobs.read.test.ts`

**Interfaces:**
- Consumes: `loadOpenHoldPointsBatch` (Task 4), `loadUnitSpinesBatch` (Task 3)
- Produces: `loadJobs`'s existing signature and `JobListItem[]` output shape unchanged for the no-options call form (Task 9 adds the paginated overload).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { loadJobs } from "./jobs.read";
import { ROLES, type Actor } from "@/lib/authz";

function actor(over: Partial<Actor> = {}): Actor {
  return {
    userId: 1, tenantId: 1, clientId: null, name: "Test", email: "t@despl.local",
    roles: [ROLES.ADMIN], departmentIds: [], mustChangePassword: false,
    themePreference: "SYSTEM", outdoorMode: false, ...over,
  };
}

describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — batched extras (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("openHoldPoints/unitRollup are attributed to the right job for every job in the tenant", async () => {
    const jobA = await owner.job.findFirst({ where: { jobNumber: "DE0463" } });
    const jobB = await owner.job.findFirst({ where: { jobNumber: "DE0467" } });
    if (!jobA || !jobB) throw new Error("seed missing DE0463/DE0467 — run pnpm db:seed");

    const list = await loadJobs(actor({ tenantId: jobA.tenantId }));
    const rowA = list.find((j) => j.id === jobA.id);
    const rowB = list.find((j) => j.id === jobB.id);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // Cross-check against real DB state, not just "field exists": openHoldPoints
    // for job A must equal the count of A's own units' open blocking points.
    const unitsA = await owner.unit.findMany({ where: { equipment: { jobId: jobA.id } }, select: { id: true } });
    expect(rowA!.unitRollup.length === 0 || unitsA.length > 0).toBe(true); // spine exists only if units exist

    await owner.$disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/jobs.read.test.ts`
Expected: PASS already for this loose assertion — this test is a smoke check, not the regression proof; the real proof is Tasks 3/4's own tests. Note in the PR description that this test's job is "loadJobs still works end to end after rewiring," not "batching is correct" (that's Task 3/4's job). If it fails, something in the rewire below is broken.

- [ ] **Step 3: Implement the rewire**

Replace `jobs.read.ts:156-165`:

```typescript
  // Per-job extras that open their own transaction (hold points, spine rollup)
  // — called sequentially-after the main tx above, never nested inside it.
  const extras = await Promise.all(
    base.map(async (j) => ({
      jobId: j.id,
      openHoldPoints: (await loadOpenHoldPoints(actor, j.id)).length,
      unitRollup: rollupJobSpine((await loadJobSpines(actor, j.id)) ?? []),
    })),
  );
  const extrasByJob = new Map(extras.map((e) => [e.jobId, e]));
```

with:

```typescript
  // Per-job extras (hold points, spine rollup), batched into 2 grouped
  // queries total instead of 2 per job — Gate 4 N+1 fix.
  const jobIds = base.map((j) => j.id);
  const [holdPointsByJob, unitSpinesByJob] = await Promise.all([
    loadOpenHoldPointsBatch(actor, jobIds),
    loadUnitSpinesBatch(actor, jobIds),
  ]);
  const extrasByJob = new Map(
    base.map((j) => [
      j.id,
      {
        openHoldPoints: (holdPointsByJob.get(j.id) ?? []).length,
        unitRollup: rollupJobSpine(unitSpinesByJob.get(j.id) ?? []),
      },
    ]),
  );
```

Update the import line at the top of `jobs.read.ts`:

```typescript
import { loadJobSpines, rollupJobSpine } from "./spine.read";
import { loadOpenHoldPoints } from "./workspace.read";
```

becomes:

```typescript
import { loadUnitSpinesBatch, rollupJobSpine } from "./spine.read";
import { loadOpenHoldPointsBatch } from "./workspace.read";
```

(Drop the now-unused `loadJobSpines`/`loadOpenHoldPoints` imports — grep the file first to confirm nothing else in `jobs.read.ts` still calls them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/jobs.read.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full non-DB suite + typecheck + lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: clean, same pass count as before this task (this is a pure refactor of `loadJobs`'s internals)

- [ ] **Step 6: Run the DB suite**

Run: `pnpm test:db`
Expected: same or better pass count than the documented 1029/1030 baseline (`progress.md`) — never against `despl_demo`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/jobs.read.ts src/lib/services/jobs.read.test.ts
git commit -m "perf: batch loadJobs's per-job hold-point/spine fan-out (Gate 4 N+1 #1)"
```

---

### Task 6: Rewire `command-center.read.ts`

**Files:**
- Modify: `src/lib/services/command-center.read.ts:220-233` (the `for (const job of jobs)` loop's `getCurrentScheduleRun`/`loadJobSpine`/`tx.unit.findMany` calls)
- Test: `src/lib/services/command-center.read.test.ts` (add a DB-gated block if none exists yet — check first)

**Interfaces:**
- Consumes: `getCurrentScheduleRunsBatch` (Task 1), `loadJobSpinesBatch` (Task 2)
- Produces: `loadCommandCenter`'s existing signature/output unchanged.

- [ ] **Step 1: Check existing test file for a DB-gated block**

Run: `grep -n "RUN_DB_TESTS" src/lib/services/command-center.read.test.ts || echo "none yet"`

- [ ] **Step 2: Write the failing test**

Append to `command-center.read.test.ts` (add the imports it needs alongside the existing ones):

```typescript
describe.skipIf(!process.env.RUN_DB_TESTS)("loadCommandCenter — batched fan-out (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("rows are attributed to the correct job's own jobNumber for every active job", async () => {
    const dept = await owner.department.findFirst();
    if (!dept) throw new Error("seed missing a department — run pnpm db:seed");
    const jobs = await owner.job.findMany({ where: { status: "ACTIVE" } });
    if (jobs.length < 2) throw new Error("need >=2 ACTIVE jobs seeded to exercise the batch path meaningfully");

    const view = await loadCommandCenter(
      { userId: 1, tenantId: jobs[0].tenantId, clientId: null, name: "T", email: "t@despl.local", roles: [ROLES.PRODUCTION_HEAD], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false },
      dept.id,
      "X",
      dept.name,
    );

    const jobNumberById = new Map(jobs.map((j) => [j.id, j.jobNumber]));
    for (const row of [...view.own, ...view.waitingOnOthers]) {
      expect(row.jobNumber).toBe(jobNumberById.get(row.jobId));
    }

    await owner.$disconnect();
  });
});
```

(Adjust `view.own`/`view.waitingOnOthers` field names to whatever `CommandCenterView` actually exposes — check the interface at the top of `command-center.read.ts` before writing this; the plan's earlier scout saw `ownRows`/`waitingOnOthers`-shaped fields but confirm exact public field names on `CommandCenterView` itself, which may differ from the internal `ownRows` variable name.)

- [ ] **Step 3: Run test to verify it fails or passes vacuously**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/command-center.read.test.ts`

This test can pass even before the rewire (it's checking correctness, and the loop's current per-job logic is already correct — just slow). That's fine: its job is to catch a *regression* introduced by the rewire, not to prove the bug exists. Proceed to the rewire regardless.

- [ ] **Step 4: Implement the rewire**

In `command-center.read.ts`, before the `for (const job of jobs)` loop (around line 219), add:

```typescript
    const jobIds = jobs.map((j) => j.id);
    const [runsByJob, spinesByJob] = await Promise.all([
      getCurrentScheduleRunsBatch(tx, jobIds, null),
      loadJobSpinesBatch(tx, jobIds),
    ]);
```

Then inside the loop, replace:

```typescript
      const run = await getCurrentScheduleRun(tx, job.id, null);
      if (!run) continue;
      activeRunIds.push(run.id);

      const spine = await loadJobSpine(tx, job.id);
```

with:

```typescript
      const run = runsByJob.get(job.id);
      if (!run) continue;
      activeRunIds.push(run.id);

      const spine = spinesByJob.get(job.id);
      if (!spine) continue;
```

(The `if (!spine) continue` branch is new — `getCurrentScheduleRun`/`loadJobSpine` used to throw `NOT_FOUND` on a missing spine, which would have 500'd the whole `/command/[dept]` page for every department; `loadJobSpinesBatch` instead omits the job, so this guard is a strict improvement, not a behavior regression, matching the same "one bad job must not break the page" principle `myday.read.ts` already applies via `computeCpmSafe`.)

Leave the `tx.unit.findMany` call as-is for this task — it's a separate, simpler batching (Task 6b below), kept as its own step so this task's diff stays reviewable.

- [ ] **Step 5: Batch the `tx.unit.findMany` call too (Task 6b, same task)**

Before the loop, alongside the other batched prefetches:

```typescript
    const allUnits = await tx.unit.findMany({
      where: { equipment: { jobId: { in: jobIds } } },
      select: { id: true, serialNo: true, equipment: { select: { jobId: true } } },
    });
    const unitsByJob = new Map<number, typeof allUnits>();
    for (const u of allUnits) {
      const bucket = unitsByJob.get(u.equipment.jobId);
      if (bucket) bucket.push(u);
      else unitsByJob.set(u.equipment.jobId, [u]);
    }
```

Replace the in-loop:

```typescript
      const units = await tx.unit.findMany({ where: { equipment: { jobId: job.id } }, select: { id: true, serialNo: true } });
      const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));
```

with:

```typescript
      const units = unitsByJob.get(job.id) ?? [];
      const serialByUnit = new Map(units.map((u) => [u.id, u.serialNo]));
```

- [ ] **Step 6: Update imports**

Add `getCurrentScheduleRunsBatch, loadJobSpinesBatch` to the `_shared` import; drop `getCurrentScheduleRun, loadJobSpine` only if nothing else in the file still calls them singly (grep first — `command-center.read.ts` may use them elsewhere outside this loop).

- [ ] **Step 7: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/command-center.read.test.ts`
Expected: PASS

- [ ] **Step 8: Full suite + typecheck + lint + DB suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`
Expected: clean, no regression in pass counts.

- [ ] **Step 9: Commit**

```bash
git add src/lib/services/command-center.read.ts src/lib/services/command-center.read.test.ts
git commit -m "perf: batch command-center's per-job schedule/spine/unit fan-out (Gate 4 N+1 #2)"
```

---

### Task 7: Rewire `myday.read.ts` (same shape as Task 6)

**Files:**
- Modify: `src/lib/services/myday.read.ts:174-194`
- Test: `src/lib/services/myday.read.test.ts` (check if it exists; create if not)

**Interfaces:**
- Consumes: `getCurrentScheduleRunsBatch` (Task 1), `loadJobSpinesBatch` (Task 2) — same functions Task 6 already built and tested; no new batch functions needed here.
- Produces: `loadMyDay`'s (or equivalent — confirm the exported function name in `myday.read.ts`) existing signature/output unchanged.

- [ ] **Step 1: Write the failing/smoke test**

Same shape as Task 6 Step 2, adapted to whatever `myday.read.ts` exports (check the exported function name and its return shape before writing — the plan's scout only confirmed the internal loop, not the public API surface of this file). Assert per-job rows carry that job's own `jobId`/`jobNumber`, cross-checked against real seeded jobs.

- [ ] **Step 2: Run to confirm current (pre-rewire) behavior as a baseline**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/myday.read.test.ts`

- [ ] **Step 3: Implement the rewire**

Mirror Task 6 Steps 4-6 exactly, applied to `myday.read.ts:174-194`: prefetch `runsByJob`/`spinesByJob`/`unitsByJob` before the loop using the same three batch calls, replace the in-loop `await getCurrentScheduleRun`/`await loadJobSpine`/`await tx.unit.findMany` with map lookups. Note `myday.read.ts` already uses `computeCpmSafe` (not `computeCpm`) and already has a `continue`-on-failure guard for a malformed spine — when `spinesByJob.get(job.id)` is `undefined` (job omitted by the batch function), that's an additional case that must also `continue`, alongside the existing `if (!cpm) continue`.

- [ ] **Step 4: Update imports** (same as Task 6 Step 6)

- [ ] **Step 5: Run test, full suite, DB suite**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/myday.read.test.ts && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`
Expected: all clean, no regression.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/myday.read.ts src/lib/services/myday.read.test.ts
git commit -m "perf: batch my-day's per-job schedule/spine/unit fan-out (Gate 4 N+1 #3)"
```

---

### Task 8: Rewire `client-snapshot.read.ts`'s progress-snapshot loop

**Files:**
- Modify: `src/lib/services/client-snapshot.read.ts:116-145`
- Test: `src/lib/services/client-snapshot.read.test.ts`

**Interfaces:**
- Consumes: nothing new — this is a single inlined raw-SQL query, no shared batch helper needed (the loop is local to this one function).
- Produces: `loadClientPortalView`'s existing signature/output unchanged.

- [ ] **Step 1: Write the failing/smoke test**

```typescript
describe.skipIf(!process.env.RUN_DB_TESTS)("loadClientPortalView — batched snapshot lookup (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("each job's hasUpdate/asOf reflect that job's own latest VERIFIED snapshot", async () => {
    const client = await owner.client.findFirst({ where: { jobs: { some: {} } } });
    if (!client) throw new Error("seed missing a client with jobs — run pnpm db:seed");
    const jobs = await owner.job.findMany({ where: { clientId: client.id } });
    if (jobs.length === 0) throw new Error("client has no jobs");

    const { loadClientPortalView } = await import("./client-snapshot.read");
    const views = await loadClientPortalView({
      userId: 1, tenantId: client.tenantId, clientId: client.id, name: "T", email: "t@despl.local",
      roles: [], departmentIds: [], mustChangePassword: false, themePreference: "SYSTEM", outdoorMode: false,
    });

    for (const job of jobs) {
      const latest = await owner.progressSnapshot.findFirst({ where: { jobId: job.id, status: "VERIFIED" }, orderBy: { asOf: "desc" } });
      const view = views.find((v) => v.jobId === job.id)!;
      expect(view.hasUpdate).toBe(latest != null);
      if (latest) expect(view.asOf === null || new Date(view.asOf!).getTime() === latest.asOf.getTime()).toBe(true);
    }

    await owner.$disconnect();
  });
});
```

- [ ] **Step 2: Run to confirm current behavior as baseline**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/client-snapshot.read.test.ts`
Expected: PASS (proves current per-job loop is already correct — the rewire must not change this).

- [ ] **Step 3: Implement the rewire**

Replace `client-snapshot.read.ts:116-145`'s loop body. Before the `const views: ClientJobView[] = [];` line, add:

```typescript
    const jobIds = jobs.map((j) => j.id);
    const latestRows = jobIds.length
      ? await tx.$queryRaw<{ job_id: number; as_of: Date }[]>`
          SELECT DISTINCT ON (job_id) job_id, as_of
          FROM progress_snapshots
          WHERE job_id = ANY(${jobIds}::int[]) AND status = 'VERIFIED'
          ORDER BY job_id, as_of DESC
        `
      : [];
    const latestByJob = new Map(latestRows.map((r) => [r.job_id, r.as_of]));

    const allRows = jobIds.length
      ? await tx.progressSnapshot.findMany({
          where: {
            status: "VERIFIED",
            OR: latestRows.map((r) => ({ jobId: r.job_id, asOf: r.as_of })),
          },
        })
      : [];
    const rowsByJob = new Map<number, typeof allRows>();
    for (const r of allRows) {
      const bucket = rowsByJob.get(r.jobId);
      if (bucket) bucket.push(r);
      else rowsByJob.set(r.jobId, [r]);
    }
```

Then replace the loop:

```typescript
    for (const job of jobs) {
      const latestVerified = await tx.progressSnapshot.findFirst({
        where: { jobId: job.id, status: "VERIFIED" },
        orderBy: { asOf: "desc" },
        select: { asOf: true },
      });
      const equipmentName = job.equipments[0]?.name ?? null;

      if (!latestVerified) {
        views.push({ jobId: job.id, jobNumber: job.jobNumber, equipmentName, hasUpdate: false });
        continue;
      }

      const rows = await tx.progressSnapshot.findMany({
        where: { jobId: job.id, asOf: latestVerified.asOf, status: "VERIFIED" },
      });
      const units = rowsToUnits(rows);
```

with:

```typescript
    for (const job of jobs) {
      const latestAsOf = latestByJob.get(job.id);
      const equipmentName = job.equipments[0]?.name ?? null;

      if (!latestAsOf) {
        views.push({ jobId: job.id, jobNumber: job.jobNumber, equipmentName, hasUpdate: false });
        continue;
      }

      const rows = rowsByJob.get(job.id) ?? [];
      const units = rowsToUnits(rows);
```

(Everything after `const units = rowsToUnits(rows);` stays exactly as-is — only replace `latestVerified.asOf` references below it with `latestAsOf` if any remain; grep the rest of the loop body for `latestVerified` to catch all uses.)

- [ ] **Step 4: Run test to verify it still passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/client-snapshot.read.test.ts`
Expected: PASS, same as the pre-rewire baseline in Step 2.

- [ ] **Step 5: Full suite + typecheck + lint + DB suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/client-snapshot.read.ts src/lib/services/client-snapshot.read.test.ts
git commit -m "perf: batch client portal's per-job progress-snapshot lookup (Gate 4 N+1 #4)"
```

---

### Task 9: Pagination on `/jobs` and `/api/jobs`

**Files:**
- Modify: `src/lib/services/jobs.read.ts` (add optional pagination param/overload)
- Modify: `src/app/(app)/jobs/page.tsx`
- Modify: `src/app/api/jobs/route.ts`
- Test: `src/lib/services/jobs.read.test.ts` (extend from Task 5)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadJobs(actor: Actor, opts?: { page: number; pageSize: number }): Promise<JobListItem[] | { items: JobListItem[]; total: number; page: number; pageSize: number }>` — every existing caller (`layout.tsx`, `welding/page.tsx`, `myday.read.ts`, `portfolio.read.ts`, `command-center.read.ts`, `reports.read.ts`) calls `loadJobs(actor)` with no `opts` and keeps getting a bare `JobListItem[]`, unchanged.

- [ ] **Step 1: Grep for any client-side fetch of `/api/jobs` before changing its response shape**

Run: `grep -rn "fetch(\"/api/jobs\"\|fetch('/api/jobs'" src/`

If any hit exists outside `src/app/api/jobs/route.ts` itself, read it and adjust Step 4 below to keep that caller working (e.g. it may need the old bare-array shape preserved for unpaginated requests).

- [ ] **Step 2: Write the failing test**

```typescript
describe.skipIf(!process.env.RUN_DB_TESTS)("loadJobs — pagination (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  it("paginated call returns only pageSize items and the correct total", async () => {
    const tenantJob = await owner.job.findFirst();
    if (!tenantJob) throw new Error("seed missing any job — run pnpm db:seed");
    const a = actor({ tenantId: tenantJob.tenantId });

    const full = await loadJobs(a);
    const paged = await loadJobs(a, { page: 1, pageSize: 1 });

    expect(Array.isArray(paged)).toBe(false);
    if (Array.isArray(paged)) throw new Error("unreachable");
    expect(paged.items.length).toBe(Math.min(1, full.length));
    expect(paged.total).toBe(full.length);
    expect(paged.page).toBe(1);
    expect(paged.pageSize).toBe(1);
    // Page 1's one item must be the same job the unpaginated call lists first
    // (both order by jobNumber asc) — proves take/skip didn't reorder anything.
    if (full.length > 0) expect(paged.items[0].id).toBe(full[0].id);

    await owner.$disconnect();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/jobs.read.test.ts`
Expected: FAIL (TS error or wrong shape)

- [ ] **Step 4: Implement pagination in `loadJobs`**

In `jobs.read.ts`, change the signature and the base query:

The only lines that change from Task 5's version are: the function signature (now overloaded), the `where` extracted to a variable, one new `tx.job.count(...)` call, the `skip`/`take` spread on `findMany`, and the two `return` statements. Every line of tally/percent/activity/mapping logic in between is untouched — shown in full below so nothing is left implicit:

```typescript
export async function loadJobs(actor: Actor): Promise<JobListItem[]>;
export async function loadJobs(
  actor: Actor,
  opts: { page: number; pageSize: number },
): Promise<{ items: JobListItem[]; total: number; page: number; pageSize: number }>;
export async function loadJobs(
  actor: Actor,
  opts?: { page: number; pageSize: number },
): Promise<JobListItem[] | { items: JobListItem[]; total: number; page: number; pageSize: number }> {
  const { base, total } = await withTenant(actor.tenantId, async (tx) => {
    const where = actor.clientId != null ? { clientId: actor.clientId } : undefined;
    const total = opts ? await tx.job.count({ where }) : 0;
    const jobs = await tx.job.findMany({
      where,
      select: {
        id: true,
        jobNumber: true,
        projectName: true,
        status: true,
        committedDeliveryDate: true,
        family: { select: { name: true } },
        equipments: { select: { _count: { select: { units: true } } } },
      },
      orderBy: { jobNumber: "asc" },
      ...(opts ? { skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize } : {}),
    });
    if (jobs.length === 0) return { base: [] as JobListItem[], total };

    const jobIds = jobs.map((j) => j.id);
    const tallies = await tx.$queryRaw<TallyRow[]>`
      SELECT sr.job_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE pp.status = 'COMPLETE')::int AS complete,
             count(*) FILTER (
               WHERE pp.status <> 'COMPLETE'
                 AND pp.planned_finish IS NOT NULL
                 AND pp.planned_finish < (now() AT TIME ZONE 'UTC')
             )::int AS overdue,
             max(pp.planned_finish) AS forecast
      FROM process_plans pp
      JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
      WHERE sr.job_id = ANY(${jobIds}::int[])
      GROUP BY sr.job_id
    `;
    const tallyByJob = new Map(tallies.map((t) => [t.job_id, t]));

    const percents = await tx.$queryRaw<PercentRow[]>`
      SELECT job_id, sum(percent * weight) / sum(weight) AS percent
      FROM v_process_plan_percent
      WHERE job_id = ANY(${jobIds}::int[])
      GROUP BY job_id
    `;
    const percentByJob = new Map(percents.map((p) => [p.job_id, p.percent]));

    const activity = await tx.$queryRaw<ActivityRow[]>`
      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN process_plans pp ON pp.id = de.aggregate_id::int
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE de.aggregate_type = 'ProcessPlan' AND jp.job_id = ANY(${jobIds}::int[])
      GROUP BY jp.job_id

      UNION ALL

      SELECT jp.job_id, max(de.at) AS last_at
      FROM domain_events de
      JOIN delay_reasons dr ON dr.id = de.aggregate_id::int
      JOIN process_plans pp ON pp.id = dr.process_plan_id
      JOIN job_processes jp ON jp.id = pp.job_process_id
      WHERE de.aggregate_type = 'DelayReason' AND jp.job_id = ANY(${jobIds}::int[])
      GROUP BY jp.job_id
    `;
    const activityByJob = new Map<number, Date>();
    for (const a of activity) {
      const prev = activityByJob.get(a.job_id);
      if (!prev || a.last_at > prev) activityByJob.set(a.job_id, a.last_at);
    }

    const mapped = jobs.map((j) => {
      const t = tallyByJob.get(j.id);
      const total = t?.total ?? 0;
      const complete = t?.complete ?? 0;
      const forecastDispatch = t?.forecast ?? null;
      return {
        id: j.id,
        jobNumber: j.jobNumber,
        projectName: j.projectName,
        familyName: j.family.name,
        status: j.status,
        committedDeliveryDate: j.committedDeliveryDate,
        forecastDispatch,
        forecastVarianceDays:
          forecastDispatch && j.committedDeliveryDate ? Math.round((forecastDispatch.getTime() - j.committedDeliveryDate.getTime()) / 864e5) : null,
        equipmentCount: j.equipments.length,
        unitCount: j.equipments.reduce((n, e) => n + e._count.units, 0),
        totalPlans: total,
        completePlans: complete,
        overduePlans: t?.overdue ?? 0,
        percentComplete: Math.round(Number(percentByJob.get(j.id) ?? 0)),
        lastActivityAt: activityByJob.get(j.id) ?? null,
      };
    });
    return { base: mapped, total };
  });
  if (base.length === 0) return opts ? { items: [], total, page: opts.page, pageSize: opts.pageSize } : [];

  const jobIds = base.map((j) => j.id);
  const [holdPointsByJob, unitSpinesByJob] = await Promise.all([
    loadOpenHoldPointsBatch(actor, jobIds),
    loadUnitSpinesBatch(actor, jobIds),
  ]);
  const extrasByJob = new Map(
    base.map((j) => [
      j.id,
      {
        openHoldPoints: (holdPointsByJob.get(j.id) ?? []).length,
        unitRollup: rollupJobSpine(unitSpinesByJob.get(j.id) ?? []),
      },
    ]),
  );

  const items: JobListItem[] = base.map((j) => {
    const extra = extrasByJob.get(j.id)!;
    return {
      ...j,
      committedDeliveryDate: j.committedDeliveryDate ? j.committedDeliveryDate.toISOString() : null,
      forecastDispatch: j.forecastDispatch ? j.forecastDispatch.toISOString() : null,
      lastActivityAt: j.lastActivityAt ? j.lastActivityAt.toISOString() : null,
      openHoldPoints: extra.openHoldPoints,
      unitRollup: extra.unitRollup,
    };
  });
  return opts ? { items, total, page: opts.page, pageSize: opts.pageSize } : items;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `RUN_DB_TESTS=1 pnpm vitest run src/lib/services/jobs.read.test.ts`
Expected: PASS

- [ ] **Step 6: Wire `/jobs` page**

In `src/app/(app)/jobs/page.tsx`, change the server component to read `searchParams`:

```typescript
const PAGE_SIZE = 50;

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  // ... existing actor lookup ...
  const { items: jobs, total } = await loadJobs(actor, { page, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // ... existing render, replacing the old bare `jobs` array with `jobs` from the destructure above ...
}
```

(Confirm the exact current signature of `JobsPage` — Next.js 15's `searchParams` is a `Promise` in newer versions but a plain object in older ones; check an existing page in `src/app/(app)/` that already reads `searchParams` for this project's actual convention before writing this.)

Add Prev/Next links near the existing table, e.g.:

```tsx
<div className="flex justify-between items-center mt-4">
  {page > 1 ? <Link href={`?page=${page - 1}`}>Previous</Link> : <span />}
  <span>Page {page} of {totalPages}</span>
  {page < totalPages ? <Link href={`?page=${page + 1}`}>Next</Link> : <span />}
</div>
```

(Match this project's existing button/link styling convention — check `_row.tsx` or a nearby page for the actual class names/components used, e.g. this codebase may have a shared `<Button>` wrapper instead of a bare `<Link>`.)

- [ ] **Step 7: Wire `/api/jobs` route**

In `src/app/api/jobs/route.ts`, read `?page=`/`?pageSize=` from the request URL and call `loadJobs(actor, { page, pageSize })` when either is present, falling back to the old bare-array call (and old bare-array JSON response) when neither is present — preserves any undiscovered external consumer that expects today's shape.

- [ ] **Step 8: Manual verification**

Run: `pnpm dev`, log in as a real seeded user, visit `/jobs`, confirm the page renders, Prev/Next work, and the job count/order matches what `/jobs` showed before this task (spot-check against the unpaginated `pnpm test:db` baseline or a direct DB count).

- [ ] **Step 9: Full suite + typecheck + lint + DB suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`

- [ ] **Step 10: Update the ledger**

In `docs/mos-execution/LEDGER.md:119`, change `☐` to `☑` for "Pagination + the three page-load N+1s," with a Notes entry summarizing: batched functions added (Tasks 1-4), 4 call sites fixed (not 3 — myday.read.ts included, noted as a near-identical 4th found during implementation), pagination added to `/jobs` + `/api/jobs` only (6 other `loadJobs` callers deliberately left unpaginated, per the spec's rationale).

- [ ] **Step 11: Commit**

```bash
git add src/lib/services/jobs.read.ts src/lib/services/jobs.read.test.ts src/app/\(app\)/jobs/page.tsx src/app/api/jobs/route.ts docs/mos-execution/LEDGER.md
git commit -m "feat: paginate /jobs and /api/jobs (Gate 4 pagination item)"
```
