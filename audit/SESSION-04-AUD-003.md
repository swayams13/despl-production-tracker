# SESSION 04 — AUD-003 · Any QC user clears a blocking hold point with "N/A"

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §2, `audit/20_REMEDIATION_ROADMAP.md` Phase 1b.*
*This is larger than Sessions 01–03 ("M" complexity, not "S") — it adds a new
authorized action, not just a re-check. Read the whole prompt before starting;
it makes one deliberate design call that differs from the audit's literal
wording, explained below.*

---

## PASTE FROM HERE

You are a Staff Full-Stack Engineer working on **DESPL Production Tracker**, a
Next.js 15 + Prisma 6 + PostgreSQL 16 manufacturing execution system for a
pressure-vessel fabricator. This is a single, tightly-scoped session closing
one P0 compliance defect from a recent enterprise audit.

### Read before writing anything

1. `CLAUDE.md` — the project guide. Invariant #4 is the one this session
   restores: *"Hold points block; W-waivers require Production Head approval
   and are audited."*
2. `audit/10_BUSINESS_LOGIC.md` §2 (AUD-003) — the finding.
3. `src/lib/services/qcp.service.ts` — `recordQcpExecutionTx` and
   `recordQcpExecution` (top of the file). This is where you add the new
   action.
4. `src/lib/services/_shared.ts` — `assertNoOpenHoldPoint` (~line 526) and
   `assertUnitHasNoOpenHoldPoint` (~line 801). Both currently treat a
   result of `NA` as clearing. You are changing both, identically.
5. `src/lib/shared/schemas.ts` — `recordQcpExecutionSchema` (~line 217).
6. `prisma/schema.prisma` — `model QcpExecution` (~line 2075) and
   `model QcpCodeRef` (~line 584). **Every field this session needs already
   exists** — `waiverApprovedBy`, `clearedByPartyRef`, `QcpCodeRef.waivable` —
   they are just never written or read anywhere in `src/`. **This session
   needs no schema change and no migration.**
7. `src/lib/services/qcp.service.test.ts` — the existing DB-gated test
   pattern (`describe.skipIf(!RUN_DB)`, real fixtures via a `PrismaClient`
   owner connection). Your tests go here.
8. `src/lib/services/dispatch.service.ts`'s `approveDispatchRelease` for the
   `requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN)` pattern — you will
   use the identical role pair for the new action.

### The defect

```ts
// schemas.ts:221 — any caller may submit NA
result: z.enum(["ACCEPTED", "REJECTED", "NA"]),

// qcp.service.ts:64 — the only authorization on the whole action
requireRole(actor, ROLES.QC);

// _shared.ts — NA is treated as fully cleared, identically to ACCEPTED
return r !== "ACCEPTED" && r !== "NA"; // undefined (no exec), PENDING, REJECTED all block
```

Grep across `src/` (excluding generated code) confirms `waiverApprovedBy` has
**zero** references, `clearedByPartyRef` has **zero**, and
`QcpCodeRef.waivable` is read only for display, never in a gate. Any single QC
user can dismiss a non-waivable `H` hold — a hydrotest witness point, a final
inspection — by recording `NA`, and `verifyProcess`/dispatch's own gates then
let the stage, unit, and eventually the dispatch proceed. There is no waiver
record, no Production Head signature, and for an ASME/TPI documentation review
the MDR will contain no evidence the decision was ever made deliberately.

### The design call this prompt is making

The audit's own wording says: *"refuse `NA` unless [the code] is waivable and
the actor holds `PRODUCTION_HEAD`, stamping `waiverApprovedBy`."* Read
literally, that means `recordQcpExecution`'s single existing action would need
to accept two different actor roles for one field value — awkward, and it
collapses "QC observed and is flagging this for a waiver" and "Production Head
reviewed and approved the waiver" into one indistinguishable act, which is
weaker evidence for an audit trail than two separate actors, two separate
timestamps, two separate audit rows.

