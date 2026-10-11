# 01 — EXECUTIVE AUDIT

*DESPL Production Tracker · 7 September 2026 · HEAD `dc924c1`*

---

## The verdict in one paragraph

The engine is genuinely good. The product is not finished. This codebase has
better concurrency discipline, better error semantics and a better test suite
than most systems of its size — and almost every performance compromise in it is
already written down in a comment naming the exact scale at which it breaks. What
it does not have is an information architecture. Ten surfaces were each built
well, in sequence, against a spec that grew, and none of the earlier ones was
retired when a better answer to the same question arrived. Three screens render
the same ranked rows; the personal screen carries the department's work; the
supervisor's actual job has no screen at all. Underneath that, four defects
would let a pressure vessel ship without the inspection the system exists to
enforce, and one database-layer finding — proven with live SQL, not inferred —
means a second tenant on this deployment would be able to read and write the
first tenant's production data.

**Recommendation: do not onboard a second tenant, and do not treat a dispatch
release as compliance evidence, until Phase 1 of the roadmap is complete.**
Everything else can be sequenced normally.

---

## 1. Findings at a glance

**114 findings** after de-duplication across seven audit streams.

| Severity | Count | Meaning |
|---|---|---|
| **P0** — production blocker | **24** | Ships wrong data, wrong decisions, or wrong vessels |
| **P1** — critical | **47** | Materially degrades a role's ability to do their job |
| **P2** — important | **33** | Correctness or scale debt with a known trigger |
| **P3** — improvement | **10** | Worth doing, not urgent |

By domain:

| Domain | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| Security / RBAC / multi-tenancy | 2 | 1 | 3 | 5 |
| Data integrity & business logic | 4 | 8 | 6 | 2 |
| Information architecture & role model | 8 | 8 | 3 | 1 |
| Screen-level UX & density | 5 | 15 | 5 | 1 |
| Performance & scale | 4 | 8 | 6 | 1 |
| Failure modes & observability | 1 | 3 | 5 | 0 |
| Testing & accessibility | 0 | 4 | 5 | 0 |

---

## 2. The five things that matter most

### 2.1 A second tenant would see the first tenant's production data — proven, not suspected

**AUD-001 · P0.** The database has two RLS policy families and they are
**disjoint**. `tenant_isolation` covers 24 tables and fails closed, correctly.
`job_isolation` covers 28 tables and fails **open** by design. Every table in
that second set — `units`, `process_plans`, `components`, `component_operations`,
`bom_items`, `stock_lots`, `stock_txns`, `ncrs`, `qcp_executions`,
`dispatch_batch_units`, and 18 more — has **no `tenant_id` column and no tenant
policy at all**. A further 21 tables, including `equipments`, `job_processes`,
`schedule_runs` and `organizations` itself, have no RLS of any kind.

On a live build of all 50 migrations, connected as the application's own
`despl_web` role with the tenant GUC set correctly to Tenant One:

```sql
SET app.tenant_id='1';
SELECT id, job_id, unit_id FROM process_plans ORDER BY id;
 id | job_id | unit_id
  1 |      1 |       1
  2 |      1 |       1
  3 |      2 |       2      ← Tenant TWO's row

UPDATE process_plans SET status='COMPLETE' WHERE id=3 RETURNING id, job_id, status;
  3 |      2 | COMPLETE
UPDATE 1                    ← Tenant One modified Tenant Two's schedule
```

`v_unit_stage_status` — the view behind the stage grid on the primary screen —
returns other tenants' units on the ordinary request path (AUD-002).

**What saves you today:** the deployment is single-tenant, and the service layer's
scoping discipline is genuinely good — every mutating helper anchors through a
tenant-scoped parent. The application is not currently leaking. But the entire
operational half of the schema has **no database backstop**, and the one test
that claims to check RLS coverage (`rls-coverage.test.ts`) filters on
`tenant_id`, so it is structurally blind to the 28 tables that lack the column.
The debt was recorded in the migration's own comment in August and not paid.

### 2.2 Four defects let a vessel ship without the inspection the system exists to enforce

The hold-point engine is the reason this product is more than a spreadsheet. Four
independent findings puncture it:

- **AUD-003 (P0)** — any QC user clears a blocking `H` hold point by recording
  result `NA`. `_shared.ts:554-557` treats `NA` as cleared. The waiver columns
  (`waiverApprovedBy`, `clearedByPartyRef`, `callAttendedOn`) exist in the schema
  and have **zero references anywhere in `src/`**. CLAUDE.md invariant #4 says
  "W-waivers need Production Head approval." Half of that invariant does not exist.
- **AUD-004 (P0)** — verifying an internal assembly step auto-stamps `ACCEPTED`
  on the linked QCP checkpoint (`assembly.service.ts:257-272`) without reading
  the party codes. A checkpoint whose code is `H` for the **third-party
  inspector** is recorded as accepted, `clearedBy` naming a DESPL employee and
  `clearedByPartyRef` null. The audit trail then positively asserts an inspection
  that never happened.
