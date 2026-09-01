# DESPL Tracker — phase briefs for AI-assisted development

Operating manual for driving this build through Claude Code / Antigravity, phase by phase.

**You do not paste these briefs.** They live in the repo; the agent reads them itself. What you
paste at the start of a phase is two lines — see *How to run a phase* below.

Companion documents:

| File | Role |
|---|---|
| `docs/AUDIT-master-engineering-review-v1.md` | The audit — findings, evidence, severities |
| `docs/AUDIT-addendum-fabrication-and-assembly.md` | Supersedes the audit's phase order |
| `docs/DESPL-320-fabrication-assembly-spec.md` | The functional requirement for Phases 1–3 |
| `docs/KICKOFF-PROMPT.md` | First session only — verification + Phase 0 plan |
| **`docs/PHASE-PROMPTS.md`** | **This file — §0 standing rules, §1+ per-phase briefs** |

---

## How to run a phase

**First session ever:** paste the whole of `docs/KICKOFF-PROMPT.md`. It runs the eight-point
verification and produces the Phase 0 plan.

**Every phase after that**, paste exactly this:

```
Execute PHASE <N> per docs/PHASE-PROMPTS.md.
Follow the standing rules in §0. Read the phase brief, inspect the relevant code,
produce the implementation plan, and STOP for my approval before writing any code.
```

Then, once you've read and approved the plan:

```
Approved. Implement Phase <N> as planned. Stop and report if you hit anything that
changes the plan materially.
```

**Start a fresh session per phase.** Long sessions drift, and a phase boundary is the natural
place to reset. If a phase runs long, split it at a work-item boundary and start again with
`Continue PHASE <N>, items <x>–<y>. Follow §0.`

---

# §0 — Standing rules (apply to every phase)

### Before writing code
1. Read this file's brief for the phase, plus the audit sections it names. Do not re-audit.
2. Inspect only the code the phase touches. Do not survey the whole repository again.
3. Produce a plan and **stop**. The plan must carry, per work item: objective · current
   implementation with `file:line` · required change · files affected · schema change and
   migration strategy · API / server-action change · frontend change · tests to add ·
   rollback · acceptance criteria · complexity estimate.
4. If a finding turns out to be materially different from what the code shows, say so and stop
   before planning work that depends on it.

### Architecture that is not yours to replace
Do not rewrite these to make code look cleaner. The audit rates them the strongest part of the
codebase and they are load-bearing for everything downstream:

- authentication and session handling (`lib/auth/`)
- RBAC and authz guards (`lib/authz/`)
- the audit + domain-event infrastructure (`lib/audit/`, `db-guard.ts`)
- the process state machine and gating (`process.service.ts`, `lib/schedule/gating.ts`)
- the QCP/ITP engine and hold points (`qcp.service.ts`, `_shared.ts:331-368`)
- template versioning (`template.service.ts`)
- the pure schedule engine (`lib/schedule/envelope.ts`, `calendar.ts`, `feasibility.ts`)

Two need surgical fixes, not replacement: `persistScheduleRun` and `override.service.ts`.
Both are named in Phase 0.

### Generality: DESPL-320 is the calibration job, not the product

The application tracks **many projects across many product families** — pressure vessels, heat
exchangers, pipe spools, piping systems — for many departments. DESPL-320 is the pilot being used
to finalise the workflow. It is **not** the thing being built.

The schema already supports this and it must stay that way:

- `ProductFamily` — four families seeded: `PRESSURE_VESSEL`, `HEAT_EXCHANGER`, `PIPE_SPOOL`, `PIPING_SYSTEM`
- `ProcessTemplate` → `ProcessTemplateVersion` → `TemplateProcess`, **per family, versioned**; a job
  pins a version at intake and materialises editable `JobProcess` rows
- `RouteTemplate` is `@@unique([tenantId, componentTypeId, familyId])` with `familyId` nullable —
  a route either belongs to a family or applies to all of them
- `QcpTemplate` supports **library rows with `jobId: null`**; `createJob` takes
  `qcpTemplateSourceId` and `cloneQcpTemplate` clones by process **code**, not id, so it survives
  renumbering across template versions
- `EquipmentTypeRef` carries `familyId` and `defaultSpecs`, copied into `Job.specs` at intake
- `TemplateProcess.provisional` lets a family have a real, sourced route with unconfirmed durations
  — `lib/schedule/` refuses to compute rather than inventing dates. `PIPE_SPOOL` already works this way.

**The rule for every phase:**

1. **No literal in `src/`.** No job number, serial, component tag, operation name, group code or
   family code appears in application code. `workspace/page.tsx:8-13` (the `pilotJobId` fallback
   to `jobNumber: "DESPL-320"`) is a known, still-open violation — see item 0.13 and work item
   B3. Do not add another.
