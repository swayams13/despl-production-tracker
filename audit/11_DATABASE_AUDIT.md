# 11 — DATABASE AUDIT

*Every claim in this document was verified against a live PostgreSQL 16 database
built from all 50 migrations. Queries and their real output are quoted verbatim.*

---

## 1. How this evidence was produced

All 50 migrations were concatenated and applied from scratch to a fresh
PostgreSQL 16.13 cluster. Checksums were verified byte-for-byte against the repo
before anything was run:

| Artifact | Repo | Container | Match |
|---|---|---|---|
| Concatenated migrations (146,374 B) | `29bc4e31d8a815070e946484c4ad2c14` | `29bc4e31d8a815070e946484c4ad2c14` | ✅ |
| `prisma/schema.prisma` (106,666 B) | `f8407f0ab6cb836704ce4321095068c0` | `f8407f0ab6cb836704ce4321095068c0` | ✅ |

Database `despl` owned by `postgres`; a non-superuser login role `despl_web`
(`rolsuper=f, rolbypassrls=f`) granted the `despl_app` bundle exactly as
`scripts/provision-db-role.sql` does. **All probe queries below run as
`despl_web` — the application's own role.**

```
psql -v ON_ERROR_STOP=1 -f /tmp/all_migrations.sql
=== EXIT: 0 ===   (zero ERROR lines, zero WARNING lines)
tables=73  views=2
```

**All 50 migrations apply from scratch with zero errors.** For a set this size
containing a table drop and a three-phase add/backfill/not-null sequence, that is
a genuinely good result and reflects disciplined migration authoring.

*(Correction to the brief: there are 50 migrations, not 51 — `ls` returns 51
entries but one is `migration_lock.toml`.)*

---

## 2. AUD-100 (P2) — the migrations do not apply from scratch on a clean cluster

The first attempt, before `despl_web` existed, produced three hard errors:

```
psql:/tmp/all_migrations.sql:1563: ERROR:  role "despl_web" does not exist
psql:/tmp/all_migrations.sql:2209: ERROR:  role "despl_web" does not exist
psql:/tmp/all_migrations.sql:3084: ERROR:  role "despl_web" does not exist
```

Three bare `GRANT SELECT ON <view> TO despl_web;` statements in
`20260815120000_v_unit_stage_status`, `20260827040000_v_process_plan_percent` and
`20260905020000_operation_ref_family_seq`. `despl_app` is created idempotently
inside a `DO` block; `despl_web` is created by a script outside the migration set
and is not guarded at all.

**Impact:** a disaster-recovery rebuild, a new environment, or a CI job that
provisions from migrations alone fails at migration #7 of 50. Under
`prisma migrate deploy`, which stops on first error, recovery halts with a
half-built schema. `MERGE-RUNBOOK.md` already documents this trap for the
rehearsal path; it applies to DR too.

**Fix.** Grant to `despl_app` instead — `despl_web` inherits it, this matches how
every other permission in the schema is granted, and it removes the dependency
entirely. Three lines, amended forward in a new migration.

---

## 3. Row-level security

### 3.1 Coverage

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid) AS n_policies
FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r';
```

**73 tables. 52 have RLS ENABLED. 0 have it FORCED. 21 have neither.**

`relforcerowsecurity = f` everywhere is deliberate and documented (*"Table OWNER
(postgres) is not FORCEd, so migrations and the seed script continue to work"*).
The consequence is that anything connecting as `postgres` bypasses all 52
policies — which is correct for migrations and is why `DIRECT_URL` exists.

**The 21 tables with no RLS at all:**

| Table | `tenant_id` | `job_id` |
|---|---|---|
| assembly_drawings | – | **✓** |
| assembly_template_steps | – | – |
| assembly_template_versions | – | – |
| client_visibility_policies | – | – |
| dispatch_batches | – | **✓** |
| equipments | – | **✓** |
| holidays | – | – |
| job_processes | – | **✓** |
| organizations | – | – |
| packages | – | **✓** |
| process_template_versions | – | – |
| qcp_templates | – | **✓** |
| route_steps | – | – |
| route_template_versions | – | – |
| schedule_runs | – | **✓** |
| template_edges | – | – |
| template_processes | – | – |
| user_departments | – | – |
| user_roles | – | – |
| weld_joints | – | **✓** |
| weld_logs | – | **✓** |

Eight carry `job_id` and were therefore *eligible* for the H1 backstop but were
omitted from its array. `organizations` — the tenant registry itself — and
`user_roles` / `user_departments` — the authorization graph — are unprotected.

### 3.2 The two policy shapes

Exactly two policies exist, applied across 52 tables. Both are PERMISSIVE, both
apply to `{public}`, both are `cmd = ALL`, and **both do have `with_check`** — so
the "writes a row it cannot read back" failure mode does not exist anywhere in
this schema. Credit where due.

**`tenant_isolation`** — 24 tables:
```
qual       = (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::integer)
with_check = <identical>
```
**Fail-closed.** Unset GUC → NULLIF → NULL → not true → zero rows.

**`job_isolation`** — 28 tables:
```
qual       = ((job_id IS NULL)
              OR (NULLIF(current_setting('app.job_id', true), '') IS NULL)
              OR (job_id = (NULLIF(current_setting('app.job_id', true), ''))::integer))
