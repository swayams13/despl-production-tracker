# Development Report — Phase 4 Design Handoff Implementation

Session date: 8 Sep 2026. Full session-by-session detail (including exact
file:line references and rationale for every call) lives in `progress.md`'s
"Phase 4 design-handoff implementation" sessions — this document synthesizes
that log into one report, per the build prompt's final-report instruction.

## What this was

`design_handoff_phase4/` (README + DESIGN_SYSTEM + COMPONENT_INVENTORY +
RESPONSIVE_GUIDELINES + ACCESSIBILITY_AUDIT + UX_FINAL_REVIEW, plus mockups
and screenshots) is a Phase 4 design-system hardening pass over Rounds 1–3's
already-approved screens — canonical tokens/components, responsive
behavior, accessibility requirements, and empty/loading/error/toast states.
The brief's build order: repo audit → canonical components → My Day →
Activity Detail → Supervisor Team → Management Dashboard → Project Control
Centre → remaining Round 1–3 screens → this report.

## Step 0 — Repo audit

Before building anything, mapped every design-doc screen to whatever
already exists in this codebase (full table in `progress.md`). Headline
findings that shaped everything after:

- **My Day (Employee) and Supervisor My Day are already one combined,
  role-branching screen** (`my-day/_client.tsx`, 1183 lines) — not two
  screens as the design doc's naming implies.
- **Activity Detail existed only as a tab** (a log view) inside
  `jobs/[id]/_client.tsx` — no standalone unit×stage execution screen with
  a state-driven primary action existed. Real gap, built in Step 3.
- **Supervisor Team had no 1:1 route** — `command/[dept]` and `workspace`
  were the closest partial analogues. Real gap, built in Step 4 as an
  extension to `command/[dept]`.
- **Management Dashboard and Project Control Centre already existed and
  were already substantially built** (`dashboard/page.tsx`, `jobs/[id]`'s
  Overview tab) — hardening, not greenfield.
- **Portfolio/Project/Department Analytics, Schedule Performance, and
  Bottleneck Analysis have no route at all** — confirmed and left
  unbuilt in Step 7, with reasoning (see below).
- The app already has a full, previously-reviewed, previously-AA-audited
  CSS design system (`.theme-industrial` in `globals.css`) whose hex values
  match `DESIGN_SYSTEM.md`'s token table byte-for-byte. This was the single
  biggest finding shaping Step 1.

## Step 1 — Canonical components: reused vs. built new

**Deviation from the build prompt, made deliberately**: the prompt's own
step 0 suggested `npx shadcn add <component>` for primitives, since
`components.json` is configured but `src/components/ui/` is empty. Once the
existing `.theme-industrial` CSS system was found (see above), pulling in
shadcn's Tailwind/oklch-based primitives would have introduced a *second*,
competing token system that needed to be forced to match the first, instead
of just reusing it. Built typed React wrappers around the existing classes
instead. `src/components/ui/` is untouched (not deleted) — still a
legitimate choice for a genuinely new primitive with no existing
convention, just not what any component built this session needed.

