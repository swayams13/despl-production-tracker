# 06 — DASHBOARD AUDIT

*The global dashboard is not an activity list. It answers five questions about
the portfolio, in five to ten seconds.*

---

## 1. AUD-015 (P0) — the dashboard is a portfolio band bolted onto a single-project page

```tsx
// dashboard/page.tsx:107-134
const portfolio = await loadPortfolio(actor);
const selected = portfolio.rows.find(r => r.id === requested) ?? portfolio.rows[0] ?? null;
const k: JobKpis | null = jobId ? await loadJobKpis(actor, jobId) : null;
```

Everything from `page.tsx:178` down is scoped to **one** job, chosen for the user
by `portfolio.rows[0]`: `<h2>Project detail — {jobNumber}</h2>`, then 5 KPI tiles,
a 5-cell stat strip, an S-curve, "Critical path — blocking dispatch", a
Department × status matrix, plans-verified-per-week, cycle-time offenders,
overdue ageing by department, and open hold points.

`loadJobKpis` lives in `workspace.read.ts:728` — **the dashboard's project half is
literally built on the workspace read model**, and duplicates `/jobs/[id]`,
`/departments` and `/qc` from a different code path, so the numbers disagree.

**Section census in DOM order: 12 KPI/stat tiles · 11 cards · 2 tables · 6
chart-like visuals · ~2,900px of vertical scroll.** Genuinely portfolio-grain
content: `PortfolioBand` and the Sunburst. **Roughly 15% of the page.**

The MD scrolls past the answer to a project detail he did not ask for, and cannot
tell where the portfolio view ends and the single-project view begins without
reading a 15px `<h2>`.

---

## 2. Required vs actual

| Required section | Status | What exists instead |
|---|---|---|
| **1. Executive KPIs** — active, delayed, at risk, on hold, actions due; all clickable | **Partial** | 7 tiles: Active + the 6 health states. Health tiles are `Link`s that deep-link with filter state and survive refresh — **good**. "Active projects" is a plain `<div>`, not clickable. **"Actions due" absent** — no portfolio-wide overdue or open-hold count anywhere |
| **2. Project health** — project, actual %, **planned %**, variance, forecast, health | **Partial** | 12-column "Projects — worst first", correctly sorted. Has actual %, forecast, health chip. **No planned %.** "Variance" is a *date* variance. No sticky ID, no sort, no search |
| **3. Operational bottlenecks** — horizontal bars of blocked/overdue/delayed by dept | **Partial, wrong scope** | Two competing visuals, both **single-job**. The Department × status matrix graphs all 5 raw statuses including COMPLETE and NOT_STARTED (inert). "Overdue ageing by department" is the *right* encoding but is job-scoped and buried at position 10 |
| **4. Needs attention** — prioritised exception queue with project, activity, problem, dept, owner, age, action | **Absent** | Two partial substitutes, both job-scoped: "Critical path — blocking dispatch" (process, unit, dept, days — **no owner, no action, no project**) and "Open hold points" capped at 5 |
| **5. Schedule performance** — planned vs actual cumulative | **Present but unreliable** | Hand-rolled `SCurveCard`, single-job, unweighted plan counts, planned line rebases on every reschedule |
| *Activity list that does not belong* | Mostly avoided | No raw event feed — good. But "Plans verified — per week" is throughput volume, and the "Last 24h" column (`+3 · 1 late · 0 hold`) is activity telemetry inside a health table |

**Can an MD understand portfolio health in 5–10 seconds? No.** The first fold
gives the KPI band and the top ~4 rows of the worst-first table — which is close
to right. Immediately below sits a labelless doughnut, and below that eight
screens about one arbitrarily-selected project.

---

## 3. AUD-016 (P0) — the exception queue does not exist

The closest thing is "Critical path — blocking dispatch":

