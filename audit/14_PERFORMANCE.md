# 14 — PERFORMANCE AUDIT

*Assumed eventual scale: thousands of jobs, tens of thousands of units, hundreds
of thousands of activities, millions of historical events. The pilot's 9 units
hide everything.*

**Context that matters:** almost every finding here appears somewhere in the
source as a `ponytail:` comment naming the exact tradeoff and the exact trigger
for revisiting it. This audit largely confirms what the authors already wrote
down. The value added is the multiplier arithmetic and the ordering.

---

## 1. The four P0s, in order of multiplier

### AUD-021 — `v_unit_stage_status` builds the whole tenant, per request

Covered in full in `11_DATABASE_AUDIT.md` §8, with the live `EXPLAIN`.

**~688,000 estimated cost on an empty database.** The `exploded` CTE is
referenced twice, so PostgreSQL materialises it — and **a materialised CTE is an
optimisation fence, so the caller's `WHERE v.job_id = …` is never pushed in.**
Inside it, `is_rejected` is a correlated `EXISTS` evaluated once per exploded row.

Callers: `spine.read.ts` (job list, job header, digest) and
`stage-detail.read.ts` (every StageSheet open).

At 30,000 units × 36 processes × ~2 stages that is **~2.1M rows plus 2.1M
correlated probes, per request** — including a single StageSheet click that needs
one row. **Highest multiplier in the system.**

### AUD-020 — the app layout loads the entire portfolio on every page render

```ts
// (app)/layout.tsx:40-44
[overdueCount, notifications, jobs] = await Promise.all([
  loadMyOverdueCount(actor),
  loadNotifications(actor),
  loadJobs(actor),          // ← no pagination
]);
```

`loadJobs(actor)` without `opts` explicitly skips `skip`/`take`, then
unconditionally runs three raw aggregates over `process_plans`/`domain_events`
for every returned job id, then two more cross-job batch reads
(`loadOpenHoldPointsBatch`, `loadUnitSpinesBatch` — which is AUD-021).

**This layout wraps every authenticated page.** The result is used only for the
sidebar job switcher.

At 3,000 jobs / 30,000 units, opening *any* screen — including a supervisor
tapping "Start" and getting a re-render — materialises the whole portfolio.
`/jobs` itself is correctly paginated at 50, which the layout then silently undoes.

**Fix.** `loadJobSwitcherOptions(actor, { take: 20 })` returning only
`{id, jobNumber, projectName, status}` — no tallies, no percent view, no hold
points, no spine — ordered by recent activity. Keep `loadJobs` for `/jobs` only.
Wrap in React `cache()` so the layout and page share one call.

### AUD-022 — department rollups computed in JavaScript

Covered in `08_DEPARTMENT_AUDIT.md` §5. `loadDepartmentCards` loads **every
current `ProcessPlan` in the tenant** into a Node heap to compute six numbers on
six cards, and `command-center.read.ts:382` calls it a second time to read one
row out of the result — having already loaded every active job's plans.

At ~750,000 current plans this is an out-of-memory crash, not a slowdown.
`admin.read.ts:76-84` in the same codebase already does this correctly with
`groupBy`.

### AUD-023 — the events UNION limits after the union

Covered in `13_API_AUDIT.md` §5.

---

## 2. Query / index gap table

Every read model, its filter and sort columns, whether an index can serve it, and
the scan risk at scale.

