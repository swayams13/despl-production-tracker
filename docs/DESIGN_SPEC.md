# DESIGN_SPEC.md — DESPL Production Tracker · Demo-Ready Build

Execution contract. Read with CLAUDE.md (tokens, primitives, hard bans, functional
rules). Pixel reference: `design/despl-tracker-mockup.html`.

**Goal of this milestone:** every sidebar module functional end-to-end on seeded data,
so the team can click anywhere, perform real actions, and give feedback. "Functional"
is defined per module below and by the Demo Readiness checklist (§8).

Libraries: shadcn/ui (vendored, themed) · TanStack Table v8 (`<DataGrid />` wrapper) ·
TanStack Query · Recharts (`components/charts/*` wrappers) · SVAR React Gantt (MIT) ·
cmdk · sonner · lucide-react · zod (all API input validation).

---

## 1. Seed data (`scripts/seed-demo.ts`) — the demo depends on this

The demo must open on a believable mid-project state, not 0%. Seed exactly:

- **Jobs:** DESPL-320 · HP Air Receiver · 9 units · ~18% complete, forecast +4d vs
  contractual 20 Oct; DE0467 · Pressure Pipe 8"/10"/SAV 24" · 3 units · ~41%, on
  schedule; DE0463 · SS Tank · 2 units · ~63%, −2d early. All three use the 36-process
  spine materialized from the pinned pressure-vessel template.
- **DESPL-320 stage state:** Unit 1 through stage 8–9 (one stage `submitted` awaiting
  QC); Units 2–9 blocked at Stage 1 "PO Receipt & Order Review", overdue 2–7 days
  (this reproduces the workspace bulk-reason scenario); Unit 7 with one `on_hold`
  stage; 2 stages with `rejected` history ("heat no. mismatch").
- **Delay reasons:** master list (Material delay, Vendor delay, Drawing revision,
  Manpower, Client hold, Machine breakdown, Other) + ~6 filed reason records with
  user + timestamp so history panels are non-empty.
- **Hold points:** 8 ITP items for DESPL-320 (refs ITP-320-01…08) with H/W/R classes,
  acceptance refs (ASME II-A, ASME IX, UG-99, UCS-56, ASME V…), mixed states:
  2 awaiting TPI (aged 4d, 6d), 2 in QC review, 1 cleared, 3 not due.
