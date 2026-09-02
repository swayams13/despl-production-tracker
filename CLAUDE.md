# CLAUDE.md — DESPL Production Tracker

Project guide for Claude Code / AI-assisted build sessions. **Read `docs/BUILD-SPEC-v2.md` first** — it supersedes the scheduling, granularity and stack sections of `docs/PRD.md` and `docs/TRD.md`. Also read `docs/ADR-product-family-agnostic-platform-v1.md` — the app is a multi-project, multi-product-family platform (Pressure Vessel, Heat Exchanger, Pipe Spool, Piping System); DESPL-320 is the calibration pilot, not the product (see also `docs/PHASE-PROMPTS.md` §0). Update `progress.md` at the end of every working session.

> Full cross-project context pack (status, roadmap, decisions, deployment, known issues) lives in the Obsidian vault: `/Users/sonusingh/SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/`. The repo's `progress.md` is canonical; the vault mirrors it — update `progress.md`, then sync the vault (`CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md`) and run `link_vault.py` if doc files were added or renamed.

## Active execution plan  *(added 1 Sep 2026)*

**Current work is sequenced by `docs/mos-execution/PROMPTS-v4.md`.** Read `docs/mos-execution/README.md` before starting any session; log outcomes in `docs/mos-execution/LEDGER.md`. v4 supersedes `docs/mos-blueprint/PROMPTS.md` for phase ORDER and for Gates 0-2 — v3's Phase C-N item prompts are still current. The evidence behind the sequence is `docs/DESPL_CODEBASE_ALIGNMENT_AND_DEVELOPMENT_ROADMAP.md`; the gate structure is `docs/DESPL_MOS_TRANSFORMATION_PLAN.md`.

