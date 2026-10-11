# SESSION 14 — AUD-028 + AUD-059 · `aggregate_id::int` casts risk wrong matches and skip the index

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/07_PROJECT_AUDIT.md` §9, `audit/13_API_AUDIT.md` (raw-SQL section),
`audit/20_REMEDIATION_ROADMAP.md` Phase 1b items 14-15.*
*Two findings bundled — same root cause, same fix pattern, same files.*
*Independent of every other session in this batch.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session fixes a raw-SQL pattern
repeated across four read-service files: casting the polymorphic
`domain_events.aggregate_id` column to `int` inline, instead of casting the
parameter to text.

### Read before writing anything

1. `audit/07_PROJECT_AUDIT.md` §9 and `audit/13_API_AUDIT.md`'s raw-SQL
   findings section (AUD-028, AUD-059).
2. `prisma/schema.prisma` — `model DomainEvent` (or wherever `domain_events`
   is modelled — `grep -n "aggregate_id\|aggregateId" prisma/schema.prisma`).
   Confirm the column is `text`/`varchar`, confirm the actual index:
   `@@index([tenantId, aggregateType, aggregateId, at])` — the index is
   defined on `aggregateId` **as stored** (text), not on any cast of it.
3. Confirm the two already-fixed files first, so you don't re-touch them:
   `grep -n "aggregate_id" src/lib/services/reports.read.ts src/lib/services/myday.read.ts`
   — `reports.read.ts:62` and `myday.read.ts:331,351` already cast the
   *parameter* (e.g. `de.aggregate_id = ${String(id)}` or an explicit
   `::text` on the bind parameter), not the column. Leave these two files
   completely untouched.
4. Then find every remaining bad site — confirm this exact list before you
   start, since it's what defines this session's scope:

```bash
grep -n "aggregate_id::int\|aggregate_id)::int\|CAST(.*aggregate_id.*AS *int" \
  src/lib/services/events.read.ts src/lib/services/jobs.read.ts \
  src/lib/services/portfolio.read.ts src/lib/services/stage-detail.read.ts
```

Expected matches: `events.read.ts:67,82`; `jobs.read.ts:125,134`;
`portfolio.read.ts:69`; `stage-detail.read.ts:282,286` — seven sites across
four files. If your grep returns a different set (a file already fixed, a
new site introduced since), treat the live grep output as authoritative over
this list and adjust scope accordingly — say so in your PR.

### The defect

```sql
-- current pattern, e.g. events.read.ts:67
WHERE de.aggregate_type = 'Unit' AND de.aggregate_id::int = ${unitId}
```

Two separate problems, which is why this is two findings bundled into one
fix:

- **AUD-059 (correctness):** `aggregate_id` is free-text and polymorphic
  across aggregate types (`Unit`, `Job`, `Ncr`, etc. — confirm the actual
  set via `grep -n "aggregateType" prisma/schema.prisma` or wherever it's
  written). Casting the column itself to `int` will throw a runtime error
  (`invalid input syntax for type integer`) the moment any row for the
  matched `aggregate_type` predicate happens to carry a non-numeric id, and
  more subtly, if `aggregate_type` filtering is ever loosened or a join
  reorders predicate evaluation, this cast is applied before the type filter
  narrows rows, not after — the same defensive-ordering hazard already
  documented and fixed in this pattern's *correct* sibling files.
- **AUD-028 (performance):** `@@index([tenantId, aggregateType, aggregateId, at])`
  is built on the column's stored text representation. `aggregate_id::int =
  ${unitId}` cannot use that index at all — Postgres must apply the cast to
  every row's stored value before comparing, forcing a full scan of
  `domain_events` for that tenant/type combination on every request to any
  of these four read services. `reports.read.ts`/`myday.read.ts` already
  prove the fix: cast the **parameter** to text and compare directly against
  the stored column, which is fully indexable.

### Your task

At each of the seven confirmed sites, invert the cast — parameter to text,
column untouched:

```sql
-- before
WHERE de.aggregate_type = 'Unit' AND de.aggregate_id::int = ${unitId}

