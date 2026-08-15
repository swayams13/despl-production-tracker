# CLAUDE.md — DESPL Production Tracker

Project guide for Claude Code / AI-assisted build sessions. **Read `docs/BUILD-SPEC-v2.md` first** — it supersedes the scheduling, granularity and stack sections of `docs/PRD.md` and `docs/TRD.md`. Update `progress.md` at the end of every working session.

> Full cross-project context pack (status, roadmap, decisions, deployment, known issues) lives in the Obsidian vault: `/Users/sonusingh/SWAYAM OS/4_Projects/Client Work/DESPL/DESPL TRACKER/`. The repo's `progress.md` is canonical; the vault mirrors it — update `progress.md`, then sync the vault (`CURRENT_STATUS.md`, `TASKS.md`, `CHANGELOG.md`) and run `link_vault.py` if doc files were added or renamed.

## What this project is

End-to-end production tracker for DESPL (Dhruv EPC Solutions, Vedanta Group). Tracks pressure-vessel manufacturing from PO to dispatch across all departments: 25-stage work-order process, QCP/ITP checkpoints with P/W/H hold points, BOM + heat-number traceability, welding productivity, deadline/KPI accountability, and daily management visibility (MD, CEO, Production Head "SJ"). v1 pilot job: DESPL-320 (9 HP air receivers, serials 320SR01–09).

## Stack  *(revised 11 Aug 2026 — replaces the split monorepo in TRD §2)*

TypeScript strict everywhere. Single Next.js full-stack app.

- Next.js 15 (App Router) PWA, Tailwind v4 + shadcn/ui, TanStack Query v5
- Server Actions + Route Handlers (`/api/v1`) instead of a separate NestJS service
- Prisma 6, PostgreSQL 16. Background jobs via Next.js route + cron (BullMQ/Redis only if load demands it)
- `lib/services/` holds ALL business rules — Server Actions and Route Handlers are thin callers, never rule-holders
- `lib/schedule/` holds the scheduling engine (envelope, CPM, forward/backward, feasibility, override)
- `lib/shared/` — zod schemas, types, constants (roles, process/status enums, error codes)
- Deploy: Railway (staging auto-deploys from `main`; production is manual promote). CI: GitHub Actions (lint → typecheck → test → build → migrate → deploy).

## Model usage

**Opus for architecture, specification and decisions. Sonnet for coding sessions.**

## Commands

```bash
pnpm install
pnpm dev          # web :3000, api :4000 (turbo)
pnpm db:migrate   # prisma migrate dev (apps/api)
pnpm db:seed      # seed roles, departments, PV template, demo data
pnpm test         # vitest unit + supertest API
pnpm e2e          # playwright
pnpm lint && pnpm typecheck
```

## Non-negotiable invariants (the product's whole credibility rests on these)

1. **No client timestamps.** Actual dates/times are set server-side from the DB clock. No request DTO may contain `actual_*` or `*_at` fields. Ever.
2. **Hard sequential gating.** A stage starts only when its predecessor DAG (`stage_predecessors`) is COMPLETE and material deps are satisfied. Enforced in `StageService` inside a transaction — never only in the UI.
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

## Conventions

- zod schema in `packages/shared` is the single source of validation truth (client + server import it).
- NestJS: one module per PRD §6 domain (`auth, users, departments, templates, jobs, units, stages, checkpoints, bom, welding, delays, notifications, dashboards, audit`). Controllers thin; rules live in services.
- Prisma: forward-only migrations, snake_case tables, enums for statuses. Never edit an applied migration.
- Frontend: mobile-first for supervisor/QC screens; role-based landing (supervisor → "Today" priority list, MD/CEO → company dashboard). English-only strings, but ALL user-facing text goes through the i18n string table (`packages/shared/strings`) — Hindi/Gujarati arrives later as translation only.
- Time zone: store UTC, display IST (Asia/Kolkata).
- Tests: any change to the state machine, gating, RBAC, or audit paths requires table-driven tests for the violation cases, not just happy paths.

## Deferred to Phase 2 — do NOT build yet (but don't paint into a corner)

Email/WhatsApp delivery (daily brief payload is already email-ready jsonb) · geo-tagged in-app photo proof · file uploads (MTCs, reports, MDR compilation — schema keeps `record_type`/refs as text now) · TPI/client portal (Viewer role reserved) · additional equipment templates · offline writes.

## Pending inputs from DESPL

Now tracked as C1–C12 in `docs/BUILD-SPEC-v2.md` §7 with the default in use for each. **C1 (working vs calendar days) is the highest-impact one** — it changes every computed date. Still outstanding from before: welder list · weld-map joint numbering · department supervisor + representative names (C9).

## Session discipline

End every session by updating `progress.md`: what shipped, decisions made, blockers, next steps. Keep the demo script (`docs/demo.md`, once created) in sync — the demo to MD/CEO includes deliberately attempting violations and showing the refusals.