```tsx
<div className="t">
  <b>{r.processName}</b>
  <span>Unit {r.serialNo} · <span className="dept-tag">{r.deptName}</span></span>
</div>
<span className="cp-days">{r.daysOverdue}d</span>
```

The row type (`workspace.read.ts:697`) is
`{ planId, processName, departmentId, deptName, serialNo, daysOverdue }` — no
owner, no problem statement, no required action, no project number.
`ProcessPlan.assigneeUserId` exists; **no dashboard read model selects it.**

The Production Head sees "Shell Welding, Unit SR07, Fabrication, 6d" and still
has to open three screens to find who owns it and what unblocks it. **Nothing on
the dashboard tells anyone what to do.**

**Fix.** New `loadPortfolioExceptions(actor, { limit: 20 })` returning
`{ jobNumber, jobId, unitId, stageNo, activity, problem, deptName, ownerName, ageDays, requiredAction }`,
where `problem ∈ Overdue | Blocked | Hold point | Rejected | No reason filed`.
Sources all exist: `ProcessPlan` (overdue + `assigneeUserId` → owner),
`loadOpenHoldPointsBatch`, `Ncr where status='OPEN'`, and `reasonsPending`. Sort
by `ageDays` desc within problem severity. Each row deep-links to the StageSheet,
which **already renders "Why on hold" and "Why overdue"** — the destination is
built; the dashboard just does not route to it.

---

## 4. AUD-007 (P0) — every deep-link drops the job

```tsx
<Link href="/workspace?status=overdue">                                    // :205
<Link href={`/workspace?dept=${r.departmentId}`}>                          // :268
<Link href={`/workspace?dept=${row.departmentId}&status=${STATUS_FILTER[s]}`}> // :306
<Link href="/workspace?status=overdue">                                    // _portfolio.tsx:177
```

**Seven** links in total, none carrying `job=` — `dashboard/page.tsx` lines 199,
205, 268, 278, 306 and 396, plus `_portfolio.tsx:177`. `/workspace` then falls back to
`findFirst({ where: { jobNumber: "DESPL-320" } })`.

The MD is looking at DE0467, clicks its "7 overdue" cell, and lands on
DESPL-320's overdue list. **The number he clicked and the list he gets are
different projects.** This is the single most likely way a wrong operational
decision is made in the product today, and it is a one-line-per-link fix.

---

## 5. AUD-047 (P1) — "Variance" is a date variance masquerading as schedule variance

```ts
// jobs.read.ts:160
forecastVarianceDays: Math.round((forecastDispatch - committedDeliveryDate) / 864e5)
```

i.e. `max(plannedFinish) − promise`. **There is no planned-%-to-date anywhere in
the codebase** — nothing computes "what percent should be done by today".

Without it, a project at 40% complete reads identically whether it should be at
38% or at 75%. The MD's core question — "which projects are behind their own
plan" — is unanswerable from this table.

**Fix.** Add `plannedPercentToDate` to `JobListItem`, duration-weighted from the
same `v_process_plan_percent` view the actual % already uses, so the two are
directly comparable:

```sql
sum(weight) FILTER (WHERE planned_finish <= now()) / sum(weight)
```

Render as a **bullet chart** — actual bar, planned tick — in the Complete cell.
Rename the date column "Forecast vs promised".

---

## 6. AUD-017 (P0) — the S-curve is not trustworthy

Five independent problems:

**(a) Unweighted plan counts.**
```ts
// workspace.read.ts:654,657
const planned = plans.filter(p => p.plannedFinish != null && p.plannedFinish <= weekEnd).length;
const actual  = plans.filter(p => p.status === "COMPLETE" && p.actualFinish <= weekEnd).length;
```
Every other percent surface is duration-weighted from a single view, and
`jobs.read.ts:111-119` states the rule out loud: *"never the plain complete/total
ratio."* The S-curve on the same screen as that number violates it.