| Read model | Query | Filter + sort | Index? | Risk |
|---|---|---|---|---|
| `jobs.read` `loadJobs` | `job.findMany` | `tenantId` (RLS), `clientId?`; ORDER `jobNumber` | ✅ `@@unique([tenantId, jobNumber])` | **Low** — correct |
| `jobs.read` | tally `$queryRaw` | `sr.job_id = ANY`, `sr.is_current` | Partial — `is_current` **unindexed** | Medium |
| `jobs.read` | `v_process_plan_percent` | `job_id = ANY` | View has 4 correlated LATERAL counts per row | **High** |
| `jobs.read` | activity UNION | join `pp.id = de.aggregate_id::int` | **Index unusable — cast on column** | **High** |
| `jobs.read` → `loadUnitSpinesBatch` | `v_unit_stage_status` | `v.job_id = ANY` | **Predicate cannot push into a materialised CTE** | **CRITICAL** |
| `jobs.read` → `loadOpenHoldPointsBatch` | qcpItem + qcpExecution | `processLinks.jobProcess.jobId IN`, `blocksCompletion` | ✅ both | Medium — all executions loaded, latest picked in JS |
| `myday.read` | `getCurrentScheduleRunsBatch` + `include: processPlans` | `jobId IN`, `isCurrent` | `@@index([jobId])`; **no `isCurrent`** | **High** — all plans of all active jobs into JS |
| `myday.read` | `clearedToday` | `assignee_user_id`, `status`, `schedule_run_id = ANY`, `de.type`, `de.at` | ✅ ✅ | Low — correctly written |
| `myday.read` | `firstPassRejects30d` | `de.aggregate_id = ANY(::text[])` | ✅ **correct cast direction** | Low — **the reference implementation** |
| `workspace.read` `loadOpenHoldPoints` | `processPlan.findMany` | `unitId IN`, `jobProcessId IN`, `isCurrent` | ✅ ✅ | Medium; O(items × units) JS loop |
| `workspace.read` `activeTodayRows` | `at >= date_trunc('day', now())` only | — | **No `[tenantId, at]`** | **High** — full scan |
| `workspace.read` `loadMyOverdueCount` | `processPlan.count` | `ownerDepartmentId IN`, `plannedFinish <`, `status`, `isCurrent` | ✅ `@@index([ownerDepartmentId, plannedFinish])` | Low — well matched |
| `departments.read` `loadDepartmentCards` | `processPlan.findMany` | `isCurrent` **only** | **None usable; unbounded** | **CRITICAL** |
| `departments.read` `loadOpenNcrs` | `ncr.findMany` | `status != CLOSED` + 5-level relation OR | `@@index([status])` | High — tenant-wide, called 2× |
| `departments.read` detail | `delayReason.findMany` | via `processPlan.ownerDepartmentId` | Index is **wrong direction** | High — no time bound |
| `command-center.read` | the batch + `loadDepartmentCards` | as above | as above | **CRITICAL** — loads the plan universe twice |
| `qc-cockpit.read` queue | `$queryRaw` | `status='SUBMITTED'`, `is_current`; ORDER by a **correlated subquery** | Sort key uncomputable from an index | **High** — no LIMIT |
| `qc-cockpit.read` | `qcpExecution.findMany` | `qcpItemId IN` (tenant-wide), ORDER `attemptNo desc` | `@@index([qcpItemId])` | High — every attempt ever, into JS |
| `qc-cockpit.read` weekly yield | `date_trunc('week', de.at) = w.week_start` | — | **Function on column; no lower bound** | **CRITICAL** — full scan, grows forever |
| `qc-cockpit.read` | `closedReworkNcrs` | `status`, `disposition IN` | `@@index([status])` | Medium — unbounded history |
| `portfolio.read` | 3 correlated subqueries **per job** | `jp.job_id = j.id` × N | Indexes exist but evaluated N× | **High** — 3N executions |
| `reports.read` `dueRows` | `plannedFinish` range, `status`; ORDER `plannedFinish`, `take 50` | **No `[plannedFinish]` index** | | **High** — full scan + sort for 50 rows |
| `reports.read` `loadDigestHistory` | `type`, distinct `entityId`, ORDER `createdAt`, `take 30` | **No `[tenantId, type, createdAt]`** | | High |
| `notifications.read` | `recipientId`; ORDER `createdAt desc`, `take 20` | `@@index([recipientId, readAt])` — **cannot order** | | **High — runs in the layout on every page** |
| `events.read` | UNION ALL, LIMIT after ORDER | cast defeats index; **no per-branch LIMIT** | | **CRITICAL** |
| `spine.read` (both) | `v_unit_stage_status` | `job_id` | **CTE fence** | **CRITICAL** |
| `stage-detail.read` | `v_unit_stage_status` | `job_id`, `unit_id`, `stage_no` | Same fence — full build for one row | **CRITICAL** |
| `stage-detail.read` | rejections `$queryRaw` | `de.aggregate_id::int = ANY(::int[])` | **Cast on indexed column** | High |
| `stage-detail.read` | `loadMappedOps` per process | — | — | **N+1**, 4 statements × N |
| `gantt.read` | `processPlan.findMany` | `scheduleRunId`, `unitId IN` | ✅ | Low — well scoped |
| `qcp-grid.read` | qcpItem + qcpExecution | `qcpTemplateId IN`, `unitId + qcpItemId IN` | ✅ ✅ | Low — correctly unit-scoped |
| `packing` / `dispatch.read` | unit/package/batch | `jobId` | ✅ | Low |
| `bom.read` `loadBomTree` | 8-level nested select | `equipmentId` | ✅ | High — **payload size**, not index |
| `welding.read` | joints + NDT, **no time bound** | `welderId IN` | ✅ | High — unbounded + O(n×14) JS |
| `welding.read` recent NDT | ORDER `recordedAt desc`, `take 12` | **No `[recordedAt]`** | | High |
| `admin.read` | `processPlan.groupBy` | `assigneeUserId`, `status`, `isCurrent` | ✅ | Low — **correct SQL aggregation** |
| `client-snapshot.read` | `progressSnapshot.findMany` OR-pairs | `(jobId, asOf)` × N | ✅ | Medium — OR list length degrades the planner |
| `template` / `job-intake.read` | reference tables | `tenantId` | ✅ | Low |