with_check = <identical>
```
**Fail-open by two independent escape hatches:** an unset GUC, and
`job_id IS NULL` on the row.

### 3.3 AUD-001 (P0) — the two sets are disjoint

```sql
SELECT policyname, count(*) n_tables,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM information_schema.columns c
    WHERE c.table_name=p.tablename AND c.column_name='tenant_id')) AS has_tenant_id_col
FROM (SELECT DISTINCT tablename, policyname FROM pg_policies) p GROUP BY 1;

    policyname    | n_tables | has_tenant_id_col
------------------+----------+-------------------
 job_isolation    |       28 |                 0
 tenant_isolation |       24 |                24
```

**All 28 job-grain tables have no `tenant_id` column and no tenant policy.**
Every unit, component, process plan, BOM item, stock lot, stock transaction, NCR,
QC execution, paint record, DFT reading, dispatch record and drawing revision is
protected at the database layer only by a policy that defaults to open.

With **no GUC set at all**, as `despl_web`:

```
 jobs (tenant_isolation)   |     0     ← fail CLOSED
 clients (tenant)          |     0     ← fail CLOSED
 users (tenant)            |     0     ← fail CLOSED
 audit_log (tenant)        |     0     ← fail CLOSED
 domain_events (tenant)    |     0     ← fail CLOSED
 units (job_isolation)     |     2     ← fail OPEN (both tenants)
 process_plans (job)       |     3     ← fail OPEN (both tenants)
```

The fail-open design is defensible in isolation — most reads are legitimately
cross-job, and the migration's own header says so. **The problem is what it
composes with.** Set the tenant GUC correctly, which is the normal request path:

```sql
SET app.tenant_id='1';                    -- Tenant One, correctly scoped
SELECT id, job_id, unit_id FROM process_plans ORDER BY id;
 id | job_id | unit_id
  1 |      1 |       1
  2 |      1 |       1
  3 |      2 |       2     ← Tenant TWO's row, returned to Tenant One
```

And it is not read-only:

```sql
SET app.tenant_id='1';
UPDATE process_plans SET status='COMPLETE' WHERE id=3 RETURNING id, job_id, status;
 id | job_id |  status
  3 |      2 | COMPLETE
UPDATE 1                  ← Tenant One modified Tenant Two's production schedule
```

For contrast, where a tenant policy *does* cover the table the write is correctly
refused:

```sql
SET app.tenant_id='1';
INSERT INTO jobs (tenant_id, public_id, …) VALUES (2, 'PUB-EVIL', …);
ERROR:  new row violates row-level security policy for table "jobs"
```

**Fix.** Denormalise `tenant_id` onto the 28 job-grain tables — a `job_id`-driven
backfill identical in shape to the existing, working `h1_job_id_backstop` pair —
then add a **second, fail-closed** tenant policy to each. Note that permissive
policies OR together, so the correct construction is a fail-closed
`tenant_isolation` policy plus the existing job policy recreated **`AS
RESTRICTIVE`**. Do not change `job_isolation`'s fail-open semantics; the tenant
policy supplies the floor.

### 3.4 AUD-002 (P0) — the primary status view leaks across tenants

```sql
-- as despl_web, tenant GUC set correctly, app.job_id NOT set
-- (the normal path: withJob() is opt-in and dashboards do not use it)
SET app.tenant_id='1';
SELECT job_id, unit_id, stage_no, fill_status FROM v_unit_stage_status ORDER BY 1,2;
 job_id | unit_id | stage_no | fill_status
      1 |       1 |        1 | idle
      2 |       2 |        1 | idle        ← Tenant Two's unit, in Tenant One's view
