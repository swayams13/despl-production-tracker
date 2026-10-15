# Lean Core v1 — Build Prompt for Claude Code

> **11 Oct 2026:** phase order, gates, decisions D14–D27 and Phase M (master data) now live in `docs/lean-core/PHASE-PLAN-v1.md`. This file still specifies every L and J session; read both.

**Project:** DESPL Production Tracker (this repo) · **Written:** 6 Oct 2026 · **Supersedes:** the phase *order* in `docs/archive/mos-execution/PROMPTS-v4.md` and Phases 2–10 of `audit/20_REMEDIATION_ROADMAP.md` wherever they conflict with this file. Everything else in `CLAUDE.md` still binds unless §2 below revises it.

---

## How to use this file

Paste this into Claude Code at the repo root to start:

> Read `CLAUDE.md` and `docs/lean-core/BUILD-PROMPT-lean-core-v1.md` in full. We are executing **Lean Core v1**, which supersedes the PROMPTS-v4 sequence (archived: `docs/archive/mos-execution/PROMPTS-v4.md`). Do session **L0.4** first (amend `CLAUDE.md`). Before writing any code in any session, show me: the files you will touch, any migration, and the tests you will add — then wait for my go.

For every later session, use this template:

> Lean Core session **L<x.y>**. Re-read `CLAUDE.md` and §<n> of `docs/lean-core/BUILD-PROMPT-lean-core-v1.md`. Plan first (files, migration, tests) and wait for my go. Then implement on branch `lean/L<x.y>-<slug>`, run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`, open a PR, and add **at most 15 lines** to `progress.md`.

Model use: Opus for L0.4, L1.1 and L1.2 (rules and schema). Sonnet for everything else.

---

## 1. Why this plan exists (read once)

After 8 weeks and 576 commits, **no DESPL department updates the tracker daily**. Production holds 8 accounts, 3 jobs and 10 units; the cutover feedback log is empty. The engine is good. The product is too hard to update:

- **One real event is recorded at up to four levels**, each with its own Start → Submit → QC verify. Example: finishing Shell Welding (process 16) on unit 320SR01 needs 7 assembly steps + 1 component operation + the process plan itself = **27 clicks and 9 QC sign-offs**. Process plans do not roll up from their steps; `assertComponentOpsComplete` refuses them until everything below is verified, and then they need their own verify.
- Per unit: 36 process plans + 54 component operations + 54 assembly steps = 144 records × 3 clicks ≈ 430 clicks. **DESPL-320 (9 units) ≈ 3,900 clicks.** DESPL's Excel today: one row per BOM item.
- **Office processes are tracked per unit** (PO review × 9, design calculation × 9 — 324 plan rows on DESPL-320).
- **Rules punish late updates**: actual time = click time, and an overdue stage without a reason blocks all further progress on that unit. That pushes people back to Excel.
- **QC verifies every click**, not just the QCP's checkpoints, so QC becomes the bottleneck.
- Screen sprawl (see `audit/03_INFORMATION_ARCHITECTURE.md`): three screens answer "what is my department doing", the QC queue appears on four screens with four counts, nav depends on screen width rather than role, there is no operator role.

**Goal of Lean Core v1:** a pilot (Planning/PPC + Fabrication + QC) running on one live job within ~3 weeks if that job is DESPL-320, or ~5 weeks if the live job needs Phase J (any job, any equipment) first, with ≥ 90% of events entered the same day for 5 straight working days. Target ≈ 1,000 single taps for a 9-unit job instead of ≈ 3,900, fewer with batching.

**Design rule for every change below: each relaxation is DATA, defaulting to today's behaviour, and is switched on only by a recorded decision (§3).** That keeps every change reversible and keeps management's original requirements intact until they choose otherwise.

---

## 2. Rule changes (these revise `CLAUDE.md` invariants)

| # | Today (`CLAUDE.md`) | Lean Core v1 |
|---|---|---|
| 1 | No client timestamps; actual = server click time | Server still stamps `recordedAt` on every write. The client MAY send `reportedAt` for Start/Done: default now, never in the future, never before the job's order date, at most `BACKDATE_WINDOW_HOURS` (default 72, decision D4) in the past. Older corrections go through the existing admin correction flow with a reason. KPIs and schedule variance use `COALESCE(reportedAt, recordedAt)`; the audit log stores both. |
| 2 | Hard sequential gating on every edge | New column `enforcement` (`HARD` \| `SOFT`) on `TemplateEdge` and `JobProcessEdge`, **default `HARD`** (no behaviour change). A SOFT edge allows the write with an `override {category, note}`, appends a `SequenceOverride` row, and flags the item "Out of sequence" for the Production Head. Always HARD regardless of data: (a) an open blocking H hold point blocks completion of its stage; (b) Surface Preparation (29) and Painting (30) cannot start before Hydrostatic Test (27) is complete; (c) dispatch release/record refuses an open NCR, an open hold point, or incomplete production (existing AUD-005 assertions). Which other edges become SOFT = decision D2. |
| 3 | Maker–checker on every verify (process plans, component ops, assembly steps) | New `requiresQc` boolean on `OperationRef`, `AssemblyTemplateStep` and `TemplateProcess`, **default `true`** (no behaviour change). When `false`, the item goes straight to COMPLETE on Done (no SUBMITTED, no verify) and is audited. Items with `requiresQc = true` keep the full maker–checker rule: QC role AND the QC user ≠ the user who recorded the work. Decision D3 sets WORK steps and routine operations to `false`; INSPECTION steps, QCP W/H items, Hydro test and Final inspection stay `true`. |
| 4 | Process plan has its own start/submit/verify state machine | For a UNIT-grain process with mapped items (via the existing `loadMappedOps` join), the process plan becomes **derived**: `rollupProcessPlan(tx, jobProcessId, unitId)` runs in the same transaction after every item write. Status: NOT_STARTED → IN_PROGRESS (any item started or done) → COMPLETE (all mapped items COMPLETE and no open blocking hold point). `actualStart` = earliest item start, `actualFinish` = latest item done. Direct start/submit/verify on a derived plan is refused with new code `DERIVED_STATUS` ("This stage completes automatically when its steps are done"). Processes with no mapped items (office work) stay directly updatable: Start (optional) → Done, plus QC only if `requiresQc`. |
| 5 | All 36 processes planned per unit | New `grain` (`JOB` \| `UNIT`) on `TemplateProcess` and `JobProcess`, default `UNIT`. Seed sets processes 1–11 and 33 (MDR) to `JOB` (confirm in D5 review). Schedule generation creates ONE `ProcessPlan` with `unitId = NULL` for JOB-grain processes. Unit spines and stage views treat a JOB-grain plan's status as applying to every unit. |
| 7 | Overdue stage without a reason blocks all further progress on that unit | **Never block other writes.** Marking a late item Done requires a reason in the same action (`LATE_REASON_REQUIRED`, categories in the payload so the UI shows a picker). Overdue items without a reason: reminder to assignee at 10:00 IST via the existing alerts cron, escalation to Production Head after 24 h. Remove `assertNoUnfiledDelayBlock` from write paths. |
| 12 | Stable error codes | Unchanged. New codes: `DERIVED_STATUS`, `SEQUENCE_OVERRIDE_REQUIRED`, `LATE_REASON_REQUIRED`, `REPORTED_AT_OUT_OF_WINDOW`, `FEATURE_FROZEN`. Each needs a plain-English message in `src/lib/shared/errors.ts` that says what is missing and who can clear it. |

Invariants 3 (in its narrowed form), 4, 5, 6, 8, 9, 10, 11, the credential-forging ban and the frontend hard bans are **unchanged**.

---

## 3. Decisions (record in `CLAUDE.md` → "Lean Core decisions" table as they arrive)

| ID | Decision | Default until decided |
|---|---|---|
| D1 | Working days or calendar days for the schedule | Current PROVISIONAL `CALENDAR_DAYS_6DAY_WEEK` |
| D2 | Which department-handoff edges become SOFT | All HARD (today's behaviour) |
| D3 | QC scope: which items get `requiresQc = false` | All `true` (today's behaviour) |
| D4 | Backdating window | 72 hours |
| D5 | Pilot job + departments; confirm JOB-grain process list | Planning/PPC, Fabrication, QC; processes 1–11 and 33 |
| D6 | Devices (bay tablets / personal phones) and floor Wi-Fi | Design for both |
| D7 | Named department representatives; welder list | Placeholder accounts |
| D8 | On-prem server spec, admin, target month | Stay on Railway |

**Do not start L1.2 until D2, D3 and D4 are recorded.** Build the switches regardless; just leave the defaults.

---

## 4. Freeze list (keep the code, hide it, no new work)

Add `src/lib/shared/flags.ts`:

```ts
export const FEATURES = {
  clientPortal: false,       // /portal, ProgressSnapshot publish/verify UI
  multiFamilyIntake: false,  // only PRESSURE_VESSEL selectable in /jobs/new
  cpmReplanUi: false,        // feasibility / replan / duration-override screens
  analytics: false,          // the five unbuilt analytics screens stay unbuilt
  agents: false,             // planner agent / MOS layer
} as const;
```

When a flag is off: remove its nav entries, make its routes call `notFound()`, and make its server actions refuse with `FEATURE_FROZEN`. Do **not** delete code, migrations, RLS policies or tests. Do **not** add new tenancy work; keep existing RLS tests passing.

---

## 5. Sessions

Each session = one branch, one PR, CI green, ≤15 lines in `progress.md`. Acceptance checks are mandatory; "done" means demonstrated, not written.

### Phase 0 — Unblock (Week 0)

**L0.1 — Production migration window (Swayam runs it; the agent only prepares).** Apply the 5 queued migrations per `docs/mos-execution/MERGE-RUNBOOK.md` (already rehearsed on 5 Oct; re-dump and re-rehearse if more than a few days have passed). Needs a network that allows outbound TCP 51870 (phone hotspot works). Accept: `/api/health` returns 200; `_prisma_migrations` 71 applied / 0 failed.

**L0.2 — Stop shipping code ahead of schema (AUD-024).** In the Railway dashboard (Railway ignores `railway.json`): Pre-Deploy Command `pnpm prisma migrate deploy`, Healthcheck Path `/api/health`. The agent updates `CLAUDE.md`'s stack section to match, and stops there; Swayam clicks. Accept: a no-op deploy shows the pre-deploy step running in Railway logs.

**L0.3 — Staging environment.** Railway `staging` environment with its own Postgres, deploying from a `staging` branch, seeded with `pnpm db:seed`. Accept: staging URL serves `/login`; health 200.

**L0.4 — Repo and docs reset.**
- Amend `CLAUDE.md`: new top section "Active plan: Lean Core v1 (6 Oct 2026)" pointing here; apply §2 as dated revisions to the invariants (keep the old wording struck through or quoted, with the date); add the §3 decisions table and the §4 freeze list.
- Move superseded planning docs into `docs/archive/` (mos-blueprint, mos-execution prompts, PHASE-PROMPTS, SPEC/PLAN files already implemented). Keep: `CLAUDE.md`, `README.md`, `progress.md`, `docs/BUILD-SPEC-v2.md`, the ADRs, `docs/mos-execution/MERGE-RUNBOOK.md`, `docs/USER-GUIDE-WHY-WAS-I-REFUSED.md`, `audit/`, this file.
- Split `progress.md`: move everything before 1 Oct 2026 into `docs/archive/progress-aug-sep-2026.md`.
- Stale `.claude/worktrees/agent-*` directories break unscoped `pnpm test`/`lint`. **Ask Swayam for delete permission** before removing them; prune local branches already merged into `main`.
- Accept: `pnpm test` and `pnpm lint` run clean from the repo root with no path filters.

### Phase 1 — Rules and data (Weeks 1–2)

**L1.1 — Additive migration (one migration, no data loss).**
- `TemplateProcess.grain`, `JobProcess.grain` (`ProcessGrain` enum JOB/UNIT, default UNIT)
- `TemplateEdge.enforcement`, `JobProcessEdge.enforcement` (`EdgeEnforcement` HARD/SOFT, default HARD)
- `requiresQc Boolean @default(true)` on `OperationRef`, `AssemblyTemplateStep`, `TemplateProcess`, copied onto job-level rows where the codebase copies template data at intake
- `reportedStartAt`, `reportedFinishAt` (nullable) on `ProcessPlan`, `ComponentOperation`, `AssemblyStep`
- New append-only table `SequenceOverride` (id, tenantId, jobId, target kind + id, edge id, category, note, createdBy, createdAt), RLS like its siblings, no UPDATE/DELETE grant
- `Unit.publicId` (unique, opaque, backfilled) for QR URLs
- `User.locale` (`en` \| `hi` \| `gu`, default `en`)
- Roles: add `OPERATOR` and `PLANNER` to `src/lib/authz/index.ts` and the seed
- Accept: migration replays from scratch; `migrate diff` clean; RLS coverage test extended to `sequence_overrides`; all existing tests still green (behaviour unchanged because every default preserves it).

**L1.2 — One write path: `recordWork`.** New `src/lib/services/work.service.ts`:

```ts
recordWork(actor, {
  items: Array<{ kind: 'COMPONENT_OP' | 'ASSEMBLY_STEP' | 'PROCESS_PLAN'; id: number }>,
  action: 'START' | 'DONE',
  reportedAt?: string,                               // ISO; validated per §2 row 1
  override?: { category: string; note?: string },    // for SOFT edges
  lateReason?: { categoryId: number; note?: string },
}) => { applied: ItemResult[]; refused: Array<{ id: number; code: string; message: string; meta?: unknown }> }
```

- One transaction. Pre-validate every item with the existing gate functions (hold points, HARD edges, kit-ready, drawing-released, the time window); apply the items that pass; return the rest in `refused`. Batch = partial success with a precise report.
- DONE on an item with `requiresQc = false` → COMPLETE. With `requiresQc = true` → SUBMITTED for QC.
- After the writes, call `rollupProcessPlan` for every affected (jobProcessId, unitId), in the same transaction.
- One audit row per item (before/after JSON), as today. Notifications as today (submit → QC).
- Keep the old `start*/submit*/verify*` service functions for QC paths and office processes; route the floor UI through `recordWork` only.
- New `inspect(actor, { targetId, kind, result: 'ACCEPT' | 'REJECT', reason? })` wraps the existing verify/reject + QCP execution logic for QC.
- Tests (table-driven, violation cases first): time window (future, too old, before order date); each HARD gate; SOFT edge with and without override; late DONE with and without reason; `requiresQc` true vs false; rollup across every status combination including an open H point; JOB-grain plan; batch with mixed passes and refusals; maker–checker on `inspect`; derived plan refuses direct start/verify.

**L1.3 — Scheduling and backfill.**
- `schedule.service.ts`: JOB-grain processes produce one plan with `unitId = NULL`. Spine and stage reads (`spine.read.ts`, `stage-detail.read.ts`, the `v_unit_stage_status` view) project a JOB-grain plan onto every unit.
- Script `scripts/lean-backfill-job-grain.ts`: for existing jobs, collapse per-unit plans of JOB-grain processes into one (keep earliest actual start and latest actual finish, write an audit row per collapse). Idempotent, `--dry-run` default, rehearse on a restored dump before production.
- Seed: set `grain` and `requiresQc` per the decisions in §3 (only once recorded).
- Accept: DESPL-320 regenerates with ≤ 12 office plans instead of 108; rehearsal log attached to the PR.

**L1.4 — Delay reasons without blocking.** Remove `assertNoUnfiledDelayBlock` from write paths; add `LATE_REASON_REQUIRED` handling in `recordWork`; extend `/api/cron/alerts` with the 10:00 IST reminder and 24 h escalation. Accept: tests prove an unfiled overdue item no longer blocks an unrelated item on the same unit.

### Phase J — Any job, any equipment (Weeks 2–4, runs after L1)

DESPL-320 is the first job, not the product. Every order differs in equipment type, quantity and client requirements while the process stays the same. The template machinery (families, versioned process routes, component routes, QCP library, intake wizard) already exists; what is still DESPL-320-shaped is the family-wide assembly template with DESPL-320's seams written in, quantity-blind durations, one family per job, and floor steps generated at job creation instead of at BOM release. Pilot on whichever job is actually on the floor; **if that is not DESPL-320, J1–J5 must land before the pilot.** Standing acceptance test (extends `docs/ADR-product-family-agnostic-platform-v1.md`): *one PO for four three-course horizontal vessels on saddles with 8 nozzles each, plus one U-tube heat exchanger, is created with no code change, and its floor steps come from its own BOM and weld map.*

Rule for all J sessions: configuration may decide what gets **materialised**, but scheduling and gating read only materialised rows, never configuration JSON (keeps invariant 12 and the `Job.specs` rule intact). Every inclusion or exclusion stores its reason.

**J1 — Equipment type is the template anchor.** Add nullable `equipmentTypeId` to `AssemblyTemplate` (family-level template remains the fallback). New `EquipmentTypeComponent` (equipmentTypeId, componentTypeId, defaultQty, qtySource: `FIXED` | `NOZZLE_SCHEDULE` | `ANSWER:<key>`). Seed the pressure-vessel types DESPL confirms (proposal: vertical on skirt, vertical on legs, horizontal on saddles) and move DESPL-320's assembly template onto "vertical on skirt". Accept: DESPL-320 regenerates identically from its equipment type.

**J2 — Questions and rules as data.** New `ConfigQuestion` (scope: family or equipment type; key, label, type, options, default, help). Answers stored per equipment line in `Equipment.config` (JSON). Replace the hard-coded `SPEC_FIELDS` in `src/lib/shared/specs.ts` with this table (retires the ADR's B11 exception). Add optional `includeWhen` (small JSON rule: `{all|any: [{key, op: eq|neq|in|truthy, value}]}`, no code evaluation) on `TemplateProcess`, `RouteStep`, `AssemblyTemplateStep` and `QcpItem`. Evaluate once at configure time; write `included` + `inclusionReason` (rule id and the answer that triggered it) onto the materialised rows. Tests: table-driven rule evaluation, including missing answers (default = include, flagged).

**J3 — Route per equipment line.** Add `templateVersionId` (and `assemblyTemplateVersionId`) to `Equipment`; add nullable `equipmentId` to `JobProcess`, `ProcessPlan` and `ScheduleRun` scoping. Order-level (JOB-grain) processes keep `equipmentId = NULL`; line-level processes carry their line. Keep `Job.familyId`/`templateVersionId` as the default for single-line jobs; backfill existing jobs to their single equipment. Spine, board and stage reads group by line. Accept: one job with a vessel line and an exchanger line schedules both, each on its own route.

**J4 — Generators and the weld map.** `AssemblyTemplateStep.scope`: `PER_UNIT` | `PER_JOINT` (with `jointType`: LONG_SEAM, CIRC_SEAM, NOZZLE, ATTACHMENT) | `PER_COMPONENT` (with component type). New `PlannedJoint` per equipment line (jointNo, jointType, components joined, WPS ref, NDT extent, source: `IMPORTED` | `GENERATED`, confirmed flag). Importer from the weld-map Excel; generator from answers (shell courses n → LS-1..n, CS-1..n+1; nozzle schedule → N1..Nk). Materialisation expands scoped steps per joint; existing `WeldJoint` (actual welding records) links to its `PlannedJoint`. DESPL-320's LS-1, CS-1, CS-2 move from template text into DESPL-320's planned joints.

**J5 — Floor steps are generated at BOM release.** `createJob` creates the job, lines, units and process plan only. A new `releaseBomRevision(actor, { equipmentId, bomRevisionId })` (Engineering/Planner role) materialises components (from BOM lines mapped to component types + the equipment-type kit), component operations (from component routes, filtered by rules), assembly steps (from scoped steps × planned joints × units) and QCP links. A later revision computes a diff: rows for steps not yet started are added/removed/updated; started steps are flagged (`needsReview`) for the planner with Keep / Replace / Cancel. All in one transaction with audit rows. Accept: releasing a revision twice is idempotent; a revision that removes a started step never deletes it.

**J6 — Lots and quantity-aware durations.** `Equipment.trackingMode`: `SERIAL` | `LOT` | `LOT_THEN_SERIAL` (with the process code where serial tracking begins). LOT lines create no per-piece units; steps carry `qtyPlanned/qtyDone` (add to `ProcessPlan` and `AssemblyStep`; `ComponentOperation` already has them) and `recordWork` accepts a quantity. Rollup by quantity. Durations: `TemplateProcess.qtyBands` (JSON: `[{maxQty, multiplier}]`, default none = today's behaviour); the schedule multiplies base duration by the band for the line's quantity.

**J7 — New-job flow.** "Copy a previous job" (copies lines, answers, BOM, weld map and QCP as a draft) plus the intake redesign: Order → Equipment lines → Configure (live preview of included/excluded processes with reasons, expected weld steps, QCP) → QCP edits per client → Schedule preview with feasibility → Release. Jobs have a `DRAFT` status until released. Build to the Claude Design artifacts 13A–13F, 14A–14C.

**J8 — Heat-exchanger content and milestones.** Author the HEAT_EXCHANGER family as data once DESPL supplies its exchanger lead-time sheet, one or two past QAPs, a past BOM with GA drawing, and the TEMA types it builds: process route (with shell-side and tube-side hydro), stage list, component types (tubesheet, tube, baffle, tie rod, channel, bonnet, floating head, expansion joint), operations (drilling, bundle assembly, expansion, tube-to-tubesheet welding, leak test, bundle insertion), routes, equipment types per TEMA type, standard QCP. Until then it stays provisional (dates "not scheduled", as for pipe spool). Add a company-wide `Milestone` list (about 10) with a mapping from every family's processes, used by Portfolio, the digest and client updates; progress % weighted by planned effort.

### Phase 2 — Screens (Weeks 3–5), built from the Claude Design output

Treat the designs placed in `design/lean-core/` as the pixel reference (recreate them in this codebase's components and data layer; do not port HTML). Until they arrive, build to the specs below. Every screen ships with: loading skeleton matching the layout, empty state (one sentence + one action), error state with retry, refusal state that names what is missing and who can clear it, keyboard path, 44 px touch targets and ≥ 12 px text on coarse pointers, ≥ 11 px text everywhere. Apply the token fixes first (L2.0).

**L2.0 — Tokens and type floor.** In `src/app/globals.css`: `--border` #262A30 → #3A4048; `--s-idle` #4A4F57 → #5C6068; chip tint 12% → 6%; no text below 11 px (12 px under `pointer: coarse`); replace the 69 inline `fontSize:` literals with utility classes; spine/matrix hit areas 44 px via `::before` insets (see `audit/18_DESIGN_SYSTEM.md` §3). Default palette: `theme-outdoor` (light high-contrast) on coarse pointers; dark on desktop; user preference still wins.

**L2.1 — Navigation by role.** One `NAV_ITEMS` registry with `roles[]`, rendered into sidebar, rail and bottom bar (fixes AUD-011/012). Landing: OPERATOR → `/today`; SUPERVISOR → `/today`; QC → `/qc`; PLANNER → `/jobs`; PRODUCTION_HEAD → `/team`; MANAGEMENT → `/dashboard`. Delete `/board` and `/profile` stubs; `/workspace` → redirect `/team`; `/my-day` → redirect `/today`.

**L2.2 — Floor screen `/u/[unitPublicId]` (QR target).** Unit header (job, serial, current stage on the Stage Spine). "Next steps" = the next 3–5 actionable items for the viewer's department, grouped by component in floor language ("Shell · Long seam LS-1 · Weld"). One big Done per item; optional Start. "Also for SR02–SR09" toggle opens a unit picker for batch. Late → reason sheet inline. Refused items show the plain reason and a "Notify <role>" button. Undo for 10 s instead of confirm dialogs.

**L2.3 — Today `/today`.** Mine only (`assigneeUserId = actor`, plus unassigned items in my department for OPERATOR only via one "Claim next" button). Sections: one summary line · Do this first · Today · Blocked ("Waiting on: …", already computed in `prioritizer.ts`) · Upcoming (collapsed) · My progress (collapsed, bottom). Max ~7 visible items before "Show all". After 16:00 IST show the end-of-shift check-in: today's planned items as a list → Done / Not done + reason, submitted in one batch through `recordWork`.

**L2.4 — Job board `/jobs/[id]/board`.** Units × 25 work-order stages matrix with the value printed in every cell; tap a cell → `StageSheet` with the item checklist, planned date, reported vs recorded time, who, QC result, overrides, and the role-correct action. Filter chips (department, status, out-of-sequence). "Export to Excel" in the layout of `docs/DESPL-320 Production Tracker.xlsx` → "Units × Process Tracker" sheet.

**L2.5 — Team `/team/[dept]`.** Promote `/command/[dept]` per `audit/05_SUPERVISOR_TEAM_AUDIT.md` §8: department KPIs, workload by person (the centrepiece), unassigned pool with multi-select assign, overdue & blocked, "You're blocking / Waiting on others", per-process bulk actions absorbed from `/workspace`, and **same-day update rate** for the department.

**L2.6 — QC queue `/qc`.** Role-gated (QC and above). Tabs: Ready to inspect · Open holds · NCRs. Grouped job → unit, paginated 25, oldest first. Accept / Reject with reason via `inspect`. Remove QC lists from My Day, Workspace and Dashboard; elsewhere show a count that links here.

**L2.7 — Portfolio `/dashboard`.** Per `audit/06_DASHBOARD_AUDIT.md` §11: 5 linked KPI tiles (Active · Delayed · At risk · On hold · Actions due), project health table (6 columns, worst first), department bottleneck bars (blocked / overdue / rejected, each linking with `job=` preserved), needs-attention queue (top 15). Remove the sunburst, project-detail band, stat strip, dept × status matrix, inline S-curve. Add one line: "N of M jobs forecast past committed date".

**L2.8 — Job overview tabs.** Overview · Board · Schedule · Materials · QC · Dispatch · History (per `audit/07_PROJECT_AUDIT.md` §3, minus frozen items). Materials = BOM lines with indent → PO → received → identified → issued as pipeline chips.

**L2.9 — QR travellers.** `/jobs/[id]/travellers` print view (print CSS, A5 portrait, one per unit): job, client, serial, QR to `/u/[publicId]` (server-side SVG via the `qrcode` package), short URL text fallback. Accept: printed QR opens the Floor screen on an Android phone on shop Wi-Fi.

**L2.10 — Excel in and out.** Import of in-flight jobs and BOMs in DESPL's existing sheet format (DE0463/DE0467 structure, see `seed/live-jobs.json` and `seed/data-issues.json`) using the existing `xlsx` dependency: upload → dry-run preview → data-issues list → confirm. Board export per L2.4.

**L2.11 — Morning digest by email.** The digest payload is already email-ready JSON. Add SMTP delivery (`nodemailer`, env `SMTP_*`) at 08:30 IST to MANAGEMENT and PRODUCTION_HEAD; include: jobs at risk, overdue by department with top reasons, out-of-sequence overrides from yesterday, same-day update rate per department.

**L2.12 — Floor language.** Minimal dictionary `src/lib/i18n/{en,hi,gu}.ts` used only by the Floor screen and Today; `User.locale` selects it. Ship draft Hindi/Gujarati strings marked `// REVIEW: DESPL` for a native speaker to approve; never machine-translate safety or refusal copy without that review.