**This session instead splits it into two actions:**

1. `recordQcpExecution` (existing, QC-only, unchanged role gate) may still
   record `NA` — but only when the item has at least one blocking code that is
   `waivable`. A non-waivable blocking code refuses the `NA` outright, at
   submission time. This is a tightened version of today's behavior, not a
   new mechanism.
2. A new `approveQcpWaiver` (Production Head / Admin only) finds that pending
   `NA` execution and stamps `waiverApprovedBy`. Only *after* this stamp does
   `assertNoOpenHoldPoint` / `assertUnitHasNoOpenHoldPoint` treat the
   checkpoint as cleared.

This is closer to how the real hydrotest/witness workflow actually works (QC
flags it, PH reviews and signs off) and gives you a real two-actor,
two-timestamp audit trail — which is what invariant #4 and an MDR review
actually need. If you disagree after reading the code, that's a legitimate
call to make differently, but say so explicitly in your PR description rather
than silently doing something else.

### Your task

**1 — Tighten `recordQcpExecution`: refuse `NA` on a non-waivable blocking code.**

Add one new error code to `src/lib/shared/errors.ts`, in the same style as the
existing entries:

```ts
/** recordQcpExecution (AUD-003): NA was submitted for a checkpoint whose blocking code is not waivable — it can never be cleared this way. */
QCP_CODE_NOT_WAIVABLE: "QCP_CODE_NOT_WAIVABLE",
```

Give it a message in `ERROR_MESSAGES` and an HTTP mapping (409) in
`src/app/api/_lib.ts`'s `STATUS` map, matching `UNIT_NOT_COMPLETE`'s pattern
from a previous session.

In `recordQcpExecution`, after resolving `unit` and before calling
`recordQcpExecutionTx`, when `result === "NA"`: load the `qcpItem`'s party
codes and check whether any `blocksCompletion` code exists that is **not**
`waivable`. If so, throw `QCP_CODE_NOT_WAIVABLE` with the `qcpItemId` in
context, before any write happens. If every blocking code on this item is
waivable (or there is no blocking code at all — a non-hold-point checkpoint),
allow the `NA` to be recorded exactly as today, with `waiverApprovedBy` left
`null` — it is now a *pending* waiver, not a cleared one.

**2 — Add `approveQcpWaiver`.**

New schema in `schemas.ts`, next to `recordQcpExecutionSchema`:

```ts
export const approveQcpWaiverSchema = z.object({ qcpItemId: id, unitId: id }).strict();
export type ApproveQcpWaiverInput = z.infer<typeof approveQcpWaiverSchema>;
```

New function in `qcp.service.ts`, following `recordQcpExecution`'s own
tenant-anchoring pattern (unit resolved through `equipment.job.tenantId`, not
a bare id lookup — the same C3 concern its comment already explains):

```ts
export async function approveQcpWaiver(actor: Actor, input: ApproveQcpWaiverInput): Promise<QcpExecution> {
  const { qcpItemId, unitId } = approveQcpWaiverSchema.parse(input);
  assertNotClientUser(actor);
  requireRole(actor, ROLES.PRODUCTION_HEAD, ROLES.ADMIN);

  return withTenant(actor.tenantId, async (tx) => {
    const unit = await tx.unit.findFirst({
      where: { id: unitId, equipment: { job: { tenantId: actor.tenantId } } },
    });
    if (!unit) throw new AppError(ERROR_CODES.NOT_FOUND, { entity: "Unit", unitId });

    // latest attempt for this (item, unit) — same "latest wins" convention
    // as assertNoOpenHoldPoint's own resolution.
    const latest = await tx.qcpExecution.findFirst({
      where: { qcpItemId, unitId },
      orderBy: { attemptNo: "desc" },
    });
    if (!latest || latest.result !== "NA") {
      throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, { qcpItemId, unitId, actual: latest?.result ?? null });
    }
    if (latest.waiverApprovedBy != null) {
      throw new AppError(ERROR_CODES.INVALID_STATE_TRANSITION, { qcpItemId, unitId, reason: "already approved" });
    }

    return audited(tx, actor, async () => {
      const updated = await tx.qcpExecution.update({
        where: { id: latest.id },
        data: { waiverApprovedBy: actor.userId },
      });
      return {
        result: updated,
        audit: {
          action: "qcp.waiver_approve",
          entityType: "QcpExecution",
          entityId: updated.id,
          after: { qcpItemId, unitId, waiverApprovedBy: actor.userId },
          eventType: "QcpWaiverApproved",
          eventPayload: { qcpItemId, unitId },
        },
      };
    });
  });
}
```