```

Same shape on `v_process_plan_percent`.

**The view is not the bug — it is the amplifier.** Its base tables are `units`
(fail-open) plus `equipments`, `job_processes` and `schedule_runs`, **all three
of which have no RLS at all**. `security_invoker=true` faithfully applies the
underlying policies; the underlying policies simply do not constrain by tenant.

**Interim fix, shippable today and independent of the P0 above:** add an explicit
tenant predicate inside the view body —
`JOIN jobs j ON j.id = e.job_id AND j.tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::int`.
`jobs` is fail-closed, so this makes the view fail closed without touching the
policy model.

### 3.5 The `nullif_fix` migration — a real bug, correctly diagnosed

`20260905091500_h1_job_isolation_rls_nullif_fix` replaced
`current_setting(...)::int` with `NULLIF(current_setting(...), '')::int`. **Both
sides were reproduced.** Recreating the pre-fix policy on `units`:

```sql
SET app.job_id='';  SELECT count(*) FROM units;
ERROR:  invalid input syntax for type integer: ""
SET app.job_id='';  SET enable_seqscan=off;  SELECT count(*) FROM units WHERE job_id=1;
ERROR:  invalid input syntax for type integer: ""
```
```sql
-- post-fix policy
SET app.job_id='';  SELECT count(*) FROM units;             --> 2
                    SELECT count(*) FROM units WHERE job_id=1;  --> 1
```

The planner evaluated the `::int` cast independently of the guarding `OR`
branches and threw, exactly as the migration comment claims. An empty-string GUC
from a pooled-connection reset would have produced hard 500s on every job-scoped
read. That is a difficult bug to find and the fix is correct for what it targets.

**One caveat worth recording:** the fix **converted a loud failure into a silent
one**. `app.job_id=''` now returns *all* rows instead of erroring. The crash was,
accidentally, the only thing making a GUC-reset bug visible. A non-numeric GUC
(`app.job_id='abc'`) still errors, so the cast is not fully hardened either.

---

## 4. Append-only audit — verified

```sql
SELECT table_name, grantee, string_agg(privilege_type,',' ORDER BY privilege_type)
FROM information_schema.role_table_grants WHERE table_schema='public'
AND (table_name LIKE '%audit%' OR table_name IN ('domain_events','stock_txns','procurement_events','stock_lots'))
GROUP BY 1,2;

     table_name     |  grantee  |                          privs
--------------------+-----------+---------------------------------------------------------
 audit_log          | despl_app | INSERT,SELECT
 audit_log          | postgres  | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
 domain_events      | despl_app | INSERT,SELECT
 procurement_events | despl_app | INSERT,SELECT
 stock_lots         | despl_app | INSERT,SELECT
 stock_txns         | despl_app | INSERT,SELECT
```

**UPDATE and DELETE are genuinely absent, and they bite:**

```sql
UPDATE audit_log SET action='TAMPERED' WHERE tenant_id=1;  ERROR: permission denied
DELETE FROM audit_log WHERE tenant_id=1;                   ERROR: permission denied
TRUNCATE audit_log;                                        ERROR: permission denied
UPDATE domain_events SET type='X';                         ERROR: permission denied
DELETE FROM stock_txns;                                    ERROR: permission denied
INSERT INTO audit_log (…) RETURNING id;                    --> 3   (append still works)
```

No trigger or rule backs it (`0` non-internal triggers, `0` rules). Enforcement
is grant-only and single-layer — effective against `despl_web`, defeated entirely
by any connection as `postgres`, which migrations, seeds and `DIRECT_URL` all use.
That is the correct trade-off; it is worth knowing.

Also verified: **`despl_web` cannot escalate out of this.**
```sql
ALTER TABLE units DISABLE ROW LEVEL SECURITY;  ERROR: must be owner of table units
DROP POLICY job_isolation ON units;            ERROR: must be owner of relation units
SET ROLE postgres;                             ERROR: permission denied to set role "postgres"
```

---

## 5. Constraints

### 5.1 AUD-006 (P0) — one CHECK constraint across 73 tables

```sql
SELECT rel.relname, con.conname, pg_get_constraintdef(con.oid)
FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
WHERE con.contype='c' AND rel.relnamespace='public'::regnamespace;

 tbl  |        conname         |  def