2. **Anything that varies by product family goes in a versioned template**, pinned by the job,
   materialised per unit — the same three-layer pattern `ProcessTemplate → JobProcess → ProcessPlan`
   and `RouteTemplate → RouteStep → ComponentOperation` already use. Never a per-job hand-seed with
   no template behind it.
3. **Job-specific data lives in `seed/*.json` and `scripts/`**, never in `src/`.
4. **New vocabulary is shared vocabulary.** An operation DESPL-320 needs is a new `OperationRef` in
   the tenant vocabulary and a `RouteStep` on the relevant family route — never a special case.
5. **The acceptance test for every phase:** *"If we won an identical heat exchanger tomorrow, what
   code changes?"* The correct answer is **none** — a template, a route set and a QCP get authored
   as data by an engineer, and the job runs. If a phase's work makes that answer anything other
   than "none", the design is wrong. Say so before implementing it.

Family readiness today, for context: `PRESSURE_VESSEL` has the full 36-process template and the
25-route library. `PIPE_SPOOL` has a provisional template sourced from two piping QAPs — real
sequence, no durations. `PIPING_SYSTEM` and `HEAT_EXCHANGER` have no template yet. That is a data
gap, not an engineering one, and it is the correct state.

### Repository conventions to follow
- All business rules live in `lib/services/`. Server Actions and Route Handlers stay thin.
  Pages must not reach past the service layer to `@/lib/db` — three currently do; do not add a fourth.
- Every mutation runs inside `withTenant()` and writes its audit row via `audited()` in the same
  transaction. No exceptions.
- Anchor every lookup on a table without `tenant_id` through a tenant-scoped parent. 35 of 56
  tables have no RLS; the convention is the only protection. `_shared.ts:264-286` is the pattern.
- No request DTO may accept an `actual*` or `*_at` timestamp. Zod schemas stay `.strict()`.
- Any change to the state machine, gating, RBAC or audit paths needs **table-driven tests for the
  violation cases**, not just happy paths.
- Prisma migrations are forward-only. Never edit an applied migration.
- Store UTC, display IST. After Phase 0 there is one business-day helper — use it, never a raw
  timestamp comparison for "overdue" or "on time".
- User-facing copy: plain verbs, sentence case, humanised enums. No raw enum values, table names,
  or developer commentary in the UI.

### Verification
- Never forge a session token. `CLAUDE.md`'s "Agent conduct" section exists because it happened
  once. Drive the real `/login` form through browser automation, or report verification as
  incomplete. An honestly-flagged gap is recoverable; a forged session is a live credential in a
  transcript.
- After each logical group of changes: `pnpm typecheck` · `pnpm lint` · `pnpm test` ·
  `pnpm test:db` · verify migrations · click the affected workflow in the running app.
- `pnpm test:db` runs against `despl_test`. **Never** point `RUN_DB_TESTS` at `despl_demo`.

### Scope discipline
Implement only the approved phase. No silent work on future phases, no unrelated refactors, no UI
redesign outside a UX phase, no new dependencies without justification in the plan.

### Reporting at phase end
What changed · why · files modified · schema changes · API changes · frontend changes · tests
added · tests executed and their results · remaining limitations · risks · acceptance-criteria
status · next recommended phase.

Label every item honestly: **implemented · partially implemented · UI-only · untested · blocked**.
A feature is not complete because the UI exists.

Then update `progress.md` — but write to the *top* of the file as a new `## Session —` block. Do
not append to the existing 12,000-word single lines; they are already unreadable.

---

# §1 — PHASE 0: Safety, integrity and credibility

**Objective:** stop data loss, close disclosure, become able to see a failure, and remove the
scaffolding that makes a working product look unfinished. No features.

**Why first:** Phase 3 makes stage actuals load-bearing for the floor's own data. The reschedule
bug erases exactly those. And you cannot verify anything in Phases 1–3 while three `console.error`
calls are the entire observability story.

**Read:** audit §3 (C1–C5), §4 (H1–H8), §7 (A1–A10), §17.

### Work items

