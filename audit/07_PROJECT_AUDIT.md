# 07 — PROJECT CONTROL CENTRE AUDIT

*`/jobs/[id]` is the strongest surface in the product and should become the
canonical Projects screen. It is also incomplete in specific, nameable ways.*

---

## 1. What is already right

`/jobs/[id]` is the pattern the rest of the app should copy:

- **Nine tabs, URL-driven** — `?tab=&unit=&equipment=&openUnit=&openStage=`, so
  every view is linkable, bookmarkable and back-button-correct.
- **Lazily loaded per tab** (`page.tsx:60-71`): each reader is
  `tab === "x" ? load(...) : null`. Opening the BOM tab does not pay for the
  Gantt. This is the correct pattern and it is applied consistently.
- **Four separate capability booleans** threaded to the client, so actions are
  role-shaped at the presentation layer — the one place in the app that does
  this properly alongside `/command/[dept]`.
- **The StageSheet drill-down works.** `stage-detail.read.ts` returns backing
  plans, contributing operations, hold points, delay reasons and rejection
  history in one payload; the launcher renders "Why on hold" and "Why overdue".
  **Every recommendation in this audit targets it as the terminal action — the
  destination is already built.**

**Verdict: KEEP. This becomes canonical Projects.** The dashboard's project half
(`06_DASHBOARD_AUDIT.md` §1) moves *into* it, not the other way round.

---

## 2. AUD-053 (P1) — Overview is a spine plus an activity feed

Tabs as rendered (`_client.tsx:154-164`):

> Overview · Timeline (Gantt) · BOM & Components · Assembly · QCP / Hold points ·
> Packing · Dispatch · Activity · Client View

**Overview contains exactly three things:** a job-rollup `StageSpine`, a
Units × stage matrix whose column headers are `fontSize: 9`, and a 5-row activity
feed.

The header carries jobNumber, equipment, family, unit count, status chip, order
date, due date, forecast and variance. It does **not** carry percent complete,
overdue count, or open-hold count — **all three are already in `JobHeader`**
(`job-detail.read.ts:31-34`: `totalPlans, completePlans, overduePlans,
percentComplete`) and simply not rendered.

**Impact.** "What is happening to this project?" is answered with a coloured bar
and the last five events. Schedule health, the exception list, procurement status
and QC status are each one tab click away with no summary — so the answer
requires visiting five tabs and holding the result in your head.

**Root cause.** Overview was built as the spine's home, and each subsequent
capability (BOM, assembly, packing, dispatch) was added as a peer tab rather than
as a summary card feeding a detail tab.

---

## 3. Proposed tab model

Mapping the target model onto what exists:

| Target tab | Composition | Status |
|---|---|---|
| **Overview** | Health summary: % complete **vs planned %**, forecast vs promised, overdue count, open holds, top-5 exceptions, job spine | **Regroup.** The four header numbers cost nothing — surface them today |
| **Schedule** | Gantt + department deadlines | **Regroup.** `computeDepartmentDeadlines` is already written (`gantt-layout.ts:105`) and has no surface |
| **Engineering** | Drawings, revisions, release status | **New surface needed.** `drawing.service.ts` and `DrawingRevision` exist; nothing renders them. This is also the blocker behind `assertDrawingReleased` being effectively untestable by a user |
| **Procurement** | BOM items, procurement events, stock lots, MTC / heat numbers | **Split** from the current "BOM & Components" tab |
| **Manufacturing** | Components + component operations + Assembly + the Units × stage matrix | **Merge** the components half of BOM with Assembly |
| **QC** | QCP grid + **this job's NCRs** | **Extend.** NCRs are currently only on the tenant-wide `/qc` cockpit — there is no per-job NCR view |
| **Documentation** | MTC certificates, MDR compilation | **New surface needed.** `mtc.service.ts` exists; nothing renders it |
| **Dispatch** | Packing + Dispatch merged | **Merge** two thin tabs into one |
| **History** | Activity feed | **Rename** from Activity |
| *Client View* | Publish → verify workflow | **Keep** — correctly gated by `canReviewClientUpdates` |

Two tabs need genuinely new read models (Engineering, Documentation); the rest is
regrouping components that already exist.

---

## 4. AUD-088 (P2) — the Gantt loads every unit's every bar