------+------------------------+-------------------------------------------------------
 ncrs | ncr_exactly_one_source | CHECK (((component_operation_rejection_id IS NOT NULL)::int
                                      + (assembly_step_rejection_id IS NOT NULL)::int) = 1)
(1 row)
```

It works:
```sql
INSERT INTO ncrs (job_id) VALUES (1);
ERROR:  new row for relation "ncrs" violates check constraint "ncr_exactly_one_source"
```

**Exactly one business rule is enforced in the database.** Everything else —
durations, sequencing, percentages, quantities, QC gating, dispatch release —
lives only in application code and is enforced only on the paths that go through
it. Zero triggers, zero functions, zero rules.

The team clearly *knows* how to do this — `ncr_exactly_one_source` is a
well-crafted, working example using the boolean-summation idiom. This is an
unexercised habit, not a knowledge gap.

### 5.2 Uniqueness

126 unique indexes including 73 PKs. Tenant-scoped composites are used
consistently and well: `clients(tenant_id, code)`, `jobs(tenant_id, job_number)`,
`users(tenant_id, email/username/employee_code)`, `departments(tenant_id, code)`,
and the same pattern on all seven `*_refs` lookup tables. Partial unique indexes
are used with real sophistication — `process_plans` has a matched pair for the
`unit_id IS NULL` / `IS NOT NULL` grains, and
`components … WHERE unit_id IS NULL` exists specifically because the author
understood that NULLs are distinct in a plain unique index.

**Business keys that are NOT unique:**

**(a) Duplicate live assignment for the same unit + process.** `process_plans` is
unique on `(schedule_run_id, job_process_id, unit_id)` — scoped *per run* — and
nothing constrains `is_current` to one row per job. See §6(f).

**(b) AUD-099 (P2) — unit serial numbers are unique per equipment, not per job.**

```sql
INSERT INTO equipments (id, job_id, name) VALUES (3,1,'EQ1-B');
INSERT INTO units (equipment_id, serial_no, job_id) VALUES (3,'SN-1',1) RETURNING …;
 id | equipment_id | serial_no | job_id
 11 |            3 | SN-1      |      1

SELECT job_id, serial_no, count(*) FROM units GROUP BY 1,2 HAVING count(*)>1;
 job_id | serial_no | count
      1 | SN-1      |     2
```

Two units in the same job carrying the identical serial number. **Serial number
is the nameplate identity used on MDRs, dispatch notes and gate passes.** Also
unindexed for lookup — only `(equipment_id, serial_no)` exists, so "find unit by
serial" cannot use it.

### 5.3 Foreign keys

```
 RESTRICT : 71    CASCADE : 71    SET NULL : 57    total : 199
 ON UPDATE CASCADE : 199/199 (Prisma default, harmless — all PKs are immutable serials)
```

**31 of the 71 CASCADEs hang directly off `jobs(id)`.**

**Mitigating, and worth real credit:** a bare `DELETE FROM jobs WHERE id=1` is
*blocked* by a RESTRICT ring (`equipments`, `weld_joints`, `weld_logs`):

```
ERROR: update or delete on table "jobs" violates foreign key constraint
       "equipments_job_id_fkey" on table "equipments"
```

But the ring is three constraints deep, and once a "delete job" routine clears
them in dependency order — which it must — the CASCADE fires. Measured live and
rolled back: **20 tables of production, QA and material history erased**,
including `dft_readings`, `ncrs`, `qcp_executions` and `stock_txns`.

**`audit_log` and `domain_events` are correctly NOT in that list** — they are
tenant-grain with no FK to `jobs`, so the audit trail survives job deletion. A
deliberate and correct choice.

**AUD-069 (P1) — the `SET NULL`s that compound with fail-open RLS.** Four FKs
from `jobs` are `SET NULL`: `qcp_templates.job_id`, `qcp_items.job_id`,
`inspection_parties.job_id`, `qcp_item_party_codes.job_id`. Per
`20260905030000`, `QcpTemplate.jobId IS NULL` **means** "library template". So
deleting a job silently *promotes* its job-specific QCP into the shared library:

```sql
BEGIN;
SELECT id, job_id, activity FROM qcp_items;      -->  1 | 1 | Hydro
-- clear the RESTRICT ring, DELETE FROM jobs WHERE id=1
SELECT id, job_id, activity FROM qcp_items;      -->  1 |   | Hydro   (job_id → NULL)
ROLLBACK;

