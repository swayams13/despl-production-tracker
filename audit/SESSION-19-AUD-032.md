# SESSION 19 — AUD-032 · `assertKitReady` uses the wrong quantity basis on both sides

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §5, `audit/20_REMEDIATION_ROADMAP.md` Phase 1c item 20.*
*Independent of every other session in this batch.*

---

## PASTE FROM HERE

You are a Staff Backend Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session fixes a material-
readiness gate that is simultaneously too strict early in a job and too
permissive late in it — the exact combination the audit calls out as the
worst kind of gate to ship.

### Read before writing anything

1. `audit/10_BUSINESS_LOGIC.md` §5 (AUD-032).
2. `src/lib/services/_shared.ts` — `assertKitReady` in full
   (`grep -n "export async function assertKitReady" -A 45 src/lib/services/_shared.ts`).
   This is the function you're changing.
3. `src/lib/services/bom-explosion.ts` — `explodeBomItem` and
   `computeAvailableForShortage` in full. Note `explodeBomItem`'s `unitCount`
   parameter is a genuine multiplier — it explodes the BOM chain's `qtyPer`
   product **and then multiplies by the equipment's total unit count** — this
   is correct for a whole-equipment material-planning total, and it is what
   `assertKitReady` currently (wrongly) uses for a single-component gate.
4. `src/lib/services/bom.read.ts` lines ~500-530 and ~620-640 — the two
   other real callers of `computeAvailableForShortage`, both display-only
   (`loadBomTree` and a sibling helper). Confirm what they show today (a lot's
   quantity minus SCRAP only) — this session does **not** change what these
   display, only what the gate checks; see "The design call" below for why.
5. `prisma/schema.prisma` — `enum StockTxnType { ISSUE, RETURN, SCRAP }` and
   `model Component.bomItemId`, `model StockLot`, `model StockTxn`.

### The defect

```ts
// _shared.ts, assertKitReady — current body
const [unitCount, siblingItems] = await Promise.all([
  tx.unit.count({ where: { equipmentId: bomItem.equipmentId } }),
  ...
]);
const required = explodeBomItem(itemsById.get(bomItem.id)!, unitCount, itemsById);
const available = computeAvailableForShortage(bomItem.stockLots) ?? new Decimal(0);
const shortfall = required.minus(available);
if (shortfall.gt(0)) throw new AppError(ERROR_CODES.MATERIAL_NOT_AVAILABLE, ...);
```

Two independent problems:

1. **`required` is the whole equipment's kit**, not the one component being
   started. `unitCount` is the equipment's total unit count — on a real
   multi-unit job (the audit's example: DE0463, 40 units), starting the
   *first* cutting operation on unit 1 demands 40 units' worth of that BOM
   item be on hand right now. Staged material delivery — receiving enough
   for the units currently in fabrication, not the whole job at once — is
   normal on a 17-week vessel job, and this gate blocks it.
2. **`available` never deducts `ISSUE`.** `computeAvailableForShortage` only
   subtracts `SCRAP` from the lot total. Once enough material was ever
   received to pass the gate once, it keeps passing forever, regardless of
   how much has since actually been issued and consumed — the gate becomes
   permanently toothless for that BOM item.

Net effect, exactly as the audit states: **the gate blocks legitimate work
early in a job and permits material-less work late in it.**

### The design call this prompt is making

`computeAvailableForShortage` is shared with `bom.read.ts`'s two **display**
call sites, which show a stock lot's remaining quantity to a user browsing
the BOM tree — not a per-component gate decision. Changing its ISSUE
handling would change what those displays show, which is a separate,
untouched-by-this-audit-finding concern. **This session adds a new,
gate-specific function rather than changing the shared display one**, so the
fix is scoped exactly to `assertKitReady`'s behavior:

```ts
// bom-explosion.ts — new function, alongside computeAvailableForShortage
/** Available-to-issue for a gate decision: on-hand minus everything already
 * issued or scrapped, plus anything returned. Distinct from
 * computeAvailableForShortage (display-only; only nets SCRAP) — see AUD-032. */
export function computeAvailableToIssue(lots: StockLotForAvailability[]): Decimal | null {
  if (lots.length === 0) return null;
  let available = lots.reduce((sum, lot) => sum.plus(lot.qty), new Decimal(0));
  for (const lot of lots) {
    for (const t of lot.txns) {
      if (t.type === "SCRAP" || t.type === "ISSUE") available = available.minus(t.qty);
      if (t.type === "RETURN") available = available.plus(t.qty);
    }
  }
  return available;
}
```

If, having read `bom.read.ts`'s actual display copy/labels, you conclude the
**display** is also misleading users about real availability (e.g. a user
believes "available: 12" means issuable, and it silently includes material
already issued elsewhere), say so explicitly in your PR as a follow-up
recommendation — do not fold that change into this session, since it's a
distinct UX/read-model question with its own blast radius (every screen that
renders BOM availability).

### Your task

**1 — Fix the requirement basis.** In `assertKitReady`, compute the required
quantity for **the one component being started**, not the whole equipment:

```ts
const required = explodeBomItem(itemsById.get(bomItem.id)!, /* unitCount */ 1, itemsById);
```

Confirm via `explodeBomItem`'s own logic (re-read it) that passing `1` here
correctly yields "the quantity needed for one unit's worth of this
component," not zero or a nonsensical value — the function multiplies the
`qtyPer` chain product by `unitCount` at the very end, so `1` is the correct
single-unit basis. You no longer need the `tx.unit.count(...)` query at all
for this purpose — remove it if nothing else in the function still needs it
(confirm by re-reading the whole function once you've made this change).

**2 — Fix the availability basis.** Use the new `computeAvailableToIssue`
instead of `computeAvailableForShortage`:

```ts
const available = computeAvailableToIssue(bomItem.stockLots) ?? new Decimal(0);
```

**3 — Re-read the SEAM comments in this function and keep them accurate.**
The existing comments about "no BOM link" and "zero StockLot rows ever
recorded is not a SEAM, it's a genuine shortage" describe behavior this
session doesn't change — leave them in place, but re-verify they still read
correctly given the new quantity basis (e.g., "shortage" is now measured
per-component, so update any comment wording that specifically says
"equipment's" or "whole equipment" kit).

### Details that matter

- **This gate runs per-component, at operation start** — confirm the actual
  call site (`grep -rn "assertKitReady(" src/lib/services --include=*.ts`)
  to see what triggers it, and confirm your fix's "quantity for one
  component" framing matches what's actually being started at that call
  site (a single `Component`, not a batch).
- **`unitCount` may still have a real purpose for the sibling `bomItem`
  quantity lookups** if `explodeBomItem`'s chain-walk touches parent BOM
  items shared across multiple components (e.g. a sub-assembly item whose
  `qtyPer` is defined relative to the *equipment*, not the component) — read
  `explodeBomItem`'s loop carefully; if the chain's semantics genuinely
  require knowing how many components of this exact BOM item exist within
  the *unit* being started (not the whole equipment) rather than a flat `1`,
  use that instead and explain the distinction in your PR. Don't default to
  `1` if the real correct per-unit multiplier is something else — verify
  against `explodeBomItem`'s actual chain-walk logic and a real BOM
  hierarchy, not just this prompt's suggestion.
- **`RETURN` transactions genuinely give material back** — confirm this is
  the correct interpretation by checking any existing service that writes a
  `RETURN` transaction (`grep -rn "type: \"RETURN\"" src/lib/services --include=*.ts`)
  to see what business event actually produces one, so `computeAvailableToIssue`'s
  `+ RETURN` isn't a guess.

### Constraints — these are binding

- **Do not modify `computeAvailableForShortage`** — it stays exactly as is
  for its existing display callers in `bom.read.ts`.
- **No schema change, no migration.**
- **Do not touch `explodeBomItem` itself** — its chain-walk logic is correct;
  only the argument `assertKitReady` passes to it changes.

### Tests

Add to `bom-explosion.test.ts` (for the new function) and whichever test
file covers `assertKitReady` (check `_shared.test.ts` or similar; DB-gated):

| # | Scenario | Expect |
|---|---|---|
| 1 | `computeAvailableToIssue`: a lot with `qty=10`, one `ISSUE` txn of 3 | returns 7 |
| 2 | `computeAvailableToIssue`: a lot with `qty=10`, one `ISSUE` of 3, one `RETURN` of 1 | returns 8 |
| 3 | `computeAvailableToIssue`: a lot with `qty=10`, one `SCRAP` of 2, one `ISSUE` of 3 | returns 5 |
| 4 | `computeAvailableToIssue([])` | returns `null`, matching `computeAvailableForShortage`'s existing no-data convention |
| 5 | `assertKitReady`, real multi-unit equipment (e.g. a 4-unit fixture), enough material on hand for **one** unit's worth but not all four | **succeeds** — this is the actual regression guard for the "blocks legitimate staged work" half of the bug |
| 6 | `assertKitReady`, a BOM item where enough was received once (passing historically) but has since been fully issued and consumed | **refused**, `MATERIAL_NOT_AVAILABLE` — this is the regression guard for the "permits material-less work" half |
| 7 | `assertKitReady`, a component with no `bomItemId` link (SEAM case) | unaffected — still a no-op, exactly as today |

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note explicitly what you
   found when tracing `explodeBomItem`'s chain-walk for the correct
   per-component multiplier (whether it's genuinely `1` or something else),
   and whether you think `bom.read.ts`'s display should also account for
   `ISSUE` (as a follow-up, not in this PR).
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-032** closed with the
   PR reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| `bom.read.ts`'s display availability numbers | Same underlying data, different concern — a follow-up if you believe it's also misleading |
| AUD-092 | The BOM tree's own N+1/over-fetch performance issue — unrelated, different session |

## PASTE TO HERE
