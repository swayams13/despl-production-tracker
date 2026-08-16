# Portfolio dashboard — design spec

**Date:** 16 Aug 2026
**Status:** approved design, not yet implemented
**Supersedes:** nothing. Extends `DESIGN_SPEC.md` §4.2, which scoped `/dashboard` to a
single job and left "portfolio toggle if cheap" as an option. This spec takes that option.

---

## 1. Problem

SJ, MD and CEO hold a project-progress meeting every morning. The tracker cannot
support it. `/dashboard` is hardcoded to one job:

```ts
// src/app/(app)/dashboard/page.tsx:10
tx.job.findFirst({ where: { jobNumber: "DESPL-320" } })
```

Every KPI, the S-curve, the critical path and the department matrix on that page
describe DESPL-320 and nothing else. No screen in the app shows two projects at once.
To answer "which projects need attention today?" management must open each job in turn
and compare by eye.

**Goal:** one glance answers how many projects are active, on track, delayed, on hold
and completed — and which specific projects are in trouble, worst first.

## 2. Goals and non-goals

**Goals**

- A portfolio summary readable in seconds at the top of `/dashboard`.
- A per-project table, worst-first, with the numbers the meeting actually argues about.
- A single canonical definition of project health, shared by every surface that shows it.
- Every number computed from the database. No hardcoded arrays, no mock data.

**Non-goals**

- No change to gating, maker–checker, hold points, RBAC or audit. This spec is read-only
  except for one data-prep step (§8), which uses the existing schedule service unchanged.
- No new charting. The existing single-job cards stay exactly as built in §9.4.
- No portfolio-level S-curve or cross-job Gantt. Out of scope; revisit if asked.

## 3. What already exists

Roughly 80% of the inputs are already computed. `loadJobs()` (`src/lib/services/jobs.read.ts`)
returns, per job, in one non-N+1 query: `status`, `deliveryDate`, `forecastDispatch`,
`forecastVarianceDays`, `overduePlans`, `completePlans`, `totalPlans`, `percentComplete`,
`openHoldPoints`, `unitRollup` (mini stage-spine) and `lastActivityAt`.

`JobStatus` already stores `ACTIVE | ON_HOLD | COMPLETE | CANCELLED` — three of the six
buckets are stored fields, not derivations.

`/reports` already has a cross-job daily digest (`loadDailyDigest`) covering stages
verified, newly overdue, holds opened/cleared and due-tomorrow, for a chosen IST date.
It is complementary and is linked, not duplicated.

**What does not exist:** any notion of a project being *on time* or *delayed*. That is the
one new concept this spec introduces.

## 4. The health rule (canonical)

Three-tier RAG for active projects, plus three structural states.

```
CANCELLED                              → CANCELLED     (excluded from tiles and table)
status = COMPLETE                      → COMPLETED
status = ON_HOLD                       → ON_HOLD
no current schedule run, or 0 plans    → NOT_PLANNED
promised date is before today          → DELAYED
forecast_dispatch > delivery_date      → DELAYED
overdue_plans > 0                      → AT_RISK
otherwise                              → ON_TRACK
```

First match wins, in exactly that order.

**The promised day itself is not yet late.** The comparison is on calendar dates, not
timestamps: a job promised today is `ON_TRACK` (or `AT_RISK`) all day and only turns
`DELAYED` tomorrow. `delivery_date` is stored at midnight UTC, so a naive
`delivery_date < now()` would flip it red at 00:00 on the very day it was promised — a
day early, and a number SJ would immediately and correctly dispute.

**Why two DELAYED branches.** They catch different failures and both are real in the
current data:

- *Promised date already passed* — DE0463 was promised 28 Jul 2026 and is still ACTIVE.
  Its forecast is irrelevant; the date is gone. Without this branch a job whose remaining
  work is small would read ON_TRACK while being weeks late.