-- and job_id IS NULL is job_isolation's first escape hatch:
SET app.tenant_id='2'; SET app.job_id='2';
SELECT id, job_id, activity FROM qcp_items;
 id | job_id |    activity
 99 |        | ORPHANED-HYDRO     ← a Tenant One artefact, read by Tenant Two
```

Customer-specific QCPs — inspection extents, acceptance criteria, client
specifications, TPI party codes — are commercially sensitive and often
contractually confidential.

**Also grain-destroying `SET NULL`s:** `components.unit_id`,
`process_plans.unit_id`, `progress_snapshots.unit_id`,
`bom_items.bom_revision_id`. Deleting a unit silently converts unit-grain records
into equipment-grain records rather than deleting them — and `components` has a
conditional unique index on `(equipment_id, tag) WHERE unit_id IS NULL`, so
orphaning can collide.

### 5.4 Types and nullability

**Status is enum-typed, comprehensively — this is a strength.** 25 enum types
cover every meaningful state machine. Scanning every text/varchar/array column
whose name implies state, only **`weld_joints.joint_type`** is a genuine domain
vocabulary stored as unconstrained text. `domain_events.type` and
`notifications.type` are unconstrained by design but have no CHECK or lookup, so
a typo creates a silently-unmatched event stream.

Separately: **`bom_items.qty` is `text`** (with a `qty_per numeric` added
alongside later). A BOM quantity as a string cannot be summed or compared in SQL.

**Nullable but semantically required** — 30 columns. The ones that matter are
completion/approval pairs individually nullable with nothing tying them to the
status they evidence:

| Table | Nullable while `status` can be COMPLETE/closed |
|---|---|
| `process_plans` | `actual_start`, `actual_finish`, `submitted_by`, `verified_by` |
| `component_operations` | `started_at`, `finished_at`, `submitted_by`, `verified_by`, `qtyGood`, `qtyPlanned`, `qtyRejected` |
| `assembly_steps` | `started_at`, `finished_at`, `submitted_by`, `verified_by` |
| `ncrs` | `closed_by`, `closed_at`, `dispositioned_by` — nullable with `status='CLOSED'` |
| `dispatch_batches` | `release_approved_by`, `release_approved_at`, `actual_dispatch_date` |
| `qcp_executions` | `cleared_by` — nullable with `result='ACCEPTED'` |
| `bom_revisions`, `drawing_revisions` | `released_at` — nullable with `status='RELEASED'` |

Every one is a candidate for a two-column CHECK. None exists.

**AUD-076 (P2) — no `createdAt`/`updatedAt` on the core mutable tables.** `Job`,
`JobProcess`, `ProcessPlan`, `ComponentOperation`, `AssemblyStep`, `Ncr`,
`BomItem`, `QcpItem`, `DispatchBatch` and `Equipment` have neither.
**`Ncr` in particular has no raised-at timestamp, so NCR ageing — a standard
quality KPI and a likely TPI question — cannot be computed.** Reconstructing
"when did this change" requires an `audit_log` scan.

---

## 6. Impossible states — proven by insertion

All as `despl_web`, with `app.tenant_id='1'; app.job_id='1'` set correctly,
against realistic parent rows.

**(a) Plan COMPLETE whose FINISH_TO_START predecessor is NOT_STARTED — PERMITTED**
```
 predecessor | pred_status | successor | succ_status
 P10         | NOT_STARTED | P20       | COMPLETE       INSERT 0 1
```

**(b) `actual_finish` before `actual_start` — PERMITTED**
```sql
UPDATE process_plans SET actual_start='2026-06-10 08:00', actual_finish='2026-06-01 08:00' WHERE id=1
RETURNING …, actual_finish - actual_start AS duration;
  1 | 2026-06-10 08:00 | 2026-06-01 08:00 | -9 days      UPDATE 1
