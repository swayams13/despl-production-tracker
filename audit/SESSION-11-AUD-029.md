# SESSION 11 — AUD-029 · PAINTING is permanently un-verifiable

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §5, `audit/20_REMEDIATION_ROADMAP.md` Phase 1b item 11.*
*This prompt implements the safe interim half of the audit's either/or fix,
not the full feature. See "The design call" before writing anything.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a P1 finding that
is, right now, a hard production stop with no clear button: any real
PAINTING operation can be started and submitted, but can never be verified,
and nothing downstream of it can ever complete.

### Read before writing anything

1. `audit/10_BUSINESS_LOGIC.md` §5 (AUD-029).
2. `src/lib/services/component.service.ts` — `verifyComponentOperation`,
   specifically the `if (requiresDftGate)` block
   (`grep -n "requiresDftGate" src/lib/services/component.service.ts`).
   **The gate logic itself is real and correctly implemented** — it checks a
   `PaintRecord` exists and enough distinct `DftReading` coats are accepted.
3. Confirm the write path genuinely doesn't exist:
   `grep -rn "recordPaintRecord\|recordDftReading\|paintRecord\|dftReading" src/app src/components --include=*.ts --include=*.tsx`
   — this should return nothing. If it now returns matches, someone has
   already started the write path; stop and re-read this prompt's premise
   before proceeding, since the fix below assumes it's still fully absent.
4. `prisma/schema.prisma` — `model PaintRecord`, `model DftReading`,
   `OperationRef.requiresDftGate`.
5. `prisma/migrations/20260904230000_operation_ref_requires_dft_gate/migration.sql`
   — how the flag was turned on for `PAINTING` (`UPDATE operation_refs SET
   requires_dft_gate = true WHERE code = 'PAINTING'`).

### The defect

`requiresDftGate` is on by default for the `PAINTING` `OperationRef`. The gate
in `verifyComponentOperation` refuses without a `PaintRecord` and enough
accepted `DftReading` coats. There is no action, no UI, no route anywhere that
can create either row. Every real PAINTING operation:

1. Starts fine.
2. Submits fine.
3. Sits `SUBMITTED` forever — verification always refuses `DFT_NOT_ACCEPTED`.
4. `assertComponentOpsComplete` then blocks the owning process stage.
5. Every successor process is gated behind that stage and never starts.

**No floor user, supervisor, or admin can clear this today.** It is worse than
a missing feature — it's an enabled gate with no reachable way to satisfy it.

### The design call this prompt is making

Building the real write path — a form for recording a coating system and DFT
(dry film thickness) readings per coat, deciding what "accepted" means
operationally, whether there's a spec'd micron range to check against (the
code's own comment already flags this as an open question, not something to
silently invent here) — is a genuine feature, not a bug fix, and needs product
input this session doesn't have. **This session ships the safe interim half
only:** disable the gate until that feature exists, and add a guard so this
specific failure mode — an enabled gate with no reachable producer — can never
happen silently again, for this or any future gate.

If your own read of the situation says the full write path is actually small
enough to do properly in one sitting, don't guess at the missing product
decisions (accepted-range logic, who may record a reading, whether coats are
sequential) — stop and ask, or file the interim fix now and propose the full
feature as its own follow-up. Do not ship a half-designed write path; a wrong
one is worse than none, because it would look authoritative in an MDR.

### Your task

**1 — Disable the gate**, via a new migration:

```sql
UPDATE operation_refs SET requires_dft_gate = false WHERE code = 'PAINTING';
```

Confirm this doesn't need an `OperationRef`-family loop (check whether
`requires_dft_gate` was set per-tenant or globally by the original migration —
if multiple tenants each have their own `PAINTING` `OperationRef` row, make
sure your `UPDATE` reaches all of them, not just tenant 1's).

**2 — A CI assertion that every enabled gate has a reachable producer.** Add a
test (a good place: alongside whatever test file already covers
`component.service.ts`, or a new `src/lib/services/gate-reachability.test.ts`)
that fails the build if this ever regresses:

