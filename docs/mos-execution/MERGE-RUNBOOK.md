# MERGE RUNBOOK — post-mortem verification of the 2 Sep unrehearsed deploy

**Item:** S5 (Gate 0), re-scoped 2 Sep 2026. **Status:** written, not executed.
Nothing in this document has been run against any database.

**Why this is not what S5 originally asked for.** S5 was written as "the runbook
for merging `demo` → `main`". That merge has already happened — on 2 Sep, via a
documentation PR, with no rehearsal, and Railway auto-deployed it unwatched. The
prospective runbook is therefore moot; §§1–5 below establish what production
actually is, and Appendix A preserves the rehearsal procedure for the next merge,
which is the first time it will be usable.

---

## 1. What happened

Local `main` was 99 commits stale, which is why the S5 brief (and my own first
pass at this document) believed 21 migrations were pending. Against `origin/main`:

```
$ git rev-list --left-right --count main...origin/main
0	99                                 # local main, 99 behind

$ git rev-list --count origin/main..demo
0                                      # demo adds NOTHING to origin/main

$ git ls-tree -d --name-only origin/main prisma/migrations/ | wc -l
40                                     # all 40, not 19

$ git diff --name-only origin/main...demo -- prisma/migrations | wc -l
0                                      # zero pending
```

All three migrations the brief flagged as dangerous are on `origin/main`:

```
20260827120001_procurement_event_drop_procurements        : PRESENT
20260827040000_v_process_plan_percent                     : PRESENT
20260831064422_phase5_ncr_evidence_paint_packing_dispatch : PRESENT
```

**The carrier was PR #6, a docs PR:**

```
$ git log --first-parent --oneline -1 origin/main \
    -- prisma/migrations/20260827120001_procurement_event_drop_procurements/
f5a499f 2026-09-02 Merge pull request #6 from swayams13/chore/B1-docs-drift-corrections
```

`chore/B1-docs-drift-corrections` was branched off `demo`, so merging it carried
all 77 `demo` commits — and all 21 migrations — onto `main`. Every subsequent 2
Sep merge already shows 40 migration dirs:

```
f5a499f Merge PR #6  (B1 docs)      : 40
02803b3 Merge PR #8  (S1 gating)    : 40
859d293 Merge PR #10 (S2 headers)   : 40
39968fc Merge PR #11 (S3 logging)   : 40
7597a3c Merge PR #12 (S4 CI/env)    : 40   <-- origin/main tip
```

Railway deploys from `main` (LEDGER D1, confirmed 2 Sep) and `railway.json` runs
`pnpm exec prisma migrate deploy` as an unattended `preDeployCommand`. So that
push ran all 21 migrations against production. `progress.md`'s S4 entry records:
*"Railway auto-deployed from both merges; neither deploy was watched."*

No migration file has been edited since (`git log --since=2026-09-01 --
prisma/migrations/` is empty), so there is **no checksum-drift risk on the next
deploy** — the files on disk are byte-identical to what was applied.

---

## 2. The two hypotheses

Exactly one of these is true. Nothing currently in the repo or the ledger
distinguishes them — S3's "demonstrated on" is a local `:3100` build against
`despl_test`, not production.

**Hypothesis A — the deploy succeeded.** All 21 applied. `procurements` was
dropped in production on 2 Sep. That is the irreversible step this document's
predecessor existed to gate, taken with no rehearsal, no watched log, and LEDGER
D2 (backups) still `☐`. If the inline backfill in `20260827120001` mis-mapped
anything, the source rows are gone.

