# SESSION 17 — AUD-080 + AUD-069 · Nine tables omitted from the RLS backstop; four SET NULL FKs promote job data into a cross-tenant library

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/12_SECURITY_RBAC.md` §1, `audit/11_DATABASE_AUDIT.md` §3.1 and §5.3,
`audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 14.*
*Hard prerequisite: Session 16 (AUD-001) must land first — this session
extends the same backstop pattern to tables AUD-001's own migration
deliberately did not touch (they were never in the 28-table `job_isolation`
set to begin with; they have no RLS of any kind).*

---

## PASTE FROM HERE

You are a Staff Database Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes two related
gaps: nine `job_id`-carrying tables that were eligible for the tenant/job RLS
backstop but were never enrolled, and four `SET NULL` foreign keys that
silently convert a deleted job's QCP rows into cross-tenant-readable "library"
data.

### Read before writing anything

1. Confirm Session 16 (AUD-001) has landed —
   `grep -rn "tenant_isolation_" prisma/migrations/*/migration.sql | head`.
   If it hasn't, **stop**: this session's fix pattern is "enroll these nine
   tables the same way," and there is no "same way" to point to yet.
2. `audit/12_SECURITY_RBAC.md` §1 — the exact framing: *"nine tables carry
   `job_id` and were eligible for the H1 backstop but were omitted from its
   array, because the policy list was derived from 'tables this migration
   added a column to' rather than 'tables that have the column'. No
   automated check detects the divergence."*
3. `audit/11_DATABASE_AUDIT.md` §3.1 — the full 21-table "no RLS at all"
   list with its `tenant_id`/`job_id` column markers. Of these, **nine carry
   `job_id`**: `assembly_drawings`, `dispatch_batches`, `equipments`,
   `job_processes`, `packages`, `qcp_templates`, `schedule_runs`,
   `weld_joints`, `weld_logs`. (Session 15/AUD-078 already gave
   `qcp_templates` its own `tenantId` column and RLS policy directly — see
   "Coordination with Session 15" below before touching it again here.)
4. `audit/11_DATABASE_AUDIT.md` §5.3 — AUD-069, the four `SET NULL` FKs off
   `jobs`: `qcp_templates.job_id`, `qcp_items.job_id`,
   `inspection_parties.job_id`, `qcp_item_party_codes.job_id`. Read the full
   live reproduction (the `BEGIN`/`DELETE FROM jobs`/`ROLLBACK` transcript
   showing a QCP item's `job_id` going to `NULL` on job deletion, and the
   `job_id IS NULL` read as Tenant Two immediately after).
5. Whichever migration Session 16 (AUD-001) actually added —
   `grep -rln "tenant_isolation_" prisma/migrations/*/migration.sql` — read
   it in full as the pattern to replicate for this session's nine tables.
