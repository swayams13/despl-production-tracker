# MIGRATION RUNBOOK — production is running new code on the 24 August schema

**Item:** S5 (Gate 0). **Status:** written, not executed. The only commands run
against production while writing this were read-only `SELECT`s, quoted below.

**Read §1 and §2 before doing anything.** This document was scoped as "the
runbook for merging `demo` → `main`". That merge already happened. Then the
verification query revealed that the migrations it was supposed to carry never
ran at all — and still haven't. The procedure in §5 is therefore live and
pending, not historical.

---

## 1. What production actually is, verified 2 Sep 2026

### 1.1 The merge happened; the migrations did not

`origin/main` has all 40 migration directories and `demo` adds nothing to it
(`git rev-list --count origin/main..demo` → `0`). The carrier was **PR #6,
`chore/B1-docs-drift-corrections`** — a docs PR branched off `demo`, which
silently brought 72 commits, 109 changed files under `src/`, and 20 migrations
onto `main`:

```
$ git log --first-parent --oneline -1 origin/main \
    -- prisma/migrations/20260827120001_procurement_event_drop_procurements/
f5a499f 2026-09-02 Merge pull request #6 from swayams13/chore/B1-docs-drift-corrections
```

Production's migration state:

```
$ psql -c "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
                  count(*) FILTER (WHERE finished_at IS NULL) AS unfinished,
                  count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
           FROM _prisma_migrations;"
 applied | unfinished | rolled_back
---------+------------+-------------
      20 |          1 |           1
```

The `unfinished`/`rolled_back` pair is **one historical row, not a wedge** —
`20260815120000_v_unit_stage_status`, started 16 Aug 10:59, marked rolled back
16 Aug 11:09, re-applied successfully 16 Aug 11:10. That is the documented
first-deploy incident in `progress.md`. It is healed and Prisma ignores it.

The last applied migration is **`20260822130000_template_version_updated_at`,
finished 2026-08-24 09:54**. The 20 migrations from the 2 Sep merge have **no
rows at all** — not applied, not failed, never attempted.

### 1.2 The new code IS live

```
$ railway deployment list --service despl-production-tracker
2026-09-02T16:19 SUCCESS 7597a3c | preDeploy: None | builder: RAILPACK | Merge PR #12
2026-09-02T11:05 REMOVED 39968fc | preDeploy: None | builder: RAILPACK | Merge PR #11
2026-09-02T03:07 REMOVED f5a499f | preDeploy: None | builder: RAILPACK | Merge PR #6
2026-08-25T17:04 REMOVED e4d0348 | preDeploy: None | builder: RAILPACK | Merge PR #5
```

```
$ curl -sI https://despl-production-tracker-production.up.railway.app/login
content-security-policy-report-only: default-src 'self'; ...
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: DENY
x-content-type-options: nosniff
```

S2's headers are present, so the running container is `7597a3c` — the full
Phase 4 + Phase 5 + S1–S4 payload.

### 1.3 The data is intact

```
$ psql -c "SELECT to_regclass('public.procurements'), to_regclass('public.procurement_events'),
                  to_regclass('public.ncrs'), to_regclass('public.components');"
 procurements | procurement_events | ncrs | components
--------------+--------------------+------+------------
 procurements |                    |      | components

$ psql -c "SELECT count(*) FROM procurements;"
 34
```

**`20260827120001` never ran. `procurements` is intact with 34 rows. Nothing has
been destroyed and every recovery option is still open.** This is the single most
important fact in this document.

---

## 2. Root cause — `railway.json` is not honored

`preDeployCommand: None` on **every deployment ever recorded**, including August's.
And `builder: RAILPACK` where `railway.json` specifies `"builder": "NIXPACKS"`.

```json
// railway.json — believed to be in force; it is not
{ "build": { "builder": "NIXPACKS" },
  "deploy": { "preDeployCommand": "pnpm exec prisma migrate deploy", ... } }
```