**Hypothesis B — `preDeployCommand` failed.** Then the deploy failed, the *old*
container kept serving, and production has been running pre-2-Sep code against a
partially-migrated schema ever since. Every deploy after it (#8, #10, #11, #12)
hit the same wedged migration row and failed identically — meaning **S1, S2, S3
and S4 are not actually in production** despite being merged. This is the §6.4
failure mode, and it is silent by construction: no outage, no alarm, healthcheck
green because the old container is healthy.

B is not the unlikely branch. §6.2 (missing `despl_web` — already hit once on
Railway's first deploy) and §6.6 (constraints against real production rows) are
both live risks that a fresh-DB test would never surface.

---

## 3. STEP 1 — the one query that decides

Read-only. Safe. Run it before anything else, today.

```bash
psql "$PROD_DIRECT_URL" -c \
  "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
          count(*) FILTER (WHERE finished_at IS NULL) AS unfinished,
          count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back
   FROM _prisma_migrations;"
```

| Result | Verdict | Go to |
|---|---|---|
| `applied = 40, unfinished = 0, rolled_back = 0` | **Hypothesis A.** Migrations are fully applied. | §4 |
| any `unfinished > 0` | **Hypothesis B.** That row is the wedge. | §5 |
| `applied < 40, unfinished = 0` | Deploy never ran at all — check Railway's deploy history. | §5 |
| `rolled_back > 0` | Someone intervened by hand. Find out who and when before touching anything. | §5 |

Then name the exact rows:

```bash
psql "$PROD_DIRECT_URL" <<'SQL'
WITH expected(name) AS (VALUES
  ('20260820050300_operation_ref_lead_time_process_seq'),
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
       m.finished_at,
       CASE WHEN m.migration_name IS NULL THEN 'NEVER RAN'
            WHEN m.finished_at IS NULL     THEN 'FAILED — THIS IS THE WEDGE'
            WHEN m.rolled_back_at IS NOT NULL THEN 'ROLLED BACK BY HAND'
            ELSE 'APPLIED' END AS state
FROM expected e LEFT JOIN _prisma_migrations m ON m.migration_name = e.name
ORDER BY e.name;
SQL
```

Record the full output in `LEDGER.md`. This is the first real evidence anyone
will have about production's state since 2 Sep.

**Also record the deploy timestamps** from Railway's deploy history for pushes
`f5a499f`, `02803b3`, `859d293`, `39968fc`, `7597a3c` — success or failure, each
one. Under Hypothesis B they will all show the same pre-deploy failure.

---

## 4. Hypothesis A — verification

Migrations applied. Now confirm the schema, the data the drop consumed, and the
app. None of this was checked on 2 Sep.

### 4.1 Schema matches the datamodel

```bash
pnpm exec prisma migrate diff \
  --from-url "$PROD_DATABASE_URL" --to-schema-datamodel ./prisma/schema.prisma --exit-code
```

**Pass:** exit 0, "No difference detected". Non-zero means production's schema is
not what the running code expects — queries reference columns that do not exist.

### 4.2 The dropped table, and what replaced it

```bash
psql "$PROD_DIRECT_URL" -c "SELECT to_regclass('public.procurements');"   # expect NULL
psql "$PROD_DIRECT_URL" -c "SELECT count(*), min(at), max(at) FROM procurement_events;"
psql "$PROD_DIRECT_URL" -c "SELECT type, count(*) FROM procurement_events GROUP BY 1 ORDER BY 1;"
```

**Pass:** `to_regclass` NULL, and `procurement_events` holds rows across the
`INDENT_RAISED` / `INDENT_APPROVED` / `PO_PLACED` / `RECEIPT` types the migration's
backfill maps to.

**There is no way to verify the backfill against the source** — the source table
is gone and no pre-drop dump was taken. The strongest available check is human:
open a job that had procurement history before 2 Sep and confirm its indent/PO/
receipt dates still read correctly in the UI (§4.4 step 5). If they do not, the
data is not recoverable from production; the only possible source would be a
Railway backup predating 2 Sep, which is exactly what LEDGER D2 does not yet
guarantee exists. **Check whether such a backup exists before anything else in
this section** — its retention window is closing.

### 4.3 Grants and invariants survived

```bash
psql "$PROD_DIRECT_URL" -c \
  "SELECT has_table_privilege('despl_web','v_process_plan_percent','SELECT') AS view_readable,
          has_table_privilege('despl_web','procurement_events','UPDATE')     AS must_be_false,
          has_table_privilege('despl_web','stock_txns','DELETE')             AS must_be_false_2,
          has_table_privilege('despl_web','audit_log','UPDATE')              AS invariant_5;"
```

**Pass:** `view_readable = t`; the other three `f`. The last is invariant #5
(append-only audit); the middle two are `20260827180000`'s append-only REVOKEs.

```bash
psql "$PROD_DIRECT_URL" -c "SELECT count(*) FROM pg_policies WHERE schemaname='public';"
```

**Pass:** non-zero. RLS is the only tenant boundary this app has.

### 4.4 The app, in a real browser

Against the production URL. Not curl, not a hand-made cookie, not `jose` — see
CLAUDE.md's "never forge credentials".

1. `curl -fsS https://<production-host>/api/health` → 200.
2. `/login`, real credentials, real form submit.
3. Dashboard renders with real numbers.
4. One job detail page, all five tabs.
5. **The BOM / procurement view of a job that had procurement history before 2
   Sep** — the §4.2 check, and the only one that can catch a bad backfill.
6. `/workspace`.

**Pass:** every page renders, console clean. Record page by page in `LEDGER.md`.

### 4.5 Confirm S1–S4 are actually live

They were merged but never verified in production. Cheap checks:

```bash
curl -sI https://<production-host>/ | grep -i 'content-security-policy\|x-frame-options\|strict-transport'
```

**Pass:** S2's headers present. If absent, the running container predates PR #10
and you are in Hypothesis B after all — go to §5.

---

## 5. Hypothesis B — incident procedure

Production is serving pre-2-Sep code against a partially-migrated schema, and
four merged work items are not live.

**Do not push a new commit to `main` to "trigger a redeploy".** The wedge is a
database row; a new push re-runs the same `migrate deploy`, hits the same failed
row, and fails identically.

### 5.1 Identify and root-cause the wedge

§3's second query names it. Get Railway's pre-deploy log for `f5a499f` and read
the actual Postgres error. Match it against §6 — the failure is almost certainly
§6.2 (missing role), §6.3 (backfill guard) or §6.6 (constraint vs real data).

### 5.2 Fix the cause, then resolve the row

Per §6's recovery for that specific migration. The general shape, run over the
TCP proxy as the direct/owner role:

```bash
# 1. fix the underlying cause (create the role / fix the data / create the user)
# 2. clear the failed row so deploys can proceed
pnpm exec prisma migrate resolve --rolled-back <migration_name>
# 3. redeploy from Railway's UI — no new commit needed
```

**Print `$DATABASE_URL` and read it before every one of these.** These are the
only commands in this document that write to production.

Never `prisma migrate resolve --applied` here. It marks a migration applied
*without running its SQL* — on `20260827120001` that would skip the backfill and
the drop, leaving a schema Prisma believes is current and is not.

### 5.3 Then run all of §4

Once the deploy goes green, §4 is still owed in full. It was never done.

---

## 6. Failure-mode reference

What each failure looks like in a pre-deploy log, and its recovery. Under
Hypothesis A these are historical; under B, one of them is your incident.

### 6.1 Checksum mismatch

**Currently not a risk.** No migration file has changed since the 2 Sep deploy
(`git log --since=2026-09-01 -- prisma/migrations/` is empty), so what is on disk
matches what was applied. It becomes a risk again the moment anyone edits an
applied migration — which has happened twice on this repo already:
`20260827120001` (3 commits: `d812f7a`, `c3a67ab`, `f21b6b8`; its own header
records the failed-deploy incident that forced the rewrite) and
`20260831064422_phase5` (`83f78cb`, then `d38c7c7` "Add missing FK constraint and
CHECK constraint").

**Looks like:** `The migration <name> was modified after it was applied.` Aborts
before applying anything.

**Recovery:** on a disposable DB, `DELETE FROM _prisma_migrations WHERE
migration_name = '<name>'` and re-run. **On production, neither that nor
`migrate resolve --applied` is acceptable** — the second skips the SQL entirely.
The real fix is to never edit an applied migration; write a new forward-only one.

### 6.2 Missing `despl_web` role

`20260827040000_v_process_plan_percent` ends with `GRANT SELECT ON
v_process_plan_percent TO despl_web;`. **This exact failure already happened once
on this project** — `progress.md`'s Railway-first-deploy session records
`20260815120000_v_unit_stage_status` failing the same way on a fresh DB.

**Looks like:** `ERROR: role "despl_web" does not exist`, at migration 9 of 21.
The eight before it are applied; this one gets a null `finished_at` and wedges
every later deploy.

**Recovery:**

```bash
DESPL_WEB_PASSWORD='<value>' psql "$PROD_DIRECT_URL" \
  -v despl_web_password="$DESPL_WEB_PASSWORD" -f scripts/provision-db-role.sql
pnpm exec prisma migrate resolve --rolled-back 20260827040000_v_process_plan_percent
# redeploy from Railway's UI
```

Production connects as `despl_web`, so the role plainly exists there — this one
is unlikely to be the 2 Sep wedge, but it is the first thing the log will rule out.

### 6.3 The `procurements` drop

`20260827120001` backfills every `procurements` row into `procurement_events` in
plain SQL, verifies with two `DO $$` guards that `RAISE EXCEPTION`, then `DROP
TABLE "procurements"` plus two enums. Its header: *"the actual point of no return
for the old flat-status data... there is no data path back."*

**Looks like, failing:** one of
- `...% tenant(s) with procurement history have no admin@despl.local user to attribute ProcurementEvent.by to`
- `...% procurements row(s) carry indent/PO/receipt dates with no matching procurement_events row`

Prisma wraps each Postgres migration file in a transaction, so an abort rolls the
file back and `procurements` survives — but the row is recorded failed.

**Recovery when failed:** create the missing `admin@despl.local` for the named
tenant, or investigate with `scripts/backfill-procurement-events.ts` in dry-run;
then `migrate resolve --rolled-back` and redeploy. **This is the good outcome** —
it means the data still exists.

**Recovery when succeeded:** none. See §4.2.

### 6.4 Unattended `preDeployCommand` — old code, new schema

The structural hazard, and the shape of Hypothesis B. `railway.json`'s
`preDeployCommand` applies every pending migration in one unattended pass with no
prompt and no gap between migrations. (`20260827120001` was rewritten to inline
its backfill precisely because a doc comment saying "run the backfill first" had
no way to execute here.) When it fails, the old container keeps serving and the
healthcheck stays green — a failure state with no symptom. §4.5 is the cheap
detector.

### 6.5 No staging environment

One Railway `production` environment. Appendix A's restored copy is a local DB,
not a deployed environment — it never exercises Railway's build, its env vars,
`assertDbRole()` in `src/instrumentation.ts`, or the internal
`postgres.railway.internal` host. Config-shaped failures (a Railway-injected
`DATABASE_URL` shadowing the manual one — see `progress.md`'s first-deploy
session — a missing `SEED_PASSWORD`, `postinstall` not regenerating the client)
can only appear on the real deploy. This is why deploys must be watched.

### 6.6 Constraints against real production rows

Three migrations pass trivially on an empty database and can fail on production's
actual data. This is the likeliest cause of a 2 Sep wedge, and the reason
Appendix A insists on a *restored* copy rather than a fresh one.

| Migration | Adds | Fails when |
|---|---|---|
| `20260827170000_actor_fks_and_partial_unique` | ~20 `ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES "users"("id")` across `process_plans`, `component_operations`, `weld_logs`, `weld_joints`, `qcp_executions`, `delay_reasons`, `progress_snapshots`, … validated immediately, no `NOT VALID` | any column holds a user id absent from `users` |
| `20260826140000_component_unit_tag_unique` | drops `components_equipment_id_tag_key`, creates unique `(unit_id, tag)` | two components share a `tag` within a unit |
| `20260827050000_component_equipment_grain_tag_unique` | same shape, equipment grain | same |

**Looks like:** `violates foreign key constraint` / `could not create unique
index ... Key (unit_id, tag)=(...) is duplicated`.

**Finding the offenders** (read-only, safe to run on production now regardless of
which hypothesis holds):

```sql
SELECT id, submitted_by FROM process_plans p
WHERE p.submitted_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.submitted_by);

SELECT unit_id, tag, count(*) FROM components GROUP BY 1,2 HAVING count(*) > 1;
```

Under Hypothesis A these must return zero rows — the constraints are live, so
they cannot return anything. Under B they will name the blocking data.

---

## 7. Rollback

The 2 Sep deploy has been live for days, so production has taken writes against
the new schema. **A restore is far more costly now than it was on 2 Sep** — it
discards every write since the restore point.

| Situation | Action |
|---|---|
| Hypothesis B, wedge identified | §5.2. Data intact. No restore. This is recoverable. |
| Hypothesis A, app broken | Redeploy an earlier `main` commit from Railway's UI. **The schema does not roll back** — you get old code against the new schema. Stopgap only. |
| Backfill provably wrong, pre-2-Sep backup exists | Restore is possible but loses every write since. Announce it. Decide deliberately; do not do this reflexively. |
| Backfill provably wrong, no pre-2-Sep backup | The old procurement data is gone. Reconstruct from paper/source documents or accept the loss. |

Never `git push --force` to `main` to undo a deploy. It does not un-drop a table
and it rewrites history others have pulled.

---

## 8. So this cannot recur

Each of these is cheap and each would have prevented 2 Sep. None is done.

1. **Never branch a PR off `demo`.** PR #6 was a docs change that silently
   carried 77 commits and 21 migrations. Branch from `main`; if a change needs
   `demo`'s code, that is a merge decision, not a side effect.
2. **A PR that touches `prisma/migrations/` must be labelled and reviewed as a
   migration PR** — regardless of what its title says. A CI check that fails when
   `prisma/migrations/` changes without an explicit label would have caught it.
3. **Watch every deploy that carries a migration.** S4's own log says neither was
   watched; §6.4 is invisible if nobody looks.
4. **Branch protection on `main`** — LEDGER S4 records this as explicitly *not*
   set.
5. **Close LEDGER D2 (backups).** Every recovery path in §7 is gated on a backup
   that is not confirmed to exist.

---

## Appendix A — rehearsal procedure, for the next merge

Unused on 2 Sep. This is the procedure that should have run, preserved verbatim
for the next migration-carrying merge. It is still correct; only its trigger has
passed.

**A.1 — Dump production.**

```bash
pg_dump --format=custom --no-owner \
  --file="$HOME/despl-prod-$(date +%Y%m%d-%H%M).dump" "$PROD_DIRECT_URL"
```

`--no-owner` but deliberately **not** `--no-acl`: grants and RLS policies are the
thing under test. Migration `20260813051500_rls_and_app_role` grants the whole
permission bundle to `despl_app`; a copy restored with `--no-acl` gives
`despl_web` a schema it cannot read a single row from, and A.5's login would fail
for reasons unrelated to the merge. The consequence is an ordering constraint:
the dump's ACLs name `despl_app`/`despl_web`, so **both roles must exist before
`pg_restore`** — hence A.2 before A.3.

**A.2 — Create the rehearsal DB and its roles, roles first.**

```bash
createdb -h localhost -U postgres despl_rehearse
psql "postgresql://postgres@localhost:5432/despl_rehearse" \
  -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='despl_app') THEN CREATE ROLE despl_app NOLOGIN; END IF; END \$\$;"
DESPL_WEB_PASSWORD='<throwaway, not production's>' \
psql "postgresql://postgres@localhost:5432/despl_rehearse" \
  -v despl_web_password="$DESPL_WEB_PASSWORD" -f scripts/provision-db-role.sql
```

Check: `despl_web` has `rolcanlogin = t` and is a member of `despl_app`.

**A.3 — Restore.**

```bash
pg_restore --no-owner --exit-on-error \
  --dbname="postgresql://postgres@localhost:5432/despl_rehearse" "$HOME/despl-prod-<stamp>.dump"
```

`--exit-on-error` is deliberate; the default logs errors and continues, yielding
a silently incomplete copy. Check `SELECT count(*) FROM pg_policies WHERE
schemaname='public'` is non-zero, and that `_prisma_migrations` matches
production's row-for-row.

**A.4 — Point `.env.rehearse` at it (gitignored; never added to `.env.example`),
and print `DATABASE_URL` before every Prisma command.** The word `despl_rehearse`
must appear; if you see `despl_demo`, `despl_test`, or a `railway.internal` /
`proxy.rlwy.net` host, stop.

**A.5 — Rehearse, on a worktree checked out at the exact commit to be pushed.**

```bash
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \
  --to-migrations ./prisma/migrations --script > ~/rehearse-pending.sql
grep -n 'DROP TABLE\|DROP TYPE\|GRANT\|ADD CONSTRAINT.*FOREIGN KEY\|CREATE UNIQUE INDEX' ~/rehearse-pending.sql
# read every hit before proceeding, then:
pnpm exec prisma migrate deploy 2>&1 | tee ~/rehearse-deploy.log
pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel ./prisma/schema.prisma --exit-code   # must be 0
```

If `migrate deploy` fails, go to §6. **Do not retry blindly** — a failed row
wedges every later deploy, converting one failure into a stuck database.

Do **not** repoint `pnpm test:db` at the rehearsal copy: the DB-gated tests create
Organizations and never clean them up, and `resolveTenantForLogin` fail-closes
when more than one org exists (`progress.md`, "RUN_DB_TESTS now targets its own
database"). Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` instead,
then `PORT=3100 pnpm start` against the rehearsal copy (never `pnpm dev`) and
drive the real `/login` form in a browser.

**A.6 — The abort point.** Everything above is free to abandon: `dropdb
despl_rehearse`, `git worktree remove`, `git branch -f main origin/main`.
**`git push origin main` is the irreversible step** — it triggers the unattended
`migrate deploy` against production. Abort if the rehearsal failed for any
un-root-caused reason, if the schema diff was non-zero, if the browser pass could
not be completed, or if there is no confirmed backup.

**A.7 — Push, and watch the Railway pre-deploy log to completion.** Then run §4.
