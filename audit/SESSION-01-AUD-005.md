# SESSION 01 — AUD-005 · Dispatch release and recording re-check nothing

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §2, `audit/20_REMEDIATION_ROADMAP.md` Phase 1a item 2.*

---

## PASTE FROM HERE

You are a Staff Full-Stack Engineer working on **DESPL Production Tracker**, a
Next.js 15 + Prisma 6 + PostgreSQL 16 manufacturing execution system for a
pressure-vessel fabricator. This is a single, tightly-scoped session closing one
P0 defect from a recent enterprise audit.

### Read before writing anything

1. `CLAUDE.md` — the project guide. The **non-negotiable invariants** section is binding.
2. `audit/10_BUSINESS_LOGIC.md` §2 — the finding you are fixing, with evidence.
3. `src/lib/services/dispatch.service.ts` — the file you are changing.
4. `src/lib/services/packing.service.ts` — its sibling; `assignUnitToPackage` shows the same gate pattern applied correctly at its own binding point.
5. `src/lib/services/dispatch.service.test.ts` — 24 existing tests. Yours go here.
6. `src/lib/services/_shared.ts` — read `assertUnitHasNoOpenHoldPoint` (~line 801) and `assertUnitHasNoOpenNcr` (~line 757). **Do not modify either.**

### The defect

`dispatch.service.ts` imports both quality assertions at line 6 and calls them in
exactly one place — inside `addUnitToBatch`, at lines 151–152:

```ts
await assertUnitHasNoOpenHoldPoint(tx, unit.id, unit.equipment.jobId);
await assertUnitHasNoOpenNcr(tx, unit.id, unit.equipment.jobId);
```

`approveDispatchRelease` (line 178) and `recordDispatch` (line 233) contain
**neither call**. Their only gate is `assertDispatchBatchTransition(...)` on the
derived PLANNED → RELEASED → DISPATCHED status.

Separately, **no function in `dispatch.service.ts` or `packing.service.ts` reads
`ProcessPlan.status` at all.** Nothing anywhere requires production to be
finished before a vessel leaves the gate.

Two real consequences:

- A unit added to a batch on Monday that fails PAUT on Wednesday — NCR opened,
  hold point flipped REJECTED — is still released and dispatched on Friday. The
  gate ran three days before the defect existed. Batch membership is immutable
  after `addUnitToBatch`; the unit's **quality state is not**.
- A unit with all 36 of its process stages `NOT_STARTED` can be packed, added to
  a batch, released and dispatched, producing a dispatch note, gate pass and LR
  number for a vessel that has not been built.

For an ASME/TPI documentation review this is material. It is the single cheapest
P0 in the audit to close.

### Your task

**1 — Re-run the two existing quality gates at both later binding points.**

In `approveDispatchRelease` and in `recordDispatch`, after the existing
`assertDispatchBatchTransition(...)` call and before the `audited(...)` block,
load the batch's units and run both assertions per unit:

```ts
const links = await tx.dispatchBatchUnit.findMany({
  where: { dispatchBatchId: batch.id },
  select: { unitId: true },
});
for (const { unitId } of links) {
  await assertUnitHasNoOpenHoldPoint(tx, unitId, batch.jobId);
  await assertUnitHasNoOpenNcr(tx, unitId, batch.jobId);
}
```

Keep the `addUnitToBatch` check exactly as it is — it is early feedback and its
comment explains why it is not redundant. Add a short comment at each new site
saying *why* the re-check exists (quality state is mutable after batching), in
the same explanatory style the file already uses.

**2 — Add a production-completeness gate.**

Add a new stable error code to `src/lib/shared/errors.ts`:

```ts
/** A unit was released or dispatched with production stages still incomplete. */
UNIT_NOT_COMPLETE: "UNIT_NOT_COMPLETE",
```

Codes are an API contract — **append, never rename**, and give it a doc comment
matching the surrounding style. Add its user-facing sentence wherever the other
codes' messages live, and its HTTP mapping in `src/app/api/_lib.ts` if that file
maps codes to statuses.

Then write `assertUnitProductionComplete(tx, unitId, jobId)` in
`src/lib/services/_shared.ts`, alongside the two existing assertions and
following their shape. It must refuse with `UNIT_NOT_COMPLETE` when any
`ProcessPlan` for that unit under the job's **current** schedule run is not
`COMPLETE`.

Call it from `approveDispatchRelease` and `recordDispatch` in the same loop as
the two gates above. **Do not** call it from `addUnitToBatch` — a unit is
legitimately incomplete when it is first added to a planned batch.

Three details that matter, in order of how easy they are to get wrong:

- **Excluded processes.** A `JobProcess` with `included = false` never receives a
  `ProcessPlan`, so filtering on plans alone handles this correctly. Do not add
  an `included` filter and do not treat a missing plan as incomplete.
- **Schedule-run grain.** Scope to the current run via the plan's
  `scheduleRun: { isCurrent: true }` relation, matching how
  `loadMyOverdueCount` in `src/lib/services/workspace.read.ts` (~line 995) does
  it. A separate audit finding (AUD-034) notes a job can currently hold two
  `isCurrent` runs; **that is not your problem in this session** — do not try to
  fix it, and do not write code that depends on there being exactly one.
- **Empty batch.** A batch with no units must not silently pass as "complete".
  Decide and state your choice in the PR: either it is a no-op (nothing to
  check) or releasing an empty batch is itself refused. Prefer the no-op unless
  the existing transition machine already forbids it.

### Constraints — these are binding

- **Every check runs inside the existing `withTenant` transaction**, after
  `lockDispatchBatchForUpdate`. Never gate outside a transaction.
- **No client timestamps.** `recordDispatchSchema` has no date field and must not
  gain one. `actualDispatchDate` stays `new Date()` server-side.
- **Refusals must be explainable.** Throw `AppError` with a stable code and a
  context payload naming the offending `unitId` — never a bare `Error`, never a
  generic message. The UI renders these codes as the sentence telling a
  supervisor why they were refused.
- **Do not modify** `_shared.ts`'s two existing assertions, the state machine,
  `packing.service.ts`, any migration, `schema.prisma`, or any UI file.
- **No schema change and no migration in this session.** If you believe one is
  needed, stop and say so rather than writing it.
- **Tests are required for the violation cases, not just the happy path** —
  CLAUDE.md's testing convention for anything touching gating.

### Tests

Add to `src/lib/services/dispatch.service.test.ts`, matching the existing
fixture style in that file. These are DB-gated; follow the surrounding
`describe.skipIf(!process.env.RUN_DB_TESTS)` pattern.

| # | Scenario | Expect |
|---|---|---|
| 1 | Unit added to a batch clean, then an NCR is opened, then `approveDispatchRelease` | refused, `NCR_OPEN` |
| 2 | Same, then `recordDispatch` | refused, `NCR_OPEN` |
| 3 | Unit added clean, then a blocking checkpoint flips to REJECTED, then release | refused, `HOLD_POINT_OPEN` |
| 4 | Unit whose process plans are not all COMPLETE, then release | refused, `UNIT_NOT_COMPLETE` |
| 5 | Same unit, then `recordDispatch` | refused, `UNIT_NOT_COMPLETE` |
| 6 | Unit with a legitimately **excluded** process (`JobProcess.included = false`) and all remaining plans COMPLETE | **allowed** — this is the regression guard that stops the fix over-blocking |
| 7 | Fully clean unit, all plans COMPLETE, no NCR, no open hold | release and record both succeed, and the existing audit row and domain event are still written |
| 8 | `addUnitToBatch` on an incomplete unit | still **allowed** — proves you did not add the completeness gate too early |

Test 6 is the one most likely to fail if the implementation is wrong. Write it.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test                    # pure tests
pnpm test:db                 # DB-gated — never point RUN_DB_TESTS at despl_demo
```

Then re-read your own diff and confirm:

- both new gates are inside the transaction, after the lock;
- `addUnitToBatch` behaviour is unchanged;
- no file outside `dispatch.service.ts`, `_shared.ts`, `errors.ts`, the code→message/status maps, and the test file was touched;
- `git diff --stat` shows nothing in `prisma/`.

### When you are done

1. Open a PR. **Do not merge to `main` directly** — `main` auto-deploys to
   Railway. In the description, state the empty-batch decision you made and list
   which of the eight tests are new.
2. Append an entry to `docs/mos-execution/LEDGER.md` in that file's existing
   format: what shipped, decisions taken, anything you found and deliberately
   did not fix.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-005** as closed with the PR
   reference. That register is the live status board for the remediation, not a
   snapshot.

### Explicitly out of scope for this session

Do not touch these even if you notice them — each is a separate tracked finding
with its own session:

| Finding | What you may notice |
|---|---|
| AUD-034 | A job can hold two `isCurrent` schedule runs |
| AUD-003 | A QC user can clear a blocking hold point by recording result `NA` |
| AUD-004 | Verifying an assembly step auto-accepts an external inspector's checkpoint |
| AUD-026 | NCRs auto-close from `OPEN`, skipping disposition |
| AUD-030 | `v_unit_stage_status` ignores `JobProcess.included` |

If you find something genuinely new that is not on that list, write it down in
the LEDGER entry rather than fixing it here.

## PASTE TO HERE
