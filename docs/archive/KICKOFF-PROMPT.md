You are the Principal Engineer executing the DESPL Tracker engineering plan.

An independent engineering audit has ALREADY been completed. Do not perform another audit.
Do not recreate it. Do not re-report its findings back to me.

## Reference documents — read all four before doing anything

1. `docs/AUDIT-master-engineering-review-v1.md` — the audit. Findings, severities, roadmap.
2. `docs/AUDIT-addendum-fabrication-and-assembly.md` — **supersedes the main audit's phase order.**
   The first deliverable is fabrication and assembly production tracking. This document defines it.
3. `docs/DESPL-320-fabrication-assembly-spec.md` — the **functional spec** for the deliverable:
   the 54 fabrication operations per unit across 11 components, the 54-checkpoint assembly and weld
   sequence (groups A–Q) with DESPL and BUYER_TPI P/W/H codes, the column contract the floor
   records against, and the open questions. Generated from
   `docs/DESPL-320 Fabrication Operations Tracker.xlsx`, which remains the source of truth — open
   the workbook with a script if you need a cell the markdown does not carry.
4. `docs/PHASE-PROMPTS.md` — §0 standing rules and the per-phase briefs. Every session after this
   one is driven from it.

Also: `docs/superpowers/plans/2026-08-25-component-operation-tracking.md` — the existing task list
for the component write side.

Also relevant: `seed/despl-320-components.json` (99 component rows, never ingested),
`scripts/seed-despl320-components.ts`, `seed/component-routes.json`.

`CLAUDE.md` is stale in seven places — the audit §6 lists them. Where CLAUDE.md and the code
disagree, trust the code and flag the doc.

## Step 1 — Bounded verification, NOT a re-audit

Before planning, verify these eight specific claims against the actual repository and, where a
database is available, against live data. Report each as CONFIRMED / PARTLY / NOT CONFIRMED /
MORE SEVERE, with file:line evidence. Timebox this — it is a spot-check, not an investigation.

1. `_shared.ts` `persistScheduleRun` writes `status: "NOT_STARTED"` with no carry-forward of
   `actualStart` / `actualFinish` / `submittedBy` / `verifiedBy`, and `updateJobDatesAction`
   triggers it. (Audit C1 — the most severe finding.)
2. `recordQcpExecution` and `recordMtc` perform no tenant-ownership check on their input ids, and
   `nudgeQc` imports no authz functions. (Audit C3.)
3. `bom.read.ts` bomless-component query filters by `equipmentId` with no `unitId`. (Addendum F2.)
4. DESPL-320 has zero `BomItem` and zero `Component` rows; DE0467 has a BOM and zero `Unit` rows.
   (Addendum F1.)
5. `component.service.ts` exports start/submit/verify and no reject. (Addendum F5.)
6. `ComponentOperation` has no operator, remarks, or quantity columns. (Addendum F3, F4.)
7. `OperationRef.leadTimeProcessSeq` has exactly one consumer, in `bom.read.ts`, and it is
   display-only — no gate and no percent-complete reads it. (Audit §V2, Addendum §3.)
8. `login()` has no rate limiting and writes no audit row on failure. (Audit C4.)

If any claim is materially different from what the code shows, say so plainly and stop before
planning work that depends on it.

## Step 2 — Understand before changing

For the phase you are planning only, inspect the relevant code: where the change belongs, what it
interacts with, what tests already exist, what migration risk it carries. Do not survey the whole
repository again.

## Step 3 — Preserve what works

Do not rewrite functioning architecture to make code look cleaner. Specifically do NOT casually
replace: authentication, RBAC/authz, the audit + domain-event infrastructure, the process state
machine and gating, the QCP/ITP engine, template versioning, or `lib/schedule/`'s envelope,
calendar and feasibility modules. The audit rates these as the strongest part of the codebase.
Modify them only where a documented finding or a Phase dependency requires it.

Two of them need surgical fixes, not replacement: `persistScheduleRun` (carry actuals forward)
and `override.service.ts` (stop restamping the min-envelope).

## Step 4 — Phase order

Follow the addendum's order, not the main audit's:

- **PHASE 0** — Safety and integrity. Reschedule actual-loss fix; the three cross-tenant writes;
  login rate limiting + failed-login audit; structured logging + `/api/health` + `error.tsx`;
  PITR and one restore drill; move `migrate deploy` out of container boot; delete demo scaffolding
  (`/kit`, `/component-gallery`, `_demo.ts`, the ⌘K toast, dead models and dependencies);
  parameterise `/workspace` by job; one IST business-day helper; correct `CLAUDE.md`.
- **PHASE 1** — Fabrication tracking. F2 → F1 → F3 → F4 → F5 → F7, per the addendum.
- **PHASE 2** — Assembly tracking. `AssemblyStep`, weld-joint and QCP linkage, welder registry CRUD.
- **PHASE 3** — The rollup. Percent-complete as projection; `submitProcess` component gate.
- **PHASE 4** — BOM hierarchy, numeric quantities, revisions, materials, procurement.
- **PHASE 5+** — NCR/paint/packing/dispatch, then enterprise UX, then intelligence and performance.

Do not jump ahead because a later feature is more visually attractive.

## Step 5 — Plan, then stop

Produce the **Phase 0 implementation plan** and stop. The plan must contain, per work item:

- objective
- current implementation (file:line)
- required change
- files and modules affected
- schema changes and migration strategy
- API / server-action changes
- frontend changes
- tests to add (violation cases, not just happy paths)
- rollback strategy
- acceptance criteria
- complexity estimate

Then wait for my explicit approval. Do not implement anything before I approve.

## Rules for when implementation is approved

- Implement only the approved phase. No silent work on future phases, no unrelated refactors,
  no UI redesign, no new dependencies without justification.
- Work incrementally. After each logical group: run `pnpm test`, `pnpm test:db`, `pnpm typecheck`,
  `pnpm lint`, verify migrations, verify the affected workflow in the running app.
- Any change to the state machine, gating, RBAC or audit paths requires table-driven tests for the
  violation cases. This is an existing repository convention — follow it.
- Never forge a session token to verify a change. `CLAUDE.md`'s "Agent conduct" section exists
  because this happened once. Drive the real `/login` form, or report verification as incomplete.
- Report honestly at the end of each phase: what changed, why, files modified, schema changes,
  tests added, tests executed and their results, remaining limitations, risks, acceptance-criteria
  status, next recommended phase. Distinguish implemented / partially implemented / UI-only /
  untested / blocked. Do not describe a feature as complete because the UI exists.

## Current action

Read the four reference documents. Run Step 1's eight-point verification. Then produce the
Phase 0 plan and STOP.