```
Same on `component_operations` with `status='COMPLETE'`.

**(c) Negative / zero / inverted durations — PERMITTED**
```sql
UPDATE job_processes SET duration_min_days=-5, duration_max_days=-10, duration_override_days=0 WHERE id=1;
  1 |  -5 | -10 |  0
UPDATE job_processes SET duration_min_days=99, duration_max_days=1 WHERE id=2;
  2 |  99 |   1        ← min > max
```

**(d) Percentage above 100 / below 0 — PERMITTED**
```sql
INSERT INTO progress_snapshots (…, overall_pct) VALUES (…, 250);   -->  1 | 250
INSERT INTO progress_snapshots (…, overall_pct) VALUES (…, -40);   -->  2 | -40
```
`progress_snapshots` is the **client-facing** published artefact. A 250%-complete
snapshot can be published to a customer.

**(e) Dispatch with an open hold point and an open NCR — PERMITTED**
```sql
SELECT id, unit_id, result FROM qcp_executions WHERE job_id=1;   -->  1 | 1 | PENDING
SELECT id, status FROM ncrs WHERE job_id=1;                      -->  1 | OPEN

UPDATE dispatch_batches SET actual_dispatch_date='2026-06-15', dispatch_note_no='DN-001',
  gate_pass_no='GP-001', vehicle_no='XX-00' WHERE id=1;           UPDATE 1

 batch | actual_dispatch_date | release_approved_by | unit | pending_holds | open_ncrs
     1 | 2026-06-15           |                     |    1 |             1 |         1
```
A unit shipped with a gate pass and dispatch note, holding an unattended hold
point, an OPEN non-conformance, an operation marked COMPLETE with `verified_by`
NULL, and `release_approved_by` NULL.

**(f) AUD-034 — two `is_current` runs, two live plans, two assignees — PERMITTED**
```sql
INSERT INTO schedule_runs (job_id, version, mode, project_start_date, is_current)
VALUES (1,2,'FORWARD','2026-01-01',true);
SELECT id, job_id, version, is_current FROM schedule_runs WHERE job_id=1;
  1 |  1 | 1 | t
 11 |  1 | 2 | t        ← two CURRENT runs, nothing prevents it

 plan | schedule_run_id | is_current | process | unit | assignee |   status
    1 |               1 | t          | P10     |    1 | User A   | NOT_STARTED
   12 |              11 | t          | P10     |    1 | User B   | IN_PROGRESS
```
**Correctly blocked at the operation grain:**
```sql
INSERT INTO component_operations (component_id, seq, …) VALUES (1, 10, …);
ERROR:  duplicate key value violates unique constraint "component_operations_component_id_seq_key"
```
Also permitted: `qtyPlanned=10, qtyGood=999, qtyRejected=-5`.

**(g) Stock driven negative — PERMITTED**
```sql
INSERT INTO stock_txns (stock_lot_id, type, qty, by, job_id) VALUES (1,'ISSUE',100000,1,1);  --> 101
INSERT INTO stock_txns (…) VALUES (1,'ISSUE',-500,1,1);   -->  2 | ISSUE | -500  ← negative issue

 id | lot_qty | total_issued | remaining_on_hand
  1 | 100.000 |    99510.000 |        -99410.000
```
And a lot can be born negative: `INSERT INTO stock_lots (…, qty) VALUES (…, -9999)` → accepted.

*(The service path is correctly guarded by an advisory lock — this is what the
database permits when anything writes outside it.)*

**(h) Audit log tampering — BLOCKED.** See §4.

**7 of 8 impossible states are reachable from the application's own database
role.**

---

## 7. Indexes

**297 indexes across 73 tables.** This is a well-indexed schema.

Exactly one table has nothing beyond its PK — `client_visibility_policies` — and
its PK *is* its natural key, so that is correct.

`audit_log`'s three composites (`(tenant_id, at)`, `(tenant_id, actor_id, at)`,
`(tenant_id, entity_type, entity_id, at)`) and `domain_events`'s two are textbook:
leading tenant discriminator, trailing timestamp, matched to real access patterns.

**AUD-113 (P3) — the consistent gap is date columns.** Every timestamp on the hot
operational tables is unindexed:

```
 stock_txns           | at
 process_plans        | actual_finish, actual_start, baseline_finish, baseline_start, planned_start
 component_operations | finished_at, started_at
 assembly_steps       | finished_at, started_at
 ncrs                 | closed_at, dispositioned_at, rework_due_date, rework_finished_at, rework_started_at
 dispatch_batches     | actual_dispatch_date, planned_date, release_approved_at
 units                | created_at
