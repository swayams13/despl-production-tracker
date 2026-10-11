# SESSION 10 — AUD-026 · NCRs auto-close from OPEN, skipping disposition entirely

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §2, `audit/20_REMEDIATION_ROADMAP.md` Phase 1b item 10.*
*Independent of Sessions 04/09, but closes the same "hold-point engine" group.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a P1 finding: the
normal reject → rework → resubmit → verify flow closes a non-conformance
report with no recorded engineering decision at all.

### Read before writing anything

1. `audit/10_BUSINESS_LOGIC.md` §2 (AUD-026).
2. `src/lib/services/ncr.service.ts` — `NCR_TRANSITIONS` (~line 18) and
   `closeNcr` (~line 135), and `dispositionNcr` (find it —
   `grep -n "export async function dispositionNcr" src/lib/services/ncr.service.ts`).
3. `src/lib/services/component.service.ts` around line 398 — find the current
   auto-close block: `grep -n "openNcrs" src/lib/services/component.service.ts`.
4. `src/lib/services/assembly.service.ts` around line 240 — the identical
   block: `grep -n "openNcrs" src/lib/services/assembly.service.ts`. (Note:
   if you're running this after Session 09 (AUD-004), that session touched
   *later* lines in the same function for a different reason — your changes
   here are in the `openNcrs`/`closeNcr` block, earlier in the function; they
   shouldn't overlap, but re-read the whole function fresh either way.)
5. `prisma/schema.prisma` — `model Ncr`, specifically `disposition`,
   `dispositionedBy`, `dispositionNotes`, and its `status` enum values.
6. `src/lib/shared/errors.ts` — confirm `NCR_NOT_DISPOSITIONED` does not
   already exist (`grep -n "NCR_NOT_DISPOSITIONED" src/lib/shared/errors.ts`)
   — you're adding it.

### The defect

```ts
// ncr.service.ts:25 — close permits OPEN as a source state
close: { from: ["OPEN", "DISPOSITIONED", "REWORK_IN_PROGRESS"], to: "CLOSED" },

// component.service.ts (verifyComponentOperation, re-verify path) —
// every non-CLOSED NCR closed unconditionally
const openNcrs = await tx.ncr.findMany({ where: { status: { not: "CLOSED" }, ... } });
for (const ncr of openNcrs) { await closeNcr(tx, actor, { ncrId: ncr.id, jobId: ncr.jobId }); }
```

Identical block in `assembly.service.ts`'s `verifyAssemblyStep`. `dispositionNcr`
is the **only** writer of `disposition`/`dispositionedBy`/`dispositionNotes`,
and it is **not on this path**. The normal floor sequence — reject, rework,
resubmit, verify — closes the NCR with all three fields `NULL`. The
manufacturing record then shows a non-conformance raised and closed with no
recorded engineering decision: no REPAIR vs. REWORK vs. USE_AS_IS vs.
CONCESSION, no name attached to that call. A TPI or client audit asking "what
was decided about this NCR, and who decided it" gets nothing.

### Your task

**1 — Remove `OPEN` as a valid source for `close`.**

```ts
close: { from: ["DISPOSITIONED", "REWORK_IN_PROGRESS"], to: "CLOSED" },
```

**2 — Add the new error code.** In `errors.ts`:

```ts
/** verifyComponentOperation / verifyAssemblyStep (AUD-026): an NCR opened against this work is still OPEN — it must be dispositioned before the rework that resolved it can be verified closed. */
NCR_NOT_DISPOSITIONED: "NCR_NOT_DISPOSITIONED",
```

Add its message in `ERROR_MESSAGES` and HTTP mapping (409) in
`src/app/api/_lib.ts`'s `STATUS` map.

**3 — Change both verify paths' NCR-closing block identically.** In both
`component.service.ts` and `assembly.service.ts`, change the query from
`status: { not: "CLOSED" }` to `status: { in: ["DISPOSITIONED",
"REWORK_IN_PROGRESS"] }`, and **before** attempting to close anything, check
for any NCR still `OPEN` on the same rejection link and refuse the verify:

```ts
const undispositioned = await tx.ncr.count({
  where: { status: "OPEN", /* same rejection-link predicate the existing openNcrs query uses */ },
});
if (undispositioned > 0) {
  throw new AppError(ERROR_CODES.NCR_NOT_DISPOSITIONED, { /* the same identifying ids the surrounding function already has in scope */ });
}
```

Then proceed to close only the `DISPOSITIONED`/`REWORK_IN_PROGRESS` ones,
exactly as before (`closeNcr` itself is unchanged — it already re-asserts the
transition via `assertNcrTransition`, which now correctly rejects `OPEN` as a
source thanks to step 1, so this refusal is technically double-enforced; add
it anyway, at the point closest to the real cause, so the actor gets
`NCR_NOT_DISPOSITIONED` — an explainable, specific refusal — rather than
whatever generic error would otherwise surface from deep inside `closeNcr`'s
own transition check).

### Details that matter

- **This makes disposition a hard gate on the normal floor flow it wasn't
  before.** After this fix, a rejected operation whose NCR was never
  dispositioned literally cannot be re-verified closed — someone with
  authority to call `dispositionNcr` must act first. Confirm `dispositionNcr`'s
  own role gate (read it) makes sense as a precondition supervisors/QC can
  actually satisfy in the normal flow — if it's gated to a role that isn't
  realistically in the loop at this point (e.g., only ADMIN), that's worth
  flagging in your PR as a workflow gap this fix exposes, not something to
  silently work around by loosening the gate yourself.
- **Do not change `dispositionNcr` itself** — it's already the correct,
  sole writer of the three fields this session cares about; you're only
  making sure the verify paths can no longer route around it.
- **Both files' blocks must change identically** — this is exactly the kind
  of duplicated logic this audit already flags elsewhere as a divergence
  risk. If the two blocks aren't byte-for-byte parallel today (check both
  before you start), don't "fix" other differences between them in this
  session — only the NCR-status handling described here.