---

## 3. AUD-055 (P1) — the missing indexes, with their callers

| Missing index | Caller | Current best |
|---|---|---|
| `ProcessPlan @@index([plannedFinish])` or `[status, plannedFinish]` | `reports.read.ts:142-150` — tomorrow's due list | `@@index([ownerDepartmentId, plannedFinish])` — unusable, leading column absent |
| **`ScheduleRun @@index([jobId, isCurrent])`** | `departments.read`, `qc-cockpit.read`, `workspace.read`, `_shared.ts` — **`isCurrent: true` on every read** | `@@index([jobId])` only |
| **`Notification @@index([recipientId, createdAt])`** | `notifications.read.ts:26-30` — **runs in the layout on every page load** | `@@index([recipientId, readAt])` — cannot order |
| `Notification @@index([tenantId, type, createdAt])` | `reports.read.ts:169-175` | `@@index([tenantId])` |
| `Notification @@unique([recipientId, type, entityType, entityId])` | the cron idempotency check — see AUD-089 | none |
| `DomainEvent @@index([tenantId, at])` | `workspace.read.ts:937-941` "active users today" | Neither existing composite can serve it — the first needs `aggregate_type` equality, the second needs `type`. `AuditLog` has exactly this index; its sibling does not |
| `NdtResult @@index([recordedAt])` | `welding.read.ts:177-180` | three FK indexes only |
| `DispatchBatchUnit @@index([unitId])` | `_shared.ts:869-872` — runs on **every** verification of a dispatch-tagged stage | The composite unique leads with `dispatchBatchId` |

Plus the operational date columns in `11_DATABASE_AUDIT.md` §7. **Do not add all
19 blindly** — index writes cost on append-heavy tables. Confirm against
`pg_stat_statements` so the composites match real predicates.

**The `Notification` gap is the worst of these** because it is on the layout's
critical path: every page load in the app sorts one user's entire notification
history.

Also note on `DomainEvent`: `date_trunc('day', now())` runs under
`set_config('TimeZone','UTC')`, so "today" in that stat is the **UTC** day while
every other window in the codebase is the IST day — **the number is wrong by
5.5 hours' worth of activity** (AUD-027's cousin).

---

## 4. AUD-059 (P1) — cast the parameter, never the column

```sql
-- stage-detail.read.ts:278 — WRONG: index cannot be used
AND de.aggregate_id::int = ANY(${planIds}::int[])

-- myday.read.ts:351 — RIGHT: the reference implementation
AND de.aggregate_id = ANY(${myPlanIds.map(String)}::text[])
```

`aggregate_id` is `text` and is the third column of
`@@index([tenantId, aggregateType, aggregateId, at])`. `aggregate_id::int` is a
different expression, so the index cannot be used and the query degrades to a
scan of the tenant's events. Same pattern in `jobs.read.ts:125`,
`portfolio.read.ts:69` and `reports.read.ts:62`.

Every StageSheet open, every dashboard render and every `/jobs` page performs a
`domain_events` scan that an existing index would have satisfied.

**Fix.** Normalise all of them to `de.aggregate_id = ANY(<int[]>::text[])`. Pure
query-text change, identical results — and it simultaneously removes the AUD-028
correctness landmine.

---

## 5. AUD-058 (P1) — `loadMappedOps` N+1 in the StageSheet

```ts
// stage-detail.read.ts:155-175
const backingPlans = await Promise.all(
  backingProcesses.filter(…).map(async (p) => ({
    …,
    contributingOps: await loadMappedOps(tx, { jobProcessId: p.id, unitId, jobId }),
  })),
);
```

