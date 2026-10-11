# SESSION 09 — AUD-004 · Internal verification auto-stamps external inspectors' hold points

*Implementation prompt. Self-contained — assumes no prior conversation context.*
*Source: `audit/10_BUSINESS_LOGIC.md` §2, `audit/20_REMEDIATION_ROADMAP.md` Phase 1b item 9.*
*Prerequisite: none, but reads much more naturally after Session 04 (AUD-003)
— both touch the hold-point engine, and this session's "internal party"
resolution is new ground Session 04 didn't need.*

---

## PASTE FROM HERE

You are a Staff Full-Stack Engineer working on **DESPL Production Tracker**
(Next.js 15 + Prisma 6 + PostgreSQL 16). This session closes a P0 finding:
verifying an internal assembly step can manufacture false positive evidence
that a third-party inspector witnessed something they never saw.

### Read before writing anything

1. `CLAUDE.md` invariant #4 — hold points and waiver approval.
2. `audit/10_BUSINESS_LOGIC.md` §2 (AUD-004).
3. `src/lib/services/assembly.service.ts` — `verifyAssemblyStep`
   (`grep -n "export async function verifyAssemblyStep" -A 60 src/lib/services/assembly.service.ts`).
   This is the file and function you're changing.
4. `prisma/schema.prisma` — `model InspectionParty` (~line 1974),
   `model QcpItemPartyCode` (~line 2051), `model QcpCodeRef` (~line 584). Note
   `InspectionParty.code` is a free string per QCP template
   (`"CLIENT_TPI"`, `"BUYER_TPI"`, `"EIL_TPIA"` are real examples seen in this
   codebase's seed data) — there is **no boolean "is this party internal"
   column anywhere**.
5. `prisma/seed.ts` around the `Organization` creation
   (`grep -n 'code: "DESPL"' prisma/seed.ts`) — the tenant's own
   `Organization.code` is how "internal" is actually distinguishable, not a
   hardcoded party-code string. This matters — read "The design call" below.
6. `src/lib/services/qcp.service.ts`'s `recordQcpExecutionTx` — the shared
   tx-level primitive `verifyAssemblyStep` calls. **Do not modify it** — the
   fix is entirely in what `verifyAssemblyStep` decides to pass it, or whether
   it calls it at all.

### The defect

```ts
// assembly.service.ts, verifyAssemblyStep
if (step.templateStep.kind === "INSPECTION" && step.qcpItemId != null) {
  const exec = await recordQcpExecutionTx(tx, actor, {
    qcpItemId: step.qcpItemId,
    unitId: step.unitId,
    result: "ACCEPTED",
    jobId: step.jobId,
  });
  ...
}
```

Verifying an internal assembly step auto-records `ACCEPTED` on its linked
`QcpItem`, unconditionally. There is **no read of the item's party codes
anywhere on this path** — no check of `QcpCodeRef.blocksCompletion`, no check
of which `InspectionParty` a blocking code belongs to. The only upstream gate
is `assertMakerChecker`, which only proves two different *internal DESPL*
people were involved — it says nothing about whether an external inspector
was ever present.

A real QCP template can carry a blocking code for an external party
(`CLIENT_TPI` in this codebase's own seed data; the audit's live reproduction
used `BUYER_TPI`/`EIL_TPIA`). The moment a DESPL employee verifies the
corresponding internal assembly step, that external party's checkpoint is
recorded `ACCEPTED`, `clearedBy` naming the DESPL employee,
`clearedByPartyRef` left `NULL`. `assertNoOpenHoldPoint` then passes.
**This doesn't just fail to catch a missing inspection — it writes a record
that looks exactly like a completed one.** For an ASME/TPI documentation
review, a false positive is worse than a gap.

### The design call this prompt is making

Distinguishing "internal" from "external" needs a real anchor, and
`InspectionParty.code` is free text per template — hardcoding a literal like
`"DESPL"` here would be exactly the class of literal this codebase's own
recent work (`B10`'s "CI literal guard", the `Department.isOfficeDept`
migration) has been actively removing. **Compare against the actor's own
tenant `Organization.code`**, fetched the same way `unit`/`job` tenant-scoping
is already done elsewhere in this file, not a hardcoded string:

```ts
const org = await tx.organization.findUnique({ where: { id: actor.tenantId }, select: { code: true } });
```

A party is internal iff `inspectionParty.code === org.code`. If you find this
comparison is fragile in practice (e.g. a real tenant's `InspectionParty` rows
don't actually use the org's own code as the internal marker — check a real
seeded QCP template for this tenant to confirm before trusting the
convention), stop and say so in your PR rather than shipping a check that
silently never matches.

### Your task

In `verifyAssemblyStep`, before the existing auto-record block, when
`step.templateStep.kind === "INSPECTION" && step.qcpItemId != null`:

1. Load the linked `QcpItem`'s party codes, joined to `qcpCode.blocksCompletion`
   and `inspectionParty.code`:

```ts
const partyCodes = await tx.qcpItemPartyCode.findMany({
  where: { qcpItemId: step.qcpItemId },
  select: { qcpCode: { select: { blocksCompletion: true } }, inspectionParty: { select: { code: true } } },
});
const org = await tx.organization.findUnique({ where: { id: actor.tenantId }, select: { code: true } });
const externalBlocking = partyCodes.some(
  (pc) => pc.qcpCode.blocksCompletion && pc.inspectionParty.code !== org?.code,
);
```

2. If `externalBlocking` is `true`, **do not auto-record anything** — leave the
   checkpoint exactly as it is (no execution row, still open per
   `assertNoOpenHoldPoint`'s existing "no exec at all blocks" behavior). Skip
   the `recordQcpExecutionTx` call and its audit block entirely for this step.
3. If `externalBlocking` is `false` (every blocking code, if any, belongs to
   the tenant's own internal party — or there's no blocking code at all),
   keep today's behavior unchanged: auto-record `ACCEPTED` exactly as now.

Add a comment at the new check explaining why — future readers need to know
this isn't a stray permission check but a deliberate refusal to manufacture
evidence for a party that was never actually involved.

### Details that matter

- **This session does not build the "TPI call-given/attended" flow.** The
  audit's own note in `qcp.service.ts`'s existing comment says that stays
  Phase 2. After this fix, an assembly step gated behind an external
  checkpoint simply stays blocked at `verifyAssemblyStep` until someone
  records the checkpoint through the normal `recordQcpExecution` path
  (QC role, subject to Session 04's waiver rules if you've run that session) —
  this session does not add a new UI or action for that; it only stops the
  wrong thing from happening automatically.
- **If Session 04 (AUD-003) has already shipped**, `recordQcpExecution`'s
  waiver-aware behavior is unaffected by this session — you're not touching
  that function, only `assembly.service.ts`'s separate auto-record path.
- **`clearedByPartyRef`** stays unwired in this session too (same as Session
  04) — recording *which* external party actually attended is a further
  Phase 2 gap, not required to stop the false-positive auto-accept.
- **Verify the `component.service.ts` sibling path doesn't have the same
  pattern.** `grep -n 'result: "ACCEPTED"' src/lib/services/*.ts` — if a
  component-operation verify path does the same unconditional auto-record,
  that's the same bug in a second file and should be fixed identically in
  this session (same helper logic, don't duplicate the query by hand — factor
  the `externalBlocking` check into a small shared function in `_shared.ts`
  if it's needed in two places, following that file's existing
  `assertXxx`/resolve-helper conventions).

### Constraints — these are binding

- **Do not modify** `recordQcpExecutionTx`, `assertNoOpenHoldPoint`,
  `assertUnitHasNoOpenHoldPoint`, or anything Session 04 already changed in
  `_shared.ts` — this session adds a new pre-check in the *caller*, nothing in
  the shared primitives.
- **No schema change, no migration.**
- **Refusals aren't the shape here** — this isn't a case that should throw an
  `AppError`; verifying the assembly step itself still succeeds (the step's
  own status transition is legitimate DESPL-internal work), it's specifically
  the *auto-record side-effect* that's suppressed. Don't accidentally block
  the whole `verifyAssemblyStep` action over this.

### Tests

Add to `assembly.service.test.ts` (check it exists; follow its existing
DB-gated fixture pattern):

| # | Scenario | Expect |
|---|---|---|
| 1 | INSPECTION step's QcpItem has a blocking code belonging to the tenant's own internal party only | unchanged — auto-records `ACCEPTED`, same as today |
| 2 | INSPECTION step's QcpItem has a blocking code belonging to an external party (`CLIENT_TPI` or similar) | verify succeeds, but **no** `QcpExecution` row is created for that item — `assertNoOpenHoldPoint` still reports it open afterward |
| 3 | Same as (2), but the item also has a second, non-blocking code for the internal party | still no auto-record — one external blocking code is enough to withhold it |
| 4 | INSPECTION step whose QcpItem has no party codes at all (a plain internal-only checkpoint, if this shape exists in real data) | unchanged — auto-records as today |
| 5 | Non-INSPECTION step (any other `templateStep.kind`) | unaffected — this code path was never reached for these anyway, confirm nothing broke |

Test 2 is the one that actually proves the fix.

### Verify before you finish

```bash
pnpm lint && pnpm typecheck
pnpm test:db
```

### When you are done

1. Open a PR. **Do not merge to `main` directly.** Note in the description
   whether you found and fixed a matching pattern in `component.service.ts`,
   and confirm your "internal party = tenant org code" convention against a
   real seeded template rather than just asserting it.
2. Append an entry to `docs/mos-execution/LEDGER.md`.
3. In `audit/19_MASTER_ISSUE_REGISTER.md`, mark **AUD-004** closed with the PR
   reference.

### Explicitly out of scope for this session

| Finding | What you may notice |
|---|---|
| TPI call-given/attended flow, `clearedByPartyRef` | Genuinely unbuilt (Phase 2) — not required to close AUD-004 |
| AUD-003 | QC users clearing holds with NA — Session 04's finding, different code path |

## PASTE TO HERE