| # | Item | Anchor |
|---|---|---|
| 0.1 | **Carry actuals forward on reschedule.** `persistScheduleRun` writes `status:"NOT_STARTED"` with no carry of `actualStart`/`actualFinish`/`submittedBy`/`verifiedBy`; reads filter `isCurrent`, so prior work is orphaned. Carry forward keyed on `(jobProcessId, unitId)`, **or** refuse to regenerate a run holding any non-`NOT_STARTED` plan without explicit confirmation. Add an `isCurrent` check to start/submit/verify so a stale tab cannot write to a superseded run. **Regression test must run on a job that has actuals** — the existing test does not. | `_shared.ts:194-221` · `actions/job-intake.ts:98-100` · `process.service.ts:98,120,163` |
| 0.2 | **Close the cross-tenant writes.** Anchor `recordQcpExecution`'s `qcpItemId`/`unitId` and `recordMtc`'s `bomItemId` through a tenant-scoped parent. Add authz + `audited()` to `nudgeQc`. Note `assertClientScope` is a no-op for internal users — it is not a tenant guard. | `qcp.service.ts:25-44` · `mtc.service.ts:24-29` · `notifications.service.ts:236` · `authz/index.ts:124-128` |
| 0.3 | **Negative cross-tenant test suite.** Two tenants; assert every child-table lookup from the wrong tenant returns null or throws. This closes the class, not three instances — 0.2's holes and `loadWeldJointOptions` all die to it. Replace or supplement `rls-coverage.test.ts`, which only checks tables that already opted in. | `rls-coverage.test.ts:11-45` · `welding.read.ts:216-220` |
| 0.4 | **Client users must not reach internal reads.** Make `assertNotClientUser` the default in the `route()` wrapper, with explicit opt-in for client-facing endpoints. Today a client user can `curl` stage detail and get internal delay-reason history. | `api/_lib.ts` · `stage-detail.read.ts:100-103` |
| 0.5 | **Login rate limiting + failed-login audit rows.** Reuse the windowed-audit-count pattern that already exists for password change. Failed logins currently leave no trace at all. | `actions/auth.ts:14-64` · `lib/auth/change-password.ts:44-59` |
| 0.6 | **Observability.** Structured logging with a request id; error tracking; a real `/api/health` (middleware already whitelists a route that does not exist); one `error.tsx` per route group plus `not-found.tsx`. Log refusals at info, unexpected errors at error. | `middleware.ts:14` · `api/_lib.ts:69` |
| 0.7 | **One IST business-day helper.** Route every "overdue" comparison (8 sites) and every on-time KPI (3 sites) through it. Today a stage is red from 05:30 IST on its due date, and a process verified at 10:00 on its due date counts late. `job-health.ts:62-66` already has the right shape. | `job-health.ts:62-82` · `workspace.read.ts:595-598` · `departments.read.ts:55-57` · `myday.read.ts:256-258` |
| 0.8 | **Stop the min-envelope corruption.** `applyDurationOverride` restamps `envelope*MinDays` from a min-space CPM whose lags were fitted to max durations — terminal goes 119 → ~36 and `INFEASIBLE` becomes unreachable. Stop the restamp. Block the function on jobs that have units until it is per-unit. Add a test asserting min-space CPM against the printed `finishByMinDays`. | `override.service.ts:92-98,128-150` |
| 0.9 | **Deterministic terminal.** Four processes tie at `finishByMax=119` and `loadJobSpine` has no `orderBy`, so feasibility can read `finishByMin=105` instead of 119. Select the terminal by "no outgoing edges + max envelope"; add `orderBy: { seq: "asc" }`. | `schedule.service.ts:67-69` · `_shared.ts:103` |
| 0.10 | **Guard read-path CPM.** Wrap `computeCpm` in the read models the way `override.service.ts:37-46` does. One job with an excluded provisional process currently 500s My Day for the whole tenant. | `myday.read.ts:179` · `command-center.read.ts:225` · `workspace.read.ts:33,268,561` |
| 0.11 | **Snapshot verify/reject must check `updateMany`'s count.** A 0-row update currently still writes an audit row, emits a domain event and notifies — the append-only trail records a rejection that never happened. | `client-snapshot.service.ts:155-235` |
| 0.12 | **Delete the scaffolding.** `/kit`, `/component-gallery`, `components/industrial/_demo.ts`, the ⌘K toast button, `components/ui/button.tsx`, dead models (`DispatchBatch`, `WeldLog` — keep the tables, remove them from scope docs), dead deps (`@tanstack/react-query`, `lucide-react`, `@base-ui/react`, `class-variance-authority`, the `shadcn` CLI under `dependencies`). Retarget the WCAG contrast suite off `/kit` onto a real route. | `app-shell.tsx:436` · `kit/page.tsx` · `component-gallery/page.tsx` |
| 0.13 | **Parameterise `/workspace` by job.** It is hardcoded to `jobNumber:"DESPL-320"`, so every dashboard cross-filter link silently drops all other jobs. | `workspace/page.tsx:8-13` |
| 0.14 | **Infrastructure.** Move `prisma migrate deploy` out of container start into a release step; drop `DIRECT_URL` from the runtime environment (it is the table owner and bypasses RLS *and* the audit REVOKE). Turn on PITR, run one restore drill, write the date down. Rotate the Postgres password flagged on 22 Aug. | `package.json:12` |
| 0.15 | **Docs.** Correct `CLAUDE.md`'s seven stale claims (audit §6) and invariant #2's material clause, which is factually false. Banner PRD/TRD as superseded *in the files themselves*. Mark the four superpowers specs as shipped. Split `progress.md`. Replace the `create-next-app` README. | audit §6 |

