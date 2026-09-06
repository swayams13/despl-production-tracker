# Gate 4 — Pagination + page-load N+1s — Design

**Ledger item:** `docs/mos-execution/LEDGER.md:119`, "Pagination + the three page-load N+1s" (☐).

## Problem

Four read-service functions fan out one or more DB round trips per job in a
tenant's job list, instead of one grouped query for the whole set:

1. `src/lib/services/jobs.read.ts:158-164` (`loadJobs`) — `Promise.all` over
   every job, each iteration opening its own transaction via
   `loadOpenHoldPoints(actor, j.id)` and `loadJobSpines(actor, j.id)`. 2N
   extra round trips. `loadJobs` also has no `take`/`skip` on its base
   `tx.job.findMany` (`jobs.read.ts:59`) — unbounded by job count.
2. `src/lib/services/command-center.read.ts:220-232` — `for (const job of
   jobs)` calling `getCurrentScheduleRun`, `loadJobSpine`, and
   `tx.unit.findMany` per job. 3N round trips, on top of inheriting #1
   (`loadCommandCenter` calls `loadJobs` first).
3. `src/lib/services/myday.read.ts:174-193` — the same 3-per-job shape as #2
   (`getCurrentScheduleRun`, `loadJobSpine`, `tx.unit.findMany`).
4. `src/lib/services/client-snapshot.read.ts:117-132` (`loadClientPortalView`)
   — `for (const job of jobs)` calling `tx.progressSnapshot.findFirst` then,
   for jobs with a verified snapshot, `tx.progressSnapshot.findMany`. Up to
   2N round trips.

The ledger names "three" — this design fixes all four, since #2 and #3 share
identical per-job logic and the same batched helpers built for #2 cover #3
at near-zero marginal cost.

`portfolio.read.ts:16-18` already carries a `ponytail:` comment flagging
that it inherits #1 through `loadJobs()` — no separate fix needed there;
fixing #1 fixes portfolio for free.

Real-world trigger already documented (`progress.md:5350`): 4,197 leftover
test jobs under one tenant turned this into a 90-second `/dashboard`
timeout.

## Design: batch, don't change behavior

Every fix below is the same shape: replace "one query per job" with "one
query for all jobs, `WHERE x = ANY(${jobIds}::int[])` or `{ in: jobIds }`,
grouped into a `Map<jobId, T>` in JS," reusing the pattern already proven in
`portfolio.read.ts:47-99`. The per-job **business logic does not change** —
only where its inputs come from (a map lookup instead of an awaited query).

New batched functions are added alongside the existing single-job ones
(which stay, used by 8+ other single-job call sites found in the codebase
scout — out of scope to touch):

| New function | File | Batches | Return |
|---|---|---|---|
| `getCurrentScheduleRunsBatch(tx, jobIds, equipmentId)` | `_shared.ts` | `getCurrentScheduleRun` | `Map<number, ScheduleRunWithPlans>` |
| `loadJobSpinesBatch(tx, jobIds)` | `_shared.ts` | `loadJobSpine` (JobSpine: processes/edges/calendar) | `Map<number, JobSpine>` |
| `loadUnitSpinesBatch(actor, jobIds)` | `spine.read.ts` | `loadJobSpines` (UnitSpine[] per-unit stage status) | `Map<number, UnitSpine[]>` |
| `loadOpenHoldPointsBatch(actor, jobIds)` | `workspace.read.ts` | `loadOpenHoldPoints` | `Map<number, OpenHoldPoint[]>` |

Naming note: `loadJobSpinesBatch` (JobSpine — processes+edges+calendar,
`_shared.ts`) and `loadUnitSpinesBatch` (UnitSpine[] — per-unit stage rows,
`spine.read.ts`) are deliberately named differently from each other despite
both batching something called "spine," because the singular functions they
batch (`loadJobSpine` vs `loadJobSpines`) already have that same easy-to-
confuse-at-a-glance relationship in this codebase today — matching existing
naming, not fixing it.

### Per-function batching notes

- **`getCurrentScheduleRunsBatch`**: no per-job branching in the singular
  version — direct `findMany({ where: { jobId: { in: jobIds }, equipmentId:
  equipmentId ?? null, isCurrent: true }, include: { processPlans: true } })`
  grouped by `jobId`.
- **`loadJobSpinesBatch`**: singular throws `AppError(NOT_FOUND)` for a
  missing job — the batch version must not throw for one bad job among many;
  it simply omits that jobId from the returned map (all current callers
  already source jobIds from `loadJobs()`'s output, which only lists jobs
  that exist and are visible, so this is a hardening, not a behavior
  change). `jobProcess.findMany`/`jobProcessEdge.findMany` batch via `{
  jobId: { in: jobIds } }` / `{ process: { jobId: { in: jobIds } } }`; keep
  the existing `orderBy: { seq: "asc" }` (add `jobId` as the leading sort key
  so per-job order is undisturbed after grouping — order within each job's
  bucket is unchanged, only the global row order changes). Calendar
  resolution batches as: one `workCalendar.findMany({ where: { id: { in:
  distinctCalendarIds } } })` plus one shared `findFirst({ isDefault: true
  })`, both computed once, then mapped per job in JS — not a per-job
  lookup.