Wire it into whatever the QC UI's checkpoint action surface is (the same
component that currently offers ACCEPTED/REJECTED/NA) — add a
Production-Head-only "Approve waiver" action visible on a checkpoint whose
latest execution is `NA` with `waiverApprovedBy` still null. Follow this
project's existing `useRun`/refusal-note pattern for the button and its error
display rather than inventing a new one — check how the existing QC action
buttons wire their server action + refusal display and match that.

**3 — Make the hold-point gates waiver-aware.**

In `_shared.ts`, both `assertNoOpenHoldPoint` and `assertUnitHasNoOpenHoldPoint`
currently select only `result` from the latest execution per item. Change both
to also select `waiverApprovedBy`, and change the "open" predicate:

```ts
const execs = await tx.qcpExecution.findMany({
  where: { /* unchanged */ },
  orderBy: { attemptNo: "desc" },
  select: { qcpItemId: true, result: true, waiverApprovedBy: true },
});

const latestByItem = new Map<number, { result: string; waiverApprovedBy: number | null }>();
for (const e of execs) if (!latestByItem.has(e.qcpItemId)) latestByItem.set(e.qcpItemId, e);

const open = itemIds.filter((itemId) => {
  const e = latestByItem.get(itemId);
  if (!e) return true;                                   // no execution at all — blocks
  if (e.result === "ACCEPTED") return false;
  if (e.result === "NA") return e.waiverApprovedBy == null; // NA clears only once approved
  return true;                                             // PENDING / REJECTED block
});
```

Apply this identically in both functions — they are two independently
maintained copies of the same resolution logic (one scoped to a
`jobProcessId`, one to a whole unit for packing/dispatch), and this audit
already treats their divergence as a risk. Do not refactor them into one
shared helper in this session unless it is trivial — if it looks like more
than a few lines of extraction, leave the duplication and note it for a later
session instead of expanding this one's scope.

### Details that matter

- **Do not add the DB CHECK constraint the audit text suggests**
  (`result <> 'NA' OR waiver_approved_by IS NOT NULL`). That constraint
  assumes `NA` and its approval happen in the same write. Under this session's
  two-step design, QC legitimately inserts `NA` with `waiver_approved_by NULL`
  first, and `approveQcpWaiver` updates the same row later — the constraint as
  written would make step one impossible. If DB-level hardening is wanted
  later, it needs a different shape (e.g. checking against a separate
  approval-audit table), which is a real design question, not something to
  improvise here. State this explicitly in your PR — it is a deliberate,
  reasoned deviation from the audit's literal text, not an oversight.
- **Maker-checker is not required between the QC submitter and the approving
  Production Head** in this design — `qcp.service.ts`'s own existing comment
  notes "the maker-checker rule (#3) sits on process verify, not on the
  execution itself." Leave it that way; do not add a same-person check unless
  you find CLAUDE.md says otherwise on a closer read.
- **`clearedByPartyRef`** (recording which external party — `BUYER_TPI`,
  `EIL_TPIA` — actually attended/cleared a witness point) is a related gap
  (see AUD-004) but is **not** required to close AUD-003. Do not wire it in
  this session; it needs its own design pass on how the party is selected in
  the UI.