`loadMappedOps` issues **four** statements per call, and `Promise.all` does not
help — these run on one interactive transaction client, which serialises. **A
stage with 6 backing processes is 24 sequential round-trips.**

The StageSheet is the primary shop-floor interaction — every spine segment,
matrix cell and worklist row opens it. 24 serialised round-trips over Railway's
internal network is a visibly laggy drawer, on every tap.

**Fix.** `loadMappedOpsBatch(tx, { jobProcessIds, unitId, jobId })`: four
statements total regardless of process count. Keep the singular function as a
thin wrapper so `assertComponentOpsComplete` is unaffected.

---

## 6. AUD-060 (P1) — `loadPortfolio` runs 3N correlated subqueries

`const jobs = await loadJobs(actor);` — unpaginated — then three correlated
subqueries evaluated **once per job row**, one of which is a four-table join
through `qcp_item_processes → qcp_item_party_codes → qcp_code_refs`.

The file's own header concedes the shape: *"roughly 2N+3 queries. Fine at DESPL's
3-40 concurrently active jobs, batch those two reads before a tenant with
hundreds."*

`/dashboard` for the MD — the screen leadership judges the system by — is 3N
correlated subqueries **on top of AUD-020's cost**. At 3,000 jobs that is 9,000
subquery executions per page view.

**Fix.** One `GROUP BY jp.job_id` aggregate per metric — three grouped queries,
not 3N correlated ones — joined in JS by job id, exactly the pattern
`jobs.read.ts:94-119` already uses. Then paginate to the worst 50 with a total
count.

---

## 7. AUD-061 (P1) — no request-level memoisation anywhere

Repository-wide grep for `unstable_cache`, `revalidate`, `dynamic` and React
`cache` returns **zero hits** in `src/lib/` and `src/app/(app)/`.

`getActor()` opens a full `withTenant` transaction — two `set_config`
round-trips plus a `user.findFirst` with two nested includes — and is called at
`(app)/layout.tsx:33` **and** again in each page, and once more inside
`requireActor()` for every Server Action.

`loadJobs(actor)` is called at `layout.tsx:43` **and again** inside `loadMyDay`,
`loadCommandCenter`, `loadPortfolio` and `loadDailyDigest` — so **`/my-day` runs
the full portfolio read twice per request**, `/dashboard` twice, `/reports` twice.

**Fix.** Wrap `getActor` in React `cache()` — it takes no arguments and is
per-request-scoped, so this is a one-line, zero-risk change that removes 2–4
transactions per request. Same for the job-switcher read.

**Do not use `unstable_cache` for anything actor-scoped** — the cache key would
not include the tenant or actor and would leak across users.

---

## 8. AUD-094 (P2) — connection pool

```ts
new PrismaClient({ log, transactionOptions: { timeout: 20_000 } })   // no connection_limit
```

