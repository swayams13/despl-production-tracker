# SESSION 07 — AUD-027 · Two incompatible definitions of "overdue"

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §5, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 5.*
*Coordination note: this session edits `v_unit_stage_status`'s migration
chain, which Session 03 (AUD-002) also touches. Read "Details that matter"
below before writing your migration.*

---

## PASTE FROM HERE

You are a Database/Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). Single-purpose session: make SQL's
notion of "overdue" agree with the application's.

### Read before writing anything

1. `src/lib/shared/business-day.ts` — read this in full. **The TypeScript-side
   fix already exists and is already correctly applied** across nine service
   files (confirm with
   `grep -rln "istCalendarDayMarker\|isOverdue\|isOnTime" src/ --include=*.ts | grep -v business-day.ts | grep -v test`).
   This session's job is bringing the remaining raw-SQL sites into agreement
   with that existing, correct TS logic — not inventing new logic.
2. `audit/10_BUSINESS_LOGIC.md` §5 (row 19 of the metrics table, and the
   "AUD-027" paragraph) — the finding.
3. Re-grep for the current SQL sites — **do not trust this prompt's line
   numbers**, confirm fresh with:
   `grep -rn "AT TIME ZONE 'UTC'" src/lib/services/*.ts prisma/migrations/*/migration.sql`

### The defect

`business-day.ts`'s own doc comment already names the bug precisely: a raw
`plannedFinish < now()` "flips a plan overdue at 00:00 UTC = 05:30 IST on its
own due date — a full working day early." The fix (`istCalendarDayMarker`,
`isOverdue`, `isOnTime`) is applied everywhere the application computes
overdue-ness in TypeScript. It was never applied to the SQL that computes the
same thing directly in the database. **Confirmed still-raw sites, as of this
session:**

1. `prisma/migrations/20260815120000_v_unit_stage_status/migration.sql` —
   the `is_overdue` column: `pp.planned_finish < (now() AT TIME ZONE 'UTC')`.
2. `src/lib/services/jobs.read.ts` — the `tallies` raw query's `overdue` count,
   same predicate shape.
3. `src/lib/services/portfolio.read.ts` — the `newly_overdue` sub-select,
   same predicate shape.

**Do not touch a fourth site that looks similar but isn't one:**
`portfolio.read.ts`'s `holds_opened` sub-select also contains
`AND pp.actual_start < (now() AT TIME ZONE 'UTC')` — this is **not** an
overdue-definition bug. Read the comment directly above it: it bounds a
rolling 24-hour activity window ("Rolling 24h, NOT an IST calendar day...
the window must not reset to zero at 00:00 IST while people are still
working"), which is a deliberately different, correct use of a raw instant.
Changing it to the calendar marker would itself be a regression. This is
exactly the distinction to get right — an overdue *threshold* compares a
calendar-day field against "has the due day fully passed," which needs the
IST marker; a rolling *window bound* compares an instant against "the last 24
real hours," which correctly needs the raw instant. Classify each site you
find by which of these two it actually is before changing it.

### Your task

**1 — One SQL-side source of truth.** Add a new migration creating a single
`IMMUTABLE` SQL function mirroring `istCalendarDayMarker`'s exact logic:

```sql
CREATE OR REPLACE FUNCTION ist_day_marker(ts timestamptz)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('day', ts AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
$$;
```

Before committing to that exact expression, verify it produces the same
instant as `istCalendarDayMarker` for a handful of cases by comparing against
the TS function directly (a few `SELECT ist_day_marker('2026-09-08T05:29:00Z')`
vs. `istCalendarDayMarker(new Date('2026-09-08T05:29:00Z'))` in a scratch
script) — timezone arithmetic is exactly the kind of thing that looks right
and is off by one boundary case. `IMMUTABLE` is required for it to be used in
an index or a view predicate without Postgres complaining; confirm the
function genuinely qualifies (it must not depend on the session's `TimeZone`
setting — using the explicit `'Asia/Kolkata'` literal in both `AT TIME ZONE`
casts, not the session default, is what makes this safe to mark `IMMUTABLE`).

**2 — Use it at the three confirmed sites**, replacing
`(now() AT TIME ZONE 'UTC')` with `ist_day_marker(now())` in each:

- The `v_unit_stage_status` view (`DROP VIEW; CREATE VIEW` in your new
  migration, copying the current full view body — see the coordination note
  below).
- `jobs.read.ts`'s tallies query.
- `portfolio.read.ts`'s `newly_overdue` sub-select only — leave
  `holds_opened`'s `actual_start < (now() AT TIME ZONE 'UTC')` exactly as it
  is.

**3 — The regression test the audit specifically asks for.** A test asserting
the TS and SQL sides agree at 06:00 IST on a plan's due date (00:30 UTC) — the
exact boundary where the old bug and the correct behavior diverge.

### Details that matter — coordination with Session 03 (AUD-002)

`v_unit_stage_status` is also being modified by a separate session (AUD-002,
adding a tenant-scoping join). **Before writing your migration, check whether
that session's migration has already merged** (`git log --oneline -- prisma/migrations/ | grep -i tenant` or just look for a migration after `20260815120000` that touches this view). If it has, your `CREATE VIEW` must start from *that* migration's body (tenant join included), not the original — copy the current, most-recently-modified version of the view, whichever migration produced it. If it has not merged yet, proceed from the original body and note in your PR that whichever of the two migrations lands second must be rebased to include both changes, or the second one will silently revert the first's fix. Do not guess — check the actual current state of the migrations directory before writing `CREATE VIEW`.

### Constraints — these are binding

- Do not change any other part of `v_unit_stage_status`'s logic beyond the one
  predicate, per the same discipline as Session 03.
- Do not touch `jobs.read.ts`/`portfolio.read.ts`'s non-overdue queries.
- Do not modify `business-day.ts` itself — it is already correct; this session
  brings SQL up to match it, not the reverse.
- Follow `MERGE-RUNBOOK.md`'s rehearsal procedure for the migration.

### Tests

Add a DB-gated test (new file or alongside an existing schedule/overdue test —
check for one first) asserting:

| # | Scenario | Expect |
|---|---|---|
| 1 | A `ProcessPlan` with `plannedFinish` = today's IST calendar date at UTC midnight, queried at 05:00 IST (before the working day has passed) | not overdue, both in `isOverdue()` (TS) and in a raw query using `ist_day_marker` |
| 2 | Same plan, queried at 06:00 IST (the working day has passed) | overdue, both sides agree |
| 3 | Query `v_unit_stage_status`'s `is_overdue` for a plan matching case 1/2 | matches the TS-side answer at both times — this is the actual cross-language regression guard |
| 4 | `jobs.read.ts`'s `overdue` tally and `portfolio.read.ts`'s `newly_overdue` count, same before/after-06:00-IST boundary | both now agree with `isOverdue()` |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note explicitly whether
   Session 03's migration had already landed when you wrote yours, and how you
   handled the view-body coordination.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-027** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-059, AUD-071 | Other "fix landed in one language, not the other" instances the audit's summary table mentions — separate findings, don't chase them here |
| AUD-074 | Delay-reason blocking is a related but separate defect |

## PASTE TO HERE
