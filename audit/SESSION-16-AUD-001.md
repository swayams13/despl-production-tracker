# SESSION 16 — AUD-001 · 28 job-grain tables have no tenant column and no tenant RLS policy

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/11_DATABASE_AUDIT.md` §3 (all of it), `audit/12_SECURITY_RBAC.md` §1,
`audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 13.*
*This is the single largest and most consequential fix in the entire audit —
"L" complexity, genuinely a week, not a day. It is also the P0 that everything
else in Phase 1c depends on being closed. Budget real rehearsal time. Do not
compress this into a single sitting without a rehearsal database.*

---

## PASTE FROM HERE

You are a Staff Database Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16, multi-tenant, RLS-enforced). This
session closes the audit's headline P0: cross-tenant **read and write** on the
28 tables that hold every unit, component, process plan, BOM item, stock lot,
NCR and QC execution — proven live, not theoretical.

### Read before writing anything

1. `CLAUDE.md` — every RLS invariant, especially the fail-closed vs fail-open
   distinction and why `job_isolation` is deliberately fail-open (most reads
   are legitimately cross-job within a tenant; the missing piece is the
   *tenant* floor underneath it, not a change to job-grain semantics).
2. `audit/11_DATABASE_AUDIT.md` §3 in full — §3.1 (coverage), §3.2 (the two
   policy shapes' exact SQL), §3.3 (this finding, with the live cross-tenant
   read AND write reproduction — read the actual `SELECT`/`UPDATE` transcript,
   don't just skim the prose).
3. `audit/12_SECURITY_RBAC.md` §1 — same finding, security-team framing;
   confirms `rls-coverage.test.ts` is "structurally blind" to this class of
   gap because it filters on `tenant_id` existing at all.
4. The existing, **working** precedent for exactly this kind of backfill:
   find and read the `h1_job_id_backstop` migration in full —
   `grep -rln "h1_job_id_backstop\|H1" prisma/migrations/*/migration.sql`.
   This session's `tenant_id` backfill should mirror its shape (how it added
   the column, how it backfilled via a join to the owning parent, how it
   built the policy) as closely as the tenant/job difference allows — don't
   invent a new migration style when a working one already exists in this
   codebase.
5. `prisma/schema.prisma` — confirm the current, live list of tables with
   `job_isolation` and no `tenant_id` column by running the same live query
   the audit used (see step 1 below) rather than trusting the audit's
   table list verbatim — Sessions 08/AUD-034 and others in this batch may
   have already changed some of these tables' shapes since the audit was
   written, though not their tenant-anchoring.
6. `src/lib/db/tenant.ts` or wherever `withTenant`/the GUC-setting helper
   lives (`grep -rn "app.tenant_id" src/lib --include=*.ts`) — confirm every
   write path already sets this GUC correctly; this session adds the DB-side
   backstop, it does not change how the GUC gets set.
7. `rls-coverage.test.ts` in full — you are extending this file in the same
   PR, per the roadmap's own instruction ("Extend `rls-coverage.test.ts` with
   the `job_id` query in the same PR as #13 — that is what makes the next
   omission fail CI").

### The defect, exactly as proven live

```sql
-- 11_DATABASE_AUDIT.md §3.1
 job_isolation    |       28 |                 0   -- 28 tables, ZERO have tenant_id
 tenant_isolation |       24 |                24    -- the 24 that do are fully covered

-- §3.3 — the live reproduction, as despl_web, tenant GUC set CORRECTLY (the normal path)
SET app.tenant_id='1';
SELECT id, job_id, unit_id FROM process_plans ORDER BY id;
 id | job_id | unit_id
  3 |      2 |       2     ← Tenant TWO's row, returned to Tenant One

-- and it is not read-only:
UPDATE process_plans SET status='COMPLETE' WHERE id=3 RETURNING id, job_id, status;
 id | job_id |  status
  3 |      2 | COMPLETE    ← Tenant One modified Tenant Two's production schedule
```

`job_isolation`'s fail-open design (an unset GUC, or `job_id IS NULL` on the
row, both pass) is deliberate and correct **for cross-job reads within a
tenant** — but there is nothing underneath it that stops a request scoped to
the wrong tenant from reading or writing another tenant's rows entirely. The
28 tables simply have no tenant-grain policy at all — not a weak one, none.

### Your task