### Constraints — these are binding

- **No schema change, no migration** — `disposition`/`dispositionedBy`/
  `dispositionNotes` already exist on `Ncr`.
- **Refusals must be explainable** — the new `AppError` needs enough context
  (at minimum the NCR id(s) still open) for the UI to tell the actor exactly
  what's blocking them.
- **Do not touch** `qcp.service.ts`, `dispatch.service.ts`, or anything from
  Sessions 04/09 — this session's two files are `ncr.service.ts`,
  `component.service.ts`, and `assembly.service.ts` only.

### Tests

Add to each of `component.service.test.ts` and `assembly.service.test.ts`
(check both exist; DB-gated, following their existing fixture patterns):

| # | Scenario | Expect |
|---|---|---|
| 1 | Operation rejected, NCR opens (status `OPEN`), reworked, resubmitted, then re-verified — **NCR never dispositioned** | refused, `NCR_NOT_DISPOSITIONED`, verify does not proceed |
| 2 | Same, but `dispositionNcr` called (any valid disposition) before re-verify | succeeds — NCR closes, `disposition`/`dispositionedBy`/`dispositionNotes` all non-null on the closed row |
| 3 | Two NCRs open against the same rejection link (repeated reject→resubmit→reject, per this file's own existing `findMany`-not-`findFirst` comment) — only one dispositioned | still refused, `NCR_NOT_DISPOSITIONED` — the other one is still open |
| 4 | `closeNcr` called directly with an `OPEN` source NCR (bypassing the service-level check, to test the transition table itself) | refused at the `assertNcrTransition` layer — proves step 1's transition-table change independently of the new pre-check |
| 5 | Fully normal path: no NCR ever raised for this operation | unaffected — verify proceeds exactly as before, no regression for the common case |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

Then confirm the two blocks in `component.service.ts` and `assembly.service.ts`
were changed identically — diff them against each other, not just against
their own history.

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note in the description
   whether `dispositionNcr`'s role gate looked realistic for the normal floor
   flow, per "Details that matter" above.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-026** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| AUD-003, AUD-004 | The other two hold-point-engine findings — different files, different code paths (Sessions 04 and 09) |
| `DelayReason.reviewStatus` having no writer (AUD-074) | Unrelated "decision never recorded" pattern, different subsystem |

## PASTE TO HERE