`gantt.read.ts:16-18`, the header comment, is honest about the trade:

> *"Loads every unit's bars in one query (bounded: max ~40 units × 36 processes
> for the pilot family) so the client can switch the expanded unit group with no
> extra fetch."*

Each `GanttBar` carries 12 fields. On DE0463 that is **~1,440 objects serialised
to the client** for a screen where one unit is expanded. Beyond the pilot's 40
units it degrades non-linearly.

Separately, bar labels render at `fontSize: 9` and process names at 11.5px in a
190px column — unreadable in a workshop.

**Fix.** Take `unitId?` in `loadJobGantt` and fetch the expanded group on demand;
render collapsed groups from a per-unit summary (start, finish, % complete,
overdue count). Raise the smallest Gantt label to 11px.

---

## 5. AUD-051 (P1) — the QCP grid is per-unit only

```ts
// qcp-grid.read.ts:68
const targetUnit = units.find(u => u.id === unitId) ?? units[0];
```
```tsx
// qcp-grid.tsx:47-55
<select onChange={e => router.push(`/jobs/${jobId}?tab=qcp&unit=${e.target.value}`)}>
  {data.units.map(u => <option value={u.id}>Unit {u.serialNo}</option>)}
</select>
```

Each load renders 54 checkpoint rows + 8 section headers in a 9-column table,
with acceptance criteria at 11.5px and section headers at 10.5px.

**"Which units still have an open hold at checkpoint 5.3?" requires 40
navigations and manual note-taking.**

Only `execs` is unit-scoped; items, sections and codes are **job-scoped and
already loaded**. The read model's comment correctly defends per-unit as the
default — but the UI never offers the complementary *checkpoint × unit* view that
makes the answer one glance.

**Fix.** Add a second view mode on the same tab: a checkpoint × unit matrix (rows
= the 54 checkpoints, columns = units, cell = latest `QcpExecution` result).
`src/components/viz/matrix-heatmap.tsx` is built for exactly this, renders as a
real `<table>`, and is **currently dead code** (AUD-085). Keep the per-unit list
as the drill-down.

### QCP grid column classification — 9 columns

| Column | Class |
|---|---|
| Ref | SECONDARY |
| Activity | **ESSENTIAL** |
| Class (P/W/H) | **ESSENTIAL** |
| Acceptance ref | DETAIL → expanding row |
| QC code | SECONDARY → expanding row |
| TPI code | SECONDARY → expanding row |
| Status | **ESSENTIAL** |
| Age | **ESSENTIAL** |
| Actions | **ESSENTIAL** |

**Reduced set (5):** Ref · Activity · Class · Status · Actions.

---

## 6. Units × stage matrix — right encoding, wrong type size

26–37 columns, every cell opening the StageSheet. The encoding is correct and
domain-native. The **9px numerals in the column headers**
(`jobs/[id]/_client.tsx:233`) are not (AUD-054). Raise to 11px, let the matrix
scroll horizontally, and make the unit column sticky.

---

## 7. AUD-031 (P1) — `forecastDispatch` is not a forecast, on this screen or any other

| Where | What `forecastDispatch` actually is |
|---|---|
| `jobs.read.ts:103` | `max(pp.planned_finish)` — the **plan** |
| `job-detail.read.ts:90-91` | the same, re-derived in JS |
| `workspace.read.ts:820-821` | the same again |
| `client-snapshot.read.ts:161, 220` | `job.committedDeliveryDate` — the **promise** |

`workspace.read.ts:671-673` admits it: *"current run's plans. Not a live
re-forecast from actual progress."*

Three consequences on this screen and beyond:

1. `classifyJobHealth` (`job-health.ts:85`) compares
   `forecastDispatch > committedDeliveryDate` — comparing the plan to the
   promise, both fixed at generation time. **The branch can never fire for a job
   that started feasible.** A job forty days behind on every actual still
   classifies AT_RISK, never DELAYED, until the promised date physically passes.
2. `forecastVarianceDays` on the job header is a constant.
3. The client sees a "forecast dispatch" identical by construction to the date
   they were promised — a structurally impossible-to-miss forecast.

