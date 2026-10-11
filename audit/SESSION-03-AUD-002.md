# SESSION 03 — AUD-002 · The primary status view leaks across tenants

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/11_DATABASE_AUDIT.md` §3.4, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 3.*
*This is your first migration. It is an interim, compensating fix — it does not
replace the real work tracked as AUD-001 (job-level RLS is fail-open by design;
this session does not change that).*

---

## PASTE FROM HERE

You are a Staff Full-Stack / Database Engineer working on **DESPL Production
Tracker**, a Next.js 15 + Prisma 6 + PostgreSQL 16 manufacturing execution
system for a pressure-vessel fabricator, running with Row-Level Security. This
is a single, tightly-scoped session closing one P0 data-leak from a recent
enterprise audit.

### Read before writing anything

1. `CLAUDE.md` — the project guide, especially anything about RLS and about
   manual migration discipline (`railway.json` is **not** honored by Railway's
   dashboard; migrations are applied manually — do not assume `git push`
   deploys a migration).
2. `audit/11_DATABASE_AUDIT.md` §3.3–3.5 — the finding, with live proof.
3. `docs/mos-execution/MERGE-RUNBOOK.md` — the project's own migration
   rehearsal procedure. **Follow it.** It exists because a prior session
   discovered 20 migrations sat unapplied on production for a full day; do not
   repeat that by assuming a merged PR is a deployed migration.
4. `prisma/migrations/20260815120000_v_unit_stage_status/migration.sql` — the
   view you are changing.
5. `prisma/migrations/20260905020000_operation_ref_family_seq/migration.sql`,
   the section rewriting `v_process_plan_percent` (search the file for
   `CREATE VIEW v_process_plan_percent`) — the other view you are changing.
   This is the *current* definition; an older migration
   (`20260827040000_v_process_plan_percent`) created the original but was
   superseded — do not edit that old file, and do not be confused if a stale
   copy of the view body appears there.
6. `src/lib/services/h1-job-isolation-rls.test.ts` — the test pattern you will
   follow: a `despl_web`-role client for assertions, a `DIRECT_URL` owner
   client only for fixture setup/teardown, `describe.skipIf(!RUN_DB)`.

### The defect

Both views declare `security_invoker = true`, which is correct — it means they
run with the *querying* role's own RLS policies, not the view owner's. The
problem is what they're built on:

`v_unit_stage_status` joins `units → equipments → job_processes`, with **no
join to `jobs` at all**:

```sql
FROM units u
JOIN equipments e     ON e.id = u.equipment_id
JOIN job_processes jp ON jp.job_id = e.job_id
...
```

`units`, `equipments`, and `job_processes` are all **job-grain tables covered
only by the fail-open `job_isolation` policy** (AUD-001) — they return every
tenant's rows unless the caller explicitly sets `app.job_id`, which dashboards
and status views do not do. `security_invoker=true` faithfully applies that
fail-open policy; the view just has nothing tenant-scoped to invoke it
*against*.

Live proof (already reproduced during the audit):

```sql
SET app.tenant_id='1';   -- app.job_id intentionally NOT set — the normal read path
SELECT job_id, unit_id, stage_no, fill_status FROM v_unit_stage_status ORDER BY 1,2;
 job_id | unit_id | stage_no | fill_status
      1 |       1 |        1 | idle
      2 |       2 |        1 | idle        ← Tenant Two's unit, in Tenant One's session
