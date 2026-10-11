# 08 — DEPARTMENT AUDIT

*Departments must represent departmental operational health. They must not be
another giant task list.*

---

## 1. Current state

| Surface | What it renders |
|---|---|
| `/departments` | One card per department with exactly **three** figures: `openCount`, `onTimePct`, `overdueCount` |
| `/departments/[id]` | **First and largest card is an unbounded 5-column open-items table**, then cycle time vs standard, then filed delay reasons |

The index page is close to right in shape. The detail page leads with the wrong
thing.

---

## 2. AUD-052 (P1) — the detail page is a third department task list

```ts
// departments.read.ts:207-218 — no take, no pagination
tx.processPlan.findMany({
  where: { ownerDepartmentId: deptId, scheduleRun: { isCurrent: true } },
})
```

Rendered as `<h3>Open items</h3>` with columns Job / Unit / Process / Status /
Due, sorted only by due date.

`DeptOpenItem` (`departments.read.ts:159-170`) is
`{ planId, jobId, jobNumber, unitId, serialNo, stageNo, processName, status, plannedFinish, overdue }`
— **no `assigneeUserId`**. The list cannot even answer "who is on it". It is a
worse copy of the Command Center board, and the third rendering of the same rows
(see `03_INFORMATION_ARCHITECTURE.md` §3), which means it will drift from the
other two.

On Fabrication with 1,440 plans across two jobs, this yields several hundred rows
before the two genuinely useful charts below it.

**A Production Head opening Departments to compare on-time performance is met
with a task list first and the comparison below the fold.**

---

## 3. AUD-082 (P2) — rework load is computed on every page load and thrown away

```ts
// departments.read.ts:29   — DeptCard
openReworkCount: number;
// departments.read.ts:194  — DeptDetail
openReworkItems: DeptReworkItem[];
```

Grep across `src/**/*.tsx` returns **zero consumers for either**. They are fed by
a tenant-wide NCR scan (`departments.read.ts:65-88`) that runs **twice** — once
for the cards, once per detail page.

Rework load per department is a real Production Head metric. It is already paid
for. Render it.

The same pattern appears elsewhere: `PortfolioRow.daysToPromise` is used only for
sorting and never rendered; `JobKpis.delaysByCategory` has zero consumers;
`MyDayView.week` computes a six-day forward-load strip nobody has ever seen;
`WsUnitRow.openNcrCount` runs a dedicated two-branch query and renders nowhere.

**Read models have consistently run ahead of the surfaces that present them.**
That is the single sentence that explains most of this audit.

---

## 4. What is missing from the index cards

Required: department · active work · overdue · **blocked** · completion ·
on-time performance · **workload**.

| Metric | Present? | Source if not |
|---|---|---|
| Active work (`openCount`) | ✅ | |
| Overdue | ✅ | |
| On-time % | ✅ | |
| **Blocked** | ❌ | `prioritize()` already classifies `BLOCKED` per plan |
| **Rework** | ❌ *(computed, discarded)* | `openReworkCount` — already there |
| **Workload / capacity** | ❌ | `openCount ÷ assigned headcount` from a `UserDepartment` count — cheap |
| **Completion trend** | ❌ | 7-day throughput from `command-center.read.ts:299-325` |

---

## 5. AUD-022 (P0) — the department rollup loads every current plan into JavaScript

```ts
// departments.read.ts:117-133
const plans = await tx.processPlan.findMany({
  where: { scheduleRun: { isCurrent: true } },   // ← no job, no dept, no limit
  select: { ownerDepartmentId: true, status: true, plannedFinish: true, actualFinish: true },
});
const byDept = new Map<...>();
for (const p of plans) { ... }                   // ← counts computed in JS
```

Made worse by `command-center.read.ts:382`:
`const kpi = (await loadDepartmentCards(actor)).find(d => d.id === deptId);`
— the Command Center loads **every plan in the tenant a second time**, having
already loaded every active job's plans, to read one row out of the result.
`loadOpenNcrs` is likewise tenant-wide and called twice on the detail page.