```ts
// Any OperationRef with requiresDftGate = true must have a real write path
// for PaintRecord/DftReading somewhere under src/app or src/components —
// otherwise the gate is unclearable (AUD-029).
test("every requiresDftGate-enabled operation has a reachable PaintRecord/DftReading producer", async () => {
  const anyGated = await prisma.operationRef.findFirst({ where: { requiresDftGate: true } });
  if (anyGated) {
    // grep-equivalent check, or an explicit allowlist review — see notes below
  }
});
```

Design this test to genuinely fail today if `requiresDftGate` were `true`
anywhere and pass once it's `false` everywhere — a literal filesystem grep
from inside a Vitest test is unusual; consider instead a lightweight
convention: a small `KNOWN_GATE_PRODUCERS: Record<string, boolean>` map in
`_shared.ts` or similar, manually maintained (`requiresDftGate: false` today,
flipped to `true` only in the same PR that ships the real write path), and the
test asserts every `true`-flagged `OperationRef.code` in the seed data has a
corresponding `true` entry in that map. Pick whichever mechanism actually
prevents a silent re-regression — the point is a future PR that flips
`requires_dft_gate` back to `true` without also shipping the write path must
fail CI, not just fail a human code review.

### Details that matter

- **Do not remove the gate logic itself** from `verifyComponentOperation` —
  the check, the `PaintRecord`/`DftReading` models, and `DFT_NOT_ACCEPTED` are
  all correct and should stay exactly as they are, ready for the day the
  write path ships. This session only flips the flag and adds the regression
  guard.
- **Confirm nothing currently depends on the gate being on.** If any test
  fixture or seed data currently relies on `requiresDftGate: true` producing a
  `DFT_NOT_ACCEPTED` refusal as its expected behavior, that test needs
  updating in the same PR — check `component.service.test.ts` for any test
  asserting this refusal and adjust it to reflect the interim disabled state
  (or skip/mark it clearly as testing the *gate mechanism*, not the current
  production configuration).
- **This doesn't affect any other `requiresDftGate` uses** — if you find the
  flag is also set for operations other than `PAINTING` in real seed data,
  disable those too and say so in your PR; the fix is "no enabled gate without
  a producer," not "just PAINTING."

### Constraints — these are binding

- **Do not build any part of the actual write path** in this session — no new
  action, no new schema field beyond what already exists, no UI. That's
  explicitly out of scope, per the design call above.
- **No other schema change.**
- Follow `MERGE-RUNBOOK.md`'s rehearsal procedure for the migration.

### Tests

The CI-guard test above, plus:

| # | Scenario | Expect |
|---|---|---|
| 1 | Start, submit, and verify a PAINTING component operation post-fix, with no `PaintRecord`/`DftReading` at all | verify succeeds — the gate no longer blocks it |
| 2 | The gate-reachability test itself | passes today (flag disabled), and **fails** if you locally flip `requires_dft_gate` back to `true` without also stubbing an entry in your producer map — prove this by testing it both ways during development, don't just assert it in the PR description |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test
pnpm test:db
npx prisma migrate diff --exit-code
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** State plainly in the
   description: this is the interim half of AUD-029; the real fix is shipping
   the paint/DFT recording UI, which is a separate, larger piece of work this
   session deliberately did not attempt.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-029** as *mitigated,
   not closed* — the gate is safely disabled, but the underlying feature gap
   remains; note that a follow-up session is needed to actually ship the
   write path before `requires_dft_gate` can be safely re-enabled.

### Explicitly out of scope for this session

| Item | Why |
|---|---|
| The paint/DFT recording UI and actions | A real feature needing product decisions on acceptance criteria — not a bug fix |
| Any other component-operation gate's completeness | Only `requiresDftGate`/PAINTING was audited here |

## PASTE TO HERE