```

`v_process_plan_percent` is one step better off — it already joins `jobs j ON
j.id = jp.job_id` (added incidentally, to resolve `family_id` for the
lead-time fix in `20260905020000`) — but that join carries **no `tenant_id`
predicate**, so it leaks the same way.

### Your task

Write one new migration adding an explicit tenant predicate to both views,
using `CREATE OR REPLACE VIEW` (Postgres allows replacing a view's query as
long as the output column list is unchanged — it is, in both cases). The
predicate pattern, from the audit's own recommendation:

```sql
JOIN jobs j ON j.id = <job fk> AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
```

`jobs` carries the **fail-closed** `tenant_isolation` policy, so joining
through it with an explicit tenant match makes both views fail closed without
touching the `job_isolation` policy model at all — this is a view-level
compensating control, not a policy change. Use `NULLIF(..., '')` exactly as
shown (see "details that matter" below for why).

**`v_unit_stage_status`** needs a new join added — insert it right after the
existing `equipments` join, since `equipments.job_id` is already selected in
the `FROM` clause:

```sql
FROM units u
JOIN equipments e    ON e.id = u.equipment_id
JOIN jobs j          ON j.id = e.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
JOIN job_processes jp ON jp.job_id = e.job_id
...
```

**`v_process_plan_percent`** already has the join — add the predicate to its
existing `ON` clause:

```sql
JOIN jobs j ON j.id = jp.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
```

Copy each view's full current body verbatim from its migration file above and
change only the one join line in each — do not rewrite any other part of
either view's logic (the `governing`/`exploded` CTEs, the `mapped` lateral
join, the `fill_status` CASE ladder). This finding is about the missing tenant
predicate, nothing else in either view is in scope.

Your migration file needs `DROP VIEW` before each `CREATE VIEW` (Postgres
migrations in this repo don't appear to rely on `CREATE OR REPLACE` — check
how `20260905020000` did it: it dropped `v_process_plan_percent` explicitly
before recreating it, because the column/dependency situation required it. Use
the same `DROP VIEW ...; CREATE VIEW ...;` shape for consistency, and re-add
`GRANT SELECT ON <view> TO despl_web;` after each, exactly as the originals do
— a dropped-and-recreated view loses its grants.

### Details that matter

- **Why `NULLIF(current_setting('app.tenant_id', true), '')` and not a bare
  cast.** A real regression already happened here: an earlier migration
  (`20260905091500_h1_job_isolation_rls_nullif_fix`, described in
  `11_DATABASE_AUDIT.md` §3.5) had to add exactly this `NULLIF` wrapper to a
  different policy because `current_setting(...)::int` throws on an empty
  string, and a pooled-connection GUC reset produces `''`, not `NULL`. Get
  this wrong here and you turn a data leak into an intermittent 500 on every
  dashboard load. Use the pattern from that migration's *current, fixed* form
  — do not copy the pre-fix version described in the audit as "the bug."
- **`current_setting(..., true)` (the second arg `true`)** means "don't error
  if the GUC was never set at all" — returns `NULL` in that case, and
  `NULLIF(NULL, '')` is still `NULL`, so the comparison `j.tenant_id = NULL`
  correctly matches zero rows rather than throwing. This matters for any
  session that reaches the view without `withTenant` ever running (should not
  happen given how these views are queried today, but the view itself
  shouldn't depend on that).
- **This does not fix AUD-001.** After this migration, `units`/`equipments`/
  `job_processes` themselves are still fail-open at the table level for any
  *other* query that reads them directly without going through these two
  views. Say this explicitly in your PR description — do not let it read as
  "tenant isolation fixed."

### Constraints — these are binding

- **Follow `MERGE-RUNBOOK.md`'s procedure for this migration** — dump/restore
  a rehearsal copy (or use `despl_test` if the runbook says that's sufficient
  for a non-destructive `CREATE OR REPLACE`-shaped change), run
  `prisma migrate diff --exit-code` to confirm a clean apply, and do not treat
  a green CI merge as "deployed." Production migrations in this project are
  applied manually — flag in your PR exactly what still needs to happen
  post-merge, per the runbook.
- **Do not touch** the `job_isolation` or `tenant_isolation` policies
  themselves, `rls-coverage.test.ts`'s existing assertions, or any other view.
- **Do not change either view's output columns** — anything reading
  `v_unit_stage_status` or `v_process_plan_percent` today must keep working
  unmodified.
- **No application code changes in this session.** This is a pure database
  migration plus its test. If you find yourself editing a `.ts` file outside
  `src/lib/services/`'s test directory, stop — that's scope creep.

### Tests

Add a new DB-gated test file, `src/lib/services/tenant-scoped-views.test.ts`,
following `h1-job-isolation-rls.test.ts`'s exact fixture pattern (owner client
for setup/teardown via `DIRECT_URL`, `despl_web`-role client for the actual
assertions, `describe.skipIf(!RUN_DB)`):

| # | Scenario | Expect |
|---|---|---|
| 1 | Create two tenants, one job/equipment/unit/job_process each. As `despl_web`, `SET app.tenant_id` to tenant A, do **not** set `app.job_id`. Query `v_unit_stage_status`. | Only tenant A's rows come back |
| 2 | Same setup. Query `v_process_plan_percent` (needs a `process_plan` + `schedule_run` fixture per tenant). | Only tenant A's rows come back |
| 3 | Same fixtures. `SET app.tenant_id=''` (simulating a pooled-connection reset). Query both views. | Zero rows, **no thrown error** — this is the regression the `NULLIF` guards against |
| 4 | Same fixtures, tenant A's own data only, `app.tenant_id` set correctly. | Tenant A's real rows still come back correctly-shaped (a pure sanity check that the join didn't silently break the existing output) |

Test 3 is the one most likely to fail if you use a bare `::int` cast instead of
the `NULLIF` pattern — write it.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db          # RUN_DB_TESTS — never point it at despl_demo
npx prisma migrate diff --exit-code   # against your rehearsal copy, per MERGE-RUNBOOK.md
```

Then confirm:

- `git diff --stat` shows exactly one new migration directory under
  `prisma/migrations/`, plus the one new test file. Nothing under `src/app/`
  or `src/lib/services/*.ts` (non-test) changed.
- Re-run the live proof query from "The defect" above against your rehearsal
  database, as `despl_web` with only `app.tenant_id` set — confirm it now
  returns zero cross-tenant rows.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** In the description: state
   explicitly that this is an interim compensating control, not AUD-001's full
   fix, and spell out the exact manual post-merge step per
   `MERGE-RUNBOOK.md` (this migration will **not** apply itself on deploy).
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-002** closed (interim)
   with the PR reference — note in the register that AUD-001 remains open.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-001 | The underlying fail-open `job_isolation` policy on 28 tables — this session narrows two views, not the policy |
| AUD-034 | A job can hold two `isCurrent` schedule runs — both views already filter `sr.is_current = true`; do not try to fix the underlying dual-current-run bug here |
| AUD-100 | Three earlier view migrations grant to `despl_web` directly instead of `despl_app`, breaking DR rebuild order — unrelated grant-ordering issue, not this session's views |

If you find a third view or query with the same missing-tenant-predicate shape
that isn't already tracked, write it down in the LEDGER entry rather than
fixing it here — it may need its own audit finding number.

## PASTE TO HERE
