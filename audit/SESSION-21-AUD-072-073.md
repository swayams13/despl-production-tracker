# SESSION 21 — AUD-072 + AUD-073 · Quality gates are check-then-act with no lock; publish can revert a VERIFIED snapshot

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §5 (both findings), `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 22.*
*Two findings bundled — same root cause (READ COMMITTED check-then-act with
no protection against a concurrent writer), different subsystems. AUD-073 is
the narrower, cheaper, do-first half; AUD-072 is broader and touches the
transaction infrastructure itself.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes two related
concurrency gaps: quality gates that read-then-act with no lock on what they
read, and a client-facing progress snapshot that can be silently reverted
from VERIFIED back to PUBLISHED by a race with a concurrent publish.

### Read before writing anything

1. `CLAUDE.md` — invariant #5/#6 (audit trail, no destructive edits) and
   whatever it says about transaction discipline.
2. `audit/10_BUSINESS_LOGIC.md` §5 — the **AUD-072** and **AUD-073**
   subsections, both in full.
3. `src/lib/db.ts` — `withTenant` and `withJob` in full. Note neither passes
   an `isolationLevel` to `prisma.$transaction`, so every transaction in this
   codebase runs at Postgres's default, READ COMMITTED.
4. `src/lib/services/_shared.ts` — `assertNoOpenHoldPoint`,
   `assertUnitHasNoOpenHoldPoint`, `assertNoOpenNcr`, `assertUnitHasNoOpenNcr`,
   `assertComponentOpsComplete`. All are plain `findMany`/`findFirst` reads —
   confirm none of them uses `SELECT ... FOR UPDATE` or any row lock.
5. Every real caller of these assertions — confirmed via
   `grep -rn "assertNoOpenHoldPoint\|assertUnitHasNoOpenHoldPoint\|assertNoOpenNcr\|assertUnitHasNoOpenNcr\|assertComponentOpsComplete" src/lib/services/*.ts`
   (excluding `_shared.ts` itself and test files): `process.service.ts`
   (lines ~179, ~239-240 — `verifyProcess`, or whichever function those lines
   are actually in today), `dispatch.service.ts` (lines ~151, ~199, ~266),
   `packing.service.ts` (line ~98). **These are the transition services this
   session's AUD-072 fix targets** — re-confirm the exact current line
   numbers and function names against the live file, they may have shifted.
6. `src/lib/services/client-snapshot.service.ts` — `publishSnapshot`,
   `verifySnapshot`, `rejectSnapshot`, all in full. Note that `verifySnapshot`
   and `rejectSnapshot` **already** protect themselves with a count-checked
   `updateMany` (their own comment: *"the batch was PUBLISHED as of the
   earlier `pending` read, but nothing holds a lock between that read and
   this write... An unchecked `updateMany` would then silently affect 0 rows
   while this call still reports success"*) — **this pattern already exists
   and works**; `publishSnapshot` is the one path that does **not** have it.
7. `prisma/schema.prisma` — the comment at `ProgressSnapshot` (referenced by
   the audit as "Once VERIFIED a row is frozen forever").

### AUD-073 — `publishSnapshot` can revert a VERIFIED row to PUBLISHED

**The defect.** `publishSnapshot` reads `existing` (today's batch) once,
checks `existing.some(r => r.status === "VERIFIED")` and refuses if so — but
then loops over `spines` and calls `tx.progressSnapshot.upsert(...)` per
unit, whose `update` branch unconditionally sets `status: "PUBLISHED"` with
no predicate re-checking status. If a concurrent `verifySnapshot` call
commits **between** the `existing` read and one of these upserts, that row
is now VERIFIED — and this transaction's upsert overwrites it straight back
to PUBLISHED, silently violating the schema's own "frozen forever" guarantee
that `verifySnapshot`/`rejectSnapshot` were specifically hardened to protect.

**Your task.** Apply the exact same defensive pattern `verifySnapshot`
already uses, adapted to `publishSnapshot`'s per-row upsert shape. Since
`upsert` cannot carry an extra `WHERE` predicate on its update branch, split
the operation:

```ts
// inside the existing per-spine loop, replacing the plain upsert
const wasUpdated = await tx.progressSnapshot.updateMany({
  where: { jobId, unitId: spine.unitId, asOf, status: { not: "VERIFIED" } },
  data: { overallPct: percentComplete, detail: {...}, status: "PUBLISHED", publishedBy: actor.userId, publishedAt: new Date(), rejectionReason: null },
});
if (wasUpdated.count === 0) {
  // either no row existed yet (create path) or it's now VERIFIED (race) —
  // disambiguate with a read, and refuse cleanly on the race case rather
  // than silently creating a duplicate or silently doing nothing
  const current = await tx.progressSnapshot.findUnique({ where: { jobId_unitId_asOf: { jobId, unitId: spine.unitId, asOf } } });
  if (current?.status === "VERIFIED") {
    throw new AppError(ERROR_CODES.SNAPSHOT_ALREADY_VERIFIED, { jobId, asOf, unitId: spine.unitId });
  }
  await tx.progressSnapshot.create({ data: { tenantId: actor.tenantId, jobId, unitId: spine.unitId, asOf, overallPct: percentComplete, detail: {...}, status: "PUBLISHED", publishedBy: actor.userId, publishedAt: new Date(), verifiedBy: null, verifiedAt: null, rejectionReason: null } });
}
```

Adapt the exact field lists to match the real current `create`/`update`
payloads in the file (don't retype them from this sketch — copy the real
current values verbatim, changing only the control flow). If you find a
cleaner way to express "update only if not VERIFIED, else refuse" that fits
this codebase's existing conventions better than the create/update split
above (e.g. a single raw SQL `INSERT ... ON CONFLICT ... WHERE` clause), use
it — the requirement is the outcome (no upsert can ever silently revert a
VERIFIED row), not this exact code shape.

**Also apply the same fix to `rejectSnapshot` if it has any equivalent
unconditional per-row write path** — re-read it fully; from what's quoted in
"Read before writing anything" it appears to already use the same
count-checked `updateMany` pattern as `verifySnapshot`, but confirm this
directly rather than assuming based on this prompt's summary.

### AUD-072 — quality gates read-then-act with no lock

**The defect.** All three transition services (`process.service.ts`'s
verify path, `dispatch.service.ts`'s three call sites, `packing.service.ts`'s
one) run their gating assertions as plain reads inside a READ COMMITTED
transaction, with no row lock on the rows they consult. Two concurrent
transactions can each pass the same "no open hold point / no open NCR / all
ops complete" check before either commits, then both proceed — e.g. T1
verifies a process while reading "no open NCR," and T2 commits a rejection
(opening an NCR) in the gap; both succeed, leaving a stage COMPLETE with an
open NCR against it. The audit calls this out as low-probability per event
but realistic on a shift-change pattern (a QC user rejecting while a
supervisor verifies at the same moment).

**Your task.** Run these specific transition services at
`RepeatableRead` isolation, with retry-on-serialization-failure, rather than
changing every transaction in the codebase to a stronger isolation level:

1. Add an isolation-level option to `withJob` (the function these transition
   services actually call — confirm this against each of the four call
   sites) that passes through to `prisma.$transaction`:

```ts
// db.ts — extend withJob's existing opts, don't change its default behavior
export async function withJob<T>(
  tenantId: number, jobId: number, fn: (tx: Tx) => Promise<T>,
  opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  ...
  return withTenant(tenantId, async (tx) => { ...; return fn(tx); }, opts);
}
// and withTenant needs the same opts.isolationLevel threaded into its own
// prisma.$transaction(..., { timeout, isolationLevel }) call
```

2. Add a small retry wrapper for the specific Postgres serialization-failure
   error (`SQLSTATE 40001`, "could not serialize access due to concurrent
   update") — a `RepeatableRead` transaction that loses this race is
   **expected** to throw, by Postgres design, and the correct caller
   response is to retry the whole transaction, not surface a 500:

```ts
export async function withSerializationRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isSerializationFailure = /* check err's Postgres error code === '40001', via Prisma's error wrapping — confirm the actual shape Prisma surfaces this as (PrismaClientKnownRequestError with a specific code, or the raw driver error) before writing this check */;
      if (!isSerializationFailure || attempt >= maxAttempts) throw err;
    }
  }
}
```

Confirm the exact error shape Prisma surfaces a Postgres `40001` as (this
varies by Prisma version and whether the error originates inside a raw query
vs. the query engine) — do not guess; write a small reproduction (two
concurrent `RepeatableRead` transactions racing on the same row) against
your rehearsal database and inspect the actual thrown error's shape before
finalizing the check.

3. Wire the four confirmed call sites (`process.service.ts`'s verify path,
   `dispatch.service.ts`'s three, `packing.service.ts`'s one) to call
   `withSerializationRetry(() => withJob(tenantId, jobId, fn, { isolationLevel: "RepeatableRead" }))`
   instead of a bare `withJob(...)` call. Do not change any other
   `withJob`/`withTenant` call site in the codebase — this is deliberately
   scoped to the four gates the audit identified, not a blanket isolation
   change.

### Details that matter

- **`RepeatableRead` changes failure behavior, not just correctness** — a
  caller of one of these four functions must now be prepared for the
  underlying action to legitimately retry (and take slightly longer) under
  real contention. Confirm the existing `timeoutMs` on these call sites (if
  any) still leaves enough room for up to `maxAttempts` retries; adjust if
  not, and say so in your PR.
- **Do not apply `RepeatableRead` to `withTenant`'s default** — cross-job,
  cross-tenant reads (dashboard, portfolio, my-day) have no correctness need
  for it and it would only add contention/retry overhead with no benefit;
  keep the change scoped to `withJob` call sites that opt in explicitly.
- **AUD-073's fix stands on its own** — even a service that never adopts
  `RepeatableRead` still needs its read-then-act write protected the way
  `verifySnapshot` already protects itself; don't conflate "fixed via
  isolation level" with "fixed via count-checked write" — they're two
  different defenses for two different findings, applied in this session to
  two different files.

### Constraints — these are binding

- **`STALE_WRITE`/`SNAPSHOT_ALREADY_VERIFIED` are existing error codes** —
  reuse them; don't invent a parallel code for the same class of conflict
  unless you find the existing ones are semantically wrong for this specific
  path (check their current usages first).
- **No schema change.**
- **Retry logic must be bounded** (a fixed `maxAttempts`, no infinite loop)
  and must re-run the **entire** transaction callback, not just the failed
  statement — confirm your wrapper actually calls `fn` fresh each attempt,
  not a memoized promise.

### Tests

Add to `client-snapshot.service.test.ts` and each of `process.service.test.ts`,
`dispatch.service.test.ts`, `packing.service.test.ts` (DB-gated, using real
concurrent transactions — not mocked — since this is exactly the class of
bug that only reproduces under real Postgres concurrency semantics):

| # | Scenario | Expect |
|---|---|---|
| 1 | Two real concurrent transactions: T1 `verifySnapshot`s today's batch; T2 `publishSnapshot`s the same job concurrently, racing to land between T1's commit and T2's per-row upsert | T2's write to the now-VERIFIED row is refused (`SNAPSHOT_ALREADY_VERIFIED`), not silently reverted — this is the actual regression guard for AUD-073 |
| 2 | Normal, non-concurrent `publishSnapshot` | unaffected — behaves exactly as before |
| 3 | Two real concurrent transactions on `process.service.ts`'s verify path: T1 verifying a process reads "no open NCR"; T2 concurrently rejects the same operation (opening an NCR) before T1 commits | one of the two transactions fails with a serialization error, is retried by `withSerializationRetry`, and re-reads a now-consistent state — the end state never has a COMPLETE stage with an open NCR against it |
| 4 | Same pattern against `dispatch.service.ts`'s three call sites and `packing.service.ts`'s one | same guarantee — no dispatch/pack proceeds against a hold point or NCR that opened in the race window |
| 5 | `withSerializationRetry` unit test: a function that throws a simulated `40001` twice then succeeds | called exactly 3 times, returns the success result |
| 6 | `withSerializationRetry` with a non-serialization error (e.g. a genuine `AppError` refusal) | thrown immediately, on the first attempt — never retried |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State the exact Prisma
   error shape you found for a `40001` serialization failure, and confirm
   you reproduced it live rather than assuming its shape.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-072** and **AUD-073**
   both closed with the PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| Any `withTenant`/`withJob` call site outside the four confirmed transition services | Not touched — this session is deliberately scoped, not a blanket isolation-level change |
| AUD-034 | `schedule_runs`' own concurrency fix (a DB-level unique index, different mechanism) — already shipped in an earlier session |

## PASTE TO HERE
