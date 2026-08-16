# Portfolio Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give SJ/MD/CEO a single glance at every project's health — active, on track, at risk, delayed, on hold, completed — at the top of `/dashboard`, replacing the current hardcoded single-job view.

**Architecture:** One pure classification function (`classifyJobHealth`) over data `loadJobs()` already returns, composed by a new `loadPortfolio()` read function, rendered as clickable summary tiles plus a worst-first project table above the existing (now job-selectable) dashboard cards. No migration, no schema change, no new dependency.

**Tech Stack:** Next.js 15 App Router (server components), TypeScript strict, Prisma 6 / PostgreSQL 16, Vitest, Tailwind v4 with the existing `.theme-industrial` token set.

**Spec:** `docs/superpowers/specs/2026-08-16-portfolio-dashboard-design.md` — read it first; this plan argues from it.

## Global Constraints

These apply to **every** task. Copied verbatim from `CLAUDE.md` and the spec.

- **TypeScript strict everywhere.** No `any` without an eslint-disable comment explaining why (see `prioritizer.test.ts` for the accepted fixture pattern).
- **`lib/services/` holds ALL business rules.** Pages and route handlers are thin callers, never rule-holders.
- **No client timestamps.** No request DTO may contain `actual_*` or `*_at` fields. This feature is read-only; do not add any write path.
- **Status is never plain text.** It renders as a chip. Raw enums (`AT_RISK`, `PRODUCTION_HEAD`, `NOT_STARTED`) must never reach the DOM — humanize every one.
- **No dead controls.** Every button/link/cell performs a real action or does not exist. No "coming soon" toasts.
- **Real data only.** Every number comes from the database. No hardcoded arrays in components.
- **Counts stay at the 36-process plan grain** (`DESIGN_SPEC` §11.4), never rolled up to 25 stages first.
- **Hard bans:** browser-default serif · raw enums in UI · dev commentary in UI · N identical repeated cards · status as plain text · matrix cells without printed values · decorative gradients/glow/emoji · mock data in components · localStorage for app state.
- **Accent discipline:** more than ~3 orange (`--accent`) elements on one screen means remove some. On this page the filter chip is the only accent-colored element.
- **Every page ships with** loading skeleton (matching final layout, no full-page spinner), empty state (one sentence + one action), error state (what failed + retry), visible keyboard focus, `prefers-reduced-motion` support.
- **Time zone:** store UTC, display IST (`Asia/Kolkata`). Dates format as `en-IN`.
- **Tests:** DB-gated tests run **only** via `pnpm test:db` (loads `.env.test` → `despl_test`). **Never** run `RUN_DB_TESTS=1` against `despl` or `despl_demo` — it leaks `Organization` rows and breaks single-tenant login for every account. This has already happened once.
- **Commit to the `demo` branch only.** Never merge to `main` without explicit human approval.

### Environment note (read before Task 1)

The dev server is currently pointed at the `despl_demo` database, because `despl` has 37 rows in `organizations` (1 real + 36 leaked test rows) and `resolveTenantForLogin()` returns `null` unless exactly one exists — so **every login against `despl` fails**. Work against `despl_demo`:

```bash
export DATABASE_URL="postgresql://despl_web:1522d3aa4bb61c142514e80c05c15459@localhost:5432/despl_demo"
export DIRECT_URL="postgresql://postgres:devpass@localhost:5432/despl_demo"
```

Postgres runs in Docker as container `despl-pg`; start it with `docker start despl-pg` if the machine rebooted. Login accounts are `sj@despl.local` / `md@despl.local` / `admin@despl.local`, password `despl-dev-only`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/services/job-health.ts` | **The rule.** Pure `classifyJobHealth()` + the `JobHealth` types + display labels. No I/O. |
| `src/lib/services/job-health.test.ts` | Table-driven tests for all 12 rule branches. Pure, always-on tier. |
| `src/lib/services/portfolio.read.ts` | Composition: `loadJobs()` + classification + 24h change counts + sort. |
| `src/lib/services/portfolio.read.test.ts` | DB-gated: composition, tenant/client scoping, count reconciliation. |
| `src/components/industrial/health-chip.tsx` | `<HealthChip />` — health → chip class + humanized label. |
| `src/app/(app)/dashboard/_portfolio.tsx` | Tiles + project table presentation. |
| `src/app/(app)/dashboard/page.tsx` | Wires portfolio band in; job selector replaces hardcoded `DESPL-320`. |
| `scripts/bootstrap-schedule.ts` | Accept a job number argument instead of hardcoding `DESPL-320`. |

---

## Task 1: Schedule DE0463 and DE0467

Data prerequisite (spec §8). Doing it first means every later task can be verified against a board with three real projects in two different health states instead of one project and two blanks.

Both jobs are `PRESSURE_VESSEL` v1 `PUBLISHED` with 36 non-provisional processes. Neither has units — that is fine and requires **no invented data**: `schedule.service.ts:126-139` already falls back to one `unitId: null` plan per process. Unlike DESPL-320 (whose order date is genuinely unknown, so bootstrap invents an anchor), both of these have real order dates in the database, so use those.

**Files:**
- Modify: `scripts/bootstrap-schedule.ts`

**Interfaces:**
- Consumes: `generateSchedule(actor, { jobId, mode, projectStartDate })` from `src/lib/services/schedule.service.ts` — unchanged.
- Produces: nothing importable. Side effect only: current `ScheduleRun` + `ProcessPlan` rows for DE0463 and DE0467.

- [ ] **Step 1: Make the script take a job number**

Replace the hardcoded lookup in `resolveTargets()`. Currently:

```ts
const job = await owner.job.findFirst({
  where: { tenantId: org.id, jobNumber: "DESPL-320" },
  select: { id: true },
});
if (!job) throw new Error("bootstrap: job DESPL-320 not found — run pnpm db:seed first");

return { tenantId: org.id, adminUserId: admin.id, jobId: job.id };
```

Change to:

```ts
const jobNumber = process.argv[2] ?? "DESPL-320";
const job = await owner.job.findFirst({
  where: { tenantId: org.id, jobNumber },
  select: { id: true, orderDate: true },
});
if (!job) throw new Error(`bootstrap: job ${jobNumber} not found — run pnpm db:seed first`);