- **AUD-005 (P0)** — `approveDispatchRelease` and `recordDispatch` re-check
  nothing. The quality gates run only on `addUnitToBatch`. A unit batched on
  Monday that fails PAUT on Wednesday still ships on Friday. And nothing anywhere
  requires production to be *complete* before dispatch: a unit with all 36 stages
  `NOT_STARTED` can be packed, released and dispatched with a gate pass.
- **AUD-006 (P0)** — the database has **one CHECK constraint across 73 tables**
  and **zero triggers**. Seven of eight audited impossible states were reached by
  direct insert as the app's own role, including a dispatch note issued for a unit
  with a PENDING hold point, an OPEN NCR, and `release_approved_by` NULL.

For an ASME/TPI documentation review, AUD-004 is the worst of the four: it does
not merely fail to prevent something, it manufactures positive evidence.

### 2.3 "My Day" is a department board wearing a personal title

**AUD-008 (P0).** The read model does not scope to the user at all — there is no
Prisma `where` on `assigneeUserId` anywhere in `loadMyDay`. It loads every plan in
every active job and partitions in memory into `mine`, `pool` (unassigned
department work) and `teamHeld` (other people's work), then renders all three as
permanent, always-visible sections for every role.

And every plan is **born unassigned** — `schedule.service.ts:138-150` creates one
plan per process × unit with no assignee. So the pool is 100% of the schedule at
generation. On the real DE0463 order (40 units), FABRICATION alone contributes
**8 × 40 = 320 uncapped rows** to a personal dashboard (**AUD-009**). On a phone
they render as a flat unbounded card list directly beneath the user's own three
tasks.

Meanwhile a supervisor with twelve people cannot answer "who is overloaded, who
is idle, what is unclaimed" from any screen in the product. **There is no Team
surface** — no route, no read model, no nav item (**AUD-010**). Per-person
workload exists in exactly one place, `admin.read.ts:76-88`, on a page supervisors
are redirected away from.

### 2.4 Navigation is broken in a way that makes the primary surface unreachable

**AUD-011 (P0).** There are two hard-coded, non-overlapping nav arrays in
`app-shell.tsx`, and **viewport — not role — decides which one you get**.

- `/my-day` is in the mobile list only. At ≥1024px the desktop sidebar has **no
  link to My Day at all** — yet `app/page.tsx:15` lands every SUPERVISOR and QC
  user there. Click anything once and you can never get back.
- `/dashboard`, `/departments`, `/welding`, `/reports` and `/admin` are in the
  desktop list only. An MD on a tablet in the workshop cannot open the portfolio.
- Two of the seven shop-floor nav destinations, `/board` and `/profile`, are
  pages whose entire content is the sentence *"coming in R2"* (**AUD-040**) —
  the project's own hard-banned "dead coming-soon control".

And the nav is not role-filtered at all beyond one Admin group (**AUD-012**): a
welding supervisor and a stores supervisor see identical menus, and the MD's menu
is 60% shop-floor execution screens. Compounding it, there is **no operator role**
(**AUD-013**) — every shop-floor employee is seeded `SUPERVISOR`, which is the
role that grants "assign work to your colleagues".

### 2.5 Every dashboard drill-down lands on the wrong project

**AUD-007 (P0).** `/workspace` resolves its job by looking up the literal string
`"DESPL-320"`:

```ts
const j = await tx.job.findFirst({ where: { jobNumber: "DESPL-320" } });
```

Every outbound link from the dashboard carries `dept` and `status` but **never
`job`**. So an MD looking at DE0467, who clicks its "7 overdue in Fabrication"
cell, lands on **DESPL-320's** fabrication list — same heading, same layout,
different project, no warning. This is the single most likely path to a wrong
operational decision in the product today, and it is a small fix.

---

## 3. What is genuinely solid

This must be said plainly, because the list above is long and the engineering
underneath is better than it suggests.

- **Authorization primitives are excellent.** Deny-by-default with no implicit
  admin escape, pinned by a test that says so. Roles re-read from the DB on every
  call, so revocation is immediate. `sessionVersion` gives real session
  revocation without a session table. Every one of the 26 action modules
  authenticates; the two exceptions are deliberate and documented.
- **Maker–checker is real on every verify path**, with ADMIN deliberately absent.
  The client-snapshot release flow implements the same two-person rule
  independently and correctly.
- **The append-only audit is enforced at three layers and boot-checked** — and it
  holds under live test. `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` all
  return `permission denied` as `despl_web`, while `INSERT` succeeds. Pointing
  `DATABASE_URL` at a superuser crashes the deploy rather than silently
  disabling it.
- **Concurrency on the state machine is correctly done.** `SELECT … FOR UPDATE`
  before the status re-read, one transaction per transition, a `STALE_WRITE`
  guard against superseded schedule runs, and an advisory lock on stock lots
  where table grants preclude a row lock. Double-submit, double-claim and
  concurrent verify are all safe at the level that matters.
- **`security_invoker=true` on both views.** Easy to miss, and getting it wrong
  would have converted both views into complete RLS bypasses. Verified working.
- **The two-layer schedule model is implemented as specified.** `computeEnvelope`
  contains no accumulation over predecessors; nothing sums durations anywhere in
  `lib/schedule/`. Negative lags relax scheduling and provably not gating.
- **The test suite is real** — 90 files, ~750 cases, 54 running against a seeded
  PostgreSQL 16 with the actual RLS policies applied. CI proves the migrations
  produce the schema `schema.prisma` describes. Playwright authenticates through
  the real login form and never forges a session.
- **All 50 migrations apply from scratch with zero errors.** For a set this size
  containing a table drop and a three-phase add/backfill/not-null sequence, that
  is a genuinely good result.
- **The forensic honesty is the strongest signal of all.** `MERGE-RUNBOOK.md`
  documents a real production incident with the actual `psql` output and states
  plainly that the fix is "written, not executed". `CLAUDE.md` corrects its own
  earlier false claim in place, with a date. A test file records a defect it
  found, then a second defect hidden behind the first, and refuses to paper over
  either. This audit largely confirms what the authors already wrote down.

**The core problem is not craft. It is that read models have consistently run
ahead of the surfaces that present them, and no surface has ever been retired.**
Four computed read-model fields render nowhere; five chart components are dead
code; the dashboard is a well-built single-project view being asked to do a
portfolio job it was never shaped for. Almost every recommendation in this audit
is a consolidation, not a rewrite.

---

## 4. The four questions the brief set

> **Can a new employee understand what they need to do?**

**No.** They land on My Day, where their own work is one of three lists,
sandwiched between unclaimed department work and a roster of what everyone else
is holding. The first large numbers on the page are their 30-day on-time
percentage — a performance review, before the question "what do I need to do?" is
answered. Blocked work is filed silently under "Up next", so they click Start,
get a gate refusal, and only then learn what they are waiting on — even though
the system already computed "Waiting on: Plate Rolling" and threw it away.

> **Can an experienced employee complete it quickly?**

**Partly.** The action model itself is good — one primary action per row, real
refusals with stable codes, inline refusal text on My Day. But the desktop path
requires scrolling past 300+ pool rows, the row is not keyboard-operable at all
(**AUD-064**), and on a tablet the signature control — the stage spine — is a
13×14px touch target (**AUD-067**).

> **Can a supervisor understand team problems without seeing everyone's task list?**

**No.** There is no surface that answers it. Workload-by-employee exists in one
query on a page they cannot reach. Their only team tool is a bare `<select>` of
department members with no workload context, on individual rows, on their own
personal dashboard.

> **Can management understand project health without reading operational tables?**

**No.** Roughly 15% of `/dashboard` is portfolio-grain. The rest is a full
single-project deep-dive for whichever project sorted first, duplicating
`/jobs/[id]`, `/departments` and `/qc` from a different read model — so the
numbers disagree. There is no planned-% anywhere in the codebase, so "which
projects are behind their own plan" is unanswerable. And the S-curve rebases its
planned line on every reschedule (**AUD-017**), so after one replan a project
eight weeks late reads as tracking plan.

**The architecture is not finished.** But the distance from here to finished is
mostly deletion and consolidation, which is the cheap kind.

---

## 5. Two decisions needed before Phase 1 starts

1. **C1 — working days vs calendar days.** Still open with DESPL, still marked
   PROVISIONAL in `seed/lead-time-model.json`. Every computed date in the system
   depends on it, and the read layer currently reports variances in raw calendar
   days while the engine computes in a 6-day week (**AUD-071**) — a ~15% divergence
   over a 17-week job. No date on any screen means anything until this is settled.
2. **What a client may see.** The portal today shows the *promised* date under the
   label "Forecast dispatch" (**AUD-031**), so a slipping project reads as on-time
   to the customer right up to the day it misses. Either populate a real forecast
   or rename the field — but this is a commercial decision, not an engineering one.

---

## 6. Where to start

`20_REMEDIATION_ROADMAP.md` sequences all 114 findings into eleven phases mapped
onto the existing Gate 0–4 structure. The first week is small and high-leverage:

| | Finding | Effort |
|---|---|---|
| 1 | AUD-007 — propagate `job` in dashboard links; delete the `DESPL-320` literal | S |
| 2 | AUD-002 — add a tenant predicate inside `v_unit_stage_status`'s body (interim, shippable today) | S |
| 3 | AUD-005 — move the two quality assertions into `approveDispatchRelease` and `recordDispatch` | S |
| 4 | AUD-024 — set Healthcheck Path and Pre-Deploy Command in the Railway dashboard | S |
| 5 | AUD-027 — one shared IST day marker across TypeScript and SQL | S |

Four of those five are hours, not days, and three of them close a P0.
