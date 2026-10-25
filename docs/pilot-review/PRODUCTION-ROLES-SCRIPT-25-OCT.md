# Production: apply the assembly-roles script (L1.2h) — prepared 25 Oct 2026, NOT run

Run by Swayam, from the **phone hotspot** (the office LAN blocks the Railway DB proxy), owner role. Rehearsed on a fresh seeded database and applied on staging (31 fills, v2 published). Writes: one new assembly template version, 54 steps, one audit row. Never edits a published version, never deletes, never re-pins a running job.

Do this **before** `lean-backfill-equipment-types.ts` (its skirt template copies the newest published version) and before any new job is created on production.

## 0. Setup
```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
cd "/Users/sonusingh/AI DEVELOPMENT DESPL/DESPL/despl-roles"
git log -1 --oneline            # expect 7aa962a ... (merged to main as 3039d37)
ls scripts/lean-publish-assembly-roles.ts
railway whoami                  # must show you; if "Unauthorized": railway login
```

## 1. Two read-only check files
```bash
cat > "$HOME/roles-check.sql" <<'EOF'
\echo --- family template versions: version|status|steps|with_role|pressure
select v.version, v.status, count(*) steps, count(*) filter (where s.role is not null) with_role, count(*) filter (where s.pressure_part) pressure
from assembly_template_versions v join assembly_templates t on t.id = v.template_id join assembly_template_steps s on s.version_id = v.id
where t.equipment_type_id is null group by 1,2 order by 1;
\echo --- DESPL-320 step rows by role: role|count
select coalesce(role::text, 'NULL') as role, count(*) from assembly_steps
where job_id = (select id from jobs where job_number = 'DESPL-320') group by 1 order by 1;
\echo --- audit rows of this script
select count(*) from audit_log where action = 'setup.assemblyTemplate.roles';
EOF
```

## 2. Dump first
```bash
railway run --environment production --service Postgres -- sh -c 'pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "$HOME/despl-prod-pre-roles-$(date +%Y%m%d-%H%M).dump"'
ls -l "$HOME"/despl-prod-pre-roles-*.dump && pg_restore -l "$HOME"/despl-prod-pre-roles-*.dump | head -3
```
The file must be non-empty and `pg_restore -l` must list entries.

## 3. Before (read-only)
```bash
railway run --environment production --service Postgres -- sh -c 'echo "TARGET: ${DATABASE_PUBLIC_URL##*@}"; psql "$DATABASE_PUBLIC_URL" -At -f "$HOME/roles-check.sql"'
```
Expect: TARGET is `<host>.proxy.rlwy.net:<port>/railway`; template `1|PUBLISHED|54|0|0` (only v1, no roles); DESPL-320 `279` rows with a role and `207` `NULL` (31 and 23 steps x 9 units; 486 in all); audit count `0`.
**Stop if** DESPL-320 shows 0 rows with a role: then its own steps never got their facts and the pilot job has no H1/H4-H6 either (run `lean-backfill-floor-facts.ts` first, separate decision).

## 4. Dry run
```bash
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-publish-assembly-roles.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```
Expect exactly:
```
target: <host>.proxy.rlwy.net/railway (dry run); mapping REVIEWED_PROVISIONAL, reviewed against v1
source: v1 (newest published family version)
steps to fill: 31; already complete: 23
would publish: v2
```
**Stop if** the target says `localhost` (the variable was empty), the fill count is not 31, a `skipped:` line appears (for example "the mapping does not match"), or a `note:` says the source is not v1. A `skipped:` line still exits 0, so read the whole output.

## 5. Apply (same command, `--apply` after the filename)
```bash
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-publish-assembly-roles.ts --apply 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```
Expect `published: v2`.

## 6. After (read-only) and a second dry run
```bash
railway run --environment production --service Postgres -- sh -c 'psql "$DATABASE_PUBLIC_URL" -At -f "$HOME/roles-check.sql"'
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-publish-assembly-roles.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```
Expect: template `1|PUBLISHED|54|0|0` (unchanged) and `2|PUBLISHED|54|31|25`; DESPL-320 still `279` / `207`; audit count `1`; the second dry run says `steps to fill: 0; already complete: 54` and "Nothing to do".

## 7. What this changes, and what it does not
- **New jobs** (and new equipment lines) from the Pressure Vessel template get v2: roles, joints and pressure flags, so H1 and H4-H6 apply, and fewer steps go to QC (provisional D3 rule).
- **Existing jobs keep their pin**, including DESPL-320 (its rows already carry roles).
- Nothing is deleted, so there is no undo step. If v2 turned out wrong, nothing running is affected; restore the step-2 dump only if no new production data was written since.
- Next in the backfill order: equipment types (`PRODUCTION-BACKFILL-COMMANDS.md` step 4), after this.

## 8. Then tell me
Paste the output of steps 3 to 6 (it contains no secrets: the target line shows the host and database only). I will then check it against the expectations above and update the go/no-go report.

## Result: executed 25 Oct 2026, about 17:10 to 17:15 IST (by Claude at Swayam's request)
- Target `shinkansen.proxy.rlwy.net/railway` (production). Dump `~/despl-prod-pre-roles-20261025-1710.dump` (690 KB, `pg_restore -l` lists it). Log `~/prod-backfill-20261025.log`.
- Before: template `1|PUBLISHED|54|0|0`; DESPL-320 279 role rows (FIT_UP 63, WELD 72, NDT 117, HEAT_TREATMENT 9, FINAL_PWHT 9, HYDRO 9) and 207 NULL; audit 0.
- Dry run: `steps to fill: 31; already complete: 23`, `would publish: v2`, no `skipped:` or `note:`.
- Apply: `published: v2`.
- After: `1|PUBLISHED|54|0|0` (unchanged) and `2|PUBLISHED|54|31|25`; DESPL-320 unchanged (279 / 207); audit 1; second dry run "Nothing to do"; `/api/health` 200.
- Effect: new jobs and new equipment lines from the Pressure Vessel template now get v2. No running job was re-pinned. Next in the backfill order: equipment types (step 4 of `PRODUCTION-BACKFILL-COMMANDS.md`), not run.

## Also executed 25 Oct 2026, about 17:40 IST (run by Swayam: `bash /tmp/prod-apply.sh`; Claude's own run of these four was blocked by the permission classifier)
Pre-flight "schema up to date". Each dry run matched first (checked by Claude at about 17:20), then applied:
- `lean-backfill-config-questions.ts`: 8 questions created (audit `setup.configQuestion.create` 8).
- `lean-backfill-planned-joints.ts --job DESPL-320`: 14 planned joints, 126 steps linked, 0 weld records, 72 multi-joint steps left alone (read-back `14|126`).
- `lean-backfill-equipment-types.ts`: PV-VERT-SKIRT (active), PV-VERT-LEGS and PV-HORZ-SADDLE (inactive); skirt template of 54 steps; kit PLATE, DISHED_END, SKIRT, FORGING, FLANGE, PIPE, COUPLING (audit `setup.equipmentTypeComponent.create` 7); DESPL-320's equipment linked (audit `setup.equipment.setType` 1).
- `lean-seed-milestones.ts`: 10 milestones, 36 map rows (read-back `10|36`).
Every second dry run said none / nothing to create. One read-back query failed only because it named the table `equipment` (it is `equipments`); the kit and link counts are proven by the audit rows and the second dry run instead, and the query is fixed in the script. Audit totals by action also show the 18 Oct `backfill.floorFacts` rows (369) and this afternoon's `setup.assemblyTemplate.roles` (1).
Still provisional, to ratify: the milestone map (D9, SJ and the MD) and the three equipment-type names (D18).
