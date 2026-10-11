# SESSION 08 — AUD-034 · A job can hold two "current" schedule runs at once

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §4, `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 16.*
*"M" complexity, not "S" — this prompt makes a design call the roadmap's own
one-line suggestion doesn't fully cover. Read "The design call" before
writing code.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a schedule-run
integrity bug that several other sessions in this audit have deliberately
routed around rather than fixed — it's cited as "a separate, tracked finding"
in at least three other places in this codebase's comments.

### Read before writing anything

1. `CLAUDE.md` — invariant #6 (no destructive edits) and the manual-migration
   discipline.
2. `audit/10_BUSINESS_LOGIC.md` §4 (AUD-034) and the "Schedule 'current'" row
   of §1's metrics table.
3. `src/lib/services/_shared.ts` — `persistScheduleRun` (~line 312),
   `getCurrentScheduleRun` (~line 411), `getCurrentScheduleRunsBatch` (~line
   423). Read all three in full; they are the entire surface this session
   touches in application code.
4. `prisma/schema.prisma` — `model ScheduleRun` (~line 1026). Note
   `equipmentId` is nullable and there is **no** unique constraint on
   `(jobId, isCurrent)` today — only `(jobId, equipmentId, version)`, which the
   code's own comment already flags as insufficient (`NULL`-distinct
   semantics in Postgres mean it "cannot stop two `isCurrent` runs racing to
   the same version").
5. `src/lib/services/override.service.ts` — `applyDurationOverride`, the
   other real caller of `persistScheduleRun` (via `getCurrentScheduleRun`) —
   confirm via `grep -n "generateSchedule(\|persistScheduleRun(" src/ -r --include=*.ts`
   that these two call sites (`schedule.service.ts`'s `generateSchedule` and
   `override.service.ts`'s `applyDurationOverride`) are genuinely the only
   two paths that create a schedule run.
6. `src/app/actions/job-intake.ts`'s `scheduleNewJobAction` — the actual UI
   entry point for `generateSchedule`. Confirm it never passes an
   `equipmentId` (it doesn't, as of this audit) — this tells you per-equipment
   scheduling is not exercised by any real screen today, only reachable
   through `override.service.ts`'s schema, which accepts an optional
   `equipmentId` from its input.

### The defect

```ts
// _shared.ts, persistScheduleRun
const priorRun = await tx.scheduleRun.findFirst({
  where: { jobId, equipmentId, isCurrent: true },
  ...
});
...
await tx.scheduleRun.updateMany({
  where: { jobId, equipmentId, isCurrent: true },
  data: { isCurrent: false },
});
```

Demotion is scoped to the exact `(jobId, equipmentId)` pair of the run being
created. `generateSchedule`/`applyDurationOverride` both accept an optional
`equipmentId`. Call once with `equipmentId: null` (a job-grain run becomes
current), then call again with a real `equipmentId` (an equipment-grain run
becomes current) — the second call's demotion only touches other
equipment-grain runs at that same `equipmentId`, leaving the job-grain run
still marked current. **Proven live: both are current simultaneously.**

Every reader assumes exactly one current run per job:

- `v_unit_stage_status` joins `sr.job_id = e.job_id AND sr.is_current = true`
  with **no equipment predicate at all** — if a job has two current runs of
  any grain combination, this view's `exploded` CTE fans out across both,
  roughly doubling every stage-status count.
- `jobs.read.ts`/`portfolio.read.ts` double `totalPlans`/`completePlans`/
  `overduePlans` the same way.
- `getCurrentScheduleRun`/`getCurrentScheduleRunsBatch` silently default
  `equipmentId: equipmentId ?? null` — every caller that doesn't pass one
  (nearly all of them) only ever finds the job-grain run, **silently missing
  an equipment-grain current run entirely** if one exists.

Since the second run's plans are freshly created and `NOT_STARTED`, the
practical symptom is a spine that can never reach complete and two operators
shown the same operation as their own task.

### The design call this prompt is making

The roadmap's one-line suggestion is a partial unique index:
`CREATE UNIQUE INDEX ON schedule_runs (job_id, COALESCE(equipment_id, -1)) WHERE is_current;`
**This does not actually close the bug it's meant to fix.** That index only
prevents two runs at the *identical* grain from both being current — it does
nothing to stop a `(jobId, NULL)` current run and a `(jobId, 5)` current run
coexisting, since those are different index keys. It would correctly harden
the *lock-race* case the code's own comment already worries about, but the
"job-grain and equipment-grain both current" case — the one actually proven
live — needs a different invariant: **at most one current run per job,
full stop, regardless of grain.**

Given that no real UI path exercises per-equipment scheduling today (see
"Read before writing" #6), this session enforces the stronger, simpler
invariant instead:

```sql
CREATE UNIQUE INDEX schedule_runs_one_current_per_job ON schedule_runs (job_id) WHERE is_current;
```

One current row per job. Period. If you find genuine evidence (a real,
shipped or clearly-planned UI feature, not just the schema's *capability* to
set `equipmentId`) that independent per-equipment current runs are an
intentional, needed feature, **stop and say so explicitly in your PR** rather
than silently building the weaker index instead — that would be a real
product-scope question, not something to resolve unilaterally mid-session.
Absent that evidence, proceed with the one-per-job design below.

### Your task

**1 — Data cleanup, inside your migration, before adding the constraint.**
Some job may already have more than one current run (this is the proven-live
state). Demote all but the most recent one per job:

```sql
WITH ranked AS (
  SELECT id, job_id,
         row_number() OVER (PARTITION BY job_id ORDER BY created_at DESC, id DESC) AS rn
  FROM schedule_runs
  WHERE is_current = true
)
UPDATE schedule_runs SET is_current = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
```

Run this as a **preflight check query** (read-only, count affected rows)
against a rehearsal copy before deciding you're comfortable including the
`UPDATE` in the migration — if it turns out to affect real, non-test data,
that's worth flagging in your PR (which job, how many rows) rather than
silently demoting production data inside a routine migration.

Then add the unique index shown above.

**2 — Broaden the application code to match the new invariant.** In
`_shared.ts`:

- `persistScheduleRun`: change `priorRun`'s lookup from `findFirst({ where:
  { jobId, equipmentId, isCurrent: true } })` to `findMany({ where: { jobId,
  isCurrent: true } })`, and merge **all** returned runs' `processPlans` into
  `priorByKey` (extend the existing `.map()` to iterate every run, not just
  one) — during the transition period there could legitimately still be data
  from two runs to carry forward on the very last time this matters (right
  after your migration's cleanup, or for any job mid-flight when this ships).
  After this session, there will only ever be one, but the code should not
  assume that silently.
- Same function: broaden the `version` aggregate's `where` from `{ jobId,
  equipmentId }` to `{ jobId }`, and the final `updateMany` demotion from
  `{ jobId, equipmentId, isCurrent: true }` to `{ jobId, isCurrent: true }`.
  Version numbers become a single per-job sequence instead of per-grain —
  this is correct under the new invariant (there is no more a second grain to
  version in parallel).
- `getCurrentScheduleRun`: drop the `equipmentId` parameter; it always returns
  `tx.scheduleRun.findFirst({ where: { jobId, isCurrent: true }, ... })`, full
  stop.
- `getCurrentScheduleRunsBatch`: same — drop the parameter.
- Update `override.service.ts`'s call sites accordingly (it currently passes
  `equipmentId` explicitly to `getCurrentScheduleRun`). Its own
  `applyDurationOverrideSchema.equipmentId` field can stay in the schema
  input for now (removing it is a separate API-surface decision), but the
  service body should no longer thread it into schedule-run lookups.

### Details that matter

- **`persistScheduleRun`'s row lock is unaffected** — `SELECT id FROM jobs
  WHERE id = ${jobId} FOR UPDATE` already locks at the job grain, which is
  exactly right for the new job-wide invariant; you don't need to change it.
- **Do not touch `v_unit_stage_status` or any other view in this session** —
  once the unique index guarantees one current run per job, that view's
  existing `sr.job_id = e.job_id AND sr.is_current = true` join is already
  correct without modification (there's only ever one row it could match).
  If Sessions 03 (AUD-002) or 07 (AUD-027) have already touched that view's
  migration by the time you run this, your work here needs no changes to it
  either way — this session is pure `ScheduleRun` table + `_shared.ts`.
- **Don't conflate this with AUD-035** (a different, duration-override
  envelope-restamping bug) even though both live in schedule-related code —
  leave `applyOverride`'s CPM recomputation and envelope restamp logic
  untouched.

### Constraints — these are binding

- **Every check stays transactional** — you're not changing the transaction
  boundaries, only the `where` clauses inside them.
- **No client timestamps**, no change to `createdBy`/`createdAt` semantics.
- **Do not modify** `schedule.service.ts`'s `generateSchedule` itself, the
  CPM engine, or `applyOverride`'s recomputation logic — this session touches
  only `_shared.ts`'s three functions plus the two call sites in
  `override.service.ts` that pass `equipmentId` where it's no longer accepted.

### Tests

Add to whichever test file already covers `persistScheduleRun` /
`getCurrentScheduleRun` (check for one — `_shared.test.ts` or similar; if none
exists, create one following this project's DB-gated fixture convention):

| # | Scenario | Expect |
|---|---|---|
| 1 | `generateSchedule` called twice for the same job, both `equipmentId: null` | only the second run is current — this already worked, confirm it still does |
| 2 | `generateSchedule` (equipmentId null) then `applyDurationOverride` passing a real `equipmentId` for the same job | **only one current run exists afterward, for the job overall** — this is the actual regression guard; before your fix this would leave two |
| 3 | Two concurrent `persistScheduleRun` calls for the same job (simulate via two overlapping transactions) racing to become current | the row lock still serializes them; exactly one ends up current, no unique-constraint violation surfaces to either caller |
| 4 | Direct SQL: insert a second `is_current = true` row for a job that already has one, bypassing the service layer entirely | the new unique index rejects it — proves the DB-level backstop, not just the app-level lock |
| 5 | `getCurrentScheduleRun(tx, jobId)` (no `equipmentId` argument — confirm the call site compiles without one) | returns the job's one current run regardless of what `equipmentId` it happens to carry |

Test 2 is the one that actually reproduces the audit's proven-live bug — write
it first, confirm it fails against the pre-fix code, then make it pass.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
npx prisma migrate diff --exit-code
```

Then confirm: `grep -rn "equipmentId" src/lib/services/_shared.ts` no longer
shows it threaded into any `ScheduleRun` query inside the three functions you
changed.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State explicitly what the
   preflight cleanup query found on the rehearsal copy (row counts, which
   jobs if any).
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-034** closed with the PR
   reference — and since this finding is listed as a dependency of AUD-005
   (Session 01, already shipped) in the issue register, note that AUD-005's
   own "not fixed here" caveat about dual-current-run behavior is now moot.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-035 | Duration-override envelope restamping — different bug, same file family |
| AUD-030 | `v_unit_stage_status` ignores `JobProcess.included` — unrelated view defect |
| Removing `equipmentId` from `applyDurationOverrideSchema` entirely | An API-surface decision beyond this session's scope — the schema field can stay even though the service no longer uses it for schedule-run lookup |

## PASTE TO HERE