**(b) Planned rebases on every reschedule.** `buildSCurve` reads `plannedFinish`
from the *current* run, which `persistScheduleRun` rewrites on every generate.
`ProcessPlan.baselineStart/baselineFinish` exist in the schema and `buildSCurve`
never reads them. **After one replan the planned line moves to meet the actual
line and cumulative slip vanishes from the chart.**

**(c) Naive week buckets.** 7 × 86.4e6 ms from `projectStartDate`, ignoring
`lib/schedule/calendar.ts` which the rest of the engine uses.

**(d) "Actual" means QC-verified, not work finished.** `actualFinish` is written
in exactly one place — `process.service.ts:246`, inside `verify`.

**(e) A latent plotting bug.** `page.tsx:467` —
`sCurve.filter(p => p.actual !== null).map((p, i) => …xFor(i))` — `i` indexes the
*filtered* array. Benign today only because nulls occur solely in the future
tail; any mid-series null silently compresses the actual line leftward.

**An MD looking at this after a replan sees a project tracking plan when it is
eight weeks late. That is worse than showing nothing.**

**Recommendation: do not ship a schedule-performance S-curve until** (1) a frozen
baseline exists — persist run v1's `baselineFinish` and never recompute it, or
add a `ProjectBaseline` snapshot at contract signature; (2) both series are
duration-weighted from `v_process_plan_percent`; (3) buckets follow the job
calendar; (4) the actual series is labelled "verified". Until then show
planned-vs-actual **as of today only**, as the bullet bar in §5 — which is honest
at today's data quality.

---

## 7. Sunburst evaluation — AUD-049

The chart exists (`src/components/viz/sunburst.tsx`) and is already the second
thing on the dashboard. This is therefore a decision to **remove**, not to decline.

**Verdict: reject. Remove it from the dashboard.**

| Criterion | Assessment |
|---|---|
| **Operational usefulness** | **Fails.** Arc angle encodes `Math.max(1, r.totalPlans)` — **plan count**. DE0463 at 40 units × 36 processes ≈ 1,440 plans consumes most of the circle; a single-unit job three weeks late is a hairline. The chart systematically over-weights the *largest* project rather than the *latest* one — it inverts management priority |
| **Readability** | **Fails.** No arc carries a text label; identification is a hover/focus tooltip only. On a projected screen there is nothing to read. `ON_HOLD` and `NOT_PLANNED` are both `var(--s-idle)` — two different management states, identical grey, adjacent |
| **Comparison** | **Fails.** Angular area is the weakest channel for magnitude, and the third ring subdivides each job into up to three slices — sub-degree arcs at 12+ jobs |
| **Drill-down** | **Fails, and it is a dead control.** Arcs declare `role="button"` and `tabIndex={0}` with **no `onClick` and no `onKeyDown`**. Keyboard users tab through dozens of announced buttons that do nothing — the project's own banned pattern |
| **Screen space** | **Fails.** A full-width card, ~330px of SVG plus padding, between the two most important sections, pushing everything else below the fold |
| **Cognitive load** | **Fails, by the code's own admission.** `page.tsx:85-88`: *"A new card alongside 'Projects — worst first' … both stay so the numbers can be cross-checked."* A chart whose stated purpose is to let a reader verify a table they already have is a second copy of six numbers in a weaker encoding |

The craft is not the problem — the arc maths is clean, the `sr-only` fallback
table is exemplary, and avoiding a d3 dependency was well reasoned. The problem
is that **no manager acts on plan-count-by-health-share**.

**AUD-086 (P2)** compounds it: `sunburstData` is derived *before* `activeFilter`
exists and is never re-derived, so clicking "Delayed — 3" narrows the table to
3 rows while the chart beneath still shows all 12 projects. Two contradicting
portfolio pictures side by side, in a room with the CEO.

**If a portfolio-composition view is genuinely wanted:** a horizontal stacked bar
in Reports — one bar, six health segments, counting *projects* not plans, each
segment labelled and clickable to the filtered table. Same question, readable,
actionable, one-tenth the space.