return {
  tenantId: org.id,
  adminUserId: admin.id,
  jobId: job.id,
  jobNumber,
  orderDate: job.orderDate,
};
```

Update `main()` to destructure the two new fields and choose the anchor honestly:

```ts
const { tenantId, adminUserId, jobId, jobNumber, orderDate } = await resolveTargets();
```

- [ ] **Step 2: Use the real order date when the job has one**

Replace the `projectStartDate` block in `main()`. Keep the existing comment explaining DESPL-320's invented anchor — it is still accurate for that job — and add the real-order-date branch:

```ts
// A job with a real order date anchors on it: that is the actual planning
// input, not an invention. DESPL-320's order date is genuinely unknown (seed
// leaves it null rather than fabricating one), so it keeps the synthetic
// anchor below — ~10 weeks back, putting the pilot mid-flight so the demo has
// a realistic spread of overdue/current/future plans for the overdue ->
// REASON_REQUIRED delay flow (invariant #7), instead of an all-future
// schedule where nothing is ever overdue.
const projectStartDate = orderDate ?? new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
const run = await generateSchedule(admin, { jobId, mode: "FORWARD", projectStartDate });
console.log(
  `[${jobNumber}] generated schedule run ${run.id} v${run.version} with ${run.processPlans.length} plans ` +
    `(anchor ${projectStartDate.toISOString().slice(0, 10)}${orderDate ? ", real order date" : ", synthetic"}).`,
);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean, no errors.

- [ ] **Step 4: Generate both schedules**

```bash
export DATABASE_URL="postgresql://despl_web:1522d3aa4bb61c142514e80c05c15459@localhost:5432/despl_demo"
export DIRECT_URL="postgresql://postgres:devpass@localhost:5432/despl_demo"
pnpm db:bootstrap DE0463
pnpm db:bootstrap DE0467
```

Expected: each prints `36 plans` and `real order date`.

- [ ] **Step 5: Verify against Postgres directly, not the script's own output**

```bash
docker exec despl-pg psql -U postgres -d despl_demo -c "
select j.job_number, j.delivery_date::date as promised,
       count(pp.id) as plans,
       max(pp.planned_finish)::date as forecast,
       count(pp.id) filter (where pp.status<>'COMPLETE'
         and pp.planned_finish < now() at time zone 'UTC') as overdue
from jobs j
left join schedule_runs sr on sr.job_id=j.id and sr.is_current=true
left join process_plans pp on pp.schedule_run_id=sr.id
group by 1,2 order by 1;"
```

Expected: DE0463 and DE0467 each show 36 plans and a non-null forecast. DESPL-320 keeps 324. Confirm DE0463's forecast is later than its `2026-07-28` promise and DE0467's is later than `2026-10-15` — these are the two DELAYED cases the board must show.

If DE0467's forecast happens to land *before* its promised date, do not adjust the data. Record the actual number in the commit message; the rule will classify it on its merits and Task 3's expectations get updated to match reality.

- [ ] **Step 6: Commit**

```bash
git add scripts/bootstrap-schedule.ts
git commit -m "feat(schedule): bootstrap any job by number, anchor on its real order date

DE0463/DE0467 had no schedule at all. Both are PRESSURE_VESSEL v1 published
with 36 non-provisional processes and no units, which schedule.service
already handles via the unitId-null fallback - so no invented data is needed.
Jobs with a real order date now anchor on it instead of the synthetic
10-weeks-back anchor, which stays only for DESPL-320 (order date genuinely
unknown)."
```

---

## Task 2: The health classification rule

The one new concept in this feature. Pure function, no I/O, so all twelve branches are table-driven testable in the always-on `pnpm test` tier.

**Files:**
- Create: `src/lib/services/job-health.ts`
- Test: `src/lib/services/job-health.test.ts`

**Interfaces:**
- Consumes: nothing. Deliberately dependency-free.
- Produces:
  - `type JobHealth = "ON_TRACK" | "AT_RISK" | "DELAYED" | "ON_HOLD" | "COMPLETED" | "NOT_PLANNED"`
  - `type JobHealthRaw = JobHealth | "CANCELLED"`
  - `interface HealthInput { status: string; deliveryDate: string | null; forecastDispatch: string | null; totalPlans: number; overduePlans: number }`
  - `function classifyJobHealth(job: HealthInput, today: Date): JobHealthRaw`
  - `const HEALTH_LABEL: Record<JobHealth, string>`
  - `const HEALTH_ORDER: JobHealth[]` — worst-first sort order

- [ ] **Step 1: Write the failing tests**

Create `src/lib/services/job-health.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { classifyJobHealth, type HealthInput } from "./job-health";

const TODAY = new Date("2026-08-16T09:00:00Z");

/** A healthy ACTIVE job: scheduled, nothing overdue, forecast inside the promise. */
const base: HealthInput = {
  status: "ACTIVE",
  deliveryDate: "2026-12-01T00:00:00.000Z",
  forecastDispatch: "2026-11-01T00:00:00.000Z",
  totalPlans: 36,
  overduePlans: 0,
};

const cases: [name: string, input: Partial<HealthInput>, expected: string][] = [
  ["cancelled wins over everything", { status: "CANCELLED", overduePlans: 99 }, "CANCELLED"],
  ["complete wins over overdue", { status: "COMPLETE", overduePlans: 99 }, "COMPLETED"],
  ["on hold wins over overdue", { status: "ON_HOLD", overduePlans: 99 }, "ON_HOLD"],
  ["no plans at all", { totalPlans: 0 }, "NOT_PLANNED"],
  ["no plans outranks a blown promise", { totalPlans: 0, deliveryDate: "2026-01-01T00:00:00.000Z" }, "NOT_PLANNED"],
  ["promised date already passed", { deliveryDate: "2026-08-15T00:00:00.000Z" }, "DELAYED"],
  ["promised today is NOT yet late", { deliveryDate: "2026-08-16T00:00:00.000Z" }, "ON_TRACK"],
  ["forecast breaches the promise", { forecastDispatch: "2026-12-02T00:00:00.000Z" }, "DELAYED"],
  ["forecast exactly equals the promise", { forecastDispatch: "2026-12-01T00:00:00.000Z" }, "ON_TRACK"],
  ["delayed outranks at-risk", { forecastDispatch: "2026-12-02T00:00:00.000Z", overduePlans: 5 }, "DELAYED"],
  ["overdue plans with a safe forecast", { overduePlans: 1 }, "AT_RISK"],
  ["no promised date, overdue plans", { deliveryDate: null, overduePlans: 1 }, "AT_RISK"],
  ["no promised date, nothing overdue", { deliveryDate: null }, "ON_TRACK"],
  ["no forecast yet, nothing overdue", { forecastDispatch: null }, "ON_TRACK"],
  ["healthy baseline", {}, "ON_TRACK"],
];

describe("classifyJobHealth", () => {
  for (const [name, patch, expected] of cases) {
    test(name, () => {
      expect(classifyJobHealth({ ...base, ...patch }, TODAY)).toBe(expected);
    });
  }

  test("late-and-unclosed: promise passed, all plans complete, still ACTIVE", () => {
    const job: HealthInput = {
      status: "ACTIVE",
      deliveryDate: "2026-07-28T00:00:00.000Z",
      forecastDispatch: "2026-07-20T00:00:00.000Z",
      totalPlans: 36,
      overduePlans: 0,
    };
    expect(classifyJobHealth(job, TODAY)).toBe("DELAYED");
  });

  test("is pure — the same input classifies identically twice", () => {
    expect(classifyJobHealth(base, TODAY)).toBe(classifyJobHealth(base, TODAY));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test job-health`
