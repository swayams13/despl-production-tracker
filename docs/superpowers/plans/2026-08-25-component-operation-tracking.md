# Component Operation Tracking (Sub-Assembly Fabrication Tracker) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `<BomPanel>` route-step list — currently a read-only projection ("Shell: Cutting NOT_STARTED, Forming NOT_STARTED, ...") — into a real tracker: Start / Submit / Verify buttons per operation, persisted, so a floor supervisor can mark a fabrication step started/ended and QC can verify it, the same way the app already does for the 36-process schedule, followed by the assembly/weld sequence. This is the software counterpart of `docs/DESPL-320-PRODUCTION-TRACKER-ASSEMBLY-SUBASSEMBLY-v1.md` and its companion `DESPL-320 Production Tracker.xlsx` — the reference documents for this feature's scope and grain (unmodified `component-routes.json` routes, no split steps) — those are a bridge until this ships, not a parallel system.

**Why now:** the read side already exists (`src/lib/services/bom-route.ts`'s `projectComponentRoute`, wired into `<BomPanel>` per `src/components/industrial/bom-panel.tsx`) — it merges the canonical `RouteStep` sequence with actual `ComponentOperation` rows and renders NOT_STARTED for anything not yet tracked. What's missing is the write path: no Server Action, no service function, and (for DESPL-320 specifically) no `Component`/`ComponentOperation` rows to act on at all yet. This plan closes both.

**Architecture:** Mirrors `process.service.ts`'s state machine exactly, scaled down for `ComponentOperation`'s simpler shape — see `src/lib/services/component.service.ts` (drafted, not yet reviewed or wired in) for the reasoning on where it diverges (flat sequential route instead of a DAG, no HOLD state, reject left for a fast-follow). No new tables; no migration.

**Tech Stack:** Next.js 15 App Router (Server Actions), TypeScript strict, Prisma 6 / PostgreSQL 16, Vitest.

---

## Global constraints (copied from CLAUDE.md — apply to every task)

- **No client timestamps.** `startedAt`/`finishedAt` are server-clock only, same as every other action in this app.
- **Hard sequential gating**, adapted for a flat per-component route: operation N cannot start until operation N-1 on the *same component* is COMPLETE.
- **Maker–checker.** Verify requires the QC role AND `actor != submittedBy`. No admin exception.
- **Append-only audit.** Every mutation writes `audit_log` in the same transaction.
- **RBAC deny-by-default**, department-scoped via `OperationRef.defaultDepartmentId`.
- **Refusals must be explainable** — reuse the existing stable error codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `INVALID_STATE_TRANSITION`, `NOT_FOUND`, `FORBIDDEN`); no new codes needed for this feature.
- **No dead controls / real data only** — the Start/Submit/Verify buttons must round-trip to Postgres like every other action in the app; nothing renders until DESPL-320 actually has `Component` rows (Task 1).
- **Never sum/guess a schedule** — out of scope here; this feature doesn't touch `lib/schedule/`.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `seed/despl-320-components.json` | The 11-component-per-unit register (tag, type, material, weld-joint refs) | **Delivered** |
| `scripts/seed-despl320-components.ts` | Idempotent seed: creates `Component` + `ComponentOperation` (all NOT_STARTED) for DESPL-320's 99 rows, from the file above | **Drafted, not run** |
| `src/lib/shared/schemas.ts` | Add `startComponentOperationSchema` / `submitComponentOperationSchema` / `verifyComponentOperationSchema` | **Code drafted in Task 2 below — needs merging in by hand** |
| `src/lib/services/component.service.ts` | The state machine: `startComponentOperation` / `submitComponentOperation` / `verifyComponentOperation` | **Drafted, not reviewed, not wired in** |
| `src/lib/services/component.service.test.ts` | Table-driven tests, same shape as `process.service.test.ts` — every violation case, not just happy paths (CLAUDE.md's testing convention) | **Not started** |
| `src/app/actions/component.ts` (new) | Server Actions wrapping the three service functions, `Date ↔ string` boundary conversions | **Not started** |
| `src/components/industrial/bom-panel.tsx` | Wire Start/Submit/Verify buttons onto each operation row (currently read-only + "Record MTC…" only) | **Not started** |
| `package.json` | Add `"db:seed:despl320-components": "tsx scripts/seed-despl320-components.ts"` | **Not started** |

---

## Task 1: Seed DESPL-320's component register

**Do this first** — nothing else in this plan has data to act on until it's done, and it's the lowest-risk task (additive, idempotent, no schema change).

- [ ] Review `scripts/seed-despl320-components.ts` (drafted alongside this plan) — confirm it matches the team's actual conventions for a standalone seed script (see `scripts/bootstrap-schedule.ts` and `scripts/seed-despl320-and-de0467.ts` for precedent).
- [ ] Add the `db:seed:despl320-components` script alias to `package.json`.
- [ ] Run it against `despl_test` first (`pnpm test:db`'s DB), confirm 99 `Component` rows + their `ComponentOperation` rows land correctly, re-run once to confirm the idempotency guard (`skipped` count matches `created` count from the first run, `created` is 0 the second time).
- [ ] Only after that: run against `despl_demo`/`despl` per the team's own consent gate for touching those databases (see the portfolio-dashboard plan's environment note for the exact `despl` vs `despl_demo` distinction — do not run `RUN_DB_TESTS=1`-style scripts against the wrong one).
- [ ] Confirm in a live browser session (real `/login`, no forged session — CLAUDE.md's explicit rule) that DESPL-320's job page BOM tab now shows all 11 components with their full route, all NOT_STARTED, instead of empty.

**Known gap, not blocking:** `Component.bomItemId` stays null for all 99 rows — there's no real procurement BOM export for DESPL-320 (unlike DE0463/DE0467). If DESPL wants procurement-level tracking (indent/PO/material-received status) for these components before fabrication starts, that needs a real BOM CSV/export from them first, ingested the same way DE0467's was. Material/size/qty for now live only in `seed/despl-320-components.json` and the companion workbook.

## Task 2: Wire the write path

- [ ] Merge this into `src/lib/shared/schemas.ts`, near `startProcessSchema`/`submitProcessSchema`/`verifyProcessSchema` (reuses the `id` helper — `z.number().int().positive()` — already defined at the top of that file):

  ```ts
  /** Start a component operation (sub-assembly fabrication step). */
  export const startComponentOperationSchema = z.object({ componentOperationId: id }).strict();
  export type StartComponentOperationInput = z.infer<typeof startComponentOperationSchema>;

  /** Submit a component operation for QC verification (maker step). */
  export const submitComponentOperationSchema = z.object({ componentOperationId: id }).strict();
  export type SubmitComponentOperationInput = z.infer<typeof submitComponentOperationSchema>;

  /** Verify a submitted component operation (checker step, maker-checker enforced in the service). */
  export const verifyComponentOperationSchema = z.object({ componentOperationId: id }).strict();
  export type VerifyComponentOperationInput = z.infer<typeof verifyComponentOperationSchema>;
  ```
- [ ] Review and land `src/lib/services/component.service.ts` (drafted alongside this plan). Points to check specifically in review, called out in the draft's own comments:
  - The sequential-route gate (`previousOp.status !== "COMPLETE"`) — confirm "flat sequence, no DAG" is actually right for every route in `component-routes.json`, not just the ones this plan was written against (PLATE/DISHED_END/SKIRT/FLANGE/PIPE/FORGING/COUPLING).
  - `requireOperationDepartment`'s fail-loud-on-null behavior — confirm every `OperationRef` row actually has `defaultDepartmentId` set (it should, per `component-routes.json`'s own `dept` field on every canonical operation) rather than this ever firing in practice.
  - `reject` is intentionally not implemented — see Task 4.
- [ ] Add `component.service.test.ts` — table-driven, mirroring `process.service.test.ts`'s structure: every transition, every violation (wrong role, same-actor maker-checker violation, out-of-order start, wrong tenant, client-user attempt).
- [ ] Build `src/app/actions/component.ts` — three Server Actions, same `Date ↔ string` boundary pattern as `src/app/actions/job-intake.ts`.

## Task 3: Wire the UI

- [ ] In `src/components/industrial/bom-panel.tsx`, add Start / Submit / Verify buttons to each operation row (currently expand/collapse only, per the existing `openSeq` state) — role-correct per the acting user, same as `<StageSheet />`'s pattern for `ProcessPlan`.
- [ ] Optimistic re-render + toast on each action (functional-first rule — no dead controls).
- [ ] Confirm the demo's deliberate-violation script still works here too: a non-QC user attempting Verify, or the submitter attempting to verify their own submission, must return a clean refusal, not a crash.

## Task 4 (fast-follow, not blocking the above): reject with a reason

`ComponentOperation` has no field to durably record a rejection reason — `DelayReason` is keyed to `processPlanId` only. Two ways to close this, pick one when this is actually needed:
1. Add a nullable `componentOperationId` to `DelayReason` (migration) so rejections are queryable the same way process delays are.
2. Store the reason in `audit_log`'s jsonb payload only (no migration, but not queryable/reportable the same way).

## Resolved: "rolling" vs "forming" — do not split

Settled by the user (25 Aug 2026): "rolling" and "forming" in the original ask were an example of fabrication-level tracking, not a request to split them into two separately-timed steps. Track fabrication as the single existing `PLATE` route already defines it (`FORMING`, printed "Rolling/Forming," one `ComponentOperation` row) followed by assembly — same as every other component type. No change to `component-routes.json`, no new `OperationRef` row. An earlier draft of the operational workbook (v2) split this into two rows; that draft is superseded — `docs/DESPL-320-PRODUCTION-TRACKER-ASSEMBLY-SUBASSEMBLY-v1.md` and its companion `DESPL-320 Production Tracker.xlsx` are the reference going forward, and `scripts/seed-despl320-components.ts`/`src/lib/services/component.service.ts` were already written against the unmodified route (they never split it) — no code change needed there either.