### Phase 3 — Pilot support (Weeks 5–7)

**L3.1 — Adoption metrics.** Same-day rate = share of items where `reportedFinishAt` (or recorded time) and `recordedAt` fall on the same IST day; median taps per update from client telemetry (count of actions per `recordWork` call path, no PII); show on Team, Portfolio and the digest.

**L3.2 — Pilot fixes.** Log every complaint in `docs/mos-execution/CUTOVER-FEEDBACK.md`; fix within 24 h; nothing new starts while a pilot blocker is open.

**Gate to Phase 3 waves:** ≥ 90% same-day updates for 5 working days on the pilot job and the Production Head stops updating his own sheet.

### Phase 4 — Harden and move on-prem (Weeks 9–12)

**L4.1 — Docker Compose recipe:** app, Postgres 16, Caddy (TLS on the LAN), optional MinIO for photos; `.env.onprem.example`; nightly `pg_dump` with 14-day retention; restore runbook tested once.
**L4.2 — Photos at QC points and hold points** (camera input, client-side resize, MinIO/S3 presigned upload; EXIF time and GPS stored as evidence metadata only).
**L4.3 — Offline outbox** for the Floor screen (IndexedDB queue, "1 update waiting" banner, gates re-checked at delivery).
**L4.4 — Optional WhatsApp** digest (needs internet egress from the on-prem server; confirm with D8).
Only after all of the above: revisit `FEATURES.agents`.