- **`loadUnitSpinesBatch`**: singular does `assertClientScope(actor,
  job.clientId)` per job — preserve as a per-job assertion inside the batch
  loop (fetch all jobs' `clientId` in one query, assert each, still O(1)
  extra query not O(N)). `loadWorkOrderStageNames(tx, tenantId, familyId)` is
  keyed by family, not job — dedupe to one call per distinct `familyId` in
  the batch, not one per job (an improvement beyond raw batching, same
  spirit). Main `$queryRaw` becomes `WHERE v.job_id = ANY(${jobIds}::int[])`
  with `v.job_id` added to the select so rows can be grouped back per job. A
  job absent from or invisible in the result naturally maps to `[]` at the
  call site (`map.get(id) ?? []`) — replicates today's `?? []` handling of
  `loadJobSpines`'s `null` return.
- **`loadOpenHoldPointsBatch`**: singular does `assertClientScope` +
  existence check per job — same treatment as above (one query to fetch all
  jobs' `clientId`s, assert, proceed). The three inner queries
  (`unit.findMany`, `qcpItem.findMany`, `qcpExecution.findMany`) each already
  filter through a single-job relation path (`equipment: { jobId }` etc.) —
  swap to `{ in: jobIds } }`-shaped filters, adding the owning jobId to each
  `select` so results can be grouped, then run the existing per-unit/per-item
  blocking-result logic per job from the grouped buckets.
- **`loadClientPortalView`'s progress-snapshot loop**: no new named batch
  function needed — inlined as one raw query:
  ```sql
  SELECT ps.* FROM progress_snapshots ps
  JOIN (
    SELECT DISTINCT ON (job_id) job_id, as_of
    FROM progress_snapshots
    WHERE job_id = ANY(${jobIds}::int[]) AND status = 'VERIFIED'
    ORDER BY job_id, as_of DESC
  ) latest ON ps.job_id = latest.job_id AND ps.as_of = latest.as_of
  WHERE ps.status = 'VERIFIED'
  ```
  replacing the per-job `findFirst` + `findMany` pair (up to 2N queries) with
  2 queries total (the above, plus the existing `job.findMany` +
  `clientVisibilityPolicy.findUnique`, both already outside the loop). Group
  rows by `job_id` in JS with `rowsToUnits`, same as today.

### Call-site rewrites (behavior-preserving)

`jobs.read.ts`, `command-center.read.ts`, `myday.read.ts` replace their
per-job `await` calls inside the loop/`.map()` with a lookup into a map
built once *before* the loop via the new batch functions — the loop bodies'
actual business logic (CPM computation, ranking, row shaping) are untouched
line-for-line, only the data source of `run`/`spine`/`units` changes from
"awaited call" to "map.get(job.id)."

**Cross-job isolation risk (call out explicitly, given H1's job-level RLS
work this same session cycle):** every grouping-in-JS step above must key
strictly by the DB row's own `job_id`/`jobId` column, never by array index
or insertion order — a batch bug here would silently attribution one job's
hold points/spine/snapshot to another job. Each new batch function gets a
regression test with ≥2 jobs carrying deliberately different data (e.g. job
A has 2 open hold points, job B has 0) asserting the map keys resolve to
the *correct* job's own data, not just "some non-empty result."

## Pagination scope

`loadJobs` has 8 call sites (`layout.tsx`, `welding/page.tsx`,
`jobs/page.tsx`, `api/jobs/route.ts`, `myday.read.ts`, `portfolio.read.ts`,
`command-center.read.ts`, `reports.read.ts`). Only `jobs/page.tsx` and
`api/jobs/route.ts` render a plain, unfiltered job list to a human paging
through it — the other six need the *full* tenant job set for their own
correct output (nav badge count, cross-job welding view, portfolio/command-
center/reports rollups) and pagination there would change what those
features report, not just how fast. Scope is deliberately narrowed to the
two human-facing list consumers.

`loadJobs(actor, opts?)` gains an optional third-shape: `opts?: { page:
number; pageSize: number }`. Omitted (all 6 non-paginated callers): behavior
identical to today, full list, no `take`/`skip`. Passed: the base
`tx.job.findMany` adds `skip: (page - 1) * pageSize, take: pageSize`, and
the function returns `{ items: JobListItem[], total: number, page: number,
pageSize: number }` instead of a bare array — `total` from a `tx.job.count()`
run inside the same transaction. The two batch-fixed extras (hold points,
spine) only ever run against the current page's `jobIds`, not the full
tenant — free additional win, since page size is now bounded regardless of
tenant size.

`jobs/page.tsx` reads `?page=` from `searchParams` (default 1, `pageSize`
fixed at 50 — no user-facing page-size control, YAGNI until asked for one),
renders the existing table/card views unchanged, adds a Prev/Next control
pair using plain `<Link href="?page=N">` (server-rendered, no client JS
needed — matches the page's existing all-server-component shape, no
`"use client"` search/filter exists today to preserve compatibility with).
`api/jobs/route.ts` reads `?page=`/`?pageSize=` query params the same way,
returns the `{ items, total, page, pageSize }` shape instead of a bare
array — a response-shape change, but this route has no documented external
consumer contract in this repo beyond the one internal page that already
calls `loadJobs` directly, so it's low risk; still worth grepping for any
`fetch("/api/jobs"` caller before/while doing this task in case one exists
client-side.

## Out of scope

- Job search/filter/sort on `/jobs` — doesn't exist today, not part of this
  ledger item's stated scope ("pagination + the N+1s"), would be its own
  design decision (search backend: ILIKE vs full-text vs client-side).
- Pagination on the six full-list `loadJobs` callers — each would need its
  own aggregation redesign to stay correct with a partial job set; not
  requested, no evidence yet they need it at DESPL's current job counts.
- `portfolio.read.ts`'s own remaining non-N+1 queries — untouched, its
  `ponytail:` comment is fully resolved by fixing #1, nothing else there was
  flagged.