- **Departments (13):** Projects/PMO, Design & Detail Engg., Planning/PPC, Procurement,
  Stores, Fabrication Prep, Fabrication, Welding, Machining, NDT, Quality Control/QA,
  Surface & Painting, Hydro Test & Dispatch — each with a named representative and
  per-stage standard durations (placeholder values until SJ supplies real ones —
  mark the seed rows `is_placeholder=true` so they're easy to replace).
- **Users (one login per role for the demo):** admin, production head (SJ), one QC
  user, supervisors for at least PMO / Fabrication / Welding / Procurement, one
  management read-only user (CEO view). Password printed by the seed script.
- **Welding:** 4 welders, ~110 joints across DESPL-320 with NDT results distributed so
  team repair rate ≈ 4.6% and one welder ≈ 8.7% (triggers the red flag), open joints
  per welder 4–8.
- **BOM:** master BOM items; DESPL-320 Unit 1 BOM (~34 items: shell courses, dished
  ends, nozzles N1–N3 + manway, saddles, SAV, gaskets/fasteners) with heat numbers,
  MTC status, and component-level process state for Shell Course 1.
- **Events:** ~25 activity events (submits, verifies, rejects, reasons, BOM release)
  spread over 2 weeks so feeds, notifications, and the throughput chart have history.

`npm run seed:demo` must be idempotent (wipe + reseed) so the demo can be reset live.

## 2. Roles & permissions (server-enforced, UI-reflected)

| Action | Supervisor (own dept) | QC | Production Head | Management |
|---|---|---|---|---|
| Start stage / file delay reason / submit for QC | ✓ | — | ✓ | — |
| Verify / Reject submitted stage | — | ✓ | — | — |
| Record TPI clearance on hold point | — | ✓ | — | — |
| Log weld joints / NDT results | Welding sup. | NDT/QC | — | — |
| View everything, all dashboards | ✓ | ✓ | ✓ | ✓ (read-only) |
| Create users / edit standard durations / master lists | — | — | — | Admin only |

Rules the demo must survive: stage N+1 locked until stage N verified; verify/reject
only by QC; reject and overdue-start both REQUIRE a reason; every mutation writes an
event row (user, timestamp, before→after). Management user sees no action buttons at
all — same pages, read-only.

## 3. App shell (all pages)

Per CLAUDE.md. Functional requirements: job switcher actually switches job context
(all dashboards/pages re-scope); bell shows real unread events (overdue crossings,
items awaiting my verification, hold-point aging) with mark-as-read; ⌘K palette is
populated from the DB (jobs, units, stages, departments, pending-action counts) and
navigates/deep-links; sidebar badge = my overdue count, live.

## 4. Pages — layout + "functional" definition

### 4.1 `/login`
Centered 380px card, blueprint-grid background at 3% opacity (only decoration in the
app). Functional: real auth (existing), inline field errors, role-based redirect
(management → dashboard, supervisor/QC → workspace).

### 4.2 `/dashboard`
Question: "Will we ship on time, and what blocks us?" Scope: selected job (portfolio
toggle if cheap). Layout per mockup:

- 5 KPI cards: Overall completion (count-up + progress bar, "N of M plans"), On track
  (delta vs last week + 14d sparkline), At-risk/overdue (red top-border, delta,
  sparkline, **click → workspace filtered**), Open hold points (oldest age, awaiting-TPI
  count), Forecast dispatch (variance vs contractual, computed from remaining critical
  chain using standard durations — document the formula in code).
- Stat strip: First-pass yield (verified ÷ submitted, %), Avg cycle vs standard
  (d/stage), Stages completed last 7d (+delta), Reasons pending, NDT repair rate,
  Active users today.
- S-curve: planned cumulative % (from target dates) vs actual (from verified dates),
  today reference line, shaded variance band, legend shows variance %.
- Critical path panel: top 5 gate-blocking items by days blocked; **row click opens
  StageSheet**; footer → workspace.
- Department × Status matrix: counts printed, opacity-scaled, **cell click →
  `/workspace?dept=…&status=…`**; row-end on-time % bar (color by threshold 85/75).
- Throughput bar chart (stages verified per ISO week, 7 weeks, target line/label) ·
  Cycle-time-vs-standard top-5 offenders (std underlay + actual over/under bar,
  signed delta) · Overdue aging stacked bars (1–3d/3–7d/7d+ per dept) · Open hold
  points list (top 5 by age, TPI chips).

Functional = every number computed by SQL/API from seed data (write the queries as
views or route handlers, no client math beyond formatting), and every click-through
above works.

### 4.3 `/jobs` + `/jobs/[id]`
List: DataGrid — Job (mono), Family, Description, Units, **StageSpine-mini per unit
rollup**, % complete (bar+number), Forecast vs Due variance chip, Open holds, Updated.
Row → detail.

Detail header: code, description, status chip, due + forecast variance, Daily digest
button (§4.8). Five tabs, all functional:

- **Overview:** full StageSpine (segment click → StageSheet); Units × Stage matrix
  (9×25 cells from live state, hover tooltip, click → StageSheet for that unit+stage);
  recent activity (last 5, link to Activity tab). **The 25 segments/columns are a rollup
  of the 36-process spine — never read stage status directly; use the canonical rollup
  in §11.**
- **Timeline:** SVAR React Gantt — per-unit collapsible groups, bars colored by
  status, target window as underlay (render target bar manually under actual),
  finish-to-start dependencies, today marker, read-only (no drag; dates change only
  via delay-reason flow). Unit selector. Row click → StageSheet.
- **BOM & Components:** left = collapsible BOM tree (groups: Shell, Heads, Nozzles,
  Supports, Bought-out; item shows material/heat/MTC chip + component mini-spine);
  right = selected component panel (details, component process spine, process log).
  Functional: selection drives the right panel from DB; MTC status editable by QC.
- **QCP / Hold points:** DataGrid of ITP items (ref, activity, H/W/R, acceptance ref,
  QC, TPI, status, age). Functional: QC can "Record TPI clearance" (dialog: date,
  TPI name, remarks) → status flips, event logged, dashboard counts update.
- **Activity:** full event feed, filter by department/user, reverse-chron, paginated.

### 4.4 `/workspace`
Question: "What do I owe today, in priority order?" Header chips: my overdue / due
today / awaiting my QC (live counts). Filter chip from deep-links, dismissible,
URL-driven. Sort select (critical-path first · most overdue · due date) actually
re-sorts.

- Grouped cards per (stage × job): compact table of units — due, days overdue (red
  mono), reason Select (master list) + optional detail, Start button per row.
  Header bulk actions: **"Apply reason to all overdue"** (AlertDialog confirm →
  writes N reason records + events) and **"Start all"** (only enabled when gates
  allow). This is the flagship interaction — it must work flawlessly.
- "Awaiting your verification" section for QC: Verify (one click) / Reject (dialog,
  reason required). Both round-trip and update chips/badges instantly.
- Empty state: "Nothing due. Next item: {stage} · {unit} · due {date}."

### 4.5 StageSheet (component, not a page)
Opens from spine / matrix / gantt / critical path / workspace / palette. Content per
mockup: chip, title "Stage N · name", job+unit+owner, spine position strip (current
segment in accent), target vs actual, variance (colored), std duration vs elapsed,
linked hold points, delay-reason history, maker/checker explainer, role-correct
primary action (Start / Submit for QC / Verify) + "File reason…" + "Open full
activity". All actions real; sheet closes on Esc/overlay; optimistic update + toast.
**A stage may be backed by 1–3 processes (§11). The sheet is stage-scoped but every
action targets a real ProcessPlan: the primary CTA drives the *governing process*
(§11.3); multi-process stages list their backing processes as a checklist, each with
its own status + role-correct action. Never render a "start stage" control that has no
process to write to (functional rule #1).**

### 4.6 `/departments` + `/departments/[id]`
Cards (13): name, representative, open count, on-time % (colored by threshold),
overdue count, 6-week trend sparkline. Card click → department detail: DataGrid of
its open items (row → StageSheet) + cycle-time chart (its stage types, actual vs
standard) + its filed-reasons breakdown (bar per reason category). Functional: all
from DB; the on-time % must match the dashboard matrix exactly (same view/query).

### 4.7 `/welding`
Team header stats (team avg joints, team repair rate). Per-welder cards: joints on
current job, delta vs team avg, NDT repair rate (auto red flag chip above 6% —
threshold in config, not hardcoded), 14-day output sparkline. Open-joints-per-welder
balance chart. NDT results DataGrid. Functional: Welding supervisor can "Log joints"
(dialog: joint no., type, unit, welder, WPS ref) and NDT/QC can record results
(Accept/Repair/Pending) — repair rates and flags recompute.

### 4.8 `/qc` — QC & Hold Points (own page, not just a job tab)
Cross-job QC cockpit: "Awaiting verification" queue (all jobs, oldest first, one-click
open StageSheet), hold-point DataGrid with aging (same actions as job tab), first-pass
yield trend line (6 weeks), rejects-by-reason bar. Functional: this is the QC user's
home surface; everything actionable here.

### 4.9 `/reports`
Daily digest, generated (not static): for a selected date — per-job one-liner with
StageSpine-mini, stages verified that day, new overdues + their reasons, holds
opened/cleared, tomorrow's due list. "Send now" queues in-app notifications to
management users (email is next phase). History list by date. Functional: digest for
"yesterday" renders correctly from seeded events; PDF export can be deferred — if
deferred, there is no PDF button.

### 4.10 `/admin`
Minimal but real (management/admin only): users table (create user + role + dept,
reset password), master delay-reason list editor, standard-durations table editor
(per stage, flagged placeholders visible). No self-signup anywhere.

## 5. API sketch (route handlers, zod-validated, role-checked)

`GET /api/jobs` · `GET /api/jobs/:id` (spine, units×stage, header stats) ·
`GET /api/jobs/:id/gantt` · `GET /api/jobs/:id/bom` · `GET /api/jobs/:id/qcp` ·
`GET /api/dashboard?job=` (all dashboard aggregates in one payload) ·
`GET /api/workspace?dept=&status=` · `POST /api/stages/:id/start|submit|verify|reject`
(reject body: reason) · `POST /api/stages/:id/reasons` (single + bulk variant) ·
`POST /api/holds/:id/clear` · `POST /api/welding/joints` · `POST /api/ndt/results` ·
`GET /api/events?job=&dept=` · `GET /api/notifications` + `POST …/read` ·
`GET /api/search?q=` (palette) · `GET /api/reports/daily?date=` · admin CRUD routes.
Aggregations live in SQL views where possible so dashboard and department numbers
can never disagree.

## 6. Notifications (in-app, v1)

Event-driven rows: stage crossed due date (→ owner + production head), item submitted
(→ QC), reject (→ maker), hold point aged > threshold (→ QC + production head),
digest published (→ management). Bell dropdown groups by type with chips; unread
count on bell and sidebar badge; clicking a notification deep-links (workspace filter
or StageSheet).

## 7. Motion & polish pass (last session)

Count-up KPIs (once), 250–300ms fade-up on page/tab enter, sheet slide 280ms, chart
draw-in on mount only, skeletons everywhere, `prefers-reduced-motion` kills all of it.
Custom tooltip component on spine/matrix/gantt. Dark scrollbars. Focus rings.

## 8. Demo Readiness checklist (run fully before the team sees it)

1. `npm run seed:demo && npm run dev` on a clean DB → login page in Inter, no serif.
2. Log in as each of the 5 role users; each lands on the right page; management user
   sees zero action buttons anywhere.
3. Dashboard: all KPIs/charts non-empty and consistent (matrix totals = KPI totals);
   red KPI click lands filtered in workspace with chip; back button restores.
4. Workspace: bulk "Apply reason to all overdue" on Units 2–9 succeeds; events appear
   in job Activity; bell shows it; refresh — state persists.
5. QC flow: submit a stage as supervisor → appears in QC queue → Verify → next stage
   unlocks; Reject without reason is impossible; gate-skip attempt via API returns
   a clean 403/409.
6. StageSheet opens from all 6 entry points (spine, matrix, gantt, critical path,
   workspace, palette) and shows correct data for that unit+stage.
7. Gantt renders per unit with target underlays and today line; hold-point clearance
   updates dashboard count without reload (query invalidation).
8. Welding: log a joint + NDT repair → welder's repair rate and flag recompute.
9. Reports: yesterday's digest renders; "Send now" notifies the management user.
10. Kill the API mid-click → error states appear, no white screens; every empty state
    reachable (e.g. a job with no BOM) reads correctly.
11. Grep the rendered UI for `_` enums, table names, "RLS", "despl_web" → zero hits.
12. 13 sidebar/nav destinations: none dead. Anything unfinished has been removed.

## 9. Session order (one per Claude Code / Antigravity session)

1. Tokens + fonts + shell (sidebar, topbar, job switcher, bell, palette skeleton) +
   StatusChip + StageSpine + StageSheet shell.
2. Seed script + SQL views + API routes for jobs/stages/events (§1, §5) — verify with
   curl before any UI wiring.
3. Workspace (grouped cards, bulk reason, QC verification section, URL filters).
4. Dashboard (all cards/charts from `/api/dashboard`), cross-links.
5. Job detail: Overview + Units×Stage + Activity + StageSheet fully wired.
6. Job detail: Gantt + BOM + QCP tabs.
7. QC page + Departments (cards + detail).
8. Welding + Reports/digest + notifications end-to-end.
9. Admin + polish pass (§7) + full Demo Readiness run (§8) — fix everything it finds.

Each session ends with: click-test of everything built, checklist items for that
module, and the hard-ban verification list. Do not advance with a failing check.

## 10. Demo day

- 60-second headline path: Dashboard → click red At-risk KPI → workspace filtered →
  bulk "Apply reason" → ⌘K "hydro" → StageSheet shows the gate logic → bell shows the
  trail. (Visibility → accountability → traceability.)
- Then role-play: supervisor submits, QC verifies live, management login shows the
  read-only view on a phone/second laptop.
- Feedback capture: keep a `FEEDBACK.md` in the repo; during the demo log every
  comment as `[page] [who] [comment]`; afterwards triage into fix-now / next-phase
  and feed fix-now items back through the session loop.

## 11. Stage rollup (36 processes → 25 stages) — CANONICAL

The scheduling/gating spine is **36 processes** (codes 1–36). The UI's **25 work-order
stages** (StageSpine, Units×Stage matrix, job-list mini-spine, report mini-spine) are a
**display rollup** of those processes. This is a many-to-one map, it is already in the
data, and this section is the single definition of how it collapses. Build it once,
reuse everywhere. If any two surfaces disagree on a stage's status, this section is what
they were supposed to implement.

### 11.1 The crosswalk (already seeded — do not invent it)

Every process row carries the stages it belongs to: `JobProcess.workOrderStages Int[]`
(mirrored on `TemplateProcess`, sourced from `seed/lead-time-model.json`). Stage names
come from `workOrderStageNames.names` (1→"Project Kick-Off" … 25→"Dispatch"). Verified
facts about this map:

- All 25 stages are covered by the 36 processes; none is empty.
- 12 stages are backed by **multiple** processes (e.g. stage 5 "Material Procurement"
  ← processes 7,8,9; stage 6 "Incoming Material Inspection" ← 10,11; stage 17 "NDT"
  ← 17,22; stage 25 "Dispatch" ← 35,36).
- 2 processes span **two** stages (process 19 → stages 12,13; process 23 → stages 14,15).
  A process contributes to **every** stage in its array.
- 18 stages map 1:1 to a single process.

A `ProcessPlan` is one row per (process × unit). Rollup is always computed **per unit** —
a stage's status on unit 320SR03 is independent of unit 320SR04.

### 11.2 Stage status precedence (the rule)

Backing status values are the 5 `ProcessPlanStatus` enum values plus two **derived**
overlays computed at read time (never stored):
- `overdue` ≝ `status ≠ COMPLETE AND plannedFinish < now()`
- `rejected` ≝ the plan has ≥1 rejected QC submission in history (from events/audit).

Map each backing `ProcessPlan` to a display state, then collapse the set for one
(unit, stage) with **first match wins**, top to bottom:

| # | Condition over the stage's backing plans | Stage display status | Token |
|---|---|---|---|
| 1 | **All** plans are `COMPLETE` | complete | `--s-complete` |
| 2 | any plan `ON_HOLD` | on hold | `--s-hold` |
| 3 | any plan overdue (derived) | overdue | `--s-overdue` |
| 4 | any plan `SUBMITTED` | submitted (awaiting QC) | `--s-submitted` |
| 5 | any plan `IN_PROGRESS`, **or** some (not all) `COMPLETE` | in progress | `--s-progress` |
| 6 | all plans `NOT_STARTED` | idle | `--s-idle` |

Notes that make this deterministic:
- **Complete is checked first** so a fully-done stage reads green even though nothing is
  "in progress". Every other row requires the stage to be incomplete.
- **Hold outranks overdue outranks submitted** — a stage that is both overdue and on
  hold shows hold, because a hold point is a hard block that needs action first.
- `rejected` is **not** a spine color (there is no rejected token). It surfaces in the
  StageSheet history/reason panel and as a small corner marker on the matrix cell; the
  underlying plan's live status still drives the segment color.
- A single-process stage collapses to exactly that process's state — the rule degenerates
  correctly.

### 11.3 The governing process (for actions)

Stage status is a display concept; **actions are always per-process** (gating,
maker-checker, hold points all live at the 36-process grain). For a clicked stage on a
unit, the **governing process** = the earliest-by-code `ProcessPlan` among the stage's
backing plans that is **not** `COMPLETE` (ties broken by DAG order, then code). If all
are complete, the governing process is the last one (for a read-only "done" view).

- StageSheet's **primary CTA** is the governing process's role-correct action
  (Start / Submit for QC / Verify), routing to `POST /api/stages/:processPlanId/...`.
- Multi-process stages additionally render their backing plans as a small checklist
  (each: process name, status chip, its own action if actionable).
- Gates are unchanged: the CTA is only enabled when that specific process's server-side
  gate allows it. The rollup never relaxes gating (invariants #2/#11).

### 11.4 Derived numbers (avoid double-rollup drift)

- **Stage dates** (for StageSheet target/actual + gantt underlay, per unit):
  `plannedStart = min(plannedStart)`, `plannedFinish = max(plannedFinish)`,
  `actualStart = min(actualStart)` (null if none started),
  `actualFinish = max(actualFinish)` **only if all backing plans complete, else null**.
- **Job / unit % complete and all dashboard KPIs are computed at the 36-process (plan)
  grain, NOT by averaging 25 stages.** The KPI card literally says "N of M plans". Rolling
  up to 25 first and then averaging would disagree with the matrix totals and break
  Demo-Readiness check §8.3. Rule: **status/color rolls up to 25; counts/percentages stay
  at 36.** The 25-stage view is for *where things are*, never for *how much is done*.

### 11.5 One implementation, canonical in SQL

Put the rule in a SQL view so dashboard, job detail, workspace, and reports can never
disagree (matches §5's "aggregations live in SQL views"):

```
-- v_unit_stage_status(job_id, unit_id, stage_no, stage_name, status, governing_plan_id)
-- one row per (unit, stage). `status` implements the §11.2 CASE ladder over the
-- unit's plans whose job_process.work_order_stages @> ARRAY[stage_no].
```

Expose it as `GET /api/jobs/:id/spine` (per-unit stage rows + governing_plan_id) and
consume it from `<StageSpine unit=… />`, the Units×Stage matrix, the job-list
mini-spine, and report mini-spines. If a client-side `rollupToStages(plans)` helper is
ever needed (e.g. optimistic re-color after an action), it MUST implement the exact same
§11.2 ladder and is covered by a table-driven test whose cases include: all-complete,
mixed complete+overdue, hold-beats-overdue, submitted, all-idle, and the multi-process
stages 5/17/25.

### 11.6 Seed-state note (§1 uses stage language)

§1's "Unit 1 through stage 8–9", "blocked at Stage 1", "Unit 7 one on-hold stage" are
**stage-level descriptions of process-level state** — the seed sets `ProcessPlan` rows
(36-grain) such that the §11.2 rollup produces those stage readings. Seed at the process
grain; assert the rollup in the seed's self-check.