---

## 6. Acceptance demo for the pilot (run it live, real logins, no forged sessions)

1. A planner imports the DESPL-320 BOM from Excel and creates the job; office processes show 12 rows, not 108.
2. Travellers print; scanning SR01 on a phone opens its Floor screen.
3. A supervisor marks the 7 shell-welding steps (process 16) Done for SR01–SR05 in one batch: **≤ 12 taps in total**, against 135 clicks and 45 QC sign-offs today (27 and 9 per unit × 5 units).
4. QC accepts the linked inspection point (the only QC action needed once D3 is recorded). Process 16 then shows COMPLETE for those units on the Job board, with no separate process-level verify.
5. Starting Painting on SR01 before its Hydro test is refused with a plain message naming the missing step.
6. Marking an overdue item Done asks for a reason inline; an unrelated item on the same unit is not blocked.
7. A SOFT out-of-sequence start asks for an override reason and appears on the Production Head's Team view.
8. Next morning, MD and CEO receive the digest email with same-day update rates.
9. A planner creates DESPL-335 (four horizontal vessels on saddles plus one U-tube heat exchanger) from templates with no code change; the process plan exists on day one, and floor steps appear only when Engineering releases each line's BOM and weld map.

---

## 7. Conduct for every session

- Read `CLAUDE.md` first; it binds. One session item per branch and PR. CI must be green.
- **No migration merges to `main` until L0.2 is done.** Until then follow `MERGE-RUNBOOK.md` exactly.
- Business rules live in `src/lib/services/`; Server Actions stay thin. Every refusal uses a stable code.
- Never read secrets from `.env` to mint sessions; verify through the real `/login` with browser automation or report verification as incomplete.
- Ask Swayam before deleting files or data, changing RLS, dropping columns, or touching production.
- No new planning documents. If something needs writing down, it goes in `CLAUDE.md` (rules), this file or `docs/lean-core/PHASE-PLAN-v1.md` (plan), or `progress.md` (≤ 15 lines per session).
- If this file and older docs conflict, this file wins; note the conflict in the PR description.