Expected: FAIL — `Failed to resolve import "./job-health"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/services/job-health.ts`:

```ts
/**
 * Project-level health — the rule behind the portfolio dashboard's tiles
 * (spec: docs/superpowers/specs/2026-08-16-portfolio-dashboard-design.md §4).
 *
 * Three-tier RAG for active projects plus three structural states. First match
 * wins, in the order written. This is the single implementation: dashboard,
 * jobs list and the daily digest all import it, so they cannot disagree
 * (DESIGN_SPEC §11.5's guarantee — one implementation, not SQL specifically).
 *
 * Pure and I/O-free on purpose. `today` is injected rather than read from the
 * clock so the date-boundary cases are testable without mocking.
 *
 * ponytail: hold-point ageing is deliberately NOT an input here — its threshold
 * would have been invented, and an uncleared hold blocks completion (invariant
 * #4) so it reaches AT_RISK through overduePlans anyway. See spec §4.1 for the
 * upgrade path if SJ asks for it.
 */

export type JobHealth =
  | "ON_TRACK"
  | "AT_RISK"
  | "DELAYED"
  | "ON_HOLD"
  | "COMPLETED"
  | "NOT_PLANNED";

/** What the rule can emit. `CANCELLED` rows never reach the UI — see portfolio.read.ts. */
export type JobHealthRaw = JobHealth | "CANCELLED";

/** Exactly the fields `loadJobs()` already returns. Nothing new is queried for this. */
export interface HealthInput {
  status: string;
  deliveryDate: string | null;
  forecastDispatch: string | null;
  totalPlans: number;
  overduePlans: number;
}

/** User-facing labels. Raw enums must never reach the DOM (CLAUDE.md hard ban). */
export const HEALTH_LABEL: Record<JobHealth, string> = {
  ON_TRACK: "On track",
  AT_RISK: "At risk",
  DELAYED: "Delayed",
  ON_HOLD: "On hold",
  COMPLETED: "Completed",
  NOT_PLANNED: "Not planned",
};

/**
 * Worst-first. ON_HOLD sits low because a paused project is a decision already
 * taken, not a surprise to discuss.
 */
export const HEALTH_ORDER: JobHealth[] = [
  "DELAYED",
  "AT_RISK",
  "NOT_PLANNED",
  "ON_TRACK",
  "ON_HOLD",
  "COMPLETED",
];

/** UTC calendar day, so a same-day comparison ignores the time of day. */
function toUtcDay(iso: string | Date): number {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function classifyJobHealth(job: HealthInput, today: Date): JobHealthRaw {
  // Structural states outrank health: a cancelled, finished or deliberately
  // paused project is not "late", whatever its plans say.
  if (job.status === "CANCELLED") return "CANCELLED";
  if (job.status === "COMPLETE") return "COMPLETED";
  if (job.status === "ON_HOLD") return "ON_HOLD";

  // An accepted order nobody has scheduled. A real management signal, not a gap.
  if (job.totalPlans === 0) return "NOT_PLANNED";

  if (job.deliveryDate !== null) {
    // Date-vs-date, never timestamp: the promised day itself is not yet late.
    // `deliveryDate < now()` would flip a job red at 00:00 on the very day it
    // was promised — a full day early, and a number SJ would rightly dispute.
    if (toUtcDay(job.deliveryDate) < toUtcDay(today)) return "DELAYED";

    // Strictly greater: landing exactly on the promised date is on time.
    if (job.forecastDispatch !== null && toUtcDay(job.forecastDispatch) > toUtcDay(job.deliveryDate)) {
      return "DELAYED";
    }
  }

  // Slipping, but the forecast still fits (or there is no promise to miss).
  if (job.overduePlans > 0) return "AT_RISK";

  return "ON_TRACK";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test job-health`
Expected: PASS, 17 tests.

- [ ] **Step 5: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/services/job-health.ts src/lib/services/job-health.test.ts
git commit -m "feat(portfolio): project health rule, table-driven tested

Three-tier RAG plus the stored structural states. Pure and I/O-free over
fields loadJobs() already returns, so all 12 branches test in the always-on
tier with no DB fixtures and no clock mocking.

Two boundaries pinned by tests: the promised day itself is not yet late
(date-vs-date, not timestamp), and a forecast landing exactly on the
promised date is on time (> not >=)."
```

---

## Task 3: Portfolio read layer

Composes the rule with the data. This is the only task that touches the database.

**Files:**
- Create: `src/lib/services/portfolio.read.ts`
- Test: `src/lib/services/portfolio.read.test.ts`

**Interfaces:**
- Consumes: `loadJobs(actor)` → `JobListItem[]` from `./jobs.read`; `classifyJobHealth`, `JobHealth`, `JobHealthRaw`, `HEALTH_ORDER` from `./job-health`; `withTenant` from `@/lib/db`; `Actor` from `@/lib/authz`.
- Produces: `loadPortfolio(actor: Actor): Promise<Portfolio>`, plus the `PortfolioRow` and `Portfolio` interfaces used by Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/portfolio.read.test.ts`. DB-gated, following the `departments.read.test.ts` pattern exactly:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { loadPortfolio } from "./portfolio.read";
import { HEALTH_ORDER } from "./job-health";
import { ROLES, type Actor } from "@/lib/authz";