**If you need the floor deliverable sooner:** 0.1, 0.6, 0.12, 0.13 are the items that actually gate
Phase 1. The rest is genuinely urgent but does not block fabrication tracking — schedule it as
Phase 0b rather than letting it slide silently.

### Acceptance criteria
- Editing a job's dispatch date on a job with completed stages preserves every actual, status and
  signature — proven by a test that would have failed before.
- A cross-tenant read or write on any child table fails, proven by the negative suite.
- A client user calling `/api/jobs/:id/stage` receives 403.
- Repeated bad logins are throttled and appear in `audit_log`.
- A deliberate error in a read model renders a themed error page with a working retry, and the
  failure is findable in logs by request id within two minutes.
- A stage due today is not red until tomorrow; a stage finished at 16:00 IST on its due date counts on time.
- Overriding a duration leaves `envelope*MinDays` unchanged; DE0467 still reports INFEASIBLE by 22 days.
- `/workspace?job=<any id>` works.
- A restore from backup has been performed and the date recorded.
- No control in the UI does nothing.

---

# §2 — PHASE 1: Fabrication tracking

**Objective:** the floor records **every fabrication operation, on every component, on every
serial, end to end** — Started, Ended, Status, who did it, remarks, quantity where it matters —
and can reject.

**End to end here means the full component route, not a selected subset.** For a plate that is
Receipt → MTC Verification → Cutting → Edge Preparation → Rolling → Forming → Fit-up → Welding →
RT/UT → Grinding → Inspection. Every one of the 11 components carries its own route; 54 operations
per unit, 486 across the job. All of them are tracked, all of them are gated in sequence, all of
them are audited. No operation is a checkbox and none is skipped because it seemed minor.

**This is the demonstrable deliverable.** It does not need the BOM tree, materials or procurement.

**Read:** `docs/AUDIT-addendum-fabrication-and-assembly.md` §1, `docs/DESPL-320-fabrication-assembly-spec.md` §1,
`docs/superpowers/plans/2026-08-25-component-operation-tracking.md`.

**Order matters — F2 before F1**, or the first screen the team sees is unusable.

