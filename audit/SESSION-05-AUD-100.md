# SESSION 05 — AUD-100 · Migrations don't apply from scratch on a clean cluster

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/11_DATABASE_AUDIT.md` §2, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 7.*
*Independent of every other session. Smallest one in this batch.*

---

## PASTE FROM HERE

You are a Database Engineer working on **DESPL Production Tracker** (Next.js
15 + Prisma 6 + PostgreSQL 16). Single-purpose session: make the migration set
replayable on a clean cluster.

### Read before writing anything

1. `CLAUDE.md` — manual-migration discipline; Railway does not auto-apply.
2. `audit/11_DATABASE_AUDIT.md` §2 — the finding.
3. `prisma/migrations/20260813051500_rls_and_app_role/migration.sql` — how
   `despl_app` is created (idempotent, inside a `DO` block) and granted to.
4. The three offending migrations —
   `prisma/migrations/20260815120000_v_unit_stage_status/migration.sql`,
   `prisma/migrations/20260827040000_v_process_plan_percent/migration.sql`,
   `prisma/migrations/20260905020000_operation_ref_family_seq/migration.sql`
   — confirmed via `grep -n "GRANT SELECT ON.*despl_web" prisma/migrations/*/migration.sql`.

### The defect

Replaying every migration on an empty Postgres cluster (no manually-created
`despl_web` role) fails three times:

```
psql:/tmp/all_migrations.sql:1563: ERROR:  role "despl_web" does not exist
psql:/tmp/all_migrations.sql:2209: ERROR:  role "despl_web" does not exist
psql:/tmp/all_migrations.sql:3084: ERROR:  role "despl_web" does not exist
```

Three bare `GRANT SELECT ON <view> TO despl_web;` statements. `despl_app` is
created idempotently by the migration set itself; `despl_web` is created by a
script that runs outside it and isn't guarded. A disaster-recovery rebuild, a
fresh environment, or a from-scratch CI job dies at migration #7 of 50.

### Your task

Do **not** edit the three historical migration files — applied migrations are
immutable in this project's discipline (Prisma checksums them). Add one new,
forward migration that re-grants correctly:

```sql
GRANT SELECT ON v_unit_stage_status TO despl_app;
GRANT SELECT ON v_process_plan_percent TO despl_app;
```

`despl_web` inherits from `despl_app` (confirm this membership is real — check
whichever role-provisioning script creates `despl_web` for
`despl_web ... IN ROLE despl_app` or `GRANT despl_app TO despl_web`; if it
isn't there, that's a separate, more serious finding — stop and report it
rather than silently assuming inheritance works). Once confirmed, the existing
direct `despl_web` grants become redundant but harmless — leave them in the
old migrations untouched; this new migration is additive.

### Details that matter

- **This does not change any runtime behavior for the current cluster** —
  `despl_web` already has `SELECT` on both views today, directly. This is
  purely about what a *new* cluster gets when replaying from migration #1.
- **Verify the actual fix, not just the grant statement.** Spin up (or use a
  rehearsal copy per `MERGE-RUNBOOK.md`) a cluster with zero roles pre-created,
  replay every migration including your new one in order, and confirm zero
  errors. Replaying with `despl_web` already existing (today's normal
  rehearsal path) will not exercise this bug at all — you must test the
  from-scratch case specifically.

### Constraints — these are binding

- No application code changes.
- Do not touch the three historical migration files' contents or checksums.
- Do not change the `despl_web` provisioning script's actual grants in this
  session — if it's missing the `despl_app` membership, report it; adding
  that membership (if it's really absent) is arguably part of closing this
  finding, but confirm what CLAUDE.md or the provisioning script's own comments
  say about *why* it grants directly, in case there was a deliberate reason,
  before changing it.

### Tests

No unit test applies here — this is a deployment-replay property, not
application behavior. Verification is the from-scratch replay described above.
If this repo has any CI step that provisions a database from migrations alone
(check `.github/workflows/`), confirm it also exercises the true from-scratch
case (no pre-existing `despl_web`) — if it doesn't, note that gap in your PR
rather than trying to fix CI in this session.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
```

Plus the from-scratch replay above — describe exactly what you ran and its
output in the PR description, since there's no automated test asserting this.

### When you are done

1. Open a PR. **Do not merge to `main` directly.**
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-100** closed with the PR
   reference.

### Explicitly out of scope for this session

Any other grant-ordering or role-provisioning issue you notice — write it in
the LEDGER entry rather than fixing it here.

## PASTE TO HERE