```

`stock_txns.at` unindexed makes the material ledger's period reconciliation a
full scan. `process_plans.planned_finish` is indexed **only behind
`owner_department_id`**, so a portfolio-wide "what is overdue" query cannot use
it. `ncrs.rework_due_date` unindexed makes the overdue-NCR list a full scan.

The full missing-index list, cross-referenced against real callers, is in
`14_PERFORMANCE.md` §3.

---

## 8. Views

```sql
        relname         | relkind | owner    |       reloptions
------------------------+---------+----------+-------------------------
 v_unit_stage_status    | v       | postgres | {security_invoker=true}
 v_process_plan_percent | v       | postgres | {security_invoker=true}
```

**Both plain views, neither materialised. `security_invoker=true` on both — the
single best security decision in the schema.** Without it, a `postgres`-owned
view would evaluate its base tables as its superuser owner and bypass all 52
policies. Verified end-to-end that RLS is correctly applied through
`v_unit_stage_status` when the job GUC is set.

**AUD-021 (P0) — the cost is severe.**

```sql
EXPLAIN SELECT * FROM v_unit_stage_status;
 HashAggregate  (cost=688647.95..688687.89 rows=2663 width=50)
   CTE exploded
     ->  Nested Loop  (cost=299.56..684039.94 rows=32637 width=58)
           SubPlan 1
             ->  Nested Loop  (cost=4.33..20.92 rows=1 width=0)