- *Forecast breaches the promise* — DE0467 was committed 22 working days shorter than
  DESPL's own standard lead time. It is late by construction, before any stage slips.
  This is the case the tracker exists to surface (see `progress.md`, "Findings to raise
  with DESPL" #1).

**Why AT_RISK is separate from DELAYED.** A project with overdue stages but enough float
to still hit its date is not the same conversation as one that will miss. Collapsing them
either hides slippage or cries wolf. Amber means "slipping, still recoverable"; red means
"we will miss the customer's date".

**NOT_PLANNED is a real signal, not a gap.** An accepted order with no schedule is
something management should see. It is kept as a state even after §8 removes today's
instances.

### 4.1 Hold-point ageing is deliberately NOT a health input

The brainstorm proposed a second amber trigger: oldest open hold point ≥ 3 days. It is
dropped, for two reasons.

1. **The 3-day threshold was invented.** Nothing in DESPL's documents sources it. This
   project's discipline is to flag unknowns as C-numbers rather than quietly encode a
   guess, and adding a fabricated constant to the one rule management reads every morning
   is the wrong place to start guessing.
2. **It would fork a 70-line rule.** Open-hold-point detection lives in
   `loadOpenHoldPoints()` (`workspace.read.ts`) as TypeScript — latest attempt per
   (item, unit), `blocksCompletion` party codes, planned-start age fallback. Re-expressing
   it in SQL to feed the view would create exactly the two-implementations-that-disagree
   problem `DESIGN_SPEC` §11.5 exists to prevent.

An uncleared hold blocks stage completion (invariant #4), so it drives the stage overdue
and the project reaches AT_RISK through the `overdue_plans > 0` branch anyway. The signal
is not lost — only the independent, unsourced trigger is.

Open hold points remain a **column** on the table, so they stay visible.

**Upgrade path:** if SJ says an ageing hold must go amber even with zero overdue stages,
add the branch — computing the input in TypeScript from the existing `loadOpenHoldPoints()`
rather than reimplementing it in SQL — and log the agreed threshold as a C-number.

## 5. Architecture

Chosen: **portfolio band on top of the existing `/dashboard`**.

Rejected alternatives:

- *New `/portfolio` page* — management still lands on a single-job dashboard by default,
  leaving two places to look during a 15-minute meeting.
- *Dashboard becomes portfolio-only, single-job KPIs move to `/jobs/[id]`* — cleanest
  information architecture, but relocates the whole verified §9.4 build into a page that
  already carries five tabs. Disproportionate to the problem.

Resulting page order at `/dashboard`:

1. Portfolio summary tiles (new)
2. Project table (new)
3. Job selector (new, small) — defaults to the worst-off project by health rank
4. Everything already there, unchanged, now driven by the selector instead of the
   hardcoded `DESPL-320` lookup

### 5.1 Where the rule lives

`v_job_health`, a SQL view, per `DESIGN_SPEC` §11.5 ("put the rule in a SQL view so
dashboard, job detail, workspace and reports can never disagree"). Every input to the
rule as specified in §4 is a plain aggregate, so the whole thing is expressible in SQL
with no TypeScript branch — which is precisely what §4.1 buys by dropping hold ageing.

Follows the `v_unit_stage_status` migration's established pattern:

- `WITH (security_invoker = true)` — mandatory. Without it the view runs as its owner and
  bypasses tenant RLS, leaking cross-tenant rows.
- `GRANT SELECT ON v_job_health TO despl_web;`
- Overdue compares against `now() AT TIME ZONE 'UTC'`, matching the UTC timestamps Prisma
  stores and the `plannedFinish < new Date()` used everywhere else.

```sql
CREATE VIEW v_job_health
WITH (security_invoker = true) AS
WITH plan_tally AS (
  SELECT sr.job_id,
         count(*)::int                                        AS total_plans,
         count(*) FILTER (WHERE pp.status = 'COMPLETE')::int   AS complete_plans,
         count(*) FILTER (
           WHERE pp.status <> 'COMPLETE'
             AND pp.planned_finish IS NOT NULL
             AND pp.planned_finish < (now() AT TIME ZONE 'UTC')
         )::int                                               AS overdue_plans,
         max(pp.planned_finish)                               AS forecast_dispatch
  FROM process_plans pp
  JOIN schedule_runs sr
    ON sr.id = pp.schedule_run_id AND sr.is_current = true
  GROUP BY sr.job_id
)
SELECT
  j.id                                   AS job_id,
  coalesce(t.total_plans, 0)             AS total_plans,
  coalesce(t.complete_plans, 0)          AS complete_plans,
  coalesce(t.overdue_plans, 0)           AS overdue_plans,
  t.forecast_dispatch,
  CASE
    WHEN j.status = 'CANCELLED'                        THEN 'CANCELLED'
    WHEN j.status = 'COMPLETE'                         THEN 'COMPLETED'
    WHEN j.status = 'ON_HOLD'                          THEN 'ON_HOLD'
    WHEN coalesce(t.total_plans, 0) = 0                THEN 'NOT_PLANNED'
    -- Date-vs-date, not timestamp: the promised day itself is not yet late.
    WHEN j.delivery_date IS NOT NULL
     AND j.delivery_date::date
       < (now() AT TIME ZONE 'UTC')::date              THEN 'DELAYED'
    WHEN j.delivery_date IS NOT NULL
     AND t.forecast_dispatch > j.delivery_date         THEN 'DELAYED'
    WHEN coalesce(t.overdue_plans, 0) > 0              THEN 'AT_RISK'
    ELSE 'ON_TRACK'
  END AS health
FROM jobs j
LEFT JOIN plan_tally t ON t.job_id = j.id;

GRANT SELECT ON v_job_health TO despl_web;
```

`total_plans`, `complete_plans` and `overdue_plans` stay at the 36-process plan grain per
`DESIGN_SPEC` §11.4 — never rolled up to 25 stages first. The tile counts and the table
must reconcile exactly.

### 5.2 Read layer

New `src/lib/services/portfolio.read.ts`:

Two types, deliberately: the view can emit `CANCELLED`, but no row carrying it ever
reaches the UI. Keeping them separate means the compiler — not a code review — enforces
that a cancelled job can never be rendered as a chip or counted in a tile.

```ts
/** Raw `v_job_health.health` values. */
export type JobHealthRaw = JobHealth | "CANCELLED";

/** The rendered set. `CANCELLED` rows are filtered out in `loadPortfolio`. */
export type JobHealth =
  | "ON_TRACK" | "AT_RISK" | "DELAYED"
  | "ON_HOLD" | "COMPLETED" | "NOT_PLANNED";

export interface PortfolioRow extends JobListItem {
  health: JobHealth;
  clientName: string;
  daysToPromise: number | null;     // negative once the promised date has passed
  verifiedLast24h: number;
  newlyOverdueLast24h: number;
  holdsOpenedLast24h: number;
}

export interface Portfolio {
  counts: Record<JobHealth, number> & { active: number };
  rows: PortfolioRow[];             // sorted worst-first
  cancelledCount: number;           // surfaced as a footnote, never silently dropped
}

export async function loadPortfolio(actor: Actor): Promise<Portfolio>;
```

Composes `loadJobs()` (already non-N+1) with one `v_job_health` query and one
change-since query, joined in memory by job id. Client scoping is inherited from
`loadJobs()`, which already filters to `actor.clientId` for portal users on top of
tenant RLS.

`active` counts every job whose status is `ACTIVE`, regardless of health — it is the
denominator the other tiles partition, not a seventh bucket.

**Sort order (worst-first):** `DELAYED` → `AT_RISK` → `NOT_PLANNED` → `ON_TRACK` →
`ON_HOLD` → `COMPLETED`; within a bucket, by `daysToPromise` ascending (most overdue
first), then `jobNumber`. `ON_HOLD` sits low because a paused project is a decision
already taken, not a surprise.

### 5.3 Change-since-yesterday

A rolling **24-hour** window, computed in the same query pass:

- `verifiedLast24h` — `domain_events` verify events on `ProcessPlan`, per job.
- `newlyOverdueLast24h` — plans not `COMPLETE` whose `planned_finish` falls between
  `now() - 24h` and `now()`. Derived from the timestamp, so it needs no event and cannot
  drift from the overdue count.
- `holdsOpenedLast24h` — same predicate `loadDailyDigest` already uses for holds opened.

**Rolling 24h, not an IST calendar day, and this is deliberate.** `loadDailyDigest` uses
IST calendar days because it is a dated report. The meeting is a rolling cadence — "what
changed since we last met" — so a fixed window is the honest answer and does not reset to
zero at 00:00 IST while people are still working. Do not "fix" this to match the digest.

## 6. UI

Follows the industrial control-room rules in `CLAUDE.md` and `DESIGN_SPEC`. No new design
language, no new colors.

### 6.1 Summary tiles

Six tiles: **Active · On track · At risk · Delayed · On hold · Completed**.

Each is a count with a one-line caption. Clicking a tile filters the table below via a
URL param (`/dashboard?health=delayed`) so the filter survives refresh and the back
button, matching the existing cross-filter convention. The active filter shows a
dismissible orange chip, as `/workspace` already does.

Colors come from existing tokens only: `--s-complete` (on track), `--s-hold` (at risk),
`--s-overdue` (delayed), `--s-idle` (on hold, not planned), `--muted` (completed).
Reuse `<CountUp>` for tile values, consistent with the existing KPI row.

Accent discipline: the tiles introduce no new orange. Per `CLAUDE.md`, more than about
three orange elements on a screen means removing some — the filter chip is the only
accent-colored element here.

### 6.2 Project table

One row per project, worst-first, aggregated into a single table — never N repeated
cards (an explicit hard ban).

| Column | Source |
|---|---|
| Job | `jobNumber`, mono |
| Client | `clientName` |
| Health | `<StatusChip>` — never plain text (hard ban) |
| % complete | bar + number, from `percentComplete` |
| Stage spine | `unitRollup` mini `<StageSpine />` |
| Promised | `deliveryDate` |
| Forecast | `forecastDispatch` |
| Variance | `forecastVarianceDays`, signed, colored |
| Overdue | `overduePlans` |
| Holds | `openHoldPoints` |
| Δ 24h | `verifiedLast24h` / `newlyOverdueLast24h` / `holdsOpenedLast24h`, compact |
| Updated | `lastActivityAt`, relative |

Row click → `/jobs/[id]`. The overdue cell deep-links to
`/workspace?job=<id>&status=overdue`.

If any cancelled jobs exist, a muted footer line reads `N cancelled — not shown`. They are
excluded from tiles and rows, never silently dropped.

`CANCELLED` is a `JobHealthRaw` value the view can return but the UI never renders as a
chip; it is filtered out in `loadPortfolio` and only survives as `cancelledCount`.

### 6.3 Job selector

The existing single-job section keeps every card built in §9.4, unchanged. Its job is
chosen by a small selector defaulting to `rows[0]` — the worst-off project — replacing the
hardcoded `DESPL-320` lookup. Selection is URL-driven (`/dashboard?job=<id>`).

The existing "no current schedule" empty state already handles a selected job with no
schedule; it is reused verbatim.

### 6.4 Required states

Per `CLAUDE.md`, this surface ships with: loading skeletons matching the final table
layout (no full-page spinner), an empty state (one sentence + one action) for a tenant
with no jobs, an error state naming what failed with a retry, visible keyboard focus on
tiles and rows, and `prefers-reduced-motion` support on the count-up.

Humanize every enum: `AT_RISK` → "At risk", `NOT_PLANNED` → "Not planned". No raw enum
reaches the DOM.

## 7. Roles

`/dashboard` already gates to `MANAGEMENT | PRODUCTION_HEAD | ADMIN` and redirects
supervisors and QC to `/workspace`. Unchanged — the portfolio inherits it.

Management sees zero action buttons, per the Demo Readiness rule. Every control here is
navigation or filtering; nothing on this page mutates.

Portal/client users never reach `/dashboard` (they are redirected to `/portal`), and
`loadJobs()`'s client filter would scope them correctly even if routing changed.

## 8. Data prerequisite

DE0463 and DE0467 currently have **no schedule run**, so today they would occupy
`NOT_PLANNED` and the board would be one real project and two blanks.

Both are `PRESSURE_VESSEL` v1 `PUBLISHED` with 36 non-provisional processes, so both are
schedulable now. Neither has units, and that is fine: `schedule.service.ts:126–139`
already falls back to one `unitId: null` plan per process for exactly this case. **No
invented data is required** — no fabricated unit counts, no guessed quantities.

Action: run the existing `generateSchedule` for both jobs. `scripts/bootstrap-schedule.ts`
is currently hardcoded to `DESPL-320` and needs widening to accept a job number.

Expected result — an honest board, not a demo prop:

| Job | Ordered | Promised | Health after scheduling |
|---|---|---|---|
| DE0463 | 06 Jun 2026 | 28 Jul 2026 | **DELAYED** — promised date passed |
| DE0467 | 24 Jun 2026 | 15 Oct 2026 | **DELAYED** — forecast breaches promise |
| DESPL-320 | — | none set | **AT_RISK** — 63 overdue plans, no promised date |

### 8.1 Known limitation: blank spine for job-grain jobs

`v_unit_stage_status` joins `pp.unit_id = u.id` and its own header comment records that
equipment-grain plans (`unit_id NULL`) are not fanned across units. DE0463 and DE0467
have no units at all, so `loadJobSpines` returns nothing and their **stage-spine column
renders empty**.

This is accepted, not fixed here. It is honest — there are no serials to show — and
fixing it means either inventing units or extending the canonical rollup view, both
larger changes than this spec. The column renders a muted "—" with a tooltip reading
"No units defined yet", never a misleading all-idle spine.

Their `openHoldPoints` will likewise be `0`, because `loadOpenHoldPoints` returns early
when a job has no units. Also honest: with no units there is nothing to inspect.

## 9. Testing

Per `CLAUDE.md`, a new rule requires table-driven tests for the violation and boundary
cases, not just the happy path.

**Health rule — table-driven, one case per branch plus its boundaries:**

| Case | Expect |
|---|---|
| status CANCELLED | `CANCELLED`, excluded from tiles |
| status COMPLETE | `COMPLETED` |
| status ON_HOLD (even with overdue plans) | `ON_HOLD` — structural state wins |
| ACTIVE, no schedule run | `NOT_PLANNED` |
| ACTIVE, schedule run with 0 plans | `NOT_PLANNED` |
| delivery_date yesterday, forecast earlier | `DELAYED` — passed-date branch |
| delivery_date tomorrow, forecast later | `DELAYED` — forecast branch |
| delivery_date exactly today, forecast within it | **not** `DELAYED` — the promised day is not yet late |
| delivery_date yesterday, all plans complete, still ACTIVE | `DELAYED` — late and unclosed |
| forecast exactly equals delivery_date | `ON_TRACK`, not `DELAYED` — `>` not `>=` |
| no delivery_date, overdue plans > 0 | `AT_RISK` |
| no delivery_date, 0 overdue | `ON_TRACK` |
| overdue plans > 0 but forecast breaches | `DELAYED` — first match wins |

**Consistency:** tile counts must equal the row counts they filter to; `active` must equal
the sum of health buckets for `ACTIVE` jobs. Asserted in a test, since Demo Readiness
§8.3 already requires KPI/matrix reconciliation and this is the same class of bug.

**Tenancy:** a DB-gated test asserting `v_job_health` returns zero rows with `app.tenant_id`
unset, proving `security_invoker` is doing its job. This is the one that matters — a view
created without it silently bypasses RLS.

**Sort:** worst-first ordering asserted against a fixture with one job in each bucket.

DB-gated tests run via `pnpm test:db` against `despl_test` only. Never `RUN_DB_TESTS=1`
against a demo database — that pollutes `organizations` and breaks single-tenant login for
every account, which has already happened once (see §11).

## 10. Files

| File | Change |
|---|---|
| `prisma/migrations/<ts>_v_job_health/migration.sql` | new — the view + grant |
| `src/lib/services/portfolio.read.ts` | new — `loadPortfolio` |
| `src/lib/services/portfolio.read.test.ts` | new — health rule table tests |
| `src/app/(app)/dashboard/page.tsx` | portfolio band + selector; drop hardcoded lookup |
| `src/app/(app)/dashboard/_portfolio.tsx` | new — tiles + table client component |
| `scripts/bootstrap-schedule.ts` | accept a job number instead of hardcoding DESPL-320 |
| `docs/DESIGN_SPEC.md` §4.2 | record that the portfolio option was taken |
| `progress.md` | session log |

No schema change. No new dependency. The view is additive and forward-only.

## 11. Note on the current environment

Unrelated to this design, but it will be hit during implementation: the `despl` database
has 37 rows in `organizations` (1 real + 36 leaked `Delay svc test` / `Process svc test`
rows from a `RUN_DB_TESTS` run that bypassed `.env.test`). `resolveTenantForLogin()`
returns `null` unless exactly one organization exists, so **every login against `despl`
fails**. The dev server is currently pointed at `despl_demo`, which is clean.

Fixing `despl` means `pnpm prisma migrate reset` (destructive — wipes and reseeds). Not
done unattended; it is a separate decision from this spec.

## 12. Acceptance criteria

1. `/dashboard` opens with six tiles whose counts reconcile exactly with the table rows.
2. Every project appears in exactly one bucket; `active` equals the sum of the `ACTIVE`
   buckets.
3. DE0463 and DE0467 both read **Delayed**, each for its own documented reason, after §8.
4. Clicking a tile filters the table, shows a dismissible chip, and survives a refresh and
   the back button.
5. Selecting a project re-scopes the existing single-job cards; every §9.4 card still
   works and its numbers still reconcile.
6. No raw enum, DB role, table name or developer commentary renders anywhere on the page.
7. Status appears only as `<StatusChip>`, never as plain text.
8. `pnpm test`, `pnpm test:db`, `pnpm lint`, `pnpm typecheck` and `next build` all clean.
9. A logged-out request to the portfolio route returns a clean `401` JSON body, not a
   crash or a stack trace.

## 13. Open questions for DESPL

**C28 — is a paused project (`ON_HOLD`) reported separately from a delayed one, or does a
long enough hold become "delayed" in the morning meeting?** This spec treats `ON_HOLD` as
a structural state that outranks health, so a paused project never shows red however long
it has been paused. Default in use: `ON_HOLD` wins. Affects only which tile a paused
project lands in.

**C29 — should a project with no promised delivery date ever be classified as delayed?**
DESPL-320 has no `deliveryDate`, so both DELAYED branches are unreachable for it and it
can never go worse than `AT_RISK` however far behind it runs. Default in use: no promised
date means no commercial delay is computable. The alternative is to fall back to the
schedule's own baseline finish. Affects the pilot job directly.

Both follow the C1–C27 convention in `BUILD-SPEC-v2.md` §7: a working default is in place,
and the question is logged rather than silently decided.