| # | Item | Anchor |
|---|---|---|
| F2 | **Add the `unitId` filter and a unit selector to the BOM panel.** The bomless-component query filters by `equipmentId` only. The seed writes real `unitId`s, so without this all 99 parts of all 9 serials render as one list. The read model's header comment claiming `unitId` is always null is stale — fix it too. | `bom.read.ts:209` and its header |
| F7 | **`Component` uniqueness → `@@unique([unitId, tag])`** for serialised components. Today's `[equipmentId, tag]` forces `SHELL-320SR01`; the spec uses `SHELL-01`. Do this while there are zero rows. | `schema.prisma:1013` |
| F7b | **Add `Component.parentComponentId`** — nullable, self-referencing FK. Migration only: no explosion, no authoring UI, no material logic. Pulled forward from Phase 4 (`docs/ADR-product-family-agnostic-platform-v1.md`'s Phase 1 schema-shape review, approved 26 Aug 2026) because `Component` has zero rows until F1 seeds it — adding this after seeding would mean a real backfill migration instead of a schema-only one. Lets F1's seed express the SKIRT's shell + base ring + 24 gusset plates as real parent/child rows instead of collapsing them into one fabrication unit (the gap F4 names). Do this before F1. | `schema.prisma:997-1027` |
| F1 | **Seed the 99 components.** Run `scripts/seed-despl320-components.ts` against `seed/despl-320-components.json` — 11 components × 9 units, with `ComponentOperation` rows from each route. Idempotent and additive. Nothing about this phase is demonstrable until it lands. | `scripts/seed-despl320-components.ts` |
| F3 | **Operator and remarks on `ComponentOperation`.** The spec's columns are *Operator / Welder* and *Remarks*. `submittedBy` is who clicked, not who welded — on the floor these are routinely different people, which is why `Welder` exists as a registry of people who do not log in. Add `performedByWelderId` / `performedByUserId` and `remarks`. Settle open question F-d first. | `schema.prisma:1023` |
| F4 | **Quantities on `ComponentOperation`** — `qtyPlanned` / `qtyGood` / `qtyRejected`. The skirt is *"skirt shell + base ring + 24 gusset plates, tracked as one fabrication unit"* — a collapse forced by the model. Without a count, "18 of 24 gussets welded" is unrepresentable and the operation sits IN_PROGRESS for days showing nothing. Settle F-c first; if the floor says done/not-done is enough for v1, migrate the columns anyway and leave the UI out. | — |
| F5 | **`rejectComponentOperation`.** Currently omitted on purpose because "a rejection reason has nowhere durable to live yet." Add `ComponentOperationRejection` (op id, reason, `DelayCategoryRef` id, rejectedBy, at) and a `REJECTED` transition returning the op to IN_PROGRESS with the rejection retained. Maker–checker applies: the submitter cannot reject their own work. Settle F-e on where work restarts. | `component.service.ts:27-29,43-58` |
| F6 | **Reconcile all 25 seeded routes against the spec's 54 operations**, so every step the floor actually performs exists as a `RouteStep` and nothing is silently folded into a neighbour. **26 Aug 2026 — closed for `PLATE`, DESPL-320's only discrepancy.** Diffing `docs/DESPL-320-fabrication-assembly-spec.md` §1 line-by-line against `seed/component-routes.json` found DESPL-320's 11 components sum to exactly 53 vs the spec's 54, and the entire gap is `PLATE` (11 steps in spec, 10 in the route) — `EDGE_PREP`/`GRINDING`/`INSPECTION` are *already* separate `RouteStep`s on `PLATE` despite their stale `GAP` annotations, so F-b was already resolved by the code, not by this session. F-a (Rolling vs Forming) resolved by direct citation, not a guess: the spec's own SHELL-01 seq 5–6 note reads *"Team asked to track Rolling and Forming as two separate timed steps"* — sourced from the workbook itself. Applied via a new `RouteTemplateVersion` (v2, not an in-place edit — invariant #9) by `scripts/split-plate-rolling-forming.ts`, generic across every job/family using `PLATE` (`familyId` is null on its `RouteTemplate`). DESPL-320 now totals 486 ops (54×9), matching the spec exactly. **Still open:** the broader `TODO_FOR_DESPL` policy question (are Edge Prep/Grinding/Inspection *always* worth their own step for every future component type) and F-c/F-d/F-e/F-f — none of those were guessed at. | `seed/component-routes.json` · spec §1 · `scripts/split-plate-rolling-forming.ts` |
| F8 | **Generalise the transition helper.** `process.service.ts` and `component.service.ts` carry structurally identical state machines. One `assertTransition<S>(matrix, action, from, entityName)` serves both — and Phase 2 needs a third. Do this here, not later. | `process.service.ts:67-88` · `component.service.ts:34-58` |
| F9 | **UI:** operation rows in `<BomPanel />` gain Started/Ended/Operator/Remarks/quantity and a Reject action alongside Start/Submit/Verify. Match the spec's column contract. Keyboard-operable. **Render from the component's route, whatever that route is** — no hardcoded operation names, no assumption of 11 components or 54 operations. A pipe spool with a 4-step route must render correctly in the same component. | `bom-panel.tsx:321` |
| F10 | **Generality check before closing the phase.** New operations go into `OperationRef` and family-scoped `RouteTemplate`s, never a DESPL-320 branch. Confirm: nothing added this phase would need changing to run a heat exchanger, and no job number, serial or component tag has entered `src/`. See §0. | — |

### Acceptance criteria
- A supervisor opens unit 320SR03, sees its 11 components and each component's ordered route.
- They start "Cutting" on SHELL-03, name the operator, finish it; both timestamps are server-clock.
- Starting "Rolling" before "Cutting" is COMPLETE is refused with `GATING_BLOCKED` and a readable reason.
- QC rejects "RT/UT" with a categorised reason; the operation returns to IN_PROGRESS, the rejection
  stays visible, and the same person cannot both submit and verify.
- Every write appears in `audit_log` and `domain_events` in the same transaction.
- The BOM tab shows one serial at a time.
- Violation-case tests exist for: out-of-sequence start, wrong department, maker–checker on verify
  and on reject, reject without a reason, and cross-tenant access.
- **Generality (see `docs/ADR-product-family-agnostic-platform-v1.md`):**
  - DESPL-320 is represented as one `Job` of family `PRESSURE_VESSEL`, with nothing about it special-cased.
  - Components and operations render from whatever route a component has — a 4-step pipe spool route
    works in the same UI as an 11-step plate route.
  - Quantities carry a unit of measure.
  - Nothing added this phase would need changing to run a heat exchanger.
  - Two projects of different families can coexist with no shared mutable state beyond the tenant.

---

# §3 — PHASE 2: Assembly tracking — the vessel, end to end

**Objective:** the entire A–Q sequence becomes tracked work with owners, timestamps and gates —
not a checklist — and the welding module stops being an empty page.

**Read:** addendum §2, spec §2 and §3.

**Scope, stated plainly, because it is larger than "welds":** the 54-step sequence runs the vessel
from document gate to MDR.

| Groups | Covers |
|---|---|
| A–B | Document and procedure gates; material inspection and traceability; weld plan |
| C–D | Shell and head prep; head sub-assembly; simulation heat treatment of the test coupon |
| E–L | Every weld on the vessel — LS-1, nozzle-to-flange, CS-2, nozzle-to-shell, CS-1, lifting lugs, nameplate bracket, skirt — each as set-up → weld → visual → NDT |
| M–N | Pre-PWHT clearance gate; heat treatment; post-PWHT visual, MPT and RT/PAUT on all joints |
| O | Hydrostatic test — clearance, test, post-hydro MPT/LPT |
| P | Cleaning, surface preparation, painting |
| Q | Nameplate verification and attachment; documentation / MDR |

So this phase is not a welding feature. **It is the back half of the vessel's life** — heat
treatment, hydro, paint and final documentation included — and it is where the QCP's hold and
witness points actually bite.

**The core structural insight:** groups E–L are welds on *the vessel*. There is no `Component`
called "the vessel"; the 11 sub-assemblies are its inputs. Assembly is a third grain and it has no
home in the schema today.

**And note what the spec conflates**, as every QAP does: 4.5 contains both *"Weld Long Seam Of
Shell (LS-1)"* — work, with a welder and a duration — and *"Weld Visual Of LS-1"* — inspection.
The system needs both, distinguished by `kind`, with the inspection steps pointing at the `QcpItem`
that governs them.

| # | Item | Notes |
|---|---|---|
| A1 | **`AssemblyTemplate` → `AssemblyTemplateVersion` → `AssemblyTemplateStep`, then `AssemblyStep` per unit.** *Read §0's generality rule before designing this — it is the phase most at risk of hardcoding DESPL-320.* Template is `(tenantId, familyId, name)`; version carries `version` + `TemplateStatus`; step carries `seq · groupCode · groupName · activity · kind (WORK\|INSPECTION) · qcpItemRef? · weldJointRef?`. A job pins `assemblyTemplateVersionId` exactly as it pins `templateVersionId`, and intake materialises `AssemblyStep` rows per unit — `unitId · assemblyTemplateStepId · seq · status · startedAt · finishedAt · performedBy · submittedBy · verifiedBy · weldJointId? · qcpItemId? · remarks`, `@@unique([unitId, seq])`. Reuse `OperationStatus` and F8's generic transition helper. **A heat exchanger's assembly sequence must then be a new template version authored as data, not a code change.** |
| A2 | **Author the A–Q sequence as `PRESSURE_VESSEL` assembly template v1** from `docs/DESPL-320-fabrication-assembly-spec.md` §2, then materialise it for DESPL-320's 9 units through the normal intake path — not a bespoke per-unit seed. The `kind` column in the spec is this document's annotation, not a workbook field; have the floor confirm the WORK/INSPECTION split before authoring. |
| A3 | **Link `WeldJoint`.** Add `componentId` to `WeldJoint` and reference it from the weld steps. This is what makes per-welder repair rate real, lets an NDT `REJECT` re-open the offending step, and makes heat-to-weld traceability reachable later. |
| A4 | **Link `QcpItem`.** Inspection steps point at the checkpoint that governs them, so `assertNoOpenHoldPoint` needs no change and the QC cockpit and assembly view stop being two truths. |
| A5 | **Welder registry CRUD.** There is currently **no write path at all** — `Welder` can only be seeded. Blocks A3 and blocks the whole welding module. Needs open question F-f answered (welder list + employee codes, outstanding since before the pilot). |
| A6 | **Assembly UI** — the A–Q sequence per unit, with the same action set as fabrication, weld joints inline on the weld steps, and NDT results attached. |
| A8 | **QCP template authoring** *(may slip to Phase 4)* — `QcpTemplate` already supports library rows (`jobId: null`) and `createJob` already accepts `qcpTemplateSourceId`, so the mechanism exists. What is missing is a UI (PRD FR-M3). Until it exists, a new family's QCP must be hand-seeded as JSON, which is the main thing standing between "we won a heat exchanger" and "the job runs". Flag it in the plan if it fits; do not skip it silently. |
| A7 | **`ComponentConsumption`** *(defer, but leave room)* — `(assemblyStepId, componentId)`. Gives the as-built record and the gate "CS-2 set-up cannot start until BOTTOM-HEAD is COMPLETE." Not required to ship this phase; required before claiming traceability. Do not paint over it. |

### Acceptance criteria
- Unit 320SR01 shows all 54 assembly steps in order, grouped A–Q, from the document gate through
  to MDR — with no group represented as a single summary row.
- Logging weld LS-1 records its welders and appears on the assembly step and in the welding module.
- Recording a PAUT/TOFD reject on LS-1 shows against the welder's repair rate and flags the step.
- Pre-PWHT clearance, heat treatment, post-PWHT NDT, hydrostatic test, painting and nameplate are
  each individually startable, submittable and verifiable — not folded into their neighbours.
- An H-coded checkpoint that is not ACCEPTED still blocks its process completing — unchanged behaviour.
- A welder can be created, edited and deactivated in the app.
- Violation-case tests for out-of-sequence assembly steps and maker–checker on assembly verify.

### Where fabrication and assembly meet
A1's `AssemblyStep` and Phase 1's `ComponentOperation` are two grains of the same thing, and after
F8 they share one transition helper. Keep them that way. When Phase 3 rolls both up into the
36-process spine, the rollup treats them uniformly — a stage backed by component operations and a
stage backed by assembly steps must behave identically. Do not build a second, parallel mechanism.

---

# §4 — PHASE 3: The rollup

**Objective:** the two trackers become one system. Small phase, highest leverage.

**Read:** addendum §3, audit §1 (V2).

`OperationRef.leadTimeProcessSeq` already exists and already carries the right values
(`CUTTING→12`, `WELDING→16`, `NDT→17`, `PAINTING→30`). Its only consumer today draws tooltips in
`bom.read.ts:139`.

| # | Item |
|---|---|
| R1 | **Percent-complete becomes a projection.** For a `JobProcess` with mapped operations, `% = complete ops / total ops` on that unit, instead of a binary plan status. Weight by `durationMaxDays` where processes aggregate — the audit's A8 covers why unweighted counts mislead. |
| R2 | **`submitProcess` gains a gate.** Refuse with a new code `COMPONENT_OPS_INCOMPLETE` if any mapped operation or assembly step on that `(process, unit)` is not COMPLETE. This is PRD FR-C2's stated purpose and the half that did not ship. |
| R3 | **One definition of percent-complete** for internal and client surfaces. They currently disagree systematically, and the client always sees the lower number. |
| R4 | **StageSheet shows contributing operations** — opening a stage shows which component operations and assembly steps back it, and their state. |

**Do R1 and R2 together.** Either alone leaves the disconnect.

### Acceptance criteria
- Verifying "Cutting" on all 11 components of a unit moves stage 7's percentage without anyone
  touching the stage.
- Submitting "Shell Welding" with an incomplete mapped operation is refused with a reason naming
  the operation.
- The client portal and the internal dashboard report the same percentage for the same job on the same day.
- Opening a stage in the StageSheet lists the operations behind it.

---

# §5 — PHASE 4: BOM, materials and procurement

**Objective:** make `bomItemId` non-null, make quantities real, and make invariant #2's material
clause true instead of aspirational.

**Read:** audit §10, §13, §9's target chain.

| # | Item |
|---|---|
| B1 | `BomItem.qtyPer Decimal` + `uom`; keep the raw CSV string as `sourceQty` for import fidelity. |
| B2 | `parentBomItemId` and `parentComponentId` — self-referencing FKs. Adjacency list is sufficient at this depth. |
| B3 | `BomRevision`; explosion from a released revision to per-unit components using `qtyPer` × parent. |
| B4 | BOM authoring: manual add/edit, spreadsheet import, master catalog. Today the only write path is `copyBom` from an existing equipment. |
| B5 | `ProcurementEvent` (append-only, with quantity) replacing the single mutable `Procurement` row. `PARTIALLY_RECEIVED` gains a number. TRD §3.5 specified this originally. |
| B6 | `StockLot` (part + heat + location + qty) and `StockTxn` (receipt / issue / return / scrap). |
| B7 | **Kit readiness gates work release** — the fourth gate `startProcess` has never had. Correct invariant #2 in `CLAUDE.md` once it is true. |
| B8 | Move `MaterialIdentification` to `componentId` with `qtyIssued`. Heat/MTC currently attaches one level above the serial — for DE0463 that is one plate line covering 40 vessels. |
| B9 | `DrawingRevision` as child rows; units pin a revision; gate cutting on RELEASED. Today revisions are mutated in place, destroying Rev A. |
| B10 | Add the ~12 missing actor FKs (`submittedBy`, `verifiedBy`, `filedBy`, `clearedBy`, …) and the partial unique index for null-grain `ProcessPlan`. |

### Acceptance criteria
- One heat number traces forward to every serial it entered; one serial traces back to every heat in it.
- Shortage is a computed number, never typed.
- A work order cannot be released without its kit, and the refusal names what is missing.
- Issuing Rev B of a drawing leaves Rev A intact and visible, and units record which revision they were built to.

---

# §6 — PHASE 5: NCR, paint, packing, dispatch

**Objective:** close the loop from rejection to disposition to rework, and make dispatch a workflow
rather than a planned date.

| # | Item |
|---|---|
| N1 | Promote Phase 1's `ComponentOperationRejection` into a full `Ncr` with disposition — use-as-is / repair / rework / scrap / concession. |
| N2 | Rework spawns real work with an owner and dates, visible in the department queue. |
| N3 | A stage cannot complete with an open NCR — new code `NCR_OPEN`. |
| N4 | Rework quantity and hours appear in the quality dashboard and department load. |
| P1 | Paint: coating system, number of coats, DFT readings; final inspection gated on DFT acceptance. The `SURFACE_PAINT` department scope already names DFT and no field stores it. |
| D1 | `Package` / packing list with contents by serial, preservation record, weight and dimensions. |
| D2 | `DispatchBatchUnit` join — which serials shipped in which batch, the single most important dispatch fact, currently unrepresentable. |
| D3 | Dispatch note, gate pass, vehicle/LR reference, **actual dispatch date** (no actual date exists anywhere today), release approval. |
| D4 | Dispatch blocked until final QC complete, MDR compiled, packing done. |

---

# §7 — PHASE 6: Enterprise UX

**Objective:** make the surface match the system. Only now — the domain model has to settle first.

**Read:** audit §12, §15, §23.

| # | Item |
|---|---|
| U1 | `<DataTable>` — sort, column visibility, sticky header, row selection, bulk actions, CSV export. Retrofit the five pure display tables first (`/jobs`, `/qc`, `/welding`, `/reports`, `/departments/[id]`); leave the stateful worklists on `ResponsiveTable` until last. ~33 hand-written tables exist across 20 files. |
| U2 | `<Form>` sharing the server zod schemas. zod is currently imported by zero client components despite being "the single source of validation truth". Retire ~15 loose `useState` from the job wizard. |
| U3 | One `statusView()`. Four status→colour maps currently disagree — `BLOCKED` is amber on two pages and grey on two others, in a product whose spec says colour is the only status channel. |
| U4 | One date formatter pinned to `Asia/Kolkata`. There are 13, two of which disagree on the same input. |
| U5 | Keyboard access: `tabIndex` + Enter on all 34 clickable non-interactive rows; fix `role="listitem"` on the spine's buttons. |
| U6 | Fix `<CountUp />` — it never reads a changed `value`, so dashboard KPIs show the previous project's numbers after a switch. |
| U7 | Global search; ⌘K palette (now that there is something worth searching). |
| U8 | Navigation per audit §23 — Materials, Quality, Dispatch sections; Command Centre with an exceptions band first; department centre into the sidebar. |
| U9 | Mobile: build `/board`, `/alerts`, `/profile` or point the icon rail at real screens. Fix the 1024px tablet collision. Bring `/portal` under the token system — it currently renders ≈3.05:1 on the one screen a customer sees. |

---

# §8 — PHASE 7: Operational intelligence

| # | Item |
|---|---|
| I1 | Exception-first dashboard band: blocked · short · failed QC · open NCR · at-risk. |
| I2 | Predictive at-risk — remaining duration vs remaining calendar. Today `AT_RISK` fires only *because* something is already overdue. |
| I3 | Full escalation ladder: T-3 due soon, T-0 due today, T+1 supervisor, T+3 Production Head, T+7 MD/CEO. Today there is one flat notification and no MD/CEO tier. |
| I4 | Delay-reason review (acknowledge / dispute) → accountability KPI. Columns exist; no flow does. |
| I5 | First-pass yield from `attemptNo`; rework hours and cost. |
| I6 | Audit viewer for Admin/MD; correction workflow with mandatory reason and a "corrected" badge. |
| I7 | CSV export and date-range filters on every dashboard table. |

---

# §9 — PHASE 8: Performance, scale and advanced scheduling

| # | Item |
|---|---|
| S1 | Cursor pagination on every list. There is no `skip` or `cursor` anywhere in the codebase. |
| S2 | Request-level caching (`React.cache`, `unstable_cache`). There is none. |
| S3 | Kill the 2N-transaction fan-out in `loadJobs` and the `de.aggregate_id::int` cast join that defeats the `domain_events` index. |
| S4 | Move `syncNotifications` off the page-load path. |
| S5 | Playwright in CI — including the refusal paths that *are* the demo script. |
| S6 | Security headers, CSP, JWT key rotation. |
| S7 | Finish RLS on operational child tables, or enforce the parent-join convention with a lint rule. |
| S8 | Honour start-to-start edge semantics in CPM (23 of 39 edges carry negative lags and currently over-react to a predecessor duration change). |
| S9 | `WorkCenter` and finite-capacity scheduling — only now, once operation quantities and times exist. |

---

# §10 — Operating notes

**When the agent disagrees with a document.** Believe the code. These documents are a snapshot;
the repo moves. A disagreement is information — have it flag the doc and carry on, not stop.

**When a plan comes back too big.** Say so and split it at a work-item boundary. A plan you cannot
read in ten minutes is one you cannot approve honestly.

**When it starts drifting into future phases.** End the session. Start a fresh one with the phase
prompt. Drift is almost always a context-length symptom, not a judgement failure.

**Do not let "the UI exists" close a work item.** The reporting rule in §0 exists because that is
the single most common way an AI-assisted build overstates itself.

**Answer the open questions before the phase that needs them.** F-a through F-f (spec §4) block
Phase 1; F-f alone blocks Phase 2 entirely. C1, C7, C21, C22, C23 (audit §10) change computed dates
and gating. None of them are engineering work — they are conversations with the floor and with DESPL.
