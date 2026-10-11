# SESSION 18 — AUD-006 · One CHECK constraint across 73 tables — add the recommended set

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/11_DATABASE_AUDIT.md` §5.1 and §10 (items 1-7 only — see scope note),
`audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 15.*
*Independent of every other session in this batch except the two explicit
exclusions noted below.*

---

## PASTE FROM HERE

You are a Staff Database Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session adds database-level
CHECK constraints for the impossible states the audit proved reachable
through the application's own database role — negative durations, inverted
timestamps, out-of-range percentages, and quantities that don't sum.

### Read before writing anything

1. `audit/11_DATABASE_AUDIT.md` §5.1 — the current state: exactly one CHECK
   constraint exists in the entire schema (`ncr_exactly_one_source`). Read
   its definition as the one existing example of this codebase's own
   "boolean-summation idiom" style.
2. `audit/11_DATABASE_AUDIT.md` §6 — the full "impossible states, proven by
   insertion" reproduction. Read items (a) through (g) in full; this
   session's constraints close (b), (c), (d), (g) directly. **(a) and (e) are
   explicitly flagged in the audit as cross-row and NOT closeable by a CHECK
   constraint** — see "Explicitly out of scope" below.
3. `audit/11_DATABASE_AUDIT.md` §10 — "Recommended constraint set," the
   numbered list of 11 items. **This session implements items 1-7 only** —
   the roadmap's own scoping ("`11` §10 items 1–7"). Items 8-11 are separate,
   already-tracked findings — see scope note immediately below.

### Scope note — read this before writing any SQL

The audit's own §10 list bundles 11 constraint ideas together, but three of
them are **not** this session's to add, for reasons specific to this
codebase's actual, current state:

- **Item 8** (`schedule_runs_one_current_per_job` unique index, AUD-034) —
  **already shipped**, in a different and stronger form than §10 originally
  suggested. Session 08 in this batch implemented `UNIQUE (job_id) WHERE
  is_current` (one current run per job, full stop) rather than the
  `COALESCE(equipment_id, -1)` variant §10 describes, because the weaker
  per-grain version didn't actually stop the proven-live bug. Confirm this
  is already in place (`grep -n "schedule_runs_one_current_per_job"
  prisma/migrations/*/migration.sql`) and do not re-add or alter it here.
