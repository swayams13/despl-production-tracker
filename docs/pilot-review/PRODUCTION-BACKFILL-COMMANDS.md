# Production data steps (run by Swayam, from the phone hotspot, owner role)

Rehearsed on 21 Oct 2026 on a restored copy of a fresh production dump (dump `despl-prod-p1-20261021-0939.dump`, 654 KB). **Not** run against production. The `railway run … sh -c` wrapper is the same form as the 18 Oct precedent in `progress.md` but was not itself tested against production.

Run from a checkout at or after `main` `cffa131` with `pnpm install` done. This repo's Railway CLI is linked to **staging**: always pass `--environment production`.

Prerequisites: production serving and the J4a migration applied (the deploy of `main` printed "83 migrations found, 1 applied"). Steps 2 and 3 need it.

```
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"

# 0. dump first
railway run --environment production --service Postgres -- sh -c 'pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "$HOME/despl-prod-pre-backfill-$(date +%Y%m%d-%H%M).dump"'

# pre-flight: must say "Database schema is up to date" (83 migrations) and a *.proxy.rlwy.net target
railway run --environment production --service Postgres -- sh -c 'echo "TARGET: ${DATABASE_PUBLIC_URL##*@}"; DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s exec prisma migrate status'

# 1. design questions (dry run, read it, then add --apply inside the quotes)
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-config-questions.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'

# 2. planned joints for DESPL-320 only
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-planned-joints.ts --job DESPL-320 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'

# 3. equipment types (optional; nothing reads them until J5)
railway run --environment production --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" DIRECT_URL="$DATABASE_PUBLIC_URL" pnpm -s tsx scripts/lean-backfill-equipment-types.ts 2>&1 | tee -a "$HOME/prod-backfill-$(date +%Y%m%d).log"'
```

Always dry run first; `--apply` goes after the `.ts` filename, inside the quotes. Order 1, 2, 3.

## What the dry run must say (stop and re-rehearse if any number differs)

| Step | Expect |
|---|---|
| Target line | `<host>.proxy.rlwy.net/railway` and "dry run". If it says `localhost`, `DATABASE_PUBLIC_URL` was empty: stop. |
| 1 | "questions to create: design_pressure, design_temperature, mdmt, moc, capacity, orientation, radiography, shell_courses" (8) and "default specs to rename: none". |
| 2 | 14 planned joints (LS-1, CS-1, CS-2, SK-1, NF-M1, NF-N2, NF-N3, NS-M1, NS-N1..N6), 126 steps to link, 0 weld records, 72 multi-joint steps left alone. Always pass `--job DESPL-320`. |
| 3 | 3 types (PV-VERT-SKIRT, PV-VERT-LEGS, PV-HORZ-SADDLE), 1 skirt template of 54 steps, 7 kit rows, 1 equipment to link. |

A second `--apply` of any step changes nothing.

## Risks

- J4a's migration only adds enum types, nullable or defaulted columns and one empty table (trigger and RLS). Production tables are tiny, so locks are short.
- Counts are valid only while DESPL-320's data is unchanged since the dump.
- The copy ran as a superuser, so row-level security and the `despl_web` grants were not exercised by the rehearsal; production runs the scripts as the owner role, as on 18 Oct.