| Design-doc component | Reused as-is | Built new (`src/components/industrial/`) |
|---|---|---|
| Button | — | `button.tsx` (wraps `.btn`/`.btn-accent`/`.btn-ghost`/`.btn-outline-accent`; added `.btn-destructive`, the one genuinely new variant) |
| StatusBadge | `StatusChip`/`HealthChip` | — |
| DataTable | `ResponsiveTable` (extended, not replaced — see below) | `data-table.tsx`: `SortableTh`, `toggleSort`, `RowExpandButton`, `clickableRowProps` |
| MetricCard | — | `metric-card.tsx` (wraps `.kpi` — **not** `components/viz/kpi-tile.tsx`'s `KpiTile`, which uses a different, legacy token set and would render wrong colors on a dark industrial page) |
| PageHeader | — | `page-header.tsx` (wraps the `.page-h` markup already repeated verbatim across 6+ pages) |
| FilterBar | — | `filter-bar.tsx` (`FilterBar` + `Dropdown`, the latter generalizing `my-day/_project-filter.tsx`'s `ProjectFilter`) |
| Modal | — | `modal.tsx` (`Modal` + `ModalConfirmFooter`, extracted from the `.admin-dialog` pattern already duplicated across 5 admin `_client.tsx` files) |
| Tabs | — | `tabs.tsx` (wraps `.tabs`/`.tab`, real `next/link` `<Link>`s) |
| Drawer | `StageSheet`/`StageSheetLauncher` | — |
| Toast | `sonner` (already installed, used everywhere) | — |
| Nav | `AppShell` | — |

`data-table.tsx` deliberately does **not** attempt a column-config/grid
abstraction — `ResponsiveTable`'s own docstring already explains why one
doesn't exist here (heterogeneous, stateful rows across the app fight a
generic renderer more than they're helped by one). It adds only the two
real gaps: a sortable header and a Detail-tier row-expansion toggle.

## Steps 2–6 — screen by screen

**My Day** (Step 2): already responsive and toast-wired. Real gaps closed:
no `loading.tsx` existed for this route (added one); all 10 of its
clickable row/card variants (plus the shared `QueueCard`) were
`<tr>`/`<div>` with `onClick` and no keyboard path — fixed via the new
`clickableRowProps()` helper, which also caught and fixed a real
keydown-bubbling double-fire bug against nested action buttons before it
shipped.

**Activity Detail** (Step 3): built as a genuinely new page —
`jobs/[id]/activity/[unitId]/[stageNo]/` — reusing `loadStageDetail`
directly (no new API route) and the same state→primary-action mapping
already proven elsewhere. Chose a real page over extending the `StageSheet`
drawer because RESPONSIVE_GUIDELINES.md wants content + right rail
side-by-side on desktop, which a 460px overlay drawer structurally can't
do. Added Hold and Reassign — both new capability, not previously wired
anywhere in a stage-detail context. Two small additive fields
(`deptId`, `submittedBy`) added to `stage-detail.read.ts`'s existing return
type to support this, no new query. New CSS deliberately named `actd-*`,
not `ad-*` — `globals.css`'s own pre-existing comment documents that
ad-blocker filter lists hide `.ad-*` classes.

**Supervisor Team** (Step 4): no route existed; built as a "Team" roster
section on `command/[dept]` rather than a new standalone page (the design
doc's own note treats Round 1's `03`/Round 2's `05` as "the same screen,
project-scoped variant"). `command-center.read.ts` already builds every
ranked plan for a department to feed its other sections — added
`TeamMemberRow[]` grouped from that *same* array by assignee, no second
heavy computation. TDD'd (`command-center.read.test.ts`, 13/13). Reassign
uses a real 2-step `Modal` flow (pick owner → confirm "X → Y").

**Management Dashboard** (Step 5): found already mature (real `<Link>`s
everywhere, an accessible `sr-only` table fallback for the S-curve chart,
matrix zero-cells already printed per the hard ban). Swapped the 5 KPI
tiles onto `<MetricCard>` (the component's flagship named use case) and
gave the portfolio "worst first" table a real tablet card fallback
(`ResponsiveTable`) instead of relying on horizontal scroll on a
12-column table — the exact pattern COMPONENT_INVENTORY.md calls out as
the rare exception, not the default.

**Project Control Centre** (Step 6): checked the actual mockup HTML rather
than guess — its real second panel is "Exceptions", not an activity log
(independently confirmed by UX_FINAL_REVIEW.md's own screen review).
Replaced a duplicate 5-row Activity preview with a real `ExceptionsCard`,
computed entirely from already-loaded `unitSpines` data (no new query).
The mockup's other two panels ("Departments on this project", "Upcoming
milestones") have no existing data to reuse and were **not** built —
logged as a scope decision, not discovered as a gap after the fact.

## Step 7 — remaining screens

Every screen in this step's list that already exists as a route
(Department Overview, QC & Hold Points, Welding/Production, Reports) got
the same treatment: `loading.tsx` added where missing (all 5 routes
touched had none), `clickableRowProps()` applied everywhere a div/tr had an
`onClick` with no keyboard path, `<PageHeader>` swapped in where it
cleanly fit.

**Explicitly not built**: Portfolio/Project/Department Analytics, Schedule
Performance, Bottleneck Analysis (no route exists — building all five would
each match Activity Detail/Supervisor Team's scope, well beyond what one
session had budget for after 6 build steps already landed real work) and a
standalone QC Detail page (stays folded into the QC queue rows + `StageSheet`
drawer, matching Activity Detail's pre-Step-3 state).

## The CLAUDE.md pointer update

`CLAUDE.md`'s "Frontend & Design System" section now points at
`design_handoff_phase4/` instead of the stale `design/despl-tracker-
mockup.html` + `docs/DESIGN_SPEC.md` §9 build order (both predate this
handoff, neither deleted). The "Workflow for the agent" subsection's session
order now points at `progress.md`'s logged build order instead of
`DESIGN_SPEC.md` §9. Every other invariant/convention in `CLAUDE.md` is
unchanged — this was a pointer correction, not a rewrite.

## Ambiguities resolved (and how)

- **shadcn vs. hand-wrapped components** (Step 1): resolved in favor of
  wrapping the existing, already-correct CSS system — see above.
- **Activity Detail: drawer vs. real page** (Step 3): resolved in favor of
  a real page, because the responsive spec literally can't be done in a
  drawer.
- **Supervisor Team: new route vs. extend `command/[dept]`** (Step 4):
  resolved in favor of extending, per the design doc's own "same screen,
  project-scoped variant" framing.
- **Project Control Centre: guess at scope vs. check the mockup** (Step 6):
  resolved by grepping the actual `.dc.html` mockup file directly rather
  than inferring from the current (drifted) implementation.
- **Analytics screens: build shallow versions of all five vs. build none**
  (Step 7): resolved in favor of building none and documenting why, per
  "a smaller number of fully working modules beats a larger number of
  half-working ones."

## Deviations from the design spec (all logged live, not just here)

1. Canonical components wrap the existing CSS system instead of shadcn
   primitives (Step 1).
2. `.grid-2`'s existing 1100px reflow breakpoint was reused for Activity
   Detail's layout instead of introducing RESPONSIVE_GUIDELINES.md's
   literal 1439px laptop breakpoint (Step 3) — matches an established
   codebase convention rather than adding a second, slightly different one.
3. My Day's and Dashboard's KPI strips reflow to fewer columns rather than
   becoming a literal horizontal-scroll strip at tablet width (Steps 2, 5)
   — both satisfy "reflow, don't shrink"; the existing mechanism works and
   wasn't reworked for parity alone.
4. Five analytics screens and a standalone QC Detail page were not built
   (Steps 6–7) — see above.

## Remaining gaps / TODOs for the next session

- **Browser verification**: nothing in this session was verified in a real
  browser or against `design_handoff_phase4/screenshots/` — the Chrome
  extension was not connected in this environment. Every change here is
  verified by `pnpm typecheck`/`lint`/`test`/`test:db` (full suite,
  1053-1054/1054 passing every run, only the long-documented pre-existing
  `process.service.test.ts` hold-point flake) and code review, not by
  rendering the page. This is the single biggest open item — a session
  with working browser automation should drive the real `/login` form
  (never forge a session — see `CLAUDE.md`'s agent-conduct section) and
  screenshot-compare every screen touched against its reference PNG.
- **Five analytics screens** (Portfolio/Project/Department Analytics,
  Schedule Performance, Bottleneck Analysis) — no route exists; each is
  realistically its own multi-session build (new service reads, new
  routes, new tests), not a hardening pass.
- **Standalone QC Detail page** — same call as Activity Detail before Step
  3, not upgraded this session.
- **Activity Log → Activity Detail linking**: the Activity Log tab's rows
  (`jobs/[id]`'s `ActivityRow`) still don't link into the new Activity
  Detail page — `ActivityEvent` (`events.read.ts`) has no `unitId`/`stageNo`
  today, and a `JobProcess` can map to more than one work-order stage, so
  "which stage does this log line belong to" isn't unambiguous without a
  real service change (logged, not guessed at, in Step 3).
- **Project Control Centre's other two mockup panels** ("Departments on
  this project", "Upcoming milestones") — no existing data to reuse.
- Two parallel status-color vocabularies still exist
  (`components/industrial/stage-status.ts` vs `components/viz/status.ts`) —
  flagged in Step 1, not consolidated (out of scope).
- `my-day/_project-filter.tsx`'s `ProjectFilter` was not migrated onto the
  new `Dropdown` primitive it was generalized from — flagged in Step 1 as
  a candidate for a future session, left working and untouched.

## How to run / view

```bash
pnpm install
pnpm db:seed        # roles, departments, PV template, demo data
pnpm dev            # http://localhost:3000
```

Screens touched this session, by route:
`/my-day` · `/jobs/[id]/activity/[unitId]/[stageNo]` (new) ·
`/command/[dept]` · `/dashboard` · `/jobs/[id]` (Overview tab) ·
`/departments` · `/departments/[id]` · `/qc` · `/welding` · `/reports`.

Verification commands, all green as of the last commit this session:

```bash
pnpm typecheck && pnpm lint && pnpm test   # 629/629 pure tests
pnpm test:db                                # 1053/1054 — one pre-existing,
                                             # documented, unrelated flake
```