-- after
WHERE de.aggregate_type = 'Unit' AND de.aggregate_id = ${String(unitId)}
```

For the two sites that compare against an array (`jobs.read.ts`'s tallies or
similar — confirm which of the seven sites, if any, use `= ANY(...)` rather
than a scalar `=`), use the array form matching `reports.read.ts`'s or
`myday.read.ts`'s already-correct sibling pattern exactly:

```sql
-- if a scalar comparison
WHERE de.aggregate_id = ${String(id)}
-- if an array/IN comparison
WHERE de.aggregate_id = ANY(${ids.map(String)}::text[])
```

Read the exact existing correct syntax in `reports.read.ts`/`myday.read.ts`
before writing any of the seven fixes, and match it verbatim in style
(parameter interpolation style, `::text[]` cast placement) — this codebase
should end up with **one** consistent way of doing this comparison across
all six files, not six near-identical variants.

### Details that matter

- **`String(id)` must match exactly what was written at insert time.** Check
  how `aggregate_id` is populated wherever `domain_events` rows are created
  (`grep -rn "aggregateId:" src/lib/services/*.ts | grep -i "audited\|domainEvent"`)
  — if ids are stored as plain `String(numericId)` with no padding/prefix,
  `String(unitId)` on read is correct; if there's any formatting difference
  (e.g. a prefix per aggregate type), your read-side cast must reproduce it
  exactly, or the fix will silently return zero rows instead of throwing —
  which is worse, because it fails quietly. Confirm this before touching any
  call site.
- **Do not change `aggregate_type` string values, `at` column usage, or any
  other predicate in these queries** — this session is scoped to the
  `aggregate_id` cast direction only, at exactly the seven confirmed sites.
- **Do not touch `reports.read.ts` or `myday.read.ts`** — they're the
  reference implementation, already correct, out of scope by definition.

### Constraints — these are binding

- **No schema/migration change** — the column and its index are already
  correctly typed and defined; this is purely an application-layer query fix.
- **Preserve each query's existing tenant/RLS scoping exactly** — you're
  changing one predicate's cast direction, nothing about `withTenant`/GUC
  usage in these functions.
- Match the existing parameterization style in each file (`Prisma.sql`,
  tagged template, or however each of these four files currently builds its
  raw query) — don't introduce string concatenation.

### Tests

Add to whichever test files cover these four services (check for
`events.read.test.ts`, `jobs.read.test.ts`, `portfolio.read.test.ts`,
`stage-detail.read.test.ts`; DB-gated, following existing fixture patterns):

| # | Scenario | Expect |
|---|---|---|
| 1 | Each of the seven fixed call sites, exercised with a real seeded aggregate id that matches | returns the same rows it returned before the fix (behavioral regression guard) |
| 2 | Any one call site, run against a `domain_events` table containing rows for a *different* `aggregate_type` whose `aggregate_id` values are deliberately non-numeric-looking text (construct this in the test fixture) | no runtime cast error — proves AUD-059's correctness fix, since the old `::int` cast would have thrown here if the type filter didn't fully protect it |
| 3 | `EXPLAIN` (via `$queryRaw\`EXPLAIN ...\`` or your test harness's existing convention, if one exists — check for a precedent in these test files before inventing one) on one fixed query | index scan on `domain_events`'s `[tenantId, aggregateType, aggregateId, at]` index appears, not a sequential scan — proves AUD-028's performance fix; if no `EXPLAIN`-checking precedent exists in this codebase's tests, note in your PR that you verified this manually on your rehearsal database instead of asserting it in an automated test |
| 4 | The array/`ANY` site (whichever of the seven uses it) with a multi-id lookup | returns exactly the matching rows, same as pre-fix |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

Then re-run the grep from "Read before writing anything" step 4 — it should
return **zero** matches once you're done.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note in the description
   how you confirmed the on-disk `aggregate_id` string format matches your
   `String(id)` read-side cast (per "Details that matter").
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-028** and **AUD-059**
   both closed with the PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| Anything else in `reports.read.ts` / `myday.read.ts` | Already correct — reference implementation, not to be modified |
| Any other raw-SQL query in these four files not matching the `aggregate_id::int` pattern | Out of scope — only the seven confirmed sites |

## PASTE TO HERE