---

## 8. Design review — Claude Design output (added 7 Oct 2026)

The Claude Design files are in `design/lean-core/`: `DESPL Tracker.dc.html` (frames 00–07), `DESPL Tracker 08-12.dc.html` (08–12), `DESPL Job Setup.dc.html` (13–16), `ScannedUnit.dc.html` (the 01A floor component) and `support.js`. They are the pixel reference for Phase 2 and J7. **Where a frame disagrees with this file or with `seed/`, this file and the seed win.** Never copy a frame's sample names, dates or counts into code, seeds or tests.

### 8.1 Frame → session map

| Frames | Session |
|---|---|
| 00 tokens, 11 components | L2.0 and every L2 session |
| 01A–01F floor, 01G language | L2.2, L2.12 |
| 02A–02C Today, end-of-shift | L2.3 |
| 03A–03C Job board, Stage Sheet | L2.4 |
| 04A–04B Team | L2.5 |
| 05A–05B QC queue | L2.6 |
| 06A–06B Portfolio | L2.7 |
| 07A–07B Overview, Materials | L2.8 |
| 08A–08B Travellers, component tags | L2.9 |
| 09A–09B Morning digest | L2.11 |
| 10A–10D States | every L2 session |
| 12A–12D Navigation, ⌘K | L2.1 |
| 13A–13G New job | J7 |
| 14A–14C BOM release, weld map | J5, J4 |
| 15A–15D Template studio | J1, J2, J4, J6 admin |
| 16A–16B, 03E Lots | J6 |
| 03D, 13D Heat exchanger | J8 |