**1 — Enumerate the live table list yourself**, don't copy the audit's:

```sql
SELECT policyname, tablename
FROM pg_policies WHERE policyname = 'job_isolation'
ORDER BY tablename;
```

Cross-reference against `information_schema.columns` for a `tenant_id`
column, exactly as the audit's own query did (step 1's citation). Confirm the
count is still 28 (or note the actual current count in your PR if it's
changed) before writing the backfill migration.

**2 — For each table, determine how it reaches a `jobId`.** Some are directly
`job_id`-owned (`units`, `process_plans`, `ncrs`, ...); others are owned
transitively (e.g. a table keyed off `unit_id` where `unit_id → job_id`, or
off `component_id → unit_id → job_id`). Write out this ownership chain
explicitly for every one of the 28 tables in your PR description as a table —
this is the single most error-prone part of the migration, and a wrong join
here backfills the wrong tenant onto real production rows.

**3 — Migration, following the `h1_job_id_backstop` shape:**

```sql
-- a. add the nullable column to each of the 28 tables
ALTER TABLE <table> ADD COLUMN tenant_id integer;

-- b. backfill via each table's actual ownership chain to jobs.tenant_id
UPDATE <table> t SET tenant_id = j.tenant_id
FROM jobs j WHERE j.id = <t's own or transitive job_id> AND t.tenant_id IS NULL;

-- c. preflight check before making it NOT NULL — any row where the backfill
--    found no owning job at all (an orphan) needs manual attention, not a
--    silent NOT NULL failure:
SELECT '<table>', count(*) FROM <table> WHERE tenant_id IS NULL;
-- for each table returning > 0, STOP and investigate those specific rows
-- before proceeding — do not force a NOT NULL constraint through a data
-- problem, and do not guess a tenant for an orphaned row.

-- d. once every table is clean, make it NOT NULL and add the FK
ALTER TABLE <table> ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE <table> ADD CONSTRAINT <table>_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES organizations(id);

-- e. add the fail-closed tenant policy — AS RESTRICTIVE, so it composes
--    correctly with the existing PERMISSIVE job_isolation policy (permissive
--    policies OR together; a bare second PERMISSIVE tenant policy would not
--    tighten anything — it must be RESTRICTIVE to act as the floor)
CREATE POLICY tenant_isolation_<table> ON <table> AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);
```

**Read the audit's own construction note carefully**: *"Note that permissive
policies OR together, so the correct construction is a fail-closed
`tenant_isolation` policy plus the existing job policy recreated `AS
RESTRICTIVE`."* This means: it is not enough to just add a new RESTRICTIVE
tenant policy — the *existing* `job_isolation` policy on these 28 tables is
currently PERMISSIVE, and Postgres ANDs a RESTRICTIVE policy against the OR
of all PERMISSIVE policies for the same command. Confirm on your rehearsal
database, with `EXPLAIN`/direct testing (not just reading the DDL), that:
- a request with the tenant GUC set to the *correct* tenant and no job GUC
  still sees legitimate cross-job rows within that tenant (job_isolation's
  fail-open behavior is preserved), and
- a request with the tenant GUC set to the *wrong* tenant sees zero rows,
  regardless of the job GUC.

If your first attempt doesn't produce both of these together, the policy
combination is wrong — do not ship until both are independently verified
live, not just asserted.