describe.skipIf(!process.env.RUN_DB_TESTS)("portfolio.read (DB)", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  afterAll(async () => {
    await owner.$disconnect();
  });

  async function sjActor(): Promise<Actor> {
    const org = await owner.organization.findFirst({ select: { id: true } });
    if (!org) throw new Error("no organization — run pnpm db:seed");
    return {
      userId: 1,
      tenantId: org.id,
      clientId: null,
      name: "SJ",
      email: "sj@despl.test",
      roles: [ROLES.PRODUCTION_HEAD],
      departmentIds: [],
    };
  }

  it("returns every non-cancelled job exactly once, worst-first", async () => {
    const p = await loadPortfolio(await sjActor());

    expect(p.rows.length).toBeGreaterThan(0);
    const ids = p.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // No cancelled job is ever a row.
    expect(p.rows.every((r) => r.health !== ("CANCELLED" as never))).toBe(true);

    // Sorted worst-first by HEALTH_ORDER.
    const ranks = p.rows.map((r) => HEALTH_ORDER.indexOf(r.health));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("tile counts reconcile exactly with the rows they filter to", async () => {
    const p = await loadPortfolio(await sjActor());

    for (const h of HEALTH_ORDER) {
      expect(p.counts[h]).toBe(p.rows.filter((r) => r.health === h).length);
    }
    // `active` is the ACTIVE-status denominator, not a seventh bucket.
    expect(p.counts.active).toBe(p.rows.filter((r) => r.status === "ACTIVE").length);
  });

  it("scopes a client user to their own client's jobs only", async () => {
    const clientUser = await owner.user.findFirst({
      where: { clientId: { not: null } },
      select: { id: true, tenantId: true, clientId: true },
    });
    if (!clientUser) return; // seed has no client user — nothing to assert

    const actor: Actor = {
      userId: clientUser.id,
      tenantId: clientUser.tenantId,
      clientId: clientUser.clientId,
      name: "client",
      email: "client@despl.test",
      roles: [ROLES.VIEWER],
      departmentIds: [],
    };
    const p = await loadPortfolio(actor);

    const jobs = await owner.job.findMany({
      where: { tenantId: clientUser.tenantId, clientId: clientUser.clientId },
      select: { id: true },
    });
    const allowed = new Set(jobs.map((j) => j.id));
    expect(p.rows.every((r) => allowed.has(r.id))).toBe(true);
  });

  it("classifies DE0463 and DE0467 as delayed once scheduled", async () => {
    const p = await loadPortfolio(await sjActor());

    for (const jobNumber of ["DE0463", "DE0467"]) {
      const row = p.rows.find((r) => r.jobNumber === jobNumber);
      if (!row) throw new Error(`${jobNumber} missing — run pnpm db:bootstrap ${jobNumber}`);
      expect(row.totalPlans).toBeGreaterThan(0);
      expect(row.health).toBe("DELAYED");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test portfolio.read`
Expected: FAIL — `Failed to resolve import "./portfolio.read"`. (Without `RUN_DB_TESTS` the suite skips, which is also a valid "not yet implemented" signal — the import error is what you are looking for.)

- [ ] **Step 3: Write the implementation**

Create `src/lib/services/portfolio.read.ts`:

```ts
import { withTenant } from "@/lib/db";
import type { Actor } from "@/lib/authz";
import { loadJobs, type JobListItem } from "./jobs.read";
import { classifyJobHealth, HEALTH_ORDER, type JobHealth } from "./job-health";

/**
 * Portfolio view for the management dashboard (§4.2) — every project's health
 * in one payload, worst-first, so the morning meeting does not have to open
 * each job in turn.
 *
 * Composes `loadJobs()` (which already computes every health input) with the
 * canonical rule in `job-health.ts`. No new aggregate query and no SQL view:
 * a second definition of "overdue" is exactly the drift DESIGN_SPEC §11.5
 * warns about.
 *
 * ponytail: `loadJobs()`'s extras (open hold points + spine, two queries per
 * job) make this roughly 2N+3 queries. Fine at DESPL's 3-40 concurrently
 * active jobs; batch those two reads before a tenant with hundreds.
 */
export interface PortfolioRow extends JobListItem {
  health: JobHealth;
  clientName: string;
  /** Negative once the promised date has passed. Null when no date is set. */
  daysToPromise: number | null;
  verifiedLast24h: number;
  newlyOverdueLast24h: number;
  holdsOpenedLast24h: number;
}

export interface Portfolio {
  counts: Record<JobHealth, number> & { active: number };
  rows: PortfolioRow[];
  /** Cancelled jobs are excluded from tiles and rows — surfaced, never silently dropped. */
  cancelledCount: number;
}

interface ChangeRow {
  job_id: number;
  verified: number;
  newly_overdue: number;
  holds_opened: number;
}

const DAY_MS = 86_400_000;

export async function loadPortfolio(actor: Actor): Promise<Portfolio> {
  const jobs = await loadJobs(actor);
  const now = new Date();

  const extra = await withTenant(actor.tenantId, async (tx) => {
    const jobIds = jobs.map((j) => j.id);

    const clients = await tx.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, client: { select: { name: true } } },
    });
    const clientByJob = new Map(clients.map((c) => [c.id, c.client.name]));

    // Rolling 24h, NOT an IST calendar day. The meeting is a rolling cadence
    // ("what changed since we last met"), so the window must not reset to zero
    // at 00:00 IST while people are still working. `loadDailyDigest` uses IST
    // calendar days because it is a dated report — the difference is deliberate.
    const changes = jobIds.length
      ? await tx.$queryRaw<ChangeRow[]>`
          WITH win AS (SELECT (now() AT TIME ZONE 'UTC') - interval '24 hours' AS since)
          SELECT j.id AS job_id,
                 (SELECT count(*)::int
                    FROM domain_events de
                    JOIN process_plans pp ON pp.id = de.aggregate_id::int
                    JOIN job_processes jp ON jp.id = pp.job_process_id
                   WHERE de.aggregate_type = 'ProcessPlan'
                     AND de.type = 'ProcessVerified'
                     AND jp.job_id = j.id
                     AND de.at >= (SELECT since FROM win)) AS verified,
                 (SELECT count(*)::int
                    FROM process_plans pp
                    JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current = true
                   WHERE sr.job_id = j.id
                     AND pp.status <> 'COMPLETE'
                     AND pp.planned_finish >= (SELECT since FROM win)
                     AND pp.planned_finish < (now() AT TIME ZONE 'UTC')) AS newly_overdue,
                 (SELECT count(*)::int
                    FROM qcp_executions qe
                    JOIN qcp_item_processes qip ON qip.qcp_item_id = qe.qcp_item_id
                    JOIN job_processes jp ON jp.id = qip.job_process_id
                   WHERE jp.job_id = j.id
                     AND qe.result = 'REJECTED'
                     AND qe.recorded_at >= (SELECT since FROM win)) AS holds_opened
          FROM jobs j
          WHERE j.id = ANY(${jobIds}::int[])
        `
      : [];

    return { clientByJob, changeByJob: new Map(changes.map((c) => [c.job_id, c])) };
  });

  const counts = {
    active: 0,
    ON_TRACK: 0,
    AT_RISK: 0,
    DELAYED: 0,
    ON_HOLD: 0,
    COMPLETED: 0,
    NOT_PLANNED: 0,
  };
  const rows: PortfolioRow[] = [];
  let cancelledCount = 0;

  for (const j of jobs) {
    const health = classifyJobHealth(j, now);
    if (health === "CANCELLED") {
      cancelledCount += 1;
      continue;
    }

    const c = extra.changeByJob.get(j.id);
    counts[health] += 1;
    if (j.status === "ACTIVE") counts.active += 1;

    rows.push({
      ...j,
      health,
      clientName: extra.clientByJob.get(j.id) ?? "—",
      daysToPromise:
        j.deliveryDate === null
          ? null
          : Math.round((new Date(j.deliveryDate).getTime() - now.getTime()) / DAY_MS),
      verifiedLast24h: c?.verified ?? 0,
      newlyOverdueLast24h: c?.newly_overdue ?? 0,
      holdsOpenedLast24h: c?.holds_opened ?? 0,
    });
  }

  // Worst-first, then most-overdue-first inside a bucket, then stable by job number.
  rows.sort((a, b) => {
    const byHealth = HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health);
    if (byHealth !== 0) return byHealth;
    const ad = a.daysToPromise ?? Number.POSITIVE_INFINITY;
    const bd = b.daysToPromise ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return a.jobNumber.localeCompare(b.jobNumber);
  });

  return { counts, rows, cancelledCount };
}
```

- [ ] **Step 4: Check the event type and column names actually exist**

The `ProcessVerified` event type string and the `qcp_executions.recorded_at` / `qcp_item_processes` column names above are asserted, not verified. Confirm before trusting the query:

```bash
docker exec despl-pg psql -U postgres -d despl_demo -c \
  "select distinct type from domain_events where aggregate_type='ProcessPlan';"
docker exec despl-pg psql -U postgres -d despl_demo -c "\d qcp_executions"
```

If the verify event is named differently (e.g. `ProcessPlanVerified`), fix the string in the query to match. Do not invent an event type that does not exist — a silently-zero column is worse than no column.

- [ ] **Step 5: Run the DB-gated tests**

Run: `pnpm test:db portfolio.read`
Expected: PASS, 4 tests.

**Never** run `RUN_DB_TESTS=1` directly — `pnpm test:db` loads `.env.test` and points at `despl_test`. Running it against `despl_demo` leaks `Organization` rows and breaks login for every account.

If `despl_test` has no seed data, seed it first:
```bash
set -a && . ./.env.test && set +a && pnpm prisma migrate deploy && pnpm db:seed
```

- [ ] **Step 6: Run the full suite, lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all clean, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/portfolio.read.ts src/lib/services/portfolio.read.test.ts
git commit -m "feat(portfolio): loadPortfolio - health, 24h deltas, worst-first

Composes loadJobs() with the canonical health rule plus a rolling-24h change
query. No new aggregate and no SQL view: restating loadJobs()' overdue
predicate would be a second definition guaranteed to drift.

The 24h window is deliberately rolling, not an IST calendar day like the
digest - the morning meeting is a rolling cadence and must not reset to zero
at midnight while people are still working."
```

---

## Task 4: HealthChip component

**Files:**
- Create: `src/components/industrial/health-chip.tsx`

**Interfaces:**
- Consumes: `JobHealth`, `HEALTH_LABEL` from `@/lib/services/job-health`.
- Produces: `<HealthChip health={JobHealth} />`, and `HEALTH_CLASS: Record<JobHealth, string>` for the tiles in Task 5.

- [ ] **Step 1: Write the component**

Create `src/components/industrial/health-chip.tsx`:

```tsx
import { HEALTH_LABEL, type JobHealth } from "@/lib/services/job-health";

/**
 * Project-health chip for the portfolio board. Reuses the existing status-chip
 * classes — no new CSS, no new colour tokens.
 *
 * On track is blue, not green: green already means "complete" everywhere else
 * in this app, so painting a healthy in-flight project green would make it
 * indistinguishable at a glance from a finished one — the exact confusion this
 * board exists to remove. The two grey states are separated by their labels.
 */
export const HEALTH_CLASS: Record<JobHealth, string> = {
  ON_TRACK: "c-progress",
  AT_RISK: "c-hold",
  DELAYED: "c-overdue",
  COMPLETED: "c-complete",
  ON_HOLD: "c-idle",
  NOT_PLANNED: "c-idle",
};

export function HealthChip({ health }: { health: JobHealth }) {
  return (
    <span className={`chip ${HEALTH_CLASS[health]}`}>
      <i />
      {HEALTH_LABEL[health]}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm lint && pnpm typecheck`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/industrial/health-chip.tsx
git commit -m "feat(ui): HealthChip - project health as a chip, never plain text

Reuses the existing status-chip classes; no new CSS. On track is blue rather
than green so a healthy in-flight project is not visually identical to a
completed one."
```

---

## Task 5: Portfolio band — tiles and project table

The visible deliverable. Presentation only; all data arrives as props from Task 3.

**Files:**
- Create: `src/app/(app)/dashboard/_portfolio.tsx`

**Interfaces:**
- Consumes: `Portfolio`, `PortfolioRow` from `@/lib/services/portfolio.read`; `HealthChip`, `HEALTH_CLASS` from `@/components/industrial/health-chip`; `HEALTH_LABEL`, `HEALTH_ORDER`, `JobHealth` from `@/lib/services/job-health`; `CountUp` from `@/components/industrial/count-up`; `StageSpine` from `@/components/industrial/stage-spine`.
- Produces: `<PortfolioBand portfolio={Portfolio} activeFilter={JobHealth | null} />`, imported by Task 6.

- [ ] **Step 1: Check StageSpine's actual prop signature**

The mini spine is reused, not rewritten. Read its props before wiring:

```bash
sed -n '1,40p' src/components/industrial/stage-spine.tsx
```

Use whatever prop name it actually exposes for `StageSegment[]` and for its mini/4px variant. Do not guess.

- [ ] **Step 2: Write the component**

Create `src/app/(app)/dashboard/_portfolio.tsx`. Adjust the `<StageSpine>` call to the real signature found in Step 1:

```tsx
import Link from "next/link";
import { CountUp } from "@/components/industrial/count-up";
import { HealthChip, HEALTH_CLASS } from "@/components/industrial/health-chip";
import { StageSpine } from "@/components/industrial/stage-spine";
import { HEALTH_LABEL, HEALTH_ORDER, type JobHealth } from "@/lib/services/job-health";
import type { Portfolio, PortfolioRow } from "@/lib/services/portfolio.read";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** URL slug per health, so a tile click survives refresh and the back button. */
const SLUG: Record<JobHealth, string> = {
  ON_TRACK: "on-track",
  AT_RISK: "at-risk",
  DELAYED: "delayed",
  ON_HOLD: "on-hold",
  COMPLETED: "completed",
  NOT_PLANNED: "not-planned",
};

export function healthFromSlug(slug: string | undefined): JobHealth | null {
  if (!slug) return null;
  const hit = HEALTH_ORDER.find((h) => SLUG[h] === slug);
  return hit ?? null;
}

export function PortfolioBand({
  portfolio,
  activeFilter,
}: {
  portfolio: Portfolio;
  activeFilter: JobHealth | null;
}) {
  const { counts, rows, cancelledCount } = portfolio;
  const shown = activeFilter ? rows.filter((r) => r.health === activeFilter) : rows;

  if (rows.length === 0) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><h3>Projects</h3></div>
        <p className="note" style={{ margin: "16px 0" }}>
          No projects yet. Create a job to start tracking it here.{" "}
          <Link href="/jobs" className="btn btn-ghost">Go to jobs</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <h6>Active projects</h6>
          <div className="v mono"><CountUp value={counts.active} /></div>
          <div className="sub">in flight now</div>
        </div>
        {HEALTH_ORDER.map((h) => {
          const isActive = activeFilter === h;
          return (
            <Link
              key={h}
              href={isActive ? "/dashboard" : `/dashboard?health=${SLUG[h]}`}
              className={`kpi clicky${isActive ? " alert" : ""}`}
              aria-pressed={isActive}
            >
              <h6>{HEALTH_LABEL[h]}</h6>
              <div className="v mono"><CountUp value={counts[h]} /></div>
              <div className="sub">
                <span className={`chip ${HEALTH_CLASS[h]}`}><i />{HEALTH_LABEL[h]}</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <h3>Projects — worst first</h3>
          {activeFilter && (
            <Link href="/dashboard" className="chip" style={{ marginLeft: "auto", background: "rgba(255,122,26,.14)", color: "var(--accent)" }}>
              <i style={{ background: "var(--accent)" }} />
              {HEALTH_LABEL[activeFilter]} · clear
            </Link>
          )}
          {!activeFilter && (
            <span className="sub" style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
              click a card above to filter
            </span>
          )}
        </div>
        <div style={{ padding: "4px 8px 10px", overflowX: "auto" }}>
          <table className="matrix">
            <thead>
              <tr>
                <th style={{ minWidth: 110 }}>Job</th>
                <th style={{ minWidth: 140 }}>Client</th>
                <th style={{ minWidth: 100 }}>Health</th>
                <th style={{ minWidth: 130 }}>Complete</th>
                <th style={{ minWidth: 120 }}>Stages</th>
                <th>Promised</th>
                <th>Forecast</th>
                <th>Variance</th>
                <th>Overdue</th>
                <th>Holds</th>
                <th style={{ minWidth: 140 }}>Last 24h</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
          {shown.length === 0 && (
            <p className="note" style={{ margin: "16px 0" }}>
              No projects are {HEALTH_LABEL[activeFilter!].toLowerCase()} right now.{" "}
              <Link href="/dashboard" className="btn btn-ghost">Show all</Link>
            </p>
          )}
        </div>
        {cancelledCount > 0 && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", color: "var(--muted)", fontSize: 11 }}>
            {cancelledCount} cancelled — not shown
          </div>
        )}
      </div>
    </>
  );
}

function Row({ r }: { r: PortfolioRow }) {
  const v = r.forecastVarianceDays;
  const noUnits = r.unitRollup.length === 0;
  return (
    <tr>
      <td><Link href={`/jobs/${r.id}`} className="mono">{r.jobNumber}</Link></td>
      <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.clientName}</td>
      <td><HealthChip health={r.health} /></td>
      <td>
        <div className="otbar">
          <div className="bar"><i style={{ width: `${r.percentComplete}%`, background: "var(--s-complete)" }} /></div>
          <span className="mono" style={{ fontSize: 11 }}>{r.percentComplete}%</span>
        </div>
      </td>
      <td>
        {noUnits ? (
          <span style={{ color: "var(--muted)" }} title="No units defined yet">—</span>
        ) : (
          <StageSpine segments={r.unitRollup} mini />
        )}
      </td>
      <td className="mono">{fmtDate(r.deliveryDate)}</td>
      <td className="mono">{fmtDate(r.forecastDispatch)}</td>
      <td className="mono" style={{ color: v === null ? undefined : v > 0 ? "var(--s-overdue)" : "var(--s-complete)" }}>
        {v === null ? "—" : `${v > 0 ? "+" : ""}${v}d`}
      </td>
      <td>
        {r.overduePlans > 0 ? (
          <Link href="/workspace?status=overdue" className="mono" style={{ color: "var(--s-overdue)" }}>
            {r.overduePlans}
          </Link>
        ) : (
          <span className="mono" style={{ color: "var(--muted)" }}>0</span>
        )}
      </td>
      <td className="mono" style={{ color: r.openHoldPoints > 0 ? "var(--s-hold)" : "var(--muted)" }}>{r.openHoldPoints}</td>
      <td className="mono" style={{ fontSize: 11 }}>
        <span style={{ color: "var(--s-complete)" }}>+{r.verifiedLast24h}</span>
        {" · "}
        <span style={{ color: r.newlyOverdueLast24h > 0 ? "var(--s-overdue)" : "var(--muted)" }}>{r.newlyOverdueLast24h} late</span>
        {" · "}
        <span style={{ color: r.holdsOpenedLast24h > 0 ? "var(--s-hold)" : "var(--muted)" }}>{r.holdsOpenedLast24h} hold</span>
      </td>
      <td style={{ color: "var(--muted)", fontSize: 11 }}>{fmtRelative(r.lastActivityAt)}</td>
    </tr>
  );
}
```

- [ ] **Step 3: Lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both clean. If `StageSpine`'s props differ from Step 1's finding, fix the call here.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/dashboard/_portfolio.tsx"
git commit -m "feat(ui): portfolio tiles + worst-first project table

URL-driven health filter so it survives refresh and back. Jobs with no units
render an explicit dash rather than a misleading all-idle spine. Cancelled
jobs are excluded from tiles and rows but surfaced as a footnote."
```

---

## Task 6: Wire it into the dashboard, replace the hardcoded job

**Files:**
- Modify: `src/app/(app)/dashboard/page.tsx` — delete `pilotJobId()` (lines 8-13), add portfolio band + job selector.

**Interfaces:**
- Consumes: `loadPortfolio` from `@/lib/services/portfolio.read`; `PortfolioBand`, `healthFromSlug` from `./_portfolio`.
- Produces: nothing importable.

- [ ] **Step 1: Delete the hardcoded lookup and read searchParams**

Remove the `pilotJobId` function entirely (`page.tsx:8-13`) and its now-unused `withTenant` import if nothing else uses it. Replace the component signature and its first lines:

```tsx
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.clientId !== null) redirect("/portal");
  if (!hasRole(actor, ROLES.MANAGEMENT, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)) redirect("/workspace");

  const sp = await searchParams;
  const portfolio = await loadPortfolio(actor);
  const activeFilter = healthFromSlug(first(sp.health));

  // Default to the worst-off project, which is row 0 — that is the whole point
  // of the worst-first sort. An explicit ?job= wins so a link stays stable.
  const requested = Number(first(sp.job));
  const selected =
    portfolio.rows.find((r) => r.id === requested) ?? portfolio.rows[0] ?? null;
  const jobId = selected?.id ?? null;

  const k: JobKpis | null = jobId ? await loadJobKpis(actor, jobId) : null;
```

Add the imports at the top:

```tsx
import { loadPortfolio } from "@/lib/services/portfolio.read";
import { PortfolioBand, healthFromSlug } from "./_portfolio";
```

- [ ] **Step 2: Render the band above everything, and handle the no-schedule case without losing it**

The existing early return when `k` is null currently hides the whole page. It must not hide the portfolio band — a tenant whose worst project has no schedule still needs the board. Replace the `if (!k)` block with:

```tsx
  if (!k) {
    return (
      <>
        <div className="page-h"><h1>Dashboard</h1></div>
        <PortfolioBand portfolio={portfolio} activeFilter={activeFilter} />
        <p className="note">
          {selected
            ? `No current schedule for ${selected.jobNumber}. Generate one to see its detail cards.`
            : "No projects yet."}
        </p>
      </>
    );
  }
```

Then in the main return, insert the band immediately after the existing `page-h` block and before `<div className="kpis">`:

```tsx
      <PortfolioBand portfolio={portfolio} activeFilter={activeFilter} />
```

- [ ] **Step 3: Add the job selector to the detail section**

The existing cards now describe `selected`, not a hardcoded pilot. Make that explicit — replace the `<div className="page-h">` header's `<span className="sub">` job description with a real selector so the user can change it:

```tsx
      <div className="page-h" style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Project detail</h2>
        <nav className="sub" style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="Select project">
          {portfolio.rows.map((r) => (
            <Link
              key={r.id}
              href={`/dashboard?job=${r.id}${activeFilter ? `&health=${first(sp.health)}` : ""}`}
              className={`chip ${r.id === jobId ? "c-progress" : "c-idle"}`}
            >
              <i />
              {r.jobNumber}
            </Link>
          ))}
        </nav>
        <span className="sub" style={{ marginLeft: "auto" }}>
          {k.equipmentName ? `${k.equipmentName} · ` : ""}
          {k.designCode ? `${k.designCode} · ` : ""}
          {k.unitCount} units
        </span>
      </div>
```

Place this immediately before the existing `<div className="kpis">` (after `<PortfolioBand />`). Keep the original top `page-h` with just the `<h1>Dashboard</h1>` and the as-of timestamp.

- [ ] **Step 4: Lint, typecheck, build**

Run: `pnpm lint && pnpm typecheck && pnpm build`
Expected: all clean. `pnpm build` catches server/client component boundary mistakes that `typecheck` alone misses.

- [ ] **Step 5: Drive the real app — this is the acceptance gate**

```bash
export DATABASE_URL="postgresql://despl_web:1522d3aa4bb61c142514e80c05c15459@localhost:5432/despl_demo"
export DIRECT_URL="postgresql://postgres:devpass@localhost:5432/despl_demo"
pnpm dev
```

Log in as `sj@despl.local` / `despl-dev-only` and confirm each of these by looking at the screen, not by assuming:

1. Six tiles render above the fold; the counts sum correctly against the table rows.
2. DE0463 and DE0467 both show a red **Delayed** chip; DESPL-320 shows amber **At risk**.
3. Clicking the **Delayed** tile filters to two rows, shows an orange dismissible chip, and the URL reads `/dashboard?health=delayed`. Refresh — the filter survives. Press back — it clears.
4. Clicking a job chip in the selector re-renders every card below with that project's numbers; the URL carries `?job=`.
5. DE0463/DE0467 rows show `—` in the Stages column (no units), not an all-grey spine.
6. No raw enum (`AT_RISK`, `NOT_PLANNED`, `ACTIVE`), no table name, no DB role appears anywhere on screen.
7. Tab through the tiles — focus is visible on each.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/dashboard/page.tsx"
git commit -m "feat(dashboard): portfolio band + job selector, drop hardcoded DESPL-320

/dashboard was pinned to a literal DESPL-320 lookup, so management had no
screen showing more than one project. Now opens on the portfolio board and
the detail cards follow a selector defaulting to the worst-off project.

The band renders even when the selected job has no schedule - the old early
return would have hidden the whole board behind one unscheduled job."
```

---

## Task 7: Documentation and full verification sweep

**Files:**
- Modify: `docs/DESIGN_SPEC.md` §4.2
- Modify: `progress.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Record the taken option in DESIGN_SPEC §4.2**

§4.2 currently reads `Scope: selected job (portfolio toggle if cheap)`. Replace that clause with:

```
Scope: portfolio band (all projects, health-classified) above a selected-job detail
section; the job is chosen by a selector defaulting to the worst-off project.
Health rule and layout: docs/superpowers/specs/2026-08-16-portfolio-dashboard-design.md.
```

- [ ] **Step 2: Run the whole verification suite**

```bash
pnpm test && pnpm test:db && pnpm lint && pnpm typecheck && pnpm build
```

Expected: all green. Record the actual test counts — do not write "all tests pass" without the numbers in front of you.

- [ ] **Step 3: Confirm the API boundary still refuses anonymous callers**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/jobs/3/stage
```

Expected: `401`. A clean JSON error body, never a stack trace.

- [ ] **Step 4: Update progress.md**

Add a session-log row and update the status banner. State what shipped, the two spec revisions made during planning (the SQL view was dropped as redundant; hold-point ageing was dropped as an invented threshold), the C28/C29 open questions, and the known limitations: DE0463/DE0467 render no stage spine and zero hold points because they have no units, and `/workspace` still hardcodes DESPL-320 so the overdue deep-link filters by status only.

**Do not commit the current working-tree `progress.md` as-is.** It is a stale revision containing unresolved git conflict markers (`<<<<<<< HEAD`) and is 231 lines shorter than the committed version at `HEAD`. Restore it first, then edit:

```bash
git checkout HEAD -- progress.md
```

- [ ] **Step 5: Commit**

```bash
git add progress.md docs/DESIGN_SPEC.md
git commit -m "docs: portfolio dashboard session log + DESIGN_SPEC 4.2 scope"
```

- [ ] **Step 6: Push to demo**

```bash
git push origin demo
```

Never merge to `main` without explicit human approval.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 health rule, all branches | Task 2 |
| §4.1 hold ageing excluded | Task 2 (documented in the module comment) |
| §5.1 rule location (pure function) | Task 2 |
| §5.2 read layer, `PortfolioRow`/`Portfolio`, sort, N+1 ceiling | Task 3 |
| §5.3 rolling-24h change counts | Task 3 |
| §6.1 six tiles, URL filter, colors, CountUp | Tasks 4, 5 |
| §6.2 project table, all 12 columns, cancelled footnote, workspace deep-link | Task 5 |
| §6.3 job selector, default to worst-off, no-schedule empty state | Task 6 |
| §6.4 empty/error/focus/reduced-motion | Task 5 (empty), Task 6 step 5 (focus); see gap below |
| §7 roles unchanged | Task 6 (role guard preserved verbatim) |
| §8 schedule DE0463/DE0467 | Task 1 |
| §8.1 blank spine for job-grain jobs | Task 5 (`—` with tooltip) |
| §9 testing | Tasks 2, 3 |
| §10 files | all |
| §12 acceptance criteria | Task 6 step 5, Task 7 step 2 |

**Gaps found and accepted:**

- **Loading skeleton (§6.4) is not built.** The dashboard is a server component with no streaming boundary, so there is no loading state to fill today. Adding a `loading.tsx` would change the page's rendering model for every card, not just the new band — larger than this feature. Flagged here rather than silently skipped; raise it if the board feels slow on real data.
- **Error state (§6.4)** relies on Next's existing error boundary for the route group. No new handling added, consistent with every other page in the app.
- **`prefers-reduced-motion`** is already handled globally for `CountUp` and page transitions (§9.9); the band adds no new animation.

**Placeholder scan:** none. Every code step contains the actual content. Task 3 step 4 and Task 5 step 1 are explicit *verify-before-trusting* steps for two things I could not confirm from the schema alone (the `ProcessVerified` event type string, `StageSpine`'s prop names) — these are instructions to check reality, not placeholders for missing design.

**Type consistency:** `classifyJobHealth(job, today)`, `HealthInput`, `JobHealth`, `JobHealthRaw`, `HEALTH_LABEL`, `HEALTH_ORDER` (Task 2) are used with identical names and signatures in Tasks 3, 4 and 5. `loadPortfolio`, `Portfolio`, `PortfolioRow` (Task 3) match Tasks 5 and 6. `HealthChip`, `HEALTH_CLASS` (Task 4) match Task 5. `PortfolioBand`, `healthFromSlug` (Task 5) match Task 6. `PortfolioRow` extends `JobListItem`, so `percentComplete`, `unitRollup`, `forecastVarianceDays`, `openHoldPoints`, `overduePlans`, `lastActivityAt`, `deliveryDate`, `forecastDispatch` and `jobNumber` are all inherited and used with their existing names from `jobs.read.ts`.