### 8.2 Errata — build this, not the frame

**Domain, checked against `seed/`**

1. **DESPL-320 is a vertical vessel on a skirt** (`seed/despl-320-components.json` SKIRT; assembly steps 39–40). Stage 14's seed name is "Saddle Fabrication" and groups process 23 (attachments, including the skirt). Show the stage label from the seed/C27 decision; never hard-code "Saddle". The skirt tag in 08B is correct.
2. **Shell-seam NDT on DESPL-320 is PAUT/TOFD with Buyer TPI = W** (QCP 4.5, 4.7, 4.10). RT applies only to nozzle-to-flange butt welds (4.6). DESPL-320's QCP has no Buyer-TPI hold points; its four H points are DESPL's own (1.3, 3.1, 3.2, 4.1). The recurring "320SR04 · RT of LS-1 · Buyer TPI H" example (03B, 05B, 11C, 11K) is illustrative only. W waivers still need Production Head approval (invariant 4).
3. **QCPs have more than two inspection parties.** `seed/qcp-templates-batch2.json` uses CLIENT_TPI, AI, MVS, SCJV, OWNER, BUSCI_TPI and EIL_TPIA, plus codes RW and R&A (C7). The frames show two fixed columns (DESPL / Buyer TPI); render one column per party on the job's QCP. Those QCPs also mark DESPL = H on 195 of 237 rows, so if every DESPL-own H blocks floor progress, QC becomes the bottleneck again (see D12).
4. **Nozzle work happens before top-head closure.** Assembly steps 26–28 (nozzle to shell and dished end, process 20) and 31 (clearance, process 24) come before CS-1 set-up and weld (32–33, process 16). The process DAG chains 16 → 17 → 18 → 19 → 20. If those edges stay HARD, the real shop sequence is refused; if they are SOFT, every unit raises an out-of-sequence flag for normal work. The 01E-B soft-stop text ("Nozzle fit-up usually starts after shell fabrication is done") encodes the wrong order. **Input to D2:** gate floor items on assembly-step order within a unit, not on process edges 16 → 20.
5. **Process → stage is many-to-many.** Process 19 maps to stages 12 and 13, process 23 to 14 and 15, NDE processes 17 and 22 to stage 17. Board and spine aggregation must use the crosswalk. Nozzle set-up and weld steps are process 20 → **stage 13**, not stage 12 as drawn (03A SR05 outline, 07A notch, 11B tooltip, 02A rows).
6. **Departments:** use the 13 seeded names in `seed/lead-time-model.json`. The frames use non-seed names ("Surface & Painting", "Fabrication", "QC", "MDR") and omit Fabrication Prep and Machine Shop, which own processes 12–14.
7. Stage 10 as drawn (7 steps) matches process 16's WORK steps 13, 14, 15, 22, 23, 32, 33. The visual and PAUT inspections belong to process 17; show them as linked QCP points on the Stage Sheet, not as stage-10 steps.
8. The frames assume a Mon–Sat week, which matches the provisional `CALENDAR_DAYS_6DAY_WEEK` (D1).