At the assumed scale — 3,000 jobs × 30,000 units × 25 stages ≈ **750,000 rows** —
serialising that through the Prisma engine into a Node heap on every
`/departments` and `/team/[dept]` load is an out-of-memory crash, not a slowdown.
**Six numbers on six cards cost a full table read.**

`admin.read.ts:76-84` in the same codebase already does this correctly with
`tx.processPlan.groupBy`.

**Fix.** One `$queryRaw`:

```sql
SELECT owner_department_id,
       count(*) FILTER (WHERE status <> 'COMPLETE')                              AS open,
       count(*) FILTER (WHERE status <> 'COMPLETE' AND planned_finish < $1)      AS overdue,
       count(*) FILTER (WHERE status = 'COMPLETE' AND actual_finish IS NOT NULL) AS ontime_total,
       count(*) FILTER (WHERE …on-time…)                                         AS ontime
FROM process_plans pp
JOIN schedule_runs sr ON sr.id = pp.schedule_run_id AND sr.is_current
GROUP BY 1
```

For the detail page, add `ownerDepartmentId` to the WHERE and paginate
`openItems`. In `command-center.read.ts`, pass the already-loaded plans in rather
than re-reading.

`departments.read.test.ts` pins the current numbers, which makes it good
regression cover for this change.

Requires the index `ScheduleRun @@index([jobId, isCurrent])` — `is_current` is
currently unindexed and is filtered on by five separate read models
(`14_PERFORMANCE.md` §3).

---

## 6. Also on this surface

- **AUD-101 (P2)** — `/departments/[id]` must narrow to performance. Drop
  `openItems`; keep cycle time, delay-reason breakdown, open rework, `DeptCard`
  KPIs; add a trend and a link into `/team/[dept]` for the work itself.
- **`delayReason.findMany`** on the detail page filters through
  `processPlan.ownerDepartmentId` with `DelayReason @@index([processPlanId])` —
  the wrong direction — and has **no time bound**. Add a rolling window.
- **`loadOpenNcrs`** uses a 5-level relation `OR` and is tenant-wide; `Ncr` has
  only `@@index([status])`. Add `ncrs (job_id, status)`.

---

## 7. Column classification — `/departments/[id]` "Open items"

| Column | Class | Note |
|---|---|---|
| Job | **ESSENTIAL** | Keep |
| Unit | **ESSENTIAL** | Keep |
| Process | **ESSENTIAL** | Keep |
| Status | **ESSENTIAL** | Keep |
| Due | **ESSENTIAL** | Keep |
| **Owner** | **ESSENTIAL — MISSING** | `assigneeUserId` exists on the row's source and is not selected |
| **Age** | **ESSENTIAL — MISSING** | |

**The columns are right. The row count is the problem.** Split into "Needs
attention" (top 20, overdue + blocked + rework) and a filtered, paginated "All
open items" behind a "View all N" control.

---

## 8. Proposed department specification

### `/departments` — index

One card per department:

`Department · Active · Overdue · Blocked · Rework · On-time % · workload bar`

Every figure clickable, deep-linking to `/team/[dept]` with the matching filter.
Sorted worst-first by the same `HEALTH_ORDER` discipline the portfolio uses.

Source: `loadDepartmentCards` rewritten as a SQL `GROUP BY` (§5), plus
`openReworkCount` (already computed) and a headcount from `UserDepartment`.

### `/departments/[id]` — detail

| # | Section | Source |
|---|---|---|
| 1 | Department KPI header | `DeptCard`, reused verbatim — not recomputed |
| 2 | **Exception queue** — overdue + blocked + open rework, top 20, with Owner and Age | `prioritize()` + `openReworkItems` (already computed, currently discarded) |
| 3 | **Cycle time vs standard** | existing — promote above the fold |
| 4 | **Filed delay reasons** | existing, add a time window |
| 5 | On-time trend | 7-day throughput from `command-center.read.ts:299-325` |
| — | "View all N open items →" | links to `/team/[dept]`, which owns the work itself |

The distinction that makes this surface coherent: **Departments answers "how is
this department performing?"; Team answers "what is this department working on
and who has it?"** Once `/team` exists, the open-items table has a proper home
and can leave.