6. `prisma/schema.prisma` — confirm each of the nine tables' actual `job_id`
   nullability and current foreign key `onDelete` behavior before writing
   anything (some, like `qcp_templates.job_id`, are nullable by design —
   "library" rows genuinely have no job; others like `equipments.job_id` are
   presumably always populated — confirm, don't assume).

### Coordination with Session 15 (AUD-077/078)

Session 15 already added a dedicated `tenantId` column and a fail-closed
`tenant_isolation` policy directly to `qcp_templates`, backfilled from
`job.tenantId` (with its own explicit handling for genuinely global,
`job_id IS NULL` templates). **If that session has landed, `qcp_templates` is
already fully covered — skip it in this session's table list** and reduce
your scope to the remaining eight: `assembly_drawings`, `dispatch_batches`,
`equipments`, `job_processes`, `packages`, `schedule_runs`, `weld_joints`,
`weld_logs`. If Session 15 has **not** landed yet, coordinate explicitly in
your PR about which of the two sessions' migrations should land first — do
not let both add conflicting policies/columns to `qcp_templates`
independently.

### AUD-080 — enroll the eight (or nine) omitted tables

**The defect.** These tables carry `job_id` and are exactly the shape the
H1/AUD-001 backstop pattern was built for, but were left out because the
original migration's table array was hand-derived from "tables this
migration is adding a column to" rather than a live schema query. No test
catches the divergence — `rls-coverage.test.ts`, even after Session 16's
fix, only checks tables that already have `job_isolation` applied; it can't
detect a table that should have it and doesn't, unless it queries the schema
directly for every `job_id`-bearing table.

**Your task.**

1. Add `job_isolation` (the existing fail-open policy shape, verbatim —
   this is not a new policy design) to each of the eight/nine tables:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_isolation ON <table>
  USING ((job_id IS NULL)
      OR (NULLIF(current_setting('app.job_id', true), '') IS NULL)
      OR (job_id = (NULLIF(current_setting('app.job_id', true), ''))::integer))
  WITH CHECK (<identical>);
```

2. Add the `tenant_id` column + fail-closed RESTRICTIVE tenant policy to each
   of these same tables, following **exactly** the pattern Session 16 just
   established (same backfill-then-preflight-then-NOT-NULL-then-RESTRICTIVE-
   policy shape) — these tables need both halves (job_isolation AND the
   tenant floor), not just one, since they were missing RLS entirely, not
   just missing the tenant half.
3. **Extend the coverage test properly this time**: change
   `rls-coverage.test.ts`'s assertion to query `information_schema.columns`
   directly for every table with a `job_id` column, independent of any
   migration's own table array, and assert each one has both policies. This
   is the actual fix for "no automated check detects the divergence" — a
   test keyed off a hand-maintained array has exactly the same blind spot
   this finding proves out.

### AUD-069 — the SET NULL FKs that promote job data into a cross-tenant library

**The defect.** `qcp_templates.job_id`, `qcp_items.job_id`,
`inspection_parties.job_id`, `qcp_item_party_codes.job_id` are all `SET NULL`
on job deletion. `job_id IS NULL` means "library template" by design
(confirmed in migration `20260905030000`) — so deleting a job doesn't remove
its QCP rows, it silently **promotes** them into the shared library, where
(pre-Session-15) the fail-open `job_id IS NULL` branch of `job_isolation`
makes them readable by every tenant. Customer-specific inspection extents,
acceptance criteria and TPI party codes are commercially sensitive and often
contractually confidential — this is a real disclosure path, not just a data
hygiene issue.

**Your task.** Change these four FKs from `SET NULL` to `RESTRICT`:

```prisma
// schema.prisma, all four relations
job Job? @relation(fields: [jobId], references: [id], onDelete: Restrict)
```

This means: **a job with any QCP rows attached can no longer be deleted at
all** until those rows are explicitly handled (either genuinely promoted to
the library via an explicit, audited action, or deleted along with the job).
Before shipping this as a blanket behavior change, check whether "delete a
job" is a real, exercised path in this codebase today:

```bash
grep -rn "jobService.deleteJob\|prisma.job.delete\|tx.job.delete" src/ --include=*.ts
```

If job deletion is not a real UI-reachable action (confirm this, don't
assume it), `RESTRICT` is a safe, low-risk hardening with no user-facing
behavior change. If it **is** reachable, you need an explicit decision in
your PR: either the delete flow must be updated to handle these four
relations first (fail with a clear error naming the blocking QCP rows, or
add an explicit "convert to library template" step with its own audit
trail), or this session should stop and flag the decision rather than
silently breaking a real delete flow. Do not guess at that decision;
verify the actual reachability first and let it drive whether this is a
one-line schema change or needs a companion service-layer fix.

### Details that matter

- **These two findings are independent of each other** except that both
  concern the QCP tables' tenant/job anchoring — you can land AUD-080's
  eight-table enrollment and AUD-069's FK change in the same PR (they're
  bundled here because they're the same roadmap line item, "14"), but review
  each on its own merits; a reviewer should be able to evaluate the RLS
  enrollment and the FK behavior change independently.
- **Do not re-derive `job_isolation`'s predicate** — copy it verbatim from
  an existing table's policy definition (`\d+ units` or similar on your
  rehearsal DB) rather than retyping it by hand, to avoid a subtle
  transcription difference between tables.
- **`equipments`, `job_processes`, `schedule_runs` are read directly by
  `v_unit_stage_status`/`v_process_plan_percent`** (per Session 03/AUD-002's
  interim fix and this batch's own Session 13/AUD-030) — confirm those
  views' `security_invoker=true` behavior is unaffected by adding RLS to
  their base tables (it should only ever narrow results further, never
  break them, assuming the views' own tenant-scoping join still works) —
  test this explicitly, don't just assume compatibility.

### Constraints — these are binding

- **Follow Session 16's exact backfill/preflight/NOT-NULL/RESTRICTIVE-policy
  pattern** for the tenant half — do not invent a different migration shape
  for these nine tables.
- **Do not touch `qcp_templates` if Session 15 has already covered it** — see
  "Coordination" above.
- **The `RESTRICT` FK change is a real behavior change if job deletion is
  reachable** — verify reachability before treating it as low-risk.
- Follow `MERGE-RUNBOOK.md`'s rehearsal procedure.

### Tests

| # | Scenario | Expect |
|---|---|---|
| 1 | Tenant A reads any of the eight/nine newly-enrolled tables, tenant GUC set correctly, job GUC unset | sees all of Tenant A's own cross-job rows (job_isolation fail-open preserved) |
| 2 | Tenant A attempts to read/write a row on one of these tables actually owned by Tenant B | zero rows / zero rows affected |
| 3 | `rls-coverage.test.ts`'s new schema-driven assertion | passes; fails if you locally add a tenth `job_id`-bearing table with no policy, proving it's no longer array-blind |
| 4 | Attempt to delete a job with at least one attached `QcpItem`/`QcpTemplate`/`InspectionParty`/`QcpItemPartyCode` row, post-FK-change | refused at the DB level (`RESTRICT` violation) — or, if a service-layer fix was needed per "AUD-069 your task" above, refused with a clear `AppError` before reaching the DB |
| 5 | Delete a job with zero QCP rows attached | unaffected — succeeds exactly as before |
| 6 | `v_unit_stage_status`/`v_process_plan_percent` queried post-enrollment, as a correctly-scoped tenant | identical results to pre-session (confirms RLS on the newly-enrolled base tables didn't break the views) |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State explicitly whether
   job deletion was found to be a reachable path, and if so how you handled
   it.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-080** and **AUD-069**
   both closed with the PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-001 | The 28-table backstop itself — Session 16's finding, a hard prerequisite here, not to be re-touched |
| AUD-077/078 | `qcp_templates`' own dedicated tenant column and `recordQcpExecution`'s job-match check — Session 15's finding; coordinate, don't duplicate |
| The other 12 zero-RLS tables from §3.1 that don't carry `job_id` (`assembly_template_steps`, `client_visibility_policies`, `holidays`, `organizations`, `process_template_versions`, `route_steps`, `route_template_versions`, `template_edges`, `template_processes`, `user_departments`, `user_roles`) | Genuinely no `job_id` to key a `job_isolation` policy on — a different, tenant-only RLS question, not this finding's scope |

## PASTE TO HERE