```

**~688,000 estimated cost on an essentially empty database.** Two compounding
causes:

1. `exploded` is referenced **twice** (in `governing` and in the final SELECT).
   PostgreSQL 12+ inlines a CTE only when referenced exactly once; referenced
   twice it is **materialised**, and a materialised CTE is an optimisation
   fence — **the caller's `WHERE v.job_id = …` predicate is never pushed in.**
2. The `is_rejected` flag is a **correlated `EXISTS`** over
   `qcp_item_processes ⋈ qcp_executions` *inside* that CTE, so it runs once per
   exploded row. That subplan is ~684,000 of the total.

Callers are `spine.read.ts` (twice) and `stage-detail.read.ts` — so **every spine
render, every job-list row, every daily digest and every StageSheet open builds
`all units × all job_processes × unnest(stages)` for the entire tenant**, then
throws away all but one job. At 30,000 units × 36 processes × ~2 stages that is
~2.1M rows plus 2.1M correlated probes, per request. **This is the highest
multiplier defect in the system.**

**Fix.** Two independent improvements: (1) hoist `is_rejected` out of the
correlated subquery into a pre-aggregated `LEFT JOIN` grouped by
`(unit_id, job_process_id)` — this alone removes the ~684k; (2) restructure so
`exploded` is referenced once (a window function over one scan), or convert to a
set-returning function `v_unit_stage_status(p_job_ids int[])` so the filter is an
argument rather than a post-filter. Verify with `EXPLAIN (ANALYZE, BUFFERS)` that
`job_id` appears as an index condition on `equipments`, not a filter above a CTE
Scan. `spine.read.test.ts`, `spine.read.stage-names.test.ts` and
`spine.rollup.test.ts` pin the output shape and should stay green unchanged.

`v_process_plan_percent` is similar in shape — a per-plan computation with three
`COALESCE((SELECT count(*) …))` correlated subqueries.

---

## 9. AUD-104 (P2) — migration lock behaviour

Grep across all 50 migrations for `CONCURRENTLY`: **zero matches**.
`h1_job_id_backstop_not_null_fk` performs 28 pairs of:

```sql
ALTER TABLE "process_plans" ALTER COLUMN "job_id" SET NOT NULL;
ALTER TABLE "process_plans" ADD CONSTRAINT … FOREIGN KEY … ON DELETE CASCADE;
```

`SET NOT NULL` validates with a full scan under ACCESS EXCLUSIVE;
`ADD CONSTRAINT … FOREIGN KEY` without `NOT VALID` validates every row while
holding the lock on both tables. `process_plans` is the largest table in the
system. At pilot scale this is seconds; at a few million rows it is a
multi-minute full outage during deploy, on the tables the shop floor writes to.

**Fix.** For future migrations on the growing tables: `CREATE INDEX CONCURRENTLY`
in a non-transactional migration, and `ADD CONSTRAINT … NOT VALID` followed by a
separate `VALIDATE CONSTRAINT`, which takes only SHARE UPDATE EXCLUSIVE. Add a CI
grep for unqualified DDL against a list of high-volume tables.

---

## 10. Recommended constraint set

In one migration, ordered by value-per-risk. Each needs a preceding data-audit
query against production; use `NOT VALID` then `VALIDATE CONSTRAINT` so the
deploy does not block.

1. `process_plans`: `CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)`; same on `component_operations` and `assembly_steps`.
2. `progress_snapshots`: `CHECK (overall_pct BETWEEN 0 AND 100)`.
3. `job_processes` / `template_processes`: `CHECK (duration_min_days IS NULL OR duration_min_days > 0)`, `CHECK (duration_max_days IS NULL OR duration_max_days >= duration_min_days)`, `CHECK (duration_override_days IS NULL OR duration_override_days > 0)`.
4. `stock_txns`: `CHECK (qty > 0)` — direction belongs to `type`, not the sign. `stock_lots`: `CHECK (qty >= 0)`.
5. `component_operations`: `CHECK ("qtyGood" >= 0 AND "qtyRejected" >= 0)`, `CHECK ("qtyPlanned" IS NULL OR "qtyGood" + "qtyRejected" <= "qtyPlanned")`.
6. `qcp_executions`: `CHECK (result <> 'NA' OR waiver_approved_by IS NOT NULL)` — the AUD-003 backstop.
7. Status-evidence pairs: `CHECK (status <> 'COMPLETE' OR actual_finish IS NOT NULL)` on `process_plans`; `CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))` on `ncrs`.
8. `CREATE UNIQUE INDEX schedule_runs_one_current_per_job ON schedule_runs (job_id, COALESCE(equipment_id, -1)) WHERE is_current;` — AUD-034.
9. `CREATE UNIQUE INDEX units_job_id_serial_no_key ON units (job_id, serial_no);` — AUD-099, gated on a business-rule confirmation. Plus a plain `btree (serial_no)` for lookup.
10. `@@unique([recipientId, type, entityType, entityId])` on `Notification` — AUD-089.
11. `createdAt` / `updatedAt` on the ten models listed in §5.4 — AUD-076.

Cases (a) and (e) from §6 are cross-row and cannot be CHECKs. Given that the
database currently has zero triggers, the honest recommendation is exactly two:
a predecessor-completion guard on `process_plans`, and a QC/NCR-clearance guard
on `dispatch_batches.actual_dispatch_date`.

---

## 11. What the database genuinely enforces

Verified against the live build, not inferred:

- **Append-only audit is real and it holds** (§4). Three layers, boot-checked.
- **Tenant isolation fails closed on all 24 tables that have it**, with
  `with_check` present and identical to `qual` on **every one of the 52
  policies** — so the "writes a row it cannot read back" failure mode does not
  exist anywhere in this schema.
- **`security_invoker=true` on both views** — subtle, easy to miss, correct.
- **`despl_web` cannot escalate.** Owner/app-role split correctly configured.
- **The `nullif_fix` migration fixed a real bug**, and the diagnosis in its
  comment is accurate — reproduced on both seq-scan and forced index-scan plans.
- **Referential integrity is thorough** — 199 FKs, a working RESTRICT ring around
  `jobs`, and the audit trail deliberately excluded from job cascade.
- **Uniqueness is applied thoughtfully where applied** — 126 unique indexes, with
  genuine sophistication in the partial-unique pairs for NULL-distinct grains.
- **Status is enum-typed almost everywhere** — 25 enums. Illegal state *values*
  are impossible; only illegal state *combinations* get through.
- **Indexing is broad and, on the audit tables, excellent.**
- **The one CHECK constraint that exists is well-built and works.**
- **All 50 migrations apply cleanly from an empty cluster.**