---

## 8. AUD-048 (P1) — the Department × status matrix charts inert totals

```tsx
const STATUS_COLS = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETE", "ON_HOLD"];
// cells colour-weighted by raw count: opacity: 0.16 + Math.min(count, 20) * 0.03
```

The file's own header concedes the gap: *"this table has no 'overdue' column of
its own; overdue plans still sit under NOT_STARTED/IN_PROGRESS here."*

**The one column a Production Head acts on is the one column absent.**
"Fabrication: 412 NOT_STARTED" is a heat-coloured cell nobody can do anything
with — it is large because the department is large.

**Fix.** Replace with the required bottleneck bar chart: one bar per department,
length = **blocked + overdue + rejected only**, segmented by problem type, sorted
worst-first, portfolio-wide. The existing "Overdue ageing by department" visual
is already exactly the right encoding — promote it, widen it to portfolio grain,
and delete the matrix.

---

## 9. Chart register

| Chart | Business question | Acted on? | Verdict |
|---|---|---|---|
| **Sunburst** | "What share of plan count sits in each health bucket?" | **No** | **Delete from dashboard** |
| **S-curve** (inline `SCurveCard`) | "Are we ahead or behind plan cumulatively?" | Would be, if trustworthy | **Redesign + move to Reports** — blocked on AUD-017 |
| **Department × status matrix** | "How much work sits in each status per department?" | **Partly** — the actionable column is missing | **Replace** with the bottleneck bar |
| **Overdue ageing by dept** | "Which department has the oldest overdue work?" | **Yes** — deep-links with filter state | **Keep — promote to primary.** Widen to portfolio |
| **Cycle time vs standard** | "Which process consistently runs long?" | Yes, but retrospective | **Move to Reports**; keep the department-page copy |
| **Plans verified per week** | "Are we verifying fast enough?" | Marginally | **Move to Reports**, or reduce to "verified/wk vs target" |
| **Project health % bar** | "How far along is this project?" | **Yes** | **Keep.** Upgrade to a bullet with a planned-% tick |
| **StageSpine** (mini + full) | "Where in the 25-stage route is this job?" | **Yes** — clickable to StageSheet | **Keep.** Excellent domain-native encoding |
| **Units × stage matrix** | "Which unit is stuck at which stage?" | **Yes** — every cell opens the StageSheet | **Keep**, raise the 9px headers |
| **First-pass yield 6wk** | "Is quality trending?" | Yes, for QC | **Keep on `/qc`.** Fix 9px week labels |
| **Rejects by checkpoint** | "Which checkpoint fails most?" | **Yes** | **Keep.** Honest proxy, documented |
| **Filed delay reasons** | "Why is this department late?" | **Yes** | **Keep** |
| **Open joints per welder** | "Whose queue should I rebalance?" | **Yes** | **Keep.** Hoist `max` out of the render loop |
| **Welder sparkline 14d** | "Is this welder trending?" | **No** — 70×20px, no axis, no baseline, no value | **Delete** or replace with a number + delta |
| `viz/KpiTile`, `viz/ProgressRing`, `viz/MilestoneTimeline` | — | — | **Adopt or delete** |
| `viz/MatrixHeatmap` | — | — | **Adopt** for the QCP checkpoint × unit view |
| `viz/SCurve` | — | — | **Adopt** in place of `SCurveCard` — it has the crosshair and keyboard support the inline one lacks |

**AUD-085 (P2):** five of six `src/components/viz/` components are dead code —
exhaustive grep returns exactly two consumer references, both to `Sunburst` —
while `page.tsx:444-511` hand-rolls a second, inferior S-curve. The better-built
library is invisible, so every new chart gets hand-rolled inline. Adopt or delete;
do not leave both.

---

## 10. AUD-050 (P1) — portfolio table density

