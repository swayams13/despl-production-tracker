# Production data steps (run by Swayam, from the phone hotspot, owner role)

Rehearsed on 21 Oct 2026 on a restored copy of a fresh production dump (dump `despl-prod-p1-20261021-0939.dump`, 654 KB). **Not** run against production. The `railway run … sh -c` wrapper is the same form as the 18 Oct precedent in `progress.md` but was not itself tested against production.

Run from a checkout at or after `main` `cffa131` with `pnpm install` done. This repo's Railway CLI is linked to **staging**: always pass `--environment production`.

Prerequisites: production serving with all migrations applied (the 23 Oct deploy `1c575d85` printed "91 migrations found" and "All migrations have been successfully applied"). Steps 2 to 4 need it. **Updated 25 Oct (L1.2h): new step 3 below, and the counts in this file were last rehearsed on 21 Oct, so re-check them on a fresh dump.**

```
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# 0. dump first
railway run --environment production --service Postgres -- sh -c 'pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "$HOME/despl-prod-pre-backfill-$(date +%Y%m%d-%H%M).dump"'

# pre-flight: must say "Database schema is up to date" (91 migrations) and a *.proxy.rlwy.net target
railway run --environment production --service Postgres -- sh -c 'echo "TARGET: ${DATABASE_PUBLIC_URL##*@}"; DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s exec prisma migrate status'

# 1. design questions (dry run, read it, then add --apply inside the quotes)
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-config-questions.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'

# 2. planned joints for DESPL-320 only
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-planned-joints.ts --job DESPL-320 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'

# 3. NEW (L1.2h): publish the assembly template version that carries step roles (H1, H4-H6 for new jobs). BEFORE step 4.
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-publish-assembly-roles.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'

# 4. equipment types (NOT optional: the wizard's Build from master and the BOM release read the kit)
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-equipment-types.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```

Always dry run first; `--apply` goes after the `.ts` filename, inside the quotes. Order 1, 2, 3, 4 (3 before 4: the skirt template copies the newest published version, so it must already carry the roles).

## What the dry run must say (stop and re-rehearse if any number differs)

| Step | Expect |
|---|---|
| Target line | `<host>.proxy.rlwy.net/railway` and "dry run". If it says `localhost`, `DATABASE_PUBLIC_URL` was empty: stop. |
| 1 | "questions to create: design_pressure, design_temperature, mdmt, moc, capacity, orientation, radiography, shell_courses" (8) and "default specs to rename: none". |
| 2 | 14 planned joints (LS-1, CS-1, CS-2, SK-1, NF-M1, NF-N2, NF-N3, NS-M1, NS-N1..N6), 126 steps to link, 0 weld records, 72 multi-joint steps left alone. Always pass `--job DESPL-320`. |
| 3 | "source: v1", "steps to fill: 31; already complete: 23", "would publish: v2" (31 roles, 25 pressure flags; a rehearsal on a freshly seeded DB gave exactly this). If it says "the mapping does not match", stop. A second run says "Nothing to do". Existing jobs keep their pin: DESPL-320's rows got their roles from `lean-backfill-floor-facts.ts` on 18 Oct. |
| 4 | 3 types (PV-VERT-SKIRT, PV-VERT-LEGS, PV-HORZ-SADDLE), 1 skirt template of 54 steps, 7 kit rows, 1 equipment to link. |

A second `--apply` of any step changes nothing.

Also owed and not in this file yet (found in the 25 Oct pre-flight): `scripts/lean-seed-milestones.ts` (J8: 10 milestones, 36 map rows), and the screen steps (master data import, confirming DESPL-320's joints at `/jobs/4/weld-map`, entering its indent/PO). Renaming the placeholder client text is `scripts/rename-client.ts` (section below).

## Rename a placeholder client

`scripts/rename-client.ts` renames one client in the DESPL tenant and writes one `audit_log` row (`client.rename`, before/after) in the same transaction. The new name shows on the dashboard, jobs list, new-job screen and the printed traveller. Dry run by default; `--apply` writes. It refuses an empty name, a name another client in the tenant already has (case-insensitive), a client of another tenant, and a `--match` that finds more than one client (it lists them with their ids).

```
# a. list the candidates: an ambiguous --match prints every hit and exits without writing
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/rename-client.ts --match "Unknown client" --name "x"'

# b. dry run with the id from (a), read before/after, then add --apply and --actor-user <your user id>
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/rename-client.ts --client-id <id> --name "<real client name>" 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```

Run once per placeholder client. The target line must say `*.proxy.rlwy.net/railway`. `--actor-user` is optional (the audit actor is null without it) but is checked to be a user of the tenant. Staging: same commands with `--environment staging`.

## Risks

- J4a's migration only adds enum types, nullable or defaulted columns and one empty table (trigger and RLS). Production tables are tiny, so locks are short.
- Counts are valid only while DESPL-320's data is unchanged since the dump.
- The copy ran as a superuser, so row-level security and the `despl_web` grants were not exercised by the rehearsal; production runs the scripts as the owner role, as on 18 Oct.