- **`recordQcpExecutionTx`** (the bare tx-level create, called both by
  `recordQcpExecution` and by `assembly.service.ts`'s AUD-004-relevant
  auto-record path) is unaffected by this session — you are only adding the
  pre-check in the public `recordQcpExecution` wrapper, not in the shared
  tx-level primitive. Confirm this by reading both call sites before you
  finish; if the auto-record path in `assembly.service.ts` also sets
  `result: "NA"` anywhere, that is AUD-004's problem, not something to patch
  here.

### Constraints — these are binding

- **No schema change and no migration.** Every field you need already exists.
- **Refusals must be explainable** — `AppError` with a stable code and context
  naming the `qcpItemId`/`unitId`, never a bare `Error`.
- **Do not modify** `recordQcpExecutionTx`'s signature or body,
  `assembly.service.ts`, `packing.service.ts`, `dispatch.service.ts`, or
  `_shared.ts`'s `assertUnitHasNoOpenNcr` / `assertUnitProductionComplete`.
- **Every check stays inside its existing transaction.**

### Tests

Add to `src/lib/services/qcp.service.test.ts`, matching its existing
`describe.skipIf(!RUN_DB)` DB-backed fixture style:

| # | Scenario | Expect |
|---|---|---|
| 1 | QC records `NA` on a checkpoint whose only blocking code has `waivable: false` | refused, `QCP_CODE_NOT_WAIVABLE`, no row written |
| 2 | QC records `NA` on a checkpoint whose blocking code has `waivable: true` | succeeds, row written with `waiverApprovedBy: null` |
| 3 | After (2), `assertNoOpenHoldPoint` / `assertUnitHasNoOpenHoldPoint` for that item | still reports **open** — this is the core regression guard |
| 4 | A PRODUCTION_HEAD calls `approveQcpWaiver` on (2)'s item/unit | succeeds, `waiverApprovedBy` set, audit row written |
| 5 | After (4), the same hold-point assertions | now report **clear** |
| 6 | A QC-role actor (not PRODUCTION_HEAD/ADMIN) calls `approveQcpWaiver` | refused, `FORBIDDEN` |
| 7 | `approveQcpWaiver` called on an item with no `NA` execution at all (e.g. still `PENDING`) | refused, `INVALID_STATE_TRANSITION` |
| 8 | `approveQcpWaiver` called twice on the same execution | second call refused, `INVALID_STATE_TRANSITION` |
| 9 | QC records plain `ACCEPTED` (not `NA`) on any checkpoint | unchanged behavior — still clears immediately, no waiver involved |

Test 3 is the one that actually proves the fix; without it, a broken
implementation that still auto-clears on `NA` would pass every other test.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test
pnpm test:db          # RUN_DB_TESTS — never point it at despl_demo
```

Then confirm:

- `git diff --stat` shows nothing in `prisma/`.
- Both `assertNoOpenHoldPoint` and `assertUnitHasNoOpenHoldPoint` were changed
  identically — diff them against each other mentally, or literally, to check
  they didn't drift.
- The new UI control (if you wired one) only renders for
  PRODUCTION_HEAD/ADMIN, and only on a checkpoint actually in the pending-NA
  state.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State your two-step design
   decision (and the deliberately-skipped CHECK constraint) explicitly in the
   description.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-003** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-004 | `assembly.service.ts` auto-stamps external inspectors' hold points as `ACCEPTED` on internal verify — a related but separate defect, in a different file |
| `clearedByPartyRef` / TPI call-given/attended | Genuinely unimplemented (Phase 2, per the code's own comment) — not required to close AUD-003 |
| Merging `assertNoOpenHoldPoint`/`assertUnitHasNoOpenHoldPoint` into one shared function | Real duplication, but a refactor of its own — do not expand this session into it |

If you find something genuinely new that is not on that list, write it down in
the LEDGER entry rather than fixing it here.

## PASTE TO HERE
