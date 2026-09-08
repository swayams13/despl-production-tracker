# DESPL Tracker — Design decisions

Round 1: role-based information architecture (My Day, Team, Dashboard).
Round 2: the operational workflows behind them. Round 1's navigation and IA are unchanged.

File: `DESPL Round 2.dc.html` — 11 screens behind the switcher in the top strip.

| # | Screen | Answers |
|---|---|---|
| 1 | Project Control Centre | What is happening to this project? |
| 2 | Project Schedule (Timeline / Gantt) | Where is the plan slipping, and why? |
| 3 | Activity Detail | What do I do next on this activity? |
| 4 | Department Overview | Where is my department's load and lateness? |
| 5 | Supervisor Team | Whose work needs a decision from me? |
| 6 | Assignment / Reassignment | Who owns this, who will, and why it changed |
| 7 | QC & Hold Points | What is waiting on QC? |
| 8 | QC Detail | Verify, reject, hold or ask? |
| 9 | Welding / Production | What is on the floor right now? |
| 10 | Tablet activity | The same three jobs, glove-friendly |
| 11 | States | Loading, empty, error, success and the six statuses |

## Terminology — taken from the running app, not invented

- **Statuses** are the six display values in `components/industrial/stage-status.ts`:
  Not started, In progress, Awaiting QC, On hold, Overdue, Complete. Overdue and rejected
  are derived markers on top of the five `ProcessPlanStatus` enum values, so "blocked" is
  shown as *Not started + reason*, never as a seventh status.
- **Actions** are the six transitions in `process.service.ts` (`start`, `submit`, `verify`,
  `reject`, `hold`, `resume`) plus the three assignment operations in
  `assignment.service.ts` (`claim`, `assign`, `release`). Nothing else is offered.
- **Project tabs** are the real job-detail tabs: Overview, Timeline (Gantt), BOM &
  Components, Assembly, QCP / Hold points, Packing, Dispatch, Activity, Client View.
  The brief's suggested tab list (Engineering / Procurement / Manufacturing / QC /
  Documentation / Dispatch / History) was not used — those are departments, and the app
  already exposes department views separately.
- Hold points carry QCP class codes and the "Awaiting TPI / Pending / QC review /
  Reinspect / Cleared" vocabulary from `stage-detail.read.ts`.
- Rejections raise an **NCR** (`ncr.service.ts`), which is why the Rejected queue's action
  is "Open NCR" rather than "Re-submit".

## Operational hierarchy

```
Portfolio (R1 Dashboard)
  └─ Project — Control Centre (1)
       ├─ Schedule (2) ─────────── process grain, all units rolled up
       ├─ Department on this project (4)
       └─ Activity (3) ─────────── (unit × stage) grain, the only screen with write actions
             ├─ QC submission (8)
             └─ Assignment (6)
```

Two scopes are deliberately different and are labelled as such: the Control Centre's
department table is **job-scoped** (this project only), the Department Overview is
**cross-job** (`departments.read.ts` is cross-job by design), so the same department shows
different counts on the two screens.

Demonstrated flows: **A** My Day → Activity → Update → Complete (3, and the tablet's
Activity tab). **B** Team → employee → activity → Reassign (5 → 6). **C** Project →
Schedule → delayed stage → Open activity → action (1 → 2 → 3). **D** QC → Awaiting
verification → Inspection detail → Verify / Reject (7 → 8).

## Activity interaction model

One primary action per state, never a row of equal-weight buttons. The state chips on
Activity Detail switch the primary action so the model can be reviewed in one place:

| State | Primary | Secondary | Why |
|---|---|---|---|
| Not started | Start | Reassign | Predecessors cleared; starting is the only useful move |
| In progress | Update progress | Submit for QC | Progress writes are frequent; submission ends your turn |
| Awaiting QC | View QC submission | Put on hold | Maker–checker: you cannot verify your own submission |
| On hold | Resume | Edit hold reason | Resume returns to In progress (not to the pre-hold state) |
| Overdue | File delay reason & start | Reassign | A delay reason is mandatory before any further progress write |
| Complete | Open QC record | Reopen request | Read-only |

Verify / Reject / Put on hold / Request information appear only on QC Detail, where the
actor holds the QC role. Escalate is not offered: the app has no escalation entity — the
equivalent is Reassign with reason "Escalation", which is what the reason list carries.

## Assignment model

- Claim (self, from the department pool), Assign, Reassign — all read and write only
  `assigneeUserId`. Assignment never affects gating, and the modal says so.
- The candidate list is restricted to the activity's owning department, because
  `assignPlan` refuses an assignee outside it.
- Two steps, because three things must be communicated: who owns it now, who will own it,
  and why. Step 1 shows current owner → new owner with each candidate's load; step 2 takes
  a reason (required, from the delay/assignment reason list) and an optional note, and
  shows the previous assignment change from the audit trail.
