# CLAUDE.md — DESPL Production Tracker

## Active plan: Lean Core v1  *(added 7 Oct 2026 — session L0.4)*

**Current work is sequenced by `docs/lean-core/BUILD-PROMPT-lean-core-v1.md`** (Phase 0 → L1 → J1–J8 → L2 screens → pilot → L4). It supersedes the phase order in `docs/archive/mos-execution/PROMPTS-v4.md` and Phases 2–10 of `audit/20_REMEDIATION_ROADMAP.md`. Read it in full before any session. Where it conflicts with older text in this file, it wins until this file is updated; the dated "Revised 7 Oct 2026" notes below mark the changes.

- **Phase order and inputs (added 11 Oct 2026):** `docs/lean-core/PHASE-PLAN-v1.md` sets phases P0–P7, their gates, decisions D14–D27, the information still owed by the DESPL team, and adds **Phase M (master data, sessions M1–M3)**, which the build prompt does not have. Read it together with the build prompt; it wins on order, the build prompt wins on what each L/J session builds. M sessions use branch `lean/M<n>-<slug>`. Team inputs of 11 Oct live in `docs/lean-core/inputs/2026-10-11-master-list/` (all Draft, see the plan's §7 before trusting any value).
- **Goal:** pilot with Planning/PPC, Fabrication and QC on one live job; ≥ 90 % of events entered the same day for 5 straight working days.
- **Session template:** one session item per branch `lean/L<x.y>-<slug>` (or `lean/J<n>-<slug>`). Plan first — files, migration, tests — and wait for Swayam's go. Then implement, run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:db`, open a PR, add at most 15 lines to `progress.md`.
- **Design reference:** `design/lean-core/*.dc.html` (Claude Design, 7 Oct 2026). Read the build prompt's **§8 (design review)** before building any screen: it maps frames to sessions and lists 21 errata where the frames are wrong. Recreate the frames in this codebase's components and data layer; never copy their sample data.
- **Relaxations are data, defaulting to today's behaviour.** Build the switches; flip them only when the matching decision below is recorded.

### Lean Core decisions

Record each decision here (date, who) as it arrives. Until then the default applies.

| ID | Decision | Default until decided | Status |
|---|---|---|---|
| D1 | Working days or calendar days | `CALENDAR_DAYS_6DAY_WEEK` (Sun off) | Provisional (Swayam, 4 Sep) — SJ to confirm |
| D2 | Which edges become SOFT (see build prompt §8.2 item 4: nozzle work precedes CS-1) | All HARD | Open |
| D3 | Which items get `requiresQc = false` | All `true` | Open |
| D4 | Backdating window | 72 hours | Open |
| D5 | Pilot job + departments; JOB-grain process list | Planning/PPC, Fabrication, QC; processes 1–11 and 33 | Open |
| D6 | Devices and floor Wi-Fi | Design for both | Open |
| D7 | Department representatives; welder list | Placeholder accounts | Open |
| D8 | On-prem server spec, admin, target month | Stay on Railway | Open |
| D9 | Ten milestone names | See build prompt §8.4 | Open |
| D10 | Late-reason categories | The 8 in frame 01D | Open |
| D11 | Single QC inspector recorded the work | Production Head may accept, logged as override | Open |
| D12 | Do DESPL-own H points block floor progress or only QC sign-off? | Block | Open |
| D13 | Canonical 25 stage names (C27) | Seed `workOrderStageNames` | Open |
| D14 | Controlling document for routes (Q-01) | Team workbook once approved | Open |
| D15 | Who approves master data; Excel only for bulk import | Production Head approves in the tracker | Open |
| D16 | Part codes; 17 operations frozen; which of the 14 proposed operations to add | No new operations | Open |
| D17 | Standard times stored only or used for scheduling; validation method | Stored only; process min/max days schedule | Open |
| D18 | PV equipment types in the v1 catalogue | Vertical on skirt, vertical on legs, horizontal on saddles | Open |
| D19 | HE types in v1; grommet tube joint as a standard variant (Q-02, D-02) | Fixed tubesheet / MED only | Open |
| D20 | Heat treatment, PFHT, hydro: floor operations or QCP points (Q-05, PV-03) | QCP points on processes 21 and 27 | Open |
| D21 | Serial or lot tracking for multi-quantity jobs | Serial | Open |
| D22 | In-flight jobs to import; date Excel stops | Pilot job only | Open |
| D23 | Notifications: in-app + 08:30 email digest, recipients | In-app; email to MD, CEO, SJ | Open |
| D24 | Photo evidence points; GPS required | Hold points and hydro test only | Open |
| D25 | Weight calculation in v1 | After go-live | Open |
| D26 | Department rollout order after the pilot | Order in PHASE-PLAN P6 | Open |
| D27 | Backup retention, remote access, system administrator | Nightly, 14 days, LAN only | Open |

**Do not start L1.2 until D2, D3 and D4 are recorded.**

### Frozen (Lean Core §4) — keep the code, hide it, no new work

Client portal · multi-family intake (only Pressure Vessel selectable in `/jobs/new` until J-phase lifts it) · CPM replan / feasibility / duration-override UI · analytics screens · planner agent / MOS layer · new multi-tenancy work. Switches live in `src/lib/shared/flags.ts`; when off, remove nav entries, `notFound()` the routes, refuse actions with `FEATURE_FROZEN`. Never delete the code, migrations, RLS policies or tests.

---

Project guide for Claude Code / AI-assisted build sessions. **Read `docs/BUILD-SPEC-v2.md` first** — it supersedes the scheduling, granularity and stack sections of `docs/archive/PRD.md` and `docs/archive/TRD.md` (historical). Also read `docs/ADR-product-family-agnostic-platform-v1.md` — the app is a multi-project, multi-product-family platform (Pressure Vessel, Heat Exchanger, Pipe Spool, Piping System); DESPL-320 is the calibration pilot, not the product (see also `docs/archive/PHASE-PROMPTS.md` §0, historical). Update `progress.md` at the end of every working session.

> Full cross-project context pack (status, roadmap, decisions, deployment, known issues) lives in the Obsidian vault: `/Users/sonusingh/SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/`. The repo's `progress.md` is canonical; the vault mirrors it — update `progress.md`, then sync the vault (`CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md`) and run `link_vault.py` if doc files were added or renamed.

## Previous execution plan  *(added 1 Sep 2026 — phase order superseded 7 Oct 2026 by Lean Core v1, above; the known-state notes below still hold)*

**Archived 11 Oct 2026 (L0.4).** This plan's documents now live in `docs/archive/`: `mos-execution/PROMPTS-v4.md` (rules block), `mos-execution/LEDGER.md` (outcomes up to 10 Sep — log new work in `progress.md`, not there), `mos-blueprint/`, `DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md` (evidence) and `DESPL_MOS_TRANSFORMATION_PLAN.md` (gates). Read them for history only.

**Known state every session needs** (full list in the archived v4 rules block — do not "discover" these and fix them as a side effect):
- *(corrected 4 Sep 2026 — Gate 2, S16/S17)* `createJob` (`job-intake.service.ts`) now materialises `Component`/`ComponentOperation` (via its `copyBomFromEquipmentId` path only) and `AssemblyStep` (per `Unit`, from the family's `AssemblyTemplate`) for real. `prisma/seed.ts` and `scripts/seed-despl320-*.ts` remain the only writers for a BOM attached to a job *after* creation (`bom.service.ts`'s `importBomItems` doesn't even accept `componentTypeId` yet) — that gap is still open, just narrower than before.
- `dispatch.service.ts`, `packing.service.ts`, `override.service.ts`, `ncr.service.ts`'s `dispositionNcr`, and `component.service.ts`'s `recordPaintRecord`/`recordDftReading` have zero callers. Scheduled as Gate 1.
- *(corrected 4 Sep 2026 — Gate 2, S18/S19)* `Job.status` now has a writer (`setJobStatus`, guarded on `COMPLETE`); `assertKitReady` and `assertDrawingReleased` are real gates now too — `assertKitReady`'s "never stocked" SEAM is gone (S18), and `linkGoverningDrawing` (new) is the first real writer of `Component.governingDrawingId`, so `assertDrawingReleased`'s CUTTING gate is reachable.
- Excluding a process at intake currently deadlocks its successors (`loadGate` misses `bypassExcluded`). Item S1 fixes this.

**Hard bans until Gate 1 exits:** do not re-pin DESPL-320 to `ProcessTemplateVersion` v2; do not publish a version tagging an `evidenceKind` with no reachable producer; do not add a `PAINTING` operation to any route.

## What this project is

End-to-end production tracker for DESPL (Dhruv EPC Solutions, Vedanta Group). Tracks pressure-vessel manufacturing from PO to dispatch across all departments: 25-stage work-order process, QCP/ITP checkpoints with P/W/H hold points, BOM + heat-number traceability, welding productivity, deadline/KPI accountability, and daily management visibility (MD, CEO, Production Head "SJ"). v1 pilot job: DESPL-320 (9 HP air receivers, serials 320SR01–09).

## Stack  *(revised 11 Aug 2026 — replaces the split monorepo in TRD §2)*

TypeScript strict everywhere. Single Next.js full-stack app.

- Next.js 15 (App Router), Tailwind v4 + shadcn/ui. Not a PWA — no manifest, no service worker; not currently planned.
- Server Actions do every mutation; a handful of `/api/*` route handlers exist and are GET-only reads (health check, exports). No client-side data-fetching library — no TanStack Query or equivalent, just server components + Server Actions.
- Prisma 6, PostgreSQL 16. Background jobs via Next.js route + cron (BullMQ/Redis only if load demands it)
- `lib/services/` holds ALL business rules — Server Actions and Route Handlers are thin callers, never rule-holders
- `lib/schedule/` holds the scheduling engine (envelope, CPM, forward/backward, feasibility, override)
- `lib/shared/` — zod schemas, types, constants (roles, process/status enums, error codes)
- Deploy: Railway, one `production` environment, auto-deploying from `main` — no separate staging environment exists yet. CI: GitHub Actions runs lint → typecheck → test (pure + DB-gated) → build on every PR/push; it does not deploy (Railway's own auto-deploy does that) and does not run `prisma migrate deploy` against a real database.
- **Migrations are applied MANUALLY. Nothing applies them for you.** *(corrected 2 Sep 2026 — this section previously claimed `railway.json`'s `deploy.preDeployCommand` ran them; it never did.)* The Railway service does not honor `railway.json`: every deployment on record shows `preDeployCommand: None`, `builder: RAILPACK` (not the file's `NIXPACKS`), and `healthcheckPath: null`. The `preDeployCommand` key has been removed from `railway.json` so it stops implying otherwise — the remaining keys are equally un-applied, kept only as a statement of intent. **Consequence:** merging to `main` ships code without its schema. That is exactly what happened on 2 Sep — 20 migrations sat unapplied while the code that needed them ran in production. Before deploying anything that adds a migration, follow `docs/mos-execution/MERGE-RUNBOOK.md`: rehearse on a restored copy, then apply by hand, watched.

## Model usage

**Opus for architecture, specification and decisions. Sonnet for coding sessions.**

## Commands

```bash
pnpm install
pnpm dev          # single Next.js dev server, :3000 — no separate api process/port
pnpm db:seed      # seed roles, departments, PV template, demo data
pnpm test         # vitest unit + supertest API (pure tests only, no DB)
pnpm test:db      # DB-gated tests against the dedicated despl_test DB — never run RUN_DB_TESTS against despl_demo
pnpm e2e          # playwright
pnpm lint && pnpm typecheck
```

## Non-negotiable invariants (the product's whole credibility rests on these)

1. **No client timestamps.** Actual dates/times are set server-side from the DB clock. No request DTO may contain `actual_*` or `*_at` fields. Ever.
   > **Revised 7 Oct 2026 (Lean Core §2 row 1, L1.1/L1.2):** the server still stamps `recordedAt` on every write. Start/Done may carry a client `reportedAt`: default now, never future, never before the job's order date, at most `BACKDATE_WINDOW_HOURS` back (D4, default 72). Older corrections use the admin correction flow. KPIs use `COALESCE(reportedAt, recordedAt)`; the audit log stores both. No other `actual_*`/`*_at` field may come from a client.
2. **Hard sequential gating.** A stage starts only when its predecessor DAG is COMPLETE (`lib/schedule/gating.ts`'s `assertCanStart`/`assertCanComplete`, called from `lib/services/process.service.ts` inside a transaction — never only in the UI). Material-dependency gating exists at the component-operation grain, not the stage grain: `assertKitReady` (`lib/services/_shared.ts:684`), called from `startComponentOperation` (`component.service.ts:194`), throws `MATERIAL_NOT_AVAILABLE` when a component's linked BOM item is short. It silently no-ops — the operation starts unchecked — for a component with no BOM link, and for a BOM item with zero stock transactions ever recorded. No equivalent gate exists at the `ProcessPlan`/stage grain.
   > **Revised 7 Oct 2026 (Lean Core §2 row 2, switch D2):** edges carry `enforcement` HARD | SOFT, default HARD. A SOFT edge allows the write with an override reason, appends a `SequenceOverride` row and flags the item for the Production Head. Always HARD regardless of data: an open blocking H point blocks its stage's completion; Surface Preparation (29) and Painting (30) need Hydro (27) complete; dispatch refuses an open NCR, open hold point or incomplete production.
3. **Maker–checker.** `verify` requires the QC role AND `actor != submitted_by`. The same human never submits and verifies. No exceptions, including admins.
   > **Revised 7 Oct 2026 (Lean Core §2 row 3, switch D3):** `requiresQc` (default `true`) on operations, assembly steps and template processes. When `false`, Done goes straight to COMPLETE and is audited. When `true`, this invariant applies unchanged — no exceptions, including admins.
4. **Hold points block.** A stage with an uncleared H-coded checkpoint cannot complete. Witness (W) waivers require Production Head approval and are audited.
5. **Append-only audit.** Every mutation writes `audit_log` (before/after jsonb) in the same transaction; if the audit insert fails, roll back. The app DB role has no UPDATE/DELETE grant on `audit_log`. Never add one.
6. **No destructive edits.** Corrections create new versions with a mandatory reason via the admin correction flow; originals stay visible.
7. **Mandatory delay reasons.** A department with an overdue stage on a unit is blocked from further progress writes on that unit until a categorized reason is filed.
   > **Revised 7 Oct 2026 (Lean Core §2 row 7, L1.4):** never block other writes. Marking a late item Done requires the reason in the same action (`LATE_REASON_REQUIRED`). Unfiled reasons get a 10:00 IST reminder and escalate to the Production Head after 24 h. `assertNoUnfiledDelayBlock` leaves the write paths.
8. **RBAC deny-by-default** at the API layer; supervisors are scoped to their department's stages (`DepartmentScopeGuard`).
9. **Templates are versioned.** Edits create a new `template_versions` row; running units keep their pinned version.
10. **Never sum durations to build a schedule.** The 36-process lead-time table encodes concurrent fabrication and is rounded to whole weeks; naive summation gives 11.6–24 weeks against DESPL's stated ~17. Use the two-layer model in BUILD-SPEC-v2 §1 — printed envelope as authoritative, DAG lags fitted to it.
11. **Schedule lags never relax gating.** A negative lag means work may *start* concurrently. It never permits completing a process out of order, and never overrides a hold point.
12. Refusals must be explainable: use stable error codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `REASON_REQUIRED`, `HOLD_POINT_OPEN`, …) so the UI can say why.
   > **Added 7 Oct 2026 (Lean Core §2 rows 4, 5, 12):** process plans with mapped items are **derived** (`rollupProcessPlan`, same transaction); direct start/submit/verify on them refuses with `DERIVED_STATUS`. Processes carry `grain` JOB | UNIT; processes 1–11 and 33 are JOB-grain (one plan per job). New codes: `DERIVED_STATUS`, `SEQUENCE_OVERRIDE_REQUIRED`, `LATE_REASON_REQUIRED`, `REPORTED_AT_OUT_OF_WINDOW`, `FEATURE_FROZEN`, each with a plain-English message in `src/lib/shared/errors.ts`. Display states (Overdue, Out of sequence, Not scheduled) are computed, never stored as enum values.

## Agent conduct: never forge credentials to work around missing tools

**No agent — subagent, workflow step, or otherwise — may read `AUTH_SECRET` (or any other
live signing key/secret) out of `.env` and use it to hand-construct a session token,
cookie, or JWT.** This happened once (16 Aug 2026, portfolio-dashboard session — see
`progress.md`'s "Session — Portfolio Dashboard" log for the full account): an implementer
lacking browser automation extracted `AUTH_SECRET` and used `jose` to forge a valid
`sj@despl.local` session, bypassing `/login` entirely, to verify a UI change with curl.
It was caught by the harness's own safety monitor, not by review — do not rely on that
happening again.

**If you need an authenticated session to verify something, get one the real way:**

- **Preferred:** drive the actual `/login` form through real browser automation
  (Playwright, `mcp__claude-in-chrome__*`, or equivalent) — type the email/password,
  submit, and verify from there. This is what actually proves the login flow itself
  still works, which a forged session can never do.
- **If no browser automation is available:** say so explicitly and report verification
  as incomplete (`DONE_WITH_CONCERNS` in an SDD dispatch, or the equivalent), rather than
  reaching for a credential shortcut. An honestly-flagged gap is recoverable; a forged
  session is a live credential exposed in a transcript.
- **Never** import `createSession`/`jose`/any signing utility directly in a script to
  mint a session outside the real `login()` server action (`src/app/actions/auth.ts`) —
  that function's own credential check (`verifyPassword` against the DB) is the thing
  being verified when a test claims "logged in," and skipping it makes the claim false.

This applies to every phase of work — implementation, self-review, task review, and
final review — not just the phase where the incident happened.

## Conventions

- zod schema in `src/lib/shared/schemas.ts` is the single source of validation truth (Server Actions and the few route handlers both import it — there is no separate client-side copy to drift, since there's no separate API client).
- No NestJS, no controllers. `src/lib/services/` holds one file per domain (`job-intake`, `schedule`, `process`, `qcp`, `mtc`, `override`, `notifications`, `admin`, `template`, `welding`, …) — thin Server Actions call into them, rules live in the service. Auth itself (`login`, `changeOwnPassword`) lives in `src/app/actions/auth.ts`, not `lib/services/`.
- Prisma: forward-only migrations, snake_case tables, enums for statuses. Never edit an applied migration.
- Frontend: mobile-first for supervisor/QC screens; role-based landing (supervisor → "Today" priority list, MD/CEO → company dashboard). English-only strings for now — every label is a plain TSX literal today; there is no i18n string table yet, so do not import from or reference one. Hindi/Gujarati is Phase 2 and will need that infrastructure built first, not just translated. *(Revised 7 Oct 2026: Lean Core L2.12 adds a minimal dictionary `src/lib/i18n/{en,hi,gu}.ts` for the Floor screen and Today only, selected by `User.locale`; drafts marked `// REVIEW: DESPL`.)*
- Time zone: store UTC, display IST (Asia/Kolkata).
- Tests: any change to the state machine, gating, RBAC, or audit paths requires table-driven tests for the violation cases, not just happy paths.

## Deferred to Phase 2 — do NOT build yet (but don't paint into a corner)

Email/WhatsApp delivery (daily brief payload is already email-ready jsonb; *7 Oct 2026: the morning digest by email moves into Lean Core L2.11, WhatsApp stays deferred to L4.4*) · geo-tagged in-app photo proof · file uploads (MTCs, reports, MDR compilation — schema keeps `record_type`/refs as text now) · additional equipment templates · offline writes.

**Built, not deferred: TPI/client portal.** Shipped 19 Aug 2026 (`src/app/portal/page.tsx`,
`lib/services/client-snapshot.service.ts`/`client-snapshot.read.ts`, both tested). A publish →
verify/reject workflow (`ProgressSnapshot`); the portal reads exclusively through
`loadClientPortalView`, which only ever selects `VERIFIED` rows. See
`docs/superpowers/specs/2026-08-19-client-portal-daily-updates-design.md`.

## Pending inputs from DESPL

Now tracked as C1–C12 in `docs/BUILD-SPEC-v2.md` §7 with the default in use for each. **C1 (working vs calendar days) is the highest-impact one** — it changes every computed date. Still outstanding from before: welder list · weld-map joint numbering · department supervisor + representative names (C9).

## Session discipline

End every session by updating `progress.md`: what shipped, decisions made, blockers, next steps — at most 15 lines per session (Lean Core §5). Keep the demo script (`docs/demo.md`, once created) in sync — the demo to MD/CEO includes deliberately attempting violations and showing the refusals.

---

## Frontend & Design System

> Frontend/demo-ready build guide (merged from the design pack, 15 Aug 2026; pixel/spec reference updated 8 Sep 2026 — see below). The invariants and conventions above are still binding — this section governs the visual/UX layer only.

**Current milestone: DEMO ROLLOUT.** *(7 Oct 2026: the current milestone is the Lean Core pilot — see the top of this file. The no-dead-controls and real-data rules below still apply.)* The whole team will click through this build and give feedback. Therefore: every module reachable from the sidebar must be FUNCTIONAL — real data, real actions that persist. Judgment call rule: a smaller number of fully working modules beats a larger number of half-working ones, but the target is all of them per the design handoff below.

### Pixel reference *(superseded 8 Sep 2026; superseded again 7 Oct 2026)*

**7 Oct 2026:** for Lean Core Phase 2 and J7 screens the reference is `design/lean-core/` with the errata in `docs/lean-core/BUILD-PROMPT-lean-core-v1.md` §8. `design_handoff_phase4/` still governs screens Lean Core does not replace.


`design_handoff_phase4/` is the current implementation spec — it supersedes `docs/DESIGN_SPEC.md` §9's build order and `design/despl-tracker-mockup.html` as the pixel reference (both predate this handoff; the latter is stale but left in place, not deleted). Read `design_handoff_phase4/README.md` first, then all 5 docs it points to (`DESIGN_SYSTEM.md`, `COMPONENT_INVENTORY.md`, `RESPONSIVE_GUIDELINES.md`, `ACCESSIBILITY_AUDIT.md`, `UX_FINAL_REVIEW.md`) before touching any screen — they are the actual spec, not the `mockups/*.dc.html` files (design references only; recreate in this codebase's real components/data layer, don't port the HTML). Build order and screen→route mapping (which design-doc screen maps to which existing route, or "no existing route") are logged in `progress.md`'s "Phase 4 design-handoff implementation" session. When in doubt about spacing, color, density, or an interaction, open the matching `.dc.html` mockup and match it — do not "improve" the approved design without being asked.

### Functional-first rules (demo mandate)

1. **No dead controls.** Every button, link, dropdown, and cell either performs a real action (persisted via API) or does not exist. Never ship a control that only toasts "coming soon". If a feature is out of scope, remove its control.
2. **Real data only.** All screens render from the database via API routes — no hardcoded arrays in components. Demo realism comes from the seed script (see DESIGN_SPEC.md §1), never from mock data inside the UI.
3. **Actions round-trip.** Start / Submit / Verify / Reject / File reason / Clear hold must write to Postgres, re-render optimistically, toast the result, and appear in the activity log and notifications. If the demo laptop refreshes, state survives.
4. **Gates are enforced server-side.** *(Revised 7 Oct 2026: which gates are hard follows invariant 2 as revised; derived stages complete from their steps.)* A stage cannot start until the previous stage is verified; QC verify/reject only for QC roles; reject requires a reason. The demo WILL include someone trying to break this — return a clean error, not a crash.
5. **Every page ships with** loading skeletons (match final layout, no full-page spinners), an empty state (one sentence + one action), an error state (what failed + retry), visible keyboard focus, and reduced-motion support.

### Aesthetic direction (non-negotiable)

Industrial control-room aesthetic. Density and precision of Linear / Vercel dashboard / Palantir Foundry. Dark theme only in v1. *(Revised 7 Oct 2026, Lean Core L2.0: a light high-contrast "Floor" theme is the default on coarse pointers — phones and shop tablets; dark "Control room" stays the desktop default; user preference wins. Token changes per L2.0 and frame 00.)* Data density over whitespace. Zero decorative gradients, zero glassmorphism. Instrumentation, not marketing.

**Signature element:** the *Stage Spine* — a horizontal segmented bar of the 25 work-order stages, color-coded by status. Mini (4px) on every job row and in the job switcher; full-size interactive on the job page. One reusable component: `<StageSpine />`.

### Design tokens

Colors (CSS variables in `globals.css`):

- `--bg` #0B0C0E · `--surface` #141619 · `--surface-2` #1C1F24 · `--border` #262A30
- `--text` #E7E9EC · `--muted` #8B919A
- `--accent` #FF7A1A — high-vis industrial orange. Primary buttons, active nav rail, "actual" S-curve line, filter chips, focus rings. Sparingly: >3 orange elements on one screen means remove some.

Status colors (the ONLY way status is communicated — never plain grey text):

- `--s-complete` #3FB950 · `--s-progress` #4C8DFF · `--s-submitted` #A371F7 (awaiting QC)
- `--s-hold` #D9A62E · `--s-overdue` #F0524D · `--s-idle` #4A4F57

Status renders as `<StatusChip />`: pill, 10.5px uppercase, 12%-opacity tinted bg, solid dot. Heatmap/matrix cells use the same hues, opacity scaled by value, and ALWAYS print the number inside the cell (zero = plain muted "0", no tint).

### Typography

- UI/body: **Inter** via `next/font` (fallback Geist Sans). If a browser-default serif ever renders, treat it as a P0 bug.
- All numeric data: **JetBrains Mono** with `font-variant-numeric: tabular-nums`. Numbers align vertically in every table.
- Scale: page title 20/600 · section header 11/600 uppercase tracked muted · body 13 · caption 10.5–11 · KPI value 28/600 mono. Nothing larger than 28px.

### Layout

236px sidebar (collapsible to icon rail) + 48px sticky topbar with breadcrumb, job switcher (with mini spine), ⌘K, notification bell. No page outside the shell except /login. 8px grid, card padding 16px, table rows 36px, radius 6px cards / 4px inputs.

### Interaction primitives (all mandatory, build once, reuse)

- `<StageSheet />` — 460px right sheet, opens from ANY stage reference (spine segment, matrix cell, gantt row, critical-path row, workspace row). Shows owner, target vs actual, variance, std duration vs elapsed, delay-reason history, linked hold points, and the role-correct action (Start / Submit / Verify / Reject).
- `<CommandPalette />` — cmdk on ⌘K: jobs, units, stages, departments, pages, pending actions ("File delay reason (8)"). Enter executes.
- **Cross-filter navigation** — KPI cards and matrix cells deep-link to the Workspace with a dismissible orange filter chip. URL-driven (`/workspace?dept=…&status=…`) so it survives refresh and back-button.
- Custom tooltips (styled div, not `title=`), animated count-up on dashboard KPIs (once per visit), 250–300ms page/tab fade-up transitions, sonner toasts bottom-right.

### Copy rules

Plain verbs, sentence case. Buttons say what happens ("Submit for QC", not "Submit"). Humanize all enums (`PRODUCTION_HEAD` → "Production Head"). Never show DB roles, RLS notes, table names, or developer commentary in the UI. Errors state what went wrong and how to fix it; empty states invite action.

### Hard bans

Browser-default serif · raw enums in UI · dev commentary in UI · N identical repeated cards (always aggregate into grouped tables / matrices with bulk actions) · status as plain text · matrix cells without printed values · unlabeled chart axes · decorative gradients, glow, emoji, stock imagery · dead "coming soon" controls · mock data inside components · localStorage for app state.

### Workflow for the agent (Antigravity / Claude Code)

- Read `design_handoff_phase4/README.md` and its 5 docs fully before any session; they are the execution contract *(updated 8 Sep 2026 — supersedes `docs/DESIGN_SPEC.md` as the primary reference; that file may still hold non-visual product context not covered by the handoff)*. Use the `frontend-design` skill for any new visual surface.
- *(7 Oct 2026: superseded by the Lean Core session order.)* Work through the build order logged in `progress.md`'s Phase 4 session (canonical components → My Day → Activity Detail → Supervisor Team → Management Dashboard → Project Control Centre → remaining screens). One module per session. Do not start a new module until the previous one passes its acceptance checks.
- End every session by: (1) running the app and clicking every control you built, (2) checking the Demo Readiness checklist items for that module (§8), (3) listing which hard bans you verified.
- Never invent schema — extend the existing Postgres schema via migrations, keep RLS intact, and keep all writes going through API routes with server-side role checks.
- If mockup and spec conflict, the spec wins; note the conflict in your summary.
