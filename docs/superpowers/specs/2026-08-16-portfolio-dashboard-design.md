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
2. **The signal is already covered.** An uncleared hold blocks stage completion
   (invariant #4), so it drives the stage overdue and the project reaches `AT_RISK`
   through the `overduePlans > 0` branch anyway. The independent trigger would fire
   *earlier* than that, and only sometimes — a marginal gain bought with a made-up number.

*(An earlier draft argued this branch would also fork `loadOpenHoldPoints`' 70-line rule
into SQL. That argument died with the view in §5.1 — `loadOpenHoldPoints` already returns
`ageDays` per hold, so the input is cheaply available in TypeScript now. Reason 1 is the
whole reason. Recorded rather than quietly dropped, so the decision can be re-argued on
its actual merits.)*

Open hold points remain a **column** on the table, so they stay visible.

**Upgrade path:** if SJ says an ageing hold must go amber even with zero overdue stages,
add one branch to `classifyJobHealth()` fed by `max(ageDays)` from the existing
`loadOpenHoldPoints()`, with the threshold SJ gives — and add the table-driven test case
alongside the other twelve.

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

**One exported pure function, `classifyJobHealth()`, in `src/lib/services/job-health.ts`.
No SQL view, no migration.**

An earlier draft of this spec specified a `v_job_health` view, reaching for `DESIGN_SPEC`
§11.5 ("put the rule in a SQL view so dashboard, job detail, workspace and reports can
never disagree") out of habit. Writing the implementation plan showed the view would be
pure duplication: **`loadJobs()` already returns every single input the rule needs** —
`status`, `deliveryDate`, `forecastDispatch`, `overduePlans`, `totalPlans` — computed in
one grouped, non-N+1 query that every consumer already calls.

§11.5's guarantee is *one implementation*, not *SQL specifically*. A single exported
function that all three consumers import satisfies it identically, and the expensive part
— the per-job aggregation — stays in SQL where it already lives.

What this buys, and why it is the better decomposition:

- **The rule becomes table-driven testable in the always-on tier.** Twelve pure cases in
  `pnpm test` instead of twelve DB fixtures (job + schedule run + process plans each)
  reachable only through `pnpm test:db`. `CLAUDE.md` requires violation-case tests for any
  new rule; this makes them cheap enough that they will actually be maintained.
- **No migration**, so nothing to roll forward, and no `security_invoker` footgun to get
  wrong.
- **No second definition of "overdue".** The view would have had to restate the
  `status <> 'COMPLETE' AND planned_finish < now()` predicate that `loadJobs()` already
  owns — two copies, guaranteed to drift.

```ts
// src/lib/services/job-health.ts
export function classifyJobHealth(job: HealthInput, today: Date): JobHealthRaw;
```

`today` is an injected parameter, not `new Date()` inside the function — that is what makes
the date-boundary cases ("promised today", "promised yesterday") testable without clock
mocking. Callers pass the server clock.

Plan-grain discipline is unchanged: `totalPlans`, `completePlans` and `overduePlans` are
counted at the 36-process plan grain per `DESIGN_SPEC` §11.4, never rolled up to 25 stages
first. Tile counts and table rows must reconcile exactly.

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

Composes `loadJobs()` with `classifyJobHealth()` per row plus one change-since query,
joined in memory by job id. Client scoping is inherited from `loadJobs()`, which already
filters to `actor.clientId` for portal users on top of tenant RLS.

**Known ceiling:** `loadJobs()`'s main tally is one grouped query, but its *extras*
(`loadOpenHoldPoints` + `loadJobSpines`) run two queries per job in a `Promise.all` — so
the portfolio costs roughly `2N + 3` queries. Fine at DESPL's ~3–40 concurrently active
jobs; it would need a batched rewrite before a tenant with hundreds. Mark it with a
`ponytail:` comment naming that ceiling rather than pre-optimising for a scale that does
not exist.

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

Seven tiles: **Active · On track · At risk · Delayed · On hold · Completed · Not planned**.
(An earlier draft of this section listed six and omitted Not planned — an oversight
against §4's own claim that NOT_PLANNED is a real signal, not a gap: without its own
tile, an unscheduled project couldn't be one-click filtered to. Active is a status
tally, not a health bucket; the other six are exactly `HEALTH_ORDER`.)

Each is a count with a one-line caption. Clicking a tile filters the table below via a
URL param (`/dashboard?health=delayed`) so the filter survives refresh and the back
button, matching the existing cross-filter convention. The active filter shows a
dismissible orange chip, as `/workspace` already does.

Colors reuse the existing chip classes only — no new CSS:

| Health | Class | Why |
|---|---|---|
| On track | `c-progress` (blue) | blue already means "in progress and fine" app-wide |
| At risk | `c-hold` (amber) | |
| Delayed | `c-overdue` (red) | |
| Completed | `c-complete` (green) | green already means "done" everywhere else |
| On hold | `c-idle` (grey) | a paused project is a decision taken, not a health problem |
| Not planned | `c-idle` (grey) | label disambiguates from On hold |

On track is blue rather than green deliberately: green is already the app's "complete"
colour, so painting a healthy in-flight project green would make it indistinguishable at a
glance from a finished one — the exact confusion this board exists to remove.

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

Row click → `/jobs/[id]`. The overdue cell deep-links to `/workspace?status=overdue`.

**Not `?job=<id>`:** `/workspace` hardcodes DESPL-320 the same way `/dashboard` does
(`workspace/page.tsx:8`) and ignores a `job` param entirely. Emitting one would look like
job-scoped navigation while silently showing the pilot job's stages — worse than not
offering it. Job-scoping `/workspace` is real work and out of scope here; until then the
link filters by status only.

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

All of the above are **pure** tests against `classifyJobHealth()` in the always-on
`pnpm test` tier — no database, no fixtures, no clock mocking (`today` is injected).

**Tenancy:** a DB-gated test asserting `loadPortfolio` returns only the acting tenant's
jobs, and that a client-scoped actor sees only their own client's. This inherits
`loadJobs()`'s existing filter plus tenant RLS, so the test guards the composition rather
than re-proving RLS itself.

**Sort:** worst-first ordering asserted against a fixture with one job in each bucket.

DB-gated tests run via `pnpm test:db` against `despl_test` only. Never `RUN_DB_TESTS=1`
against a demo database — that pollutes `organizations` and breaks single-tenant login for
every account, which has already happened once (see §11).

## 10. Files

| File | Change |
|---|---|
| `src/lib/services/job-health.ts` | new — `classifyJobHealth`, the rule |
| `src/lib/services/job-health.test.ts` | new — table-driven, pure, always-on tier |
| `src/lib/services/portfolio.read.ts` | new — `loadPortfolio` |
| `src/lib/services/portfolio.read.test.ts` | new — DB-gated composition + scoping test |
| `src/components/industrial/health-chip.tsx` | new — `<HealthChip />` + label/class map |
| `src/app/(app)/dashboard/_portfolio.tsx` | new — tiles + table |
| `src/app/(app)/dashboard/page.tsx` | portfolio band + selector; drop hardcoded lookup |
| `scripts/bootstrap-schedule.ts` | accept a job number instead of hardcoding DESPL-320 |
| `docs/DESIGN_SPEC.md` §4.2 | record that the portfolio option was taken |
| `progress.md` | session log |

**No migration. No schema change. No new dependency.**

## 11. Note on the current environment

Unrelated to this design, but it will be hit during implementation: the `despl` database
has 37 rows in `organizations` (1 real + 36 leaked `Delay svc test` / `Process svc test`
rows from a `RUN_DB_TESTS` run that bypassed `.env.test`). `resolveTenantForLogin()`
returns `null` unless exactly one organization exists, so **every login against `despl`
fails**. The dev server is currently pointed at `despl_demo`, which is clean.

Fixing `despl` means `pnpm prisma migrate reset` (destructive — wipes and reseeds). Not
done unattended; it is a separate decision from this spec.

## 12. Acceptance criteria

1. `/dashboard` opens with seven tiles whose counts reconcile exactly with the table rows.
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