**Fix.** Rename the existing field `plannedDispatch` everywhere so nothing claims
to forecast. Add a real `forecastDispatch` derived from `computeCpm` re-anchored
on the latest `actualFinish` per process, and feed *that* into
`classifyJobHealth` and the client view. Layer-2 CPM already exists and is loaded
in three read models — it is used only for float and critical path, never to
project a finish date from actuals. If a live forecast is out of scope this
quarter, **remove the field from the client payload rather than shipping the
promise under a forecast label.**

---

## 8. AUD-071 (P1) — dates are reported in the wrong unit

The engine works exclusively in working days: `calendar.ts` skips `weekOffDays`
and seeded holidays, and `seed/lead-time-model.json` declares
`calendarBasis = "CALENDAR_DAYS_6DAY_WEEK"` with Sunday off plus six national
holidays.

Every variance in the read layer divides raw milliseconds:

```ts
Math.round((forecastDispatch.getTime() - committedDeliveryDate.getTime()) / 864e5)
// jobs.read.ts:161, job-detail.read.ts:94, workspace.read.ts:824, portfolio.read.ts:135
```

**"7 days late" on this screen is 6 working days in the schedule that produced
it.** Over a 17-week job spanning ~17 Sundays plus holidays the two units diverge
by roughly 15%. A recovery plan built by adding "12 days" of overtime is built on
the wrong number.

This is the C1 open decision leaking past the boundary `calendar.ts` was isolated
to hold — its own header says C1 *"is expected to change this file without
touching envelope/cpm/feasibility"*, but the read layer bypasses it entirely.

**Fix.** Route every variance and `daysToPromise` through
`workingDaysBetween(a, b, calendar)` using the job's resolved calendar —
`resolveCalendarsForJobs` already batches this. Label the unit in the UI.
**Resolving C1 with DESPL is a prerequisite for these numbers meaning anything.**

---

## 9. Job intake — `/jobs/new`

The 5-step wizard is sound in structure. Two findings attach:

- **AUD-033 (P1)** — `TemplateProcess.optional` is never enforced.
  `job-intake.service.ts:140-146` validates only that an excluded code *exists*
  in the template. `grep optional src/` shows only `RouteStep.optional` is ever
  read. An intake user can create a job that omits **HYDROTEST, RADIOGRAPHY or
  FINAL INSPECTION** from the spine entirely. Those processes then have no
  `ProcessPlan`, so there is nothing to gate, nothing to verify, and no hold
  point attached to them can ever block anything. Combined with AUD-030, the only
  visible symptom is that some spine stages sit grey forever — which reads as
  "not started", not "deleted from this job".
  **Fix:** refuse any excluded code whose `TemplateProcess.optional` is false,
  and record a Production-Head-level reason for each exclusion, since it is a
  permanent change to the job's contractual scope.
- **AUD-065 (P1)** — the intake form's inputs carry only placeholders. Job intake
  is where a mistyped delivery date has real cost, and it is among the least
  labelled screens in the app. See `17_ACCESSIBILITY.md` §3.

---

## 10. `/jobs` list

| Column | Class |
|---|---|
| Job | **ESSENTIAL** |
| Family | SECONDARY |
| Description | SECONDARY |
| Units | SECONDARY |
| Stages (spine) | DETAIL |
| % complete | **ESSENTIAL** |
| Forecast vs due | **ESSENTIAL** |
| Open holds | SECONDARY |
| Updated | DETAIL |

**Reduced set (5):** Job · Description · % complete · Forecast vs due · **Health
chip** — currently absent from `/jobs` although `classifyJobHealth` is one import
away. Rest → expandable row.

Correctly paginated at 50 — which the `(app)` layout then silently undoes by
calling `loadJobs` unpaginated on every page in the app (AUD-020).

**Recommendation:** fold the dashboard's portfolio band into `/jobs` as a list
view with health filters, so there is one project list rather than two.

---

## 11. Cognitive load on this surface

| Tab | KPI tiles | Cards | Tables | Charts | Max columns | Smallest font |
|---|---|---|---|---|---|---|
| Overview | 0 | 4 | 1 | 2 | **37** (units × stage) | **9px** |
| Gantt | 0 | 1 | 0 | 1 (1,440 bars) | — | **9px** |
| QCP | 0 | 1 | 1 | 0 | 9 | 10.5px |
| BOM & Components | 0 | many | 1 nested tree | 0 | — | 11px |

The header numbers that would make Overview a summary are already computed. That
is the cheapest improvement available on this screen.