**Known state every session needs** (full list in v4's rules block — do not "discover" these and fix them as a side effect):
- No code in `src/` creates `Component`, `ComponentOperation` or `AssemblyStep`. Only `prisma/seed.ts` and `scripts/seed-despl320-*.ts` do — DESPL-320's execution layer was seeded, not created by the product. Scheduled as Gate 2.
- `dispatch.service.ts`, `packing.service.ts`, `override.service.ts`, `ncr.service.ts`'s `dispositionNcr`, and `component.service.ts`'s `recordPaintRecord`/`recordDftReading` have zero callers. Scheduled as Gate 1.
- `Job.status` has no writer anywhere; `assertKitReady` and `assertDrawingReleased` no-op on fields nothing sets.
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
2. **Hard sequential gating.** A stage starts only when its predecessor DAG is COMPLETE (`lib/schedule/gating.ts`'s `assertCanStart`/`assertCanComplete`, called from `lib/services/process.service.ts` inside a transaction — never only in the UI). Material-dependency gating exists at the component-operation grain, not the stage grain: `assertKitReady` (`lib/services/_shared.ts:684`), called from `startComponentOperation` (`component.service.ts:194`), throws `MATERIAL_NOT_AVAILABLE` when a component's linked BOM item is short. It silently no-ops — the operation starts unchecked — for a component with no BOM link, and for a BOM item with zero stock transactions ever recorded. No equivalent gate exists at the `ProcessPlan`/stage grain.
3. **Maker–checker.** `verify` requires the QC role AND `actor != submitted_by`. The same human never submits and verifies. No exceptions, including admins.
4. **Hold points block.** A stage with an uncleared H-coded checkpoint cannot complete. Witness (W) waivers require Production Head approval and are audited.
5. **Append-only audit.** Every mutation writes `audit_log` (before/after jsonb) in the same transaction; if the audit insert fails, roll back. The app DB role has no UPDATE/DELETE grant on `audit_log`. Never add one.
6. **No destructive edits.** Corrections create new versions with a mandatory reason via the admin correction flow; originals stay visible.
7. **Mandatory delay reasons.** A department with an overdue stage on a unit is blocked from further progress writes on that unit until a categorized reason is filed.
8. **RBAC deny-by-default** at the API layer; supervisors are scoped to their department's stages (`DepartmentScopeGuard`).
9. **Templates are versioned.** Edits create a new `template_versions` row; running units keep their pinned version.
10. **Never sum durations to build a schedule.** The 36-process lead-time table encodes concurrent fabrication and is rounded to whole weeks; naive summation gives 11.6–24 weeks against DESPL's stated ~17. Use the two-layer model in BUILD-SPEC-v2 §1 — printed envelope as authoritative, DAG lags fitted to it.
11. **Schedule lags never relax gating.** A negative lag means work may *start* concurrently. It never permits completing a process out of order, and never overrides a hold point.
12. Refusals must be explainable: use stable error codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `REASON_REQUIRED`, `HOLD_POINT_OPEN`, …) so the UI can say why.

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
- Frontend: mobile-first for supervisor/QC screens; role-based landing (supervisor → "Today" priority list, MD/CEO → company dashboard). English-only strings for now — every label is a plain TSX literal today; there is no i18n string table yet, so do not import from or reference one. Hindi/Gujarati is Phase 2 and will need that infrastructure built first, not just translated.
- Time zone: store UTC, display IST (Asia/Kolkata).
- Tests: any change to the state machine, gating, RBAC, or audit paths requires table-driven tests for the violation cases, not just happy paths.

## Deferred to Phase 2 — do NOT build yet (but don't paint into a corner)

Email/WhatsApp delivery (daily brief payload is already email-ready jsonb) · geo-tagged in-app photo proof · file uploads (MTCs, reports, MDR compilation — schema keeps `record_type`/refs as text now) · additional equipment templates · offline writes.

**Built, not deferred: TPI/client portal.** Shipped 19 Aug 2026 (`src/app/portal/page.tsx`,
`lib/services/client-snapshot.service.ts`/`client-snapshot.read.ts`, both tested). A publish →
verify/reject workflow (`ProgressSnapshot`); the portal reads exclusively through
`loadClientPortalView`, which only ever selects `VERIFIED` rows. See
`docs/superpowers/specs/2026-08-19-client-portal-daily-updates-design.md`.

## Pending inputs from DESPL

Now tracked as C1–C12 in `docs/BUILD-SPEC-v2.md` §7 with the default in use for each. **C1 (working vs calendar days) is the highest-impact one** — it changes every computed date. Still outstanding from before: welder list · weld-map joint numbering · department supervisor + representative names (C9).

## Session discipline

End every session by updating `progress.md`: what shipped, decisions made, blockers, next steps. Keep the demo script (`docs/demo.md`, once created) in sync — the demo to MD/CEO includes deliberately attempting violations and showing the refusals.

---

## Frontend & Design System

> Frontend/demo-ready build guide (merged from the design pack, 15 Aug 2026). The invariants and conventions above are still binding — this section governs the visual/UX layer only. `docs/DESIGN_SPEC.md` is the full execution contract; `design/despl-tracker-mockup.html` is the pixel reference.

**Current milestone: DEMO ROLLOUT.** The whole team will click through this build and give feedback. Therefore: every module reachable from the sidebar must be FUNCTIONAL — real data, real actions that persist. Judgment call rule: a smaller number of fully working modules beats a larger number of half-working ones, but the target is all of them per DESIGN_SPEC.md.

### Pixel reference

`design/despl-tracker-mockup.html` (the approved v2 mockup) is the visual source of truth. When in doubt about spacing, color, density, or an interaction, open the mockup and match it. Do not "improve" the approved design without being asked.

### Functional-first rules (demo mandate)

1. **No dead controls.** Every button, link, dropdown, and cell either performs a real action (persisted via API) or does not exist. Never ship a control that only toasts "coming soon". If a feature is out of scope, remove its control.
2. **Real data only.** All screens render from the database via API routes — no hardcoded arrays in components. Demo realism comes from the seed script (see DESIGN_SPEC.md §1), never from mock data inside the UI.
3. **Actions round-trip.** Start / Submit / Verify / Reject / File reason / Clear hold must write to Postgres, re-render optimistically, toast the result, and appear in the activity log and notifications. If the demo laptop refreshes, state survives.
4. **Gates are enforced server-side.** A stage cannot start until the previous stage is verified; QC verify/reject only for QC roles; reject requires a reason. The demo WILL include someone trying to break this — return a clean error, not a crash.
5. **Every page ships with** loading skeletons (match final layout, no full-page spinners), an empty state (one sentence + one action), an error state (what failed + retry), visible keyboard focus, and reduced-motion support.

### Aesthetic direction (non-negotiable)

Industrial control-room aesthetic. Density and precision of Linear / Vercel dashboard / Palantir Foundry. Dark theme only in v1. Data density over whitespace. Zero decorative gradients, zero glassmorphism. Instrumentation, not marketing.

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

- Read `DESIGN_SPEC.md` fully before any session; it is the execution contract. Use the `frontend-design` skill for any new visual surface.
- Work in the session order in DESIGN_SPEC.md §9. One module per session. Do not start a new module until the previous one passes its acceptance checks.
- End every session by: (1) running the app and clicking every control you built, (2) checking the Demo Readiness checklist items for that module (§8), (3) listing which hard bans you verified.
- Never invent schema — extend the existing Postgres schema via migrations, keep RLS intact, and keep all writes going through API routes with server-side role checks.
- If mockup and spec conflict, the spec wins; note the conflict in your summary.