- **Item 6** (`qcp_executions`: `CHECK (result <> 'NA' OR waiver_approved_by
  IS NOT NULL)`, the "AUD-003 backstop") — **deliberately NOT compatible**
  with how AUD-003 actually shipped. Confirm this yourself:
  `audit/19_MASTER_ISSUE_REGISTER.md`'s AUD-003 entry states outright: *"DB
  CHECK constraint the audit text suggested deliberately not added
  (incompatible with the two-step design's own first write)."* AUD-003's real
  implementation intentionally writes a `QcpExecution` row with `result =
  'NA'` and `waiverApprovedBy = NULL` as a **legitimate pending state**
  (before a PRODUCTION_HEAD/ADMIN calls `approveQcpWaiver`) — this exact
  CHECK constraint would make that first, correct write fail. **Do not add
  item 6 in this session.** If you believe a different DB-level backstop is
  still worth adding for this specific gate, propose it as a follow-up in
  your PR rather than adding the literal constraint §10 describes.
- **Item 9** (`units_job_id_serial_no_key`, AUD-099) — a separate P2 finding
  with its own "gated on a business-rule confirmation" caveat in the audit
  text itself (does DESPL's own numbering scheme actually guarantee
  uniqueness per job, or per equipment, in real practice — this needs a
  product answer, not an engineering guess). Leave it for its own session.

So this session's real scope is **items 1, 2, 3, 4, 5, 7** from §10:

1. `process_plans` / `component_operations` / `assembly_steps`:
   `CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)`
2. `progress_snapshots`: `CHECK (overall_pct BETWEEN 0 AND 100)`
3. `job_processes` / `template_processes`:
   `CHECK (duration_min_days IS NULL OR duration_min_days > 0)`,
   `CHECK (duration_max_days IS NULL OR duration_max_days >= duration_min_days)`,
   `CHECK (duration_override_days IS NULL OR duration_override_days > 0)`
4. `stock_txns`: `CHECK (qty > 0)`; `stock_lots`: `CHECK (qty >= 0)`
5. `component_operations`:
   `CHECK ("qtyGood" >= 0 AND "qtyRejected" >= 0)`,
   `CHECK ("qtyPlanned" IS NULL OR "qtyGood" + "qtyRejected" <= "qtyPlanned")`
7. Status-evidence pairs:
   `CHECK (status <> 'COMPLETE' OR actual_finish IS NOT NULL)` on `process_plans`;
   `CHECK (status <> 'CLOSED' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))` on `ncrs`

### Your task

For **each** constraint above, in one migration, ordered by value-per-risk
(same order as listed):

1. Run a read-only data-audit query against a production-like rehearsal copy
   **first**, counting existing rows that would violate the constraint:

```sql
-- example for item 1 on process_plans
SELECT count(*) FROM process_plans
WHERE actual_finish IS NOT NULL AND actual_start IS NOT NULL AND actual_finish < actual_start;
```

Do this for every one of the six constraints above before writing the
migration. **If any query returns > 0, that's real, existing bad data** —
document it explicitly in your PR (which table, how many rows, and whether
you can identify why) rather than silently adding a constraint that would
then fail to apply, or silently cleaning the data without flagging it.

2. Add each constraint as `NOT VALID` first, then `VALIDATE CONSTRAINT`
   separately, exactly as the audit itself instructs ("use `NOT VALID` then
   `VALIDATE CONSTRAINT` so the deploy does not block") — this avoids taking
   a long-held lock while validating against existing rows on a live table:

```sql
ALTER TABLE process_plans ADD CONSTRAINT process_plans_finish_after_start
  CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)
  NOT VALID;
ALTER TABLE process_plans VALIDATE CONSTRAINT process_plans_finish_after_start;
```

3. Match this codebase's existing naming convention for constraints (check
   `ncr_exactly_one_source`'s style — lowercase, underscore-separated,
   descriptive of the rule not the columns) for every new constraint name.

### Details that matter

- **`component_operations`'s two quantity constraints (item 5) may interact
  with existing application logic that briefly writes an intermediate
  state.** Before adding `CHECK ("qtyPlanned" IS NULL OR "qtyGood" +
  "qtyRejected" <= "qtyPlanned")`, grep for every write path to these three
  columns (`grep -rn "qtyGood\|qtyRejected\|qtyPlanned" src/lib/services
  --include=*.ts`) and confirm none of them ever writes a transient
  out-of-range combination mid-transaction (e.g., incrementing `qtyRejected`
  before adjusting `qtyGood` in a way that briefly exceeds `qtyPlanned`) —
  a CHECK constraint is evaluated at statement end within a transaction by
  default in Postgres (immediate, not deferred), so a multi-statement write
  sequence that's only valid at commit could still fail mid-transaction if a
  single `UPDATE` statement itself produces a violating row. If you find such
  a path, either fix the write to be a single atomic update, or make the
  constraint `DEFERRABLE INITIALLY DEFERRED` and say so explicitly in your
  PR with the reasoning.
- **The status-evidence pairs (item 7) are the ones most likely to catch
  real historical data** — a `COMPLETE` process plan or `CLOSED` NCR with
  missing evidence fields is exactly the kind of state this audit found
  reachable elsewhere in the app. Take the preflight query results here
  especially seriously.
- **Do not touch `ncr_exactly_one_source`** — it already exists and is
  correct; this session only adds new constraints alongside it.

### Constraints — these are binding

- **Every new constraint uses `NOT VALID` + separate `VALIDATE CONSTRAINT`.**
  No exceptions — this is explicitly how the audit says to do it, and how
  `MERGE-RUNBOOK.md`'s own discipline expects a production ALTER to behave.
- **Do not add items 6, 8, or 9** from §10 — see "Scope note" above.
- **No application code change** — this session is pure schema/migration.
  If your preflight queries turn up real violating data, the fix for that
  data is a separate, explicitly-flagged decision in your PR, not a silent
  cleanup folded into this migration.

### Tests

Add to a schema/constraints test file (check for one; if none exists, a
lightweight DB-gated test file is appropriate here — this is exactly the
kind of test that should live close to the schema, not inside a service
test):

| # | Scenario | Expect |
|---|---|---|
| 1 | Insert/update `process_plans`/`component_operations`/`assembly_steps` with `actual_finish < actual_start` | rejected, constraint violation |
| 2 | Insert `progress_snapshots` with `overall_pct = 250` or `-40` | rejected |
| 3 | Update `job_processes`/`template_processes` with `duration_min_days = -5`, or `duration_max_days < duration_min_days` | rejected |
| 4 | Insert `stock_txns` with `qty = -500`; insert `stock_lots` with `qty = -9999` | both rejected |
| 5 | Update `component_operations` so `qtyGood + qtyRejected > qtyPlanned`, or either quantity negative | rejected |
| 6 | Update `process_plans` to `status = 'COMPLETE'` with `actual_finish` still `NULL`; update `ncrs` to `status = 'CLOSED'` with `closed_by`/`closed_at` still `NULL` | both rejected |
| 7 | Every legitimate, currently-passing write path through the real service layer (run the full existing service test suite) | **unaffected** — this is the real regression guard; if any existing service test starts failing, that's either a genuine latent bug the new constraint correctly caught (flag it, don't just relax the constraint) or a transient-write-order issue per "Details that matter" above |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test           # full existing suite — this is the real regression signal for this session
pnpm test:db
npx prisma migrate diff --exit-code
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Include every preflight
   query's result (row counts, even if zero) for all six constraints, and
   explicitly confirm items 6, 8, 9 were deliberately excluded and why.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-006** closed with the
   PR reference — note explicitly that this closes items 1-7 of the
   recommended set, not all 11, and that items 6/8/9 are tracked separately
   (8 already closed via AUD-034; 6 superseded by AUD-003's actual design; 9
   is AUD-099, open).

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-034 | Already shipped a stronger version of item 8 — don't re-touch `schedule_runs`' unique index |
| AUD-003 | Item 6 is incompatible with its actual shipped design — do not add it |
| AUD-099 | Item 9 needs a business-rule decision first — separate session |
| (a)/(e) from §6 | Cross-row impossible states (predecessor-completion ordering, dispatch-with-open-hold-point) — the audit itself says these need triggers, not CHECK constraints; genuinely out of this session's scope |

## PASTE TO HERE