- Unassigned work lives on Team only. It never appears on an employee's My Day — an
  activity with no owner is a supervisor decision, not personal work.

## QC workflow

Six queues instead of one register: Awaiting verification, Upcoming, Overdue, On hold,
Rejected, Completed — each item one card with one action. Ordering is oldest submission
first, matching `qc-cockpit.read.ts`. The verification standard (3 days) is what makes an
item appear in Overdue; "On hold" is the hold-point register filtered to items that block
completion. QC Detail states what clears if you verify, and what happens if you reject.

## Table density

Every Round 2 table classifies fields:

- **Primary, always visible**: identity (project / unit / process), status, due date, owner
  or department, and the single action.
- **Secondary, visible when it earns the space**: stage number, elapsed vs standard,
  capacity, variance.
- **Detail, behind disclosure**: planned/actual/forecast dates, dependency, per-unit split,
  history, evidence — expandable row on the Schedule, right rail on Activity Detail and QC
  Detail.

No table scrolls horizontally at the 1280px shell width. The Schedule shows one row per
process rolled up across the nine units rather than 225 rows; the unit split is in the
expanded row.

## Intentionally removed

- Cycle-time, throughput, S-curve, overdue-aging and welder-productivity analytics —
  Round 2 stops before analytics, and none of them is a decision.
- The Control Centre has no activity table. Its exceptions list links out instead.
- Welding / Production keeps only the repair rate (against its configured 6% threshold)
  because that number changes what a supervisor does today; the rest of the welder
  scoreboard was dropped.
- No "total stages", "units created" or similar counts on screens where nothing follows
  from them.
- Department Overview's employee breakdown is a supervisor-and-above view, matching the
  existing department scoping; the "by project" view is the default so the screen is
  useful without that permission.

## Assumptions recorded

- The brief's example figures are used verbatim for DESPL-320 (82% actual, 88% planned,
  −6% variance, At risk) and for the department (12 people, 86 active, 8 overdue, 7
  blocked, 12 due today, 91% on-time). These differ from the Round 1 seed snapshot (5%
  complete); the seed reads as an early-life fixture, and the brief's numbers exercise the
  layouts. Real data should replace both.
- Schedule dates are a plausible reconstruction (Apr–Dec 2026) consistent with the 07 Sept
  "today" used in Round 1 and the 26 Nov due date in the brief. The Gantt is process grain
  with finish-to-start dependencies, as `gantt.read.ts` produces.
- Owner names follow Round 1's fixtures (Rakesh Yadav, Imran Shaikh, S. Jadeja) rather than
  the brief's "Operator A".
- "Progress 72%" is rendered as backing-operation completion (13 of 18), the only progress
  measure the schema supports at activity grain.
- Tablet screen is a single 1120px landscape layout with 52–82px touch targets; it is not a
  compressed desktop view. Phone was left out of Round 2 scope.

---

# Round 3: analytics, reporting & visualisation

File: `DESPL Round 3.dc.html` — 10 screens behind the same top-strip switcher pattern.
Round 1/2's IA, terminology and visual system are unchanged; this round only adds the
analytics layer on top.

| # | Screen | Answers |
|---|---|---|
| 1 | Management Dashboard | Where should management intervene, today? |
| 2 | Portfolio Analysis | How is the whole portfolio trending, and how does it break down? |
| 3 | Project Analytics | Is this one project healthy, department by department? |
| 4 | Department Analytics | Which departments perform well or poorly, across every job? |
| 5 | Schedule Performance | Is DESPL-320 tracking to its promised date? |
| 6 | Bottleneck Analysis | Which department is creating the most delay, and what do I do about it? |
| 7 | Reports | Where do I find a specific report, organised by intent? |
| 8 | Report Detail | The representative shape every report in #7 follows |
| 9 | Sunburst vs hierarchical table | Why the Sunburst request wasn't simply adopted |
| 10 | Drill-down model | How every chart above avoids being a dead end |

## Three levels, not mixed

**Level 1 — Management Dashboard + Portfolio Analysis.** Cross-project only. The
dashboard is the daily "where do I intervene" read (health tiles, needs-attention queue);
Portfolio Analysis is the same scope one layer deeper (trend, full hierarchy). Neither
screen shows a single project's internals.

**Level 2 — Project Analytics, Department Analytics, Schedule Performance, Bottleneck
Analysis.** Project/department grain. Bottleneck Analysis sits here rather than Level 1
because its answer is never the aggregate alone — the chart only closes once it reaches a
project, an activity and an owner (see drill-down model below).

**Level 3 — Reports, Report Detail.** The generated, filterable, exportable record. Built
on the same reads as Levels 1–2, never a new metric.

## Grounded in the real data model, not invented

Every number traces to a service that already exists in `src/lib/services/`:

- **Job health** (RAG chips everywhere): `job-health.ts`'s `classifyJobHealth` — the same
  six states (`ON_TRACK`, `AT_RISK`, `DELAYED`, `ON_HOLD`, `COMPLETED`, `NOT_PLANNED`),
  worst-first order, used by the dashboard, Portfolio Analysis and (per that file's own
  comment) the daily digest. One rule, so they cannot disagree — restated on the dashboard
  as a literal footnote rather than assumed.
- **Portfolio counts, freshness, 24h deltas**: `portfolio.read.ts` (`loadPortfolio`) —
  `verifiedLast24h` / `newlyOverdueLast24h` / `holdsOpenedLast24h` are real rolling-24h
  aggregates, not a snapshot table.
- **Project stat strip, S-curve, cycle-time offenders, throughput**: `workspace.read.ts`'s
  `loadJobKpis` (Task 13, the "Management KPI dashboard" §4.2 read) — `percentComplete`,
  `sCurve`, `cycleTimeOffenders`, `throughputByWeek`, `throughputTargetPerWeek`,
  `overdueAgingByDept`, `firstPassYieldPct`, `avgCycleVsStandardDays` are read verbatim
  from that interface, not re-derived.
- **Department comparison, cycle time, delay-reason breakdown**: `departments.read.ts`
  (`loadDepartmentCards` / `loadDepartmentDetail`) — `openCount`, `overdueCount`,
  `onTimePct`, `openReworkCount`, `cycleTime[]`, `reasonBreakdown[]`.
- **Department and delay taxonomy**: the real six departments (`ENGINEERING`,
  `PROCUREMENT`, `STORES`, `QC`, `FABRICATION`, `DISPATCH`, per `lead-time-model.json`) and
  the real seven delay categories (`prisma/seed.ts`: Material delay, Manpower, Machine
  breakdown, Rework / quality, Client hold, Drawing / engineering hold, Other). No
  category was invented for a chart.
- **Reports**: `reports.read.ts` today implements exactly one report end-to-end — the daily
  digest (stages verified, new overdue + reasons, holds opened/cleared, tomorrow's due
  list). The Reports screen says so directly rather than presenting all eleven listed
  reports as equally real; the other ten are the natural IA extension of read services that
  already exist (department/QC/schedule reads), staged for a later dispatch, not a promise
  the mockup makes silently.

## Numbers that are NOT yet real, and are labelled as such