**Rules, checked against §2**

9. 02C "Waiting on you · Backdated entry · Confirm" for a 17-hour backdate contradicts §2 row 1 (≤ 72 h needs no approval). Remove it; older entries use the admin correction flow.
10. Out-of-sequence overrides are acknowledged by the **Production Head** only (§2 row 2). Remove Acknowledge from the supervisor's 02C rail; the digest must not say "Acknowledged by <supervisor>".
11. Rows with no button "wait on an earlier step" (01A, 11C) make step order a hard gate. Keep it only if D2 records it (see item 4).
12. Offline queueing (01F-C, 10A-E, 10B-E, 10C-E, 10D-E) is L4.3. Until then show the offline banner and refuse writes with a retry; don't build the queue.
13. End-of-shift (02B) must post only the rows the user changed. Give `recordWork` a client `requestId` so a repeated batch is idempotent.
14. 01D's late path takes 4 taps. Put the reason chips inline in the batch sheet (target ≤ 3 taps, §1).
15. "Claim next job" (10B empty Today) is L2.3's OPERATOR-only action; supervisors don't get it.
16. QR (08A) prints `despl.in/u/320SR05`, a serial in a public-looking URL. Use L2.9's `/u/[publicId]` on the deployment host.
17. "Notify TPI" and "Notify <client>" (03B, 05B, 06A) have no delivery channel before L2.11/L4.4. In v1 make them "Copy message" or remove them (no dead controls).
18. QC accepting a W/H point on the TPI's behalf needs the TPI inspector's name and report/IRN number; hydro test also needs test pressure, hold time and gauge IDs. Not in the frames; add to L2.6.
19. The eight status chips (11A) are display states. Do not add Overdue, Out of sequence or Not scheduled to any database enum.
20. The frames' sample data contradict each other (delay-reason counts in 09A vs 04A, out-of-sequence date and person in 09A vs 04A/07A, weld-map joint counts in 14A vs 14C, DESPL-324 as a pure lot in 03E vs lot-then-serial in 06B/16B, DESPL-320 dates far longer than the 17-week envelope). Treat all of it as placeholder.