Prisma's default is `num_cpus * 2 + 1`. The team clearly understands the risk —
CI pins it explicitly with a comment (*"left uncapped, Prisma's cpus*2+1 default
blows past Postgres's max_connections (100)…"*) and `.env.test` tunes it.
Production's `DATABASE_URL` is not in the repo, so whether it carries
`?connection_limit=` cannot be verified from here, and **nothing in the code
enforces it**.

Compounding it: each page opens **multiple** transactions, not one. `/my-day` =
`getActor` (layout) + `loadMyOverdueCount` + `loadNotifications` + `loadJobs`
→ which itself opens `loadOpenHoldPointsBatch` + `loadUnitSpinesBatch`, each its
own `withTenant` + `getActor` (page) + `loadMyDay`'s own + `myDepartments` =
**9 transactions per page view**.

With ~20 concurrent supervisors and an uncapped pool, connection exhaustion on
Railway's Postgres is a realistic mid-shift outage — presenting as generic 500s,
since there is no observability (AUD-063).

**Fix.** Verify production carries `?connection_limit=10&pool_timeout=20`, and
**assert it at boot** in `db-guard.ts`, which already runs from
`instrumentation.ts` and is already fatal-on-misconfiguration. Then reduce the
transaction count — AUD-020 and AUD-061 remove 4–5 of the 9 on `/my-day` on their
own.

---

## 9. Payload size

**AUD-092 (P2) — the BOM tree.** One `bomItem.findMany` with an eight-level
nested `select`: `materialIdentifications`, `procurementEvents`,
`stockLots → txns`, and `components → { governingDrawing → revisions,
routeVersion → steps → operation, operations → { rejections, performedBy…, operation } }`.
No `take`, and **no unit filter on the `components` relation** — note the
contrast with `bomlessComponents` immediately below, which *is* scoped, with the
comment *"without this, DESPL-320's 99 rows across 9 units would render as one
flat list."* The same reasoning applies and was not applied.

Prisma issues ~18 relation queries and assembles one JSON payload containing
every operation record and rejection for the equipment — a multi-megabyte RSC
payload to a tablet on shop-floor wifi, on every BOM tab open.

**AUD-088 (P2) — the Gantt** ships ~1,440 bar objects for a screen where one unit
is expanded (`07_PROJECT_AUDIT.md` §4).

**AUD-093 (P2) — the welding view** reads every weld joint and NDT result ever
recorded, with no time bound, then computes a 14-day sparkline as
O(welders × 14 × joints) array scans, then makes a third pass to find the latest
NDT per joint in JS.

---

## 10. Client bundle and caching

- **No caching strategy at all.** Every page is fully dynamic. That is defensible
  for a live operational tool, but combined with §7's absent memoisation it means
  the same query runs repeatedly within one render.
- **`gantt-layout.ts` is correctly split from `gantt.read.ts`** so the client
  bundle never pulls in `next/headers` — with the actual turbopack error
  preserved in the comment. Good practice.
- **`bom-panel.tsx` is 48 KB**, the largest client component in the codebase, and
  a candidate for splitting once §9's lazy-loading lands.
- **Every My Day row is instantiated three times** (AUD-045,
  `04_MY_DAY_AUDIT.md` §3) — the largest client-side cost in the app.

---

## 11. Recommended sequence

Ordered by (impact × certainty) ÷ effort:

| # | Finding | Effort | Why here |
|---|---|---|---|
| 1 | AUD-061 — `cache()` on `getActor` | **S** | One line, removes 2–4 transactions per request, zero risk |
| 2 | AUD-020 — `loadJobSwitcherOptions` | **S** | Removes the heaviest read from every page in the app |
| 3 | AUD-059 — normalise the cast direction | **S** | Pure query text; also fixes AUD-028 |
| 4 | AUD-023 — bound the UNION branches | **S** | Removes an authenticated DoS |
| 5 | AUD-055 — the index migration | **S** | Mechanical; `CREATE INDEX CONCURRENTLY` |
| 6 | AUD-058 — `loadMappedOpsBatch` | **S** | 24 round-trips → 4 on the primary interaction |
| 7 | AUD-056 — QC yield range filter | **S** | Removes an unbounded growing scan |
| 8 | AUD-022 — department rollups in SQL | **M** | `departments.read.test.ts` is good regression cover |
| 9 | AUD-057 — bound and de-quadratic `/qc` | **M** | |
| 10 | AUD-060 — grouped portfolio aggregates | **M** | Depends on #2 |
| 11 | **AUD-021 — rewrite `v_unit_stage_status`** | **M** | **Highest multiplier**, but needs a migration through the manual-apply runbook and careful `EXPLAIN` verification. The three spine tests pin the output shape and should stay green unchanged |
| 12 | AUD-092/093/088 — payload scoping | **M** each | |
| 13 | AUD-094 — pool sizing + boot assertion | **S** | After #1, #2 reduce the count |

**Measure first.** Add the Prisma `$on('query')` slow-query log from
`15_FAILURE_MODES.md` §5 behind an env flag before starting — it would have
surfaced AUD-021, AUD-022 and AUD-056 on the pilot data, and it is the only way
to confirm the fixes landed.

---

## 12. What is genuinely solid

- **N+1 elimination is real, not aspirational.** `loadUnitSpinesBatch` and
  `loadOpenHoldPointsBatch` collapse 2N queries to 2, and the remaining cost is
  documented rather than hidden.
- **`admin.read.ts` shows the team knows the right pattern** — a real
  `processPlan.groupBy` rather than a JS reduce over a `findMany`.
- **`myday.read.ts:351` is the reference implementation** for the polymorphic
  join, and it is correct.
- **`gantt.read.ts` is well scoped** by `scheduleRunId` and `unitId IN`.
- **`qcp-grid.read.ts` is correctly unit-scoped**, with a comment defending why.
- **The `ponytail:` convention.** Nearly every finding above was already known
  and written down with its trigger condition. That is unusual, and it is why
  this list is tractable rather than alarming — the hard part, knowing what is
  actually true, is already done.