**4 — Update `rls-coverage.test.ts`** so its own coverage query no longer
silently excludes tables without a `tenant_id` column — change it (per the
roadmap's explicit instruction) to check "every table with a `job_id` column
has both `job_isolation` and a fail-closed tenant policy," not "every table
with a `tenant_id` column has `tenant_isolation`." This is what makes the
*next* accidental omission (a future migration adding a new job-grain table
without its tenant policy) fail CI instead of silently reproducing this
exact bug — which is precisely what happened with AUD-080 (a separate,
follow-up session), and this test is the backstop that should have caught it.

### Details that matter

- **Do not touch `job_isolation`'s own predicate.** Its fail-open shape is
  correct and deliberate for job-grain cross-job reads within a tenant. This
  session adds a floor underneath it, not a replacement for it.
- **`organizations`, `user_roles`, `user_departments` are explicitly flagged
  as unprotected in the audit** (§1 of `12_SECURITY_RBAC.md`) but are **not**
  part of the 28 `job_isolation` tables — they have no RLS of any kind. Do
  not fold them into this session; they're AUD-080's nine-table list
  (Session 17), not this one. Confirm the boundary between "28 job_isolation
  tables missing a tenant floor" (this session) and "21 tables with zero RLS"
  (partially this session's siblings' scope, partially none of this batch's)
  before you start touching table lists — re-read §3.1's full 21-table list
  to keep the two straight.
- **This migration is large and touches production-shaped data.** Follow
  `docs/mos-execution/MERGE-RUNBOOK.md`'s full rehearsal discipline —
  against a production-like copy, not just the empty test DB — and budget
  real time for the orphan-row investigation in step 3c; do not treat an
  empty preflight result on a mostly-empty rehearsal DB as proof the real
  database is clean.
- **`ON UPDATE CASCADE`/`ON DELETE` behavior is unaffected** — you're adding
  a column and a policy, not touching the existing `job_id`-driven foreign
  key graph (that's AUD-069, a related but separate finding, likely a later
  session).

### Constraints — these are binding

- **`job_isolation`'s fail-open semantics do not change** — verify this
  explicitly, per step 3's test above, not just by inspecting the DDL.
- **The new tenant policy must be `AS RESTRICTIVE`** — a plain permissive
  policy here would not close the gap; confirm this composability live.
- **No `relforcerowsecurity`change** — the audit confirms the current
  `postgres`-bypasses-RLS behavior is deliberate (migrations/seed need it);
  this session doesn't touch that.
- **Every one of the 28 backfills needs its own explicit, reviewed join** —
  do not write one generic backfill script assuming every table has a direct
  `job_id` column; several are transitive, and getting one wrong
  mis-assigns real tenant ownership.

### Tests

Add to `rls-coverage.test.ts` and a new or existing multi-tenant integration
test file (DB-gated, two real tenants seeded):

| # | Scenario | Expect |
|---|---|---|
| 1 | Tenant A's session (correct tenant GUC, no job GUC) reads any of the 28 tables | still sees all of Tenant A's own cross-job rows — `job_isolation`'s fail-open behavior preserved |
| 2 | Tenant A's session, tenant GUC set to Tenant A, attempts to read a row actually owned by Tenant B (the exact live reproduction from the audit — a `process_plans` row for a different tenant's job) | **zero rows returned** — this is the regression guard for the actual proven bug |
| 3 | Same, but a write (`UPDATE process_plans SET status = 'COMPLETE' WHERE id = <tenant B's row>`) | **zero rows affected** — the write no longer succeeds |
| 4 | No tenant GUC set at all (session misconfiguration) | zero rows on all 28 tables — fails closed, matching every other `tenant_isolation`-covered table's existing behavior |
| 5 | `rls-coverage.test.ts`'s new coverage assertion, run against the current schema | passes; then temporarily comment out one of the 28 new policies locally and confirm the test **fails** — proving it actually catches the gap it's meant to catch |
| 6 | Every one of the 28 tables' backfill, against your rehearsal copy | zero `tenant_id IS NULL` rows remain post-backfill; any that did exist were investigated and resolved, not defaulted |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

Then, on your rehearsal database: re-run the audit's own live reproduction
from §3.3 verbatim (the exact `SET`/`SELECT`/`UPDATE` sequence quoted above)
and confirm it now returns zero rows / affects zero rows.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Include the full
   28-table ownership-chain table from step 2, and the preflight orphan-row
   findings from step 3c (even if zero) explicitly.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-001** closed with the
   PR reference — this is the finding every other Phase 1c item depends on
   in spirit even where not formally listed, so call out explicitly which
   already-closed findings (AUD-002 interim, AUD-005) can now be considered
   fully backed by a database floor rather than only application-layer
   discipline.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-080 | Nine further `job_id`-carrying tables with no RLS at all, omitted from the original H1 backstop — a related but separate follow-up session |
| AUD-069 | The `SET NULL` FKs that promote job-owned QCP rows into a cross-tenant-readable "library" state on job deletion — separate fix, separate session |
| AUD-006 | The single CHECK constraint gap — entirely unrelated to RLS |
| Any of the 21 zero-RLS tables not in the 28-table `job_isolation` set | Different finding (AUD-080's scope, or genuinely out of this audit's Phase 1 remit for the non-job-grain ones like `organizations`) |

## PASTE TO HERE