**Navigation (L2.1)**

21. Frames 02C–07B have no Scan in the sidebar, and 04A/06A (Portfolio · Team · Board) disagree with 12B (Portfolio · Jobs · Digest). Use one `NAV_ITEMS` registry: OPERATOR Today · Scan · Alerts; SUPERVISOR Today · Team · Scan · Jobs; QC Queue · Scan · Jobs; PLANNER Jobs · New job; PRODUCTION_HEAD Team (department switcher) · Portfolio · Flags · Jobs; MANAGEMENT Portfolio · Jobs · Digest; ADMIN Users & departments · Templates · Settings. "Board" is never a top-level item. Put language, theme and sign out in the person-block menu. Cap the sidebar job list to active jobs worst-first with an "All jobs" link.

**Tokens (L2.0, added 15 Oct 2026)**

22. Colour tokens follow frame 00, not the L2.0 line in Phase 2: its #3A4048 border is 1.58:1 as a control edge and #5C6068 idle is under 3:1. Control edges are `--border` #676C72 (dark) / #858B94 (Floor); #3A4048 is the decorative `--divider`. "Outdoor" is retired: Floor is the light theme, Control room the dark one, and a stored `outdoorMode` is read as Floor.

### 8.3 Needed but not drawn

- **Welder capture:** marking a weld step done records the welder(s); NDT results per joint feed welder repair rate (`Welder`, `WeldLog`, `NdtResult` exist). Add to L2.2; welder output view in L2.5.
- **Heat-number transfer at cutting** (`MaterialIdentification` exists): pick the heat number when cutting a pressure part.
- **Stores actions** on the Materials pipeline (07B is read-only): received, identified, issued.
- **Excel import screens** for L2.10: upload → dry-run preview → data issues → confirm.
- **Job tabs** Schedule, QC, Dispatch, History (L2.8); the Dispatch tab shows the open-NCR/hold refusal.
- **Alerts panel, Jobs list, in-app Digest page.**
- **Admin:** users, roles, departments and representatives, welder list, delay-reason list.
- **Nav shells** for PLANNER, PRODUCTION_HEAD and the J5 release role; Stores has no role yet.
- **Master data for J7:** a third start route on 13A, "Build from master", for an order with no template and no similar past job: pick equipment from a catalogue → components (typical kit pre-filled) → processes proposed from component routes, add/remove with a reason → QCP items → schedule (unknown durations show "not scheduled") → release → "Save as template draft". Needs an equipment catalogue, a material master and master BOM items, each with list/edit/Excel import. Every library process must map to a stage and milestone; jobs copy master data at release.
- **Template studio (15A–15D)** has no process-route tab and no process → stage → milestone mapping (needed by J8).

### 8.4 Decisions to add to §3

| ID | Decision | Default until decided |
|---|---|---|
| D9 | Ten milestone names (J8) | Engineering approved · Material ready · Cutting & forming · Fabrication · NDT · PWHT · Pressure test · Painting · Documentation · Dispatched |
| D10 | Late-reason categories | The 8 in 01D: material, manpower, machine, drawing/approval, QC/TPI, rework, power cut, other |
| D11 | Only one QC inspector on shift and they recorded the work | Production Head may accept; logged as an override |
| D12 | Do DESPL-own H points block floor progress or only the stage's QC sign-off? | Block (today's behaviour) |
| D13 | Canonical 25 stage names (C27) | Seed `workOrderStageNames` |