- **Portfolio trend cards** (completion/week, overdue, blocked, on-time%) are weekly
  buckets over `domain_events`, the same technique `workspace.read.ts`'s
  `throughputByWeek` already uses for a single job — extended here to portfolio scope, not
  a new mechanism. `ProgressSnapshot` has zero rows in this seed (same gap
  `reports.read.ts`'s own comment documents), so there is no materialised historical table;
  the trend footnote on Portfolio Analysis says this rather than implying a snapshot exists.
- **Schedule Performance's forecast line** is explicitly captioned as the schedule engine's
  computed makespan from current durations (`forecastDispatch`), not a live re-forecast
  from today's actual progress — `workspace.read.ts`'s own doc comment calls that
  "Phase 2" work. Presenting it as live would overstate what CPM here actually does.
- Every average (cycle time, first-pass yield) carries its sample size (`n=`) and period
  next to the number — Section 13's "never show an average without context" rule, applied
  literally rather than left as a principle.

## Bottleneck chart — metric and why this shape

**Business question:** which department is creating the most delay, right now, across the
whole portfolio? **Metric:** open (non-`COMPLETE`) `ProcessPlan` rows owned by that
department, summed across every active job, whose `plannedFinish` has passed — i.e. the
same overdue predicate `departments.read.ts`'s `overdueCount` already uses, rolled up
cross-job the way that file's own department cards already are. **Aggregation:** count,
banded into the same 1–3d / 3–7d / 7d+ aging buckets `workspace.read.ts`'s
`overdueAgingByDept` computes per job — extended to portfolio scope by the same method, not
a new bucket scheme invented for this chart. **Period:** as-of now (a live queue depth, not
a trailing window). **Interpretation:** longer bar and a redder stack = more, and older,
undone work sitting with that department. **Drill-down:** bar → affected projects (oldest
age, count) → affected activities (process, unit, days overdue, status) → owner and the
one primary action available for that activity's real state — reusing Round 2's exact
Activity Detail action vocabulary (`Start`, `Update progress`, `Submit for QC`,
`File delay reason & start`, `Assign`, `Resume`, `Review submission`), never inventing a
seventh action. A stacked horizontal bar was chosen over separate charts per department
(too many decorative panels) and over a single count without aging (an average would hide
that QC's 18 skews old while Stores' 5 skews young — a materially different intervention).

Quality Control / QA leads the chart (18) rather than Procurement, which the brief's own
example used generically — this keeps continuity with Round 1/2's established canon, where
Weld NDE / QC is already the named bottleneck on the Project Control Centre and Schedule
screens. Inventing a different leader here would have contradicted work already reviewed.

## Sunburst vs hierarchical table

Built both, compared on the brief's six criteria (screen 9), decided for the table. The
Sunburst's one real advantage — a single glance at how a whole breaks into parts — doesn't
outweigh five real costs: illegible small arcs past 180°, unreliable arc-length comparison,
context loss on zoom, poor fit for this app's 1280–1360px row-based shell, and a fourth
chart grammar in an app that otherwise only ever uses tables, bars and one S-curve. The
table ships on Portfolio Analysis; the Sunburst is kept only as the recorded evaluation, on
its own screen, never on the operational dashboard — exactly where the brief asked it to
land if it survived at all.

## Drill-down model

One chain, used everywhere: **Portfolio → Project → Department → Stage → Activity → Owner
→ Action.** Screen 10 demonstrates it explicitly, step by step, using the same
Quality-Control-overdue example the Bottleneck chart uses live, so the abstract model and
the working instance are visibly the same thing. The rule this enforces: no analytical
view may terminate on a number. Department Analytics' expand-in-place row, Portfolio
Analysis' hierarchy, and the Bottleneck chart's click chain are three different UI
mechanisms for the identical rule — expand-in-place where the next level is a small,
bounded list; a full click-through where it may be long. A stepper (not a dead link) exists
so this rule is checkable as its own artifact rather than only implied by six separate
screens each doing it slightly differently.

## Filter model

One filter row shape, used wherever filtering is genuinely useful (Report Detail; the
trend-range chips on Portfolio Analysis), not redrawn per report. Kept off screens where it
would be decorative — the Bottleneck chart's own click-through already scopes the data more
precisely than a project/department dropdown would.

## Colour

No new colours. Same five tokens as Round 1/2: `#f0524d` critical/delayed,
`#d9a62e` warning/at-risk/on-hold, `#3fb950` healthy/on-track, `#4c8dff` in-progress/actual,
`#ff7a1a` the one interactive/brand accent, reserved for clickable and primary-action
elements so it still means "click here" and not "this number is bad." The bottleneck
chart's three aging-band colours (`#f0c05a`/`#d9a62e`/`#f0524d`) are a single warm ramp
inside the existing warning-to-critical range, not a new palette.

## Assumptions recorded

- Portfolio composition (DESPL-320 at risk, DE0467 delayed, 12548 on track, DE0463 on
  hold) is invented to exercise all four health states on one screen; DE0467 and DE0463 are
  real job numbers from the codebase's own seed scripts, DESPL-320 and 12548 continue Round
  2's canon. Real data should replace all four.
- Department Analytics' six-department comparison numbers and the Bottleneck chart's
  overdue counts are built to agree with each other (QC 18 overdue in both places) and with
  Round 2's established Weld NDE bottleneck — deliberately, so nothing here contradicts
  reviewed work. They are illustrative, not measured.
- Cycle-time sample sizes (`n=`) and deltas are invented but shaped like the real
  `cycleTimeOffenders`/`DeptCycleTimeRow` output — same fields, same units, plausible
  magnitudes given Round 2's schedule variances (+5d to +10d on several stages).

---

# Phase 4: Design system + UX hardening pass

Documentation-only pass (no new screens; the approved Round 1–3 IA and visuals are
unchanged). Codifies what was already built and fills the gaps the brief's audit surfaced
— principally Toast, empty, loading, error and confirmation-dialog patterns that didn't
exist yet as designed states. Five documents, each following the brief's own section
numbers:

- `DESIGN_SYSTEM.md` — tokens (color/type/spacing/radius, all values pulled from the
  existing mockups, none invented) and the canonical component set.
- `COMPONENT_INVENTORY.md` — every primitive found across Rounds 1–3, with a canonical
  decision per component and the table-tier rule (Primary/Secondary/Detail columns).
- `RESPONSIVE_GUIDELINES.md` — desktop/laptop/tablet behavior for the five screens flagged
  as priority (My Day, Activity Detail, Supervisor Team, Management Dashboard, Project
  Control Centre); reflow rules, not shrink rules.
- `ACCESSIBILITY_AUDIT.md` — contrast (all pairs pass), color-never-alone check, and the
  keyboard/focus/ARIA requirements for the production build (mockups are static HTML, so
  these are requirements rather than a live audit).
- `UX_FINAL_REVIEW.md` — empty/loading/error/mutation-feedback specs, the confirmation
  matrix for destructive actions, a microcopy and visual-QA pass, the four demo-scenario
  walkthroughs, and the final screen-by-screen purpose/action review for the five priority
  screens.

Per the brief's stop condition: this is a design-hardening pass only, presented for
approval before any Phase 5 production implementation begins.