12 `<th>` inside `overflowX: auto`, with a `StageSpine variant="mini"` in column 5
rendering up to 36 segments. Row text at 11px; `th` at 10.5px. **No sticky Job
cell, no sort control, no search, no pagination** — unlike `/jobs`, which
paginates at 50.

At 40 jobs the MD scrolls horizontally and loses the job number, so every value
in columns 6–12 becomes unattributable.

| Column | Class | Action |
|---|---|---|
| Job | **ESSENTIAL** | `position: sticky; left: 0` |
| Health | **ESSENTIAL** | Keep |
| Complete (% bar) | **ESSENTIAL** | Upgrade to a bullet with a planned-% tick |
| *Planned %* | **ESSENTIAL — MISSING** | Add (AUD-047) |
| Promised | **ESSENTIAL** | Add `daysToPromise` as secondary text — already computed, never rendered |
| Variance | **ESSENTIAL** | Rename "Forecast vs promised" |
| Forecast | SECONDARY | Merge into Variance as a tooltip |
| Client | SECONDARY | → drawer |
| Overdue | SECONDARY | → the bottleneck chart owns this |
| Holds | SECONDARY | → `/qc` owns this |
| Stages (spine) | DETAIL | → drawer / job page |
| Last 24h | DETAIL | → drawer |
| Updated | DETAIL | → drawer |

**Reduced set (6):** Job · Health · Actual vs Planned (bullet) · Promised ·
Variance · Attention count.
**Drawer:** client, full spine, overdue list, open holds, last-24h deltas, last
activity, "Open project →".

**Never solve this with a smaller font.** 10.5px is already below the floor for a
wall-mounted display (AUD-054).

---

## 11. Proposed dashboard specification

Everything portfolio-grain. Target: full comprehension above the fold at 1440×900.

**1 · Executive KPIs** — one row, 5 tiles, every one a `Link` with filter state.
`Active · Delayed · At risk · On hold · Actions due`
Source: `loadPortfolio().counts` already returns `active` plus all six health
states. `Actions due` needs a new portfolio-wide count of overdue plans + open
blocking holds + open NCRs — extend `loadPortfolio`'s existing `$queryRaw`, which
already joins `qcp_code_refs … blocks_completion`. Make the `Active` tile
clickable; fold `Completed`/`Not planned` into a "show all".

**2 · Project health** — 6 columns, sticky Job, sortable, worst-first default.
Source: `loadPortfolio().rows`, already sorted by `HEALTH_ORDER` then
`daysToPromise`. Add `plannedPercentToDate` to `loadJobs`.

**3 · Operational bottlenecks** — horizontal stacked bars, one per department,
worst-first, **actionable segments only** (blocked / overdue / rejected), each
segment linking to `/team/[dept]?status=…&job=…`.
Source: **new** `loadPortfolioBottlenecks(actor)` — generalise `overdueAgingByDept`
off its single `jobId` and join open blocking holds via the already-batched
`loadOpenHoldPointsBatch` plus open NCRs via `qc-cockpit.read.ts`'s
`tenantNcrScope`. Reuse the existing `.age-row`/`.agebar` CSS unchanged.

**4 · Needs attention** — prioritised exception queue, top 15, each row
`project · activity · problem · department · owner · age · required action`,
deep-linking to the StageSheet.
Source: **new** `loadPortfolioExceptions` (§3). Reuses `prioritize()` and
`assigneeUserId`.

**5 · Schedule performance** — **defer.** Until AUD-017's four preconditions
hold, replace with one line: *"N of M projects forecast past their promised date ·
aggregate slip X days"*, from `forecastVarianceDays`, already computed. Ship the
real S-curve on `/reports` once the frozen baseline exists.

**Removed from the dashboard:** Sunburst · project-detail KPI band · stat strip ·
Department × status matrix · plans-verified bars · cycle-time offenders ·
critical-path card · open-hold-points top-5 · the inline S-curve.
**Their homes:** `/jobs/[id]` for project scope, `/reports` for analysis.
