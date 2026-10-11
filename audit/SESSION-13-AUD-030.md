# SESSION 13 — AUD-030 · Excluded processes still count in stage-status rollups

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/07_PROJECT_AUDIT.md` §9 (view layer), `audit/20_REMEDIATION_ROADMAP.md` Phase 1b item 13.*
*Coordination note: this session edits the same view family that AUD-002
(Session 03) and AUD-027 (Session 07) already touched. Read "Coordination
with prior view sessions" before writing any SQL.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session fixes a stage-status
rollup defect: a job that legitimately excluded an optional process (e.g. no
PWHT required for this spec) still has that process counted against it in
every dashboard's percent-complete and stage-status numbers.

### Read before writing anything

1. `audit/07_PROJECT_AUDIT.md` §9 (AUD-030).
2. **The current, live migration** —
   `prisma/migrations/20260908100000_tenant_scoped_status_views/migration.sql`.
   Read this file **in full**. This is the actual merged output of Session 03
   (AUD-002) and is the current source of truth for both views' bodies — do
   not build on top of any older migration file or on the audit document's
   own quoted snippets, which predate this fix.
3. `prisma/schema.prisma` — `model JobProcess`, specifically the `included`
   field, and `model TemplateProcess`'s `optional` field (the one Session 12 /
   AUD-033 gates at intake time — this session is a different fix: it's about
   what happens to the *rollup* once a legitimate exclusion exists, not about
   whether the exclusion itself was allowed).
4. `grep -n "included" prisma/migrations/20260908100000_tenant_scoped_status_views/migration.sql`
   — confirm today's view body never references `job_processes.included` at
   all.

### Coordination with prior view sessions

This is the **third** session in this audit batch to modify
`v_unit_stage_status`'s / `v_process_plan_percent`'s migration chain (after
Session 03/AUD-002's tenant-scoping fix and Session 07/AUD-027's IST-overdue
fix). If you are running this session before either of those has landed,
**stop and check the actual current file** — `prisma/migrations/` — for
whichever of `20260908100000_tenant_scoped_status_views` or a later
AUD-027 migration is the newest one touching these two views, and build your
`CREATE OR REPLACE VIEW` on top of **that** file's body, not the one quoted
in this prompt. Every session in this batch that touches these views must
compound on the previous one's actual output, never a stale copy. State in
your PR description exactly which prior migration file you built on top of.

### The defect

The current `exploded` CTE (from the migration read above) joins every
`job_processes` row for the job's active schedule run into the per-unit
stage rollup with no filter on `included`:

```sql
-- exploded CTE, current body (paraphrased from the migration you just read —
-- verify against the actual file, don't trust this paraphrase as gospel)
SELECT ..., jp.id AS job_process_id, jp.code, pp.status, pp.percent_complete
FROM job_processes jp
JOIN process_plans pp ON pp.job_process_id = jp.id AND pp.unit_id = u.id
WHERE jp.job_id = j.id
```

A `JobProcess` with `included = false` (a legitimate, allowed exclusion —
e.g. PWHT not required for this spec) never gets a `ProcessPlan` row created
for it in the first place (confirm this against `job-intake.service.ts`'s
`jobProcess.createMany`/`processPlan` creation logic — the `included: false`
rows should already be plan-less by design). So today, an excluded process
typically drops out of the `exploded` CTE naturally via the `JOIN` to
`process_plans` finding nothing — **except** anywhere the rollup counts
*expected* stages independent of whether a plan exists (denominator
calculations), which is where the real bug lives. Locate this precisely:

```bash
grep -n "job_processes\|process_plans" prisma/migrations/20260908100000_tenant_scoped_status_views/migration.sql
```

Read every place `job_processes` is joined or counted in both view bodies. If
you find a denominator (e.g. total expected stages, or `v_process_plan_percent`'s
weight sum) that counts `job_processes` rows directly rather than joining
through `process_plans`, that is the actual defect — an excluded process
still contributes to "total stages required" while contributing zero to
"stages complete," permanently capping that job below 100%. Confirm this
precisely against the live file before writing your fix — do not assume the
audit document's abstract description maps onto a specific line without
checking.

### Your task

Add `AND jp.included = true` to every place either view body references
`job_processes` directly (both in the `exploded` CTE's join/filter and in any
`v_process_plan_percent` weight/denominator calculation that reads
`job_processes` rather than `process_plans`). Write this as a new
**`CREATE OR REPLACE VIEW`** migration, layered on top of the current bodies
you read in step 2 above — reproduce the **entire** current view definitions
verbatim except for this one predicate addition, so the diff is exactly the
`included` filter and nothing else. Do not restructure the CTEs, rename
columns, or otherwise refactor while you're in there.

Since `security_invoker=true` on these views (confirm this is still set in
the current migration) means RLS is evaluated as the querying role, adding a
plain boolean predicate here has no RLS implication — this is a pure logic
fix.

### Details that matter

- **Confirm the fix target is the denominator, not the numerator.** If your
  reading of the current view shows `job_processes` is *only* ever reached
  through a `JOIN process_plans` (meaning excluded processes, having no
  `ProcessPlan`, already fully drop out), then there is no bug in the
  `exploded` CTE itself, and you need to look specifically at
  `v_process_plan_percent`'s completion-percentage weighting — re-read the
  audit's own reproduction steps in `audit/07_PROJECT_AUDIT.md` §9 to confirm
  exactly which number was proven wrong (percent-complete pinned below 100%,
  or a stage tile showing "pending" forever, or both) and trace that specific
  number's SQL, not just the first `job_processes` reference you find.
- **A job with zero exclusions must be byte-for-byte unaffected** — `included
  = true` is the default and the overwhelming majority case; your fix should
  produce an identical result set for every job that never excluded anything.
- **This is unrelated to schedule-run grain** (Session 08/AUD-034) — don't
  touch anything about `is_current`/`equipment_id` in this session, only the
  `included` predicate.

### Constraints — these are binding

- **`CREATE OR REPLACE VIEW` only** — do not `DROP VIEW`. Confirm column
  list/order/types are unchanged (`\d+ v_unit_stage_status` before and after
  in your rehearsal), since dependent views/queries key off column names.
- **Reproduce the full current view body** in your migration — do not write
  a diff-style partial `ALTER`; Postgres views require the complete
  definition on every replace.
- **No schema/model change** — `JobProcess.included` already exists.
- Follow `MERGE-RUNBOOK.md`'s rehearsal procedure.

### Tests

Add to whichever test file covers these views today (check
`grep -rln "v_unit_stage_status\|v_process_plan_percent" src --include=*.test.ts`;
if none exists, this is a good session to add one, following this project's
DB-gated fixture convention):

| # | Scenario | Expect |
|---|---|---|
| 1 | Job with a legitimately excluded optional process (real seed data or Session 12's fixture, if that session has run) | that job's percent-complete can reach 100% once all *included* processes finish; the excluded process's stage does not appear in `v_unit_stage_status`'s per-unit rollup at all |
| 2 | Same job, before all included processes finish | percent-complete reflects only included processes in both numerator and denominator — confirm the specific number the audit's reproduction flagged (check §9's reproduction table for the exact expected value) |
| 3 | Job with zero exclusions | unaffected — identical output to pre-fix, for both views |
| 4 | Job with a schedule run whose `job_processes` includes a process excluded via `excludedProcessCodes` (if Session 12 has run, one refused as non-optional should never reach this state — but confirm a *legitimately allowed* optional exclusion still flows through end-to-end here) | consistent with #1 |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

Then, on your rehearsal database: `\d+ v_unit_stage_status` and
`\d+ v_process_plan_percent` before and after — confirm identical column
lists.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State explicitly which
   prior view migration you built on top of (per "Coordination" above), and
   confirm you traced the fix to the correct one of numerator/denominator
   per "Details that matter."
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-030** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-033 | Whether the exclusion itself should have been allowed — Session 12's finding, different file (`job-intake.service.ts`) |
| AUD-002, AUD-027 | Tenant-scoping and IST-overdue fixes to these same views — already-merged/already-drafted sessions; build on top of their output, don't re-touch their logic |
| AUD-034 | Schedule-run grain integrity — unrelated defect, same view family |

## PASTE TO HERE