**`prisma migrate deploy` has never run automatically on this project.** The 20
applied migrations were applied by hand during the August sessions (see
`progress.md`'s first-deploy account). Every document in this repo that assumes
"Railway runs migrations for us" — including this runbook's own earlier drafts,
`CLAUDE.md`'s stack section, and S4's CI reasoning — is wrong.

`healthcheckPath` is also `null` in the service manifest, so the healthcheck
described in `railway.json` is not configured either.

**Fix this before §5, not after.** Two options, and it is a real decision:

| Option | Effect |
|---|---|
| **A — set `preDeployCommand` in the Railway dashboard** | Migrations apply automatically on every push to `main`. Matches what the docs already claim. Also means the next accidental docs-PR-off-`demo` deploys schema changes unattended, which is exactly how we got here. |
| **B — keep migrations manual and deliberate** | `migrate deploy` is run by a human over the proxy, as it has been all along. Slower, but no unattended irreversible DDL. Requires deleting the misleading `preDeployCommand` from `railway.json` and correcting `CLAUDE.md`. |

Recommendation: **B until Gate 0 exits**, then A once branch protection (S4) and
the §9 prevention items are in place. Whichever is chosen, `railway.json` and
`CLAUDE.md` must be made to tell the truth — a config file that looks
load-bearing and isn't is worse than no config file.

---

## 3. Current production state

| | |
|---|---|
| Code | `7597a3c` — Phase 4, Phase 5, S1–S4 all live |
| Schema | 24 August — 20 migrations behind the code |
| Consequence | **New code, old schema.** The inversion of the usual hazard. |

Working, because they touch no new table: `/api/health` (`{"status":"ok"}`),
`/login` (200), and anything reading only the pre-24-Aug schema.

Broken, because the tables and columns do not exist: BOM and procurement views,
stock lots/txns, NCR, assembly tracking, drawing revisions, material
identification, and the new `components` columns. These raise Prisma
table/column-does-not-exist errors at runtime.

**One thing this state does *not* do is corrupt data.** The new code writes
procurement history to `procurement_events`, which does not exist, so those
writes fail outright rather than silently diverging. `procurements` has been
frozen at 34 rows since 24 Aug. There is no half-written state to reconcile —
only functionality that has been failing loudly for anyone who tried to use it
since 2 Sep.

**Demo risk:** the team clicks through this build. Every module listed as broken
above will throw for them.

---

## 4. Prerequisites

| # | Prerequisite | Why |
|---|---|---|
| P1 | ~~Which branch does Railway deploy?~~ **`main`.** Confirmed 2 Sep. | LEDGER D1 closed. |
| P2 | **LEDGER D2 — backups on, last-backup timestamp known.** **BLOCKING.** | §6.3 consumes and drops a table holding 34 real rows. It is the only recovery. |
| P3 | A fresh `pg_dump` of production, taken immediately before §5.4. | The rehearsal target, and the rollback of last resort. |
| P4 | §2's decision made, and `railway.json` / `CLAUDE.md` corrected to match. | Otherwise the next merge repeats this. |
| P5 | CI green on `main` (`gh run list --branch main --limit 3`). | — |
| P6 | A maintenance window. There is no staging environment (§6.5). | — |

### The 20 pending migrations, in apply order

```
20260826082150_component_op_operator_qty_rejection
20260826084752_component_parent_id
20260826085244_component_op_performed_by_user_fk
20260826133424_assembly_tracking
20260826140000_component_unit_tag_unique              <-- unique rebuild (§6.6)
20260826140500_assembly_templates_rls
20260827034257_assembly_step_lead_time_process_seq
20260827040000_v_process_plan_percent                 <-- GRANT to despl_web (§6.2)
20260827050000_component_equipment_grain_tag_unique   <-- unique rebuild (§6.6)
20260827060000_bom_item_qty_and_parent
20260827112519_bom_revision
20260827120000_procurement_event
20260827120001_procurement_event_drop_procurements    <-- DROPs 34 rows (§6.3)
20260827130000_stock_lot_txn
20260827140000_material_identification_component
20260827150000_drawing_revision
20260827160000_drawing_revision_dates
20260827170000_actor_fks_and_partial_unique           <-- FKs vs live data (§6.6)
20260827180000_procurement_stock_append_only_grants
20260831064422_phase5_ncr_evidence_paint_packing_dispatch
```

**20, not the 21 the original brief named.** `20260820050300_operation_ref_lead_time_process_seq`
was already applied on 24 Aug. Post-migration total will be **40**.

**Checksum risk is nil.** Two of these were edited after being applied elsewhere
(`20260827120001`: `d812f7a`, `c3a67ab`, `f21b6b8`; `20260831064422`: `83f78cb`,
`d38c7c7`) — but production has never applied either, so there is no stored
checksum to mismatch. `git log --since=2026-09-01 -- prisma/migrations/` is empty.

---

## 5. The procedure

### 5.1 Dump production

```bash
pg_dump --format=custom --no-owner \
  --file="$HOME/despl-prod-$(date +%Y%m%d-%H%M).dump" "$PROD_DIRECT_URL"
```

`--no-owner` but deliberately **not** `--no-acl`: grants and RLS policies are the
thing under test. `20260813051500_rls_and_app_role` grants the permission bundle
to `despl_app`; a `--no-acl` copy gives `despl_web` a schema it cannot read a row
from, so §5.6's login would fail for reasons unrelated to this work. Keeping ACLs
imposes an ordering constraint — the dump names `despl_app`/`despl_web`, so both
roles must exist **before** `pg_restore`. Hence 5.2 before 5.3.

**Check:** `ls -lh "$HOME"/despl-prod-*.dump`

**Record the source row count now** — it is what §5.5 and §7.3 compare against:

```bash
psql "$PROD_DIRECT_URL" -c "SELECT count(*) FROM procurements;"                     # expect 34
psql "$PROD_DIRECT_URL" -c "SELECT count(*) FROM procurements
  WHERE indent_date IS NOT NULL OR approved_date IS NOT NULL
     OR po_date IS NOT NULL OR received_date IS NOT NULL;"                          # the rows the backfill must carry
```

### 5.2 Rehearsal DB and roles — roles first

```bash
createdb -h localhost -U postgres despl_rehearse
psql "postgresql://postgres@localhost:5432/despl_rehearse" \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='despl_app') THEN CREATE ROLE despl_app NOLOGIN; END IF; END \$\$;"
DESPL_WEB_PASSWORD='<throwaway, not production's>' \
psql "postgresql://postgres@localhost:5432/despl_rehearse" \
  -v despl_web_password="$DESPL_WEB_PASSWORD" -f scripts/provision-db-role.sql
```

**Check:** `despl_web` has `rolcanlogin = t` and is a member of `despl_app`.

```bash
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT r.rolname, r.rolcanlogin, ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid=m.roleid WHERE m.member=r.oid) FROM pg_roles r WHERE r.rolname IN ('despl_app','despl_web');"
```

### 5.3 Restore

```bash
pg_restore --no-owner --exit-on-error \
  --dbname="postgresql://postgres@localhost:5432/despl_rehearse" "$HOME/despl-prod-<stamp>.dump"
```

`--exit-on-error` is deliberate — the default logs errors and continues, handing
you a silently incomplete copy that makes every later "pass" meaningless. If it
stops on `role "despl_app" does not exist`, you skipped 5.2: drop the database,
do 5.2, restore again. Do not patch around it.

**Check:** RLS survived, and the copy is a faithful one.

```bash
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT count(*) FROM pg_policies WHERE schemaname='public';"          # non-zero
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"   # 20
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT count(*) FROM procurements;"                                   # 34
```

### 5.4 Point an env file at it, and read it aloud every time

`.env.rehearse` (gitignored; never added to `.env.example` — it holds a real
password, throwaway or not):

```
DATABASE_URL="postgresql://despl_web:<throwaway>@localhost:5432/despl_rehearse"
DIRECT_URL="postgresql://postgres@localhost:5432/despl_rehearse"
```

```bash
set -a && . ./.env.rehearse && set +a && echo "DATABASE_URL=$DATABASE_URL"
```

The word `despl_rehearse` must appear. If you see `despl_demo`, `despl_test`, or
a `railway.internal` / `proxy.rlwy.net` host — **stop and re-source.**

### 5.5 Rehearse the migration

On a worktree checked out at the exact commit to be deployed (`origin/main`).

```bash
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \
  --to-migrations ./prisma/migrations --script > ~/rehearse-pending.sql
grep -n 'DROP TABLE\|DROP TYPE\|GRANT\|ADD CONSTRAINT.*FOREIGN KEY\|CREATE UNIQUE INDEX' ~/rehearse-pending.sql
```

**Check:** the hits are `DROP TABLE "procurements"`, `DROP TYPE
"MaterialReceivedStatus"`, `DROP TYPE "ProcurementStatus"`, the
`v_process_plan_percent` GRANT, the actor FK block, and the two unique index
rebuilds. **Any other `DROP TABLE` — stop.**

```bash
pnpm exec prisma migrate deploy 2>&1 | tee ~/rehearse-deploy.log
```

**Check, all four:**

```bash
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"   # 40
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT to_regclass('public.procurements');"                           # NULL
psql "postgresql://postgres@localhost:5432/despl_rehearse" -c \
  "SELECT type, count(*) FROM procurement_events GROUP BY 1 ORDER BY 1;"
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel ./prisma/schema.prisma --exit-code                # exit 0
```

**This is the only chance anyone gets to verify the backfill against its source.**
Every dated row counted in §5.1 must be represented in `procurement_events`.
Once §5.7 runs on production, `procurements` is gone and this comparison becomes
impossible forever. Do not skip it, and do not accept "the migration didn't
error" as the check — its guards test for *presence*, not correctness.

If `migrate deploy` fails, go to §6. **Do not retry blindly** — a failed row
wedges every later run, converting one failure into a stuck database.

### 5.6 Rehearse the app

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Do **not** repoint `pnpm test:db` at the rehearsal copy: the DB-gated tests create
Organizations and never clean them up, and `resolveTenantForLogin` fail-closes
when more than one org exists (`progress.md`, "RUN_DB_TESTS now targets its own
database"). That would break login on the copy.

```bash
set -a && . ./.env.rehearse && set +a && echo "DATABASE_URL=$DATABASE_URL"
PORT=3100 pnpm start
```

Never `pnpm dev`. Then in a real browser — not curl, not a hand-made cookie, not
`jose` (CLAUDE.md, "never forge credentials"): log in through the real `/login`
form, then open the dashboard, a job detail page's five tabs, `/workspace`, and
**the BOM/procurement view of a job with procurement history**. That last one is
the human half of §5.5's backfill check.

### 5.7 ABORT POINT — then apply to production

> **Everything above is free to abandon.** `dropdb despl_rehearse`,
> `git worktree remove`, delete the dump. Production is untouched: it is broken
> in the §3 sense, but its data is whole and `procurements` still holds 34 rows.
>
> **The next command is irreversible.** `20260827120001` drops `procurements`
> after consuming it. From that point the only way back is the §5.1 dump.
>
> Abort if: the rehearsal failed for any un-root-caused reason · the schema diff
> was non-zero · the backfill comparison in §5.5 did not account for every dated
> row · the browser pass could not be completed · D2 is still open · you lack a
> window long enough to restore the dump.

Then, deliberately and watched — **print the URL and read it before pressing
enter**:

```bash
echo "TARGET: $PROD_DIRECT_URL"      # confirm this is production, out loud
pnpm exec prisma migrate deploy 2>&1 | tee ~/prod-deploy-$(date +%Y%m%d-%H%M).log
```

Keep the log. Do not walk away. If §2's option A was chosen instead, push to
`main` and watch Railway's pre-deploy log to completion — same rule.

### 5.8 Restart the app

The running container holds a Prisma client that has been erroring against the
old schema. Redeploy from Railway's UI (no new commit needed) so it starts clean,
then run §7.

---

## 6. Failure modes

### 6.1 Checksum mismatch

**Not a risk here** (§4): production has applied neither edited migration. It
becomes one the moment anyone edits an applied migration — which has happened
twice on this repo already.

**Looks like:** `The migration <name> was modified after it was applied.` Aborts
before applying anything.

**Recovery:** on a disposable DB, `DELETE FROM _prisma_migrations WHERE
migration_name = '<name>'` and re-run. **On production, neither that nor
`prisma migrate resolve --applied` is acceptable** — the latter marks a migration
applied *without running its SQL*, which on `20260827120001` would skip the
backfill and the drop while telling Prisma the schema is current. The real fix is
to never edit an applied migration; write a new forward-only one.

### 6.2 Missing `despl_web` role

`20260827040000_v_process_plan_percent` ends with `GRANT SELECT ON
v_process_plan_percent TO despl_web;`. **This exact failure already happened on
this project** — `20260815120000_v_unit_stage_status` on 16 Aug, which is the
very row still sitting in production's `_prisma_migrations` as rolled-back.

**Looks like:** `ERROR: role "despl_web" does not exist`, at migration 8 of 20.
The seven before it are applied; this one gets a null `finished_at` and wedges
every later run.

**Recovery:**

```bash
DESPL_WEB_PASSWORD='<value>' psql "$DIRECT_URL" \
  -v despl_web_password="$DESPL_WEB_PASSWORD" -f scripts/provision-db-role.sql
pnpm exec prisma migrate resolve --rolled-back 20260827040000_v_process_plan_percent
pnpm exec prisma migrate deploy
```

Production connects as `despl_web`, so the role exists there — this is a
rehearsal-target failure, and only §5.2 prevents it.

### 6.3 The `procurements` drop — the irreversible step

`20260827120001` backfills every `procurements` row into `procurement_events` in
plain SQL, verifies with two `DO $$` guards that `RAISE EXCEPTION`, then `DROP
TABLE "procurements"` plus two enums. Its header: *"the actual point of no return
for the old flat-status data... there is no data path back."* **34 rows on
production today.**

**Looks like, failing:** one of
- `...% tenant(s) with procurement history have no admin@despl.local user to attribute ProcurementEvent.by to`
- `...% procurements row(s) carry indent/PO/receipt dates with no matching procurement_events row`

Prisma wraps each Postgres migration file in a transaction, so an abort rolls the
file back and `procurements` survives — but the row is recorded failed.

**Recovery when it fails:** create the missing `admin@despl.local` for the named
tenant, or investigate with `scripts/backfill-procurement-events.ts` in dry-run;
then `migrate resolve --rolled-back` and re-run. **This is the recoverable
outcome** — the data still exists.

**Recovery when it succeeds and the backfill was wrong:** restore the §5.1 dump.
This is precisely why §5.5 compares the counts *before* production runs it.

### 6.4 Unattended `preDeployCommand`

The hazard the earlier drafts of this document were built around — and, per §2,
one that has **never actually been armed on this service**. It becomes live the
moment §2's option A is chosen: `migrate deploy` would then apply every pending
migration on any push to `main`, with no prompt and no gap between migrations,
including from a docs PR branched off `demo`. That is how PR #6 would have
dropped `procurements` unattended if the config had been in force.

Under option A, a failed pre-deploy leaves the *old* container serving with the
healthcheck green — a failure state with no symptom. Watch every migration-carrying
deploy.

### 6.5 No staging environment

One Railway `production` environment. §5's rehearsal copy is a local database, not
a deployed environment: it never exercises Railway's build, its env vars,
`assertDbRole()` in `src/instrumentation.ts`, or the internal
`postgres.railway.internal` host. Config-shaped failures — a Railway-injected
`DATABASE_URL` shadowing the manual one (`progress.md`'s first-deploy session), a
missing `SEED_PASSWORD`, `postinstall` not regenerating the client — appear only
on the real thing. **§2's discovery is itself an instance of this**: `railway.json`
diverging from the service's real settings was invisible to every local check.

### 6.6 Constraints against real production rows

Three migrations pass trivially on an empty database and can fail on production's
actual data — the reason §5 insists on a *restored* copy rather than a fresh one.

| Migration | Adds | Fails when |
|---|---|---|
| `20260827170000_actor_fks_and_partial_unique` | ~20 `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "users"("id")` across `process_plans`, `component_operations`, `weld_logs`, `weld_joints`, `qcp_executions`, `delay_reasons`, `progress_snapshots`, … validated immediately, no `NOT VALID` | any column holds a user id absent from `users` |
| `20260826140000_component_unit_tag_unique` | drops `components_equipment_id_tag_key`, creates unique `(unit_id, tag)` | two components share a `tag` within a unit |
| `20260827050000_component_equipment_grain_tag_unique` | same shape, equipment grain | same |

**Looks like:** `violates foreign key constraint` / `could not create unique index
... Key (unit_id, tag)=(...) is duplicated`.

**Run these on production now** — read-only, and they are the cheapest possible
early warning:

```sql
SELECT id, submitted_by FROM process_plans p
WHERE p.submitted_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.submitted_by);

SELECT unit_id, tag, count(*) FROM components GROUP BY 1,2 HAVING count(*) > 1;
```

Zero rows from both is the evidence these three are safe. Anything else is a data
fix that needs its own decision about which row survives — not a merge-runbook
call.

---

## 7. Post-migration verification

### 7.1 All 40 applied

```bash
psql "$PROD_DIRECT_URL" -c \
  "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
          count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed
   FROM _prisma_migrations;"
```

**Pass:** `applied = 40`, `failed = 0`. (The 16 Aug `20260815120000` row will
still show as rolled-back-then-reapplied — that is expected and healed, see §1.1.)

Name any stragglers:

```bash
psql "$PROD_DIRECT_URL" <<'SQL'
WITH expected(name) AS (VALUES
  ('20260826082150_component_op_operator_qty_rejection'),
  ('20260826084752_component_parent_id'),
  ('20260826085244_component_op_performed_by_user_fk'),
  ('20260826133424_assembly_tracking'),
  ('20260826140000_component_unit_tag_unique'),
  ('20260826140500_assembly_templates_rls'),
  ('20260827034257_assembly_step_lead_time_process_seq'),
  ('20260827040000_v_process_plan_percent'),
  ('20260827050000_component_equipment_grain_tag_unique'),
  ('20260827060000_bom_item_qty_and_parent'),
  ('20260827112519_bom_revision'),
  ('20260827120000_procurement_event'),
  ('20260827120001_procurement_event_drop_procurements'),
  ('20260827130000_stock_lot_txn'),
  ('20260827140000_material_identification_component'),
  ('20260827150000_drawing_revision'),
  ('20260827160000_drawing_revision_dates'),
  ('20260827170000_actor_fks_and_partial_unique'),
  ('20260827180000_procurement_stock_append_only_grants'),
  ('20260831064422_phase5_ncr_evidence_paint_packing_dispatch')
)
SELECT e.name,
       CASE WHEN m.migration_name IS NULL THEN 'NEVER RAN'
            WHEN m.finished_at IS NULL     THEN 'FAILED'
            ELSE 'APPLIED' END AS state
FROM expected e LEFT JOIN _prisma_migrations m ON m.migration_name = e.name
ORDER BY e.name;
SQL
```

### 7.2 Schema matches the datamodel

```bash
pnpm exec prisma migrate diff \
  --from-url "$PROD_DATABASE_URL" --to-schema-datamodel ./prisma/schema.prisma --exit-code
```

**Pass:** exit 0, "No difference detected". This is the check that closes §3's
new-code-old-schema gap.

### 7.3 The data survived the drop

```bash
psql "$PROD_DIRECT_URL" -c "SELECT to_regclass('public.procurements');"            # NULL
psql "$PROD_DIRECT_URL" -c "SELECT type, count(*) FROM procurement_events GROUP BY 1 ORDER BY 1;"
```

**Pass:** `to_regclass` NULL, and the per-type counts match what the rehearsal
produced in §5.5 from the same 34 rows.

### 7.4 Grants and invariants

```bash
psql "$PROD_DIRECT_URL" -c \
  "SELECT has_table_privilege('despl_web','v_process_plan_percent','SELECT') AS view_readable,
          has_table_privilege('despl_web','procurement_events','UPDATE')     AS must_be_false,
          has_table_privilege('despl_web','stock_txns','DELETE')             AS must_be_false_2,
          has_table_privilege('despl_web','audit_log','UPDATE')              AS invariant_5;
   SELECT count(*) AS policies FROM pg_policies WHERE schemaname='public';"
```

**Pass:** `view_readable = t`; the other three `f`; `policies` non-zero. The last
is invariant #5 (append-only audit); the middle two are `20260827180000`'s
append-only REVOKEs.

### 7.5 The app, in a real browser

1. `curl -fsS https://despl-production-tracker-production.up.railway.app/api/health` → 200.
2. Real `/login` form, real credentials.
3. Dashboard, one job detail page's five tabs, `/workspace`.
4. **Every module §3 listed as broken** — BOM/procurement, stock, NCR, assembly,
   drawings. These are the whole point: they have been failing since 2 Sep and
   this is what proves them fixed.
5. Console clean.

Record page by page in `LEDGER.md`. This is Gate 0's exit evidence.

---

## 8. Rollback

| Situation | Action |
|---|---|
| Before §5.7 | `dropdb despl_rehearse`, `git worktree remove`. Free. Production stays as §3 describes — broken on new surfaces, data whole. |
| §5.7 failed partway | Fix the cause per §6, `migrate resolve --rolled-back <name>`, re-run. Data intact if the failure was at or before `20260827120001`. |
| `procurements` dropped, backfill provably wrong | Restore the §5.1 dump. Loses writes since the dump — which, given §3, is a smaller set than usual. Announce it. |
| App broken after a green migration | Redeploy an earlier commit from Railway's UI. **The schema does not roll back** — this reintroduces §3's mismatch in reverse. Stopgap only. |

Never `git push --force` to `main` to undo a deploy. It does not un-drop a table
and it rewrites history others have pulled.

---

## 9. So this cannot recur

1. **Make `railway.json` true or delete it** (§2). A config file that looks
   load-bearing and isn't caused this.
2. **Never branch a PR off `demo`.** PR #6 was a docs change that carried 72
   commits and 20 migrations. Branch from `main`.
3. **A PR touching `prisma/migrations/` is a migration PR**, whatever its title
   says. A CI check that fails on unlabelled migration changes would have caught it.
4. **Watch every migration-carrying deploy.** §6.4 is invisible if nobody looks.
5. **Branch protection on `main`** — S4 records this as explicitly *not* set.
6. **Close D2.** Every recovery path above is gated on a backup.
7. **Add a deploy-time schema check.** `prisma migrate diff --exit-code` against
   the datamodel, run on boot or in the healthcheck, turns §3's silent
   new-code-old-schema state into a loud one. It is the check whose absence let
   this sit unnoticed from 2 Sep.
