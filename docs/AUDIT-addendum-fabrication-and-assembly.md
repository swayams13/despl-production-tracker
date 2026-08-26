# AUDIT ADDENDUM — Fabrication & Assembly as the first deliverable

**Date:** 25 Aug 2026 · **Companion to:** `docs/AUDIT-master-engineering-review-v1.md`
**Reason:** the first deliverable is *production tracking* — specifically fabrication and assembly.
That changes the phase order in §9 of the main audit. This document supersedes it for Phase 1.

---

## 0. The good news, stated first

**You have already written the functional spec for this deliverable, and three of the four
technical pieces already exist.** This is a far shorter path than the main audit's roadmap implies,
because fabrication tracking does *not* depend on the BOM hierarchy, materials, or procurement.

The spec is:

| Artifact | What it defines |
|---|---|
| `docs/DESPL-320 Fabrication Operations Tracker.xlsx` → **Fabrication Operations Tracker** | 486 rows = **54 operations/unit × 9 units**. Columns: Unit · Component Tag · Component · Seq · Operation · **Started · Ended · Status · Operator/Welder · Remarks** |
| same workbook → **Assembly & Weld Checklist** | 486 rows = **54 checkpoints/unit × 9 units**, grouped A–Q, with DESPL and BUYER_TPI P/W/H codes per row |
| `seed/despl-320-components.json` | The 11 components/unit (SHELL, TOP-HEAD, BOTTOM-HEAD, SKIRT, N1–N6, M1) with routes, materials and weld-joint references. **Never ingested.** |
| `docs/superpowers/plans/2026-08-25-component-operation-tracking.md` | The existing task list for the write side |

The workbook's own Read Me states the requirement precisely:

> *"v1 tracked one Status per component. This tracks every fabrication OPERATION separately — e.g.
> Shell: Cutting Started/Ended, Rolling Started/Ended, Forming Started/Ended, Welding
> Started/Ended — per the team's own request, followed by the shell-to-dish-end assembly weld
> sequence."*

That is the deliverable. Build exactly that.

---

## 1. Fabrication — what exists

`Component` → `ComponentOperation`, driven by `RouteTemplate` → `RouteTemplateVersion` →
`RouteStep`, with 25 canonical routes seeded from `seed/component-routes.json`.
`startComponentOperation` / `submitComponentOperation` / `verifyComponentOperation` shipped on
25 Aug — transactional, row-locked, department-scoped, maker–checker enforced, audited.
`bom-route.ts`'s `projectComponentRoute()` and `<BomPanel />` already render planned-vs-actual.

**The mechanism is correct. It is missing the fields the floor actually records, and it has no data.**

### Gap F1 — DESPL-320 has zero components. <span>P0</span>
`seed/despl-320-components.json` describes 99 rows (11 × 9) and
`scripts/seed-despl320-components.ts` exists to ingest them. Neither has been run.
**Nothing about fabrication tracking can be demonstrated until this lands.**

### Gap F2 — `bom.read.ts:209` has no `unitId` filter. <span>P0, blocks F1</span>
```ts
const bomlessComponents = await tx.component.findMany({
  where: { equipmentId: targetId, bomItemId: null },   // ← no unitId
```
The seed writes `bomItemId: null` and a real `unitId` for all 99 rows. So the moment F1 lands, the
BOM tab renders **all 99 parts of all 9 serials as one flat list**. The read model's header comment
asserting `unitId` is always null is stale. Fix the filter and add a unit selector *before* seeding,
or the first thing the team sees is an unusable screen.

### Gap F3 — no operator, no remarks. <span>P0</span>
The spreadsheet's columns are **Operator / Welder** and **Remarks**. `ComponentOperation` has
`submittedBy` and `verifiedBy` — *who clicked*, not *who did the work*. On the shop floor these are
routinely different people: a supervisor records what a welder did. `Welder` already exists as a
registry for exactly this reason ("welders do not log in — logging is done BY a supervisor, ABOUT a
welder"). Add `performedByWelderId` / `performedByUserId` and `remarks`.

### Gap F4 — no quantities. <span>P0 for multi-piece components</span>
The SKIRT is *"skirt shell + base ring + 24 gusset plates, tracked as one fabrication unit"* — a
collapse forced by the model, not chosen. With no quantity column, "18 of 24 gussets welded" is
unrepresentable and the operation sits IN_PROGRESS for days with no visible progress. Add
`qtyPlanned / qtyGood / qtyRejected` to `ComponentOperation`.

### Gap F5 — there is no `reject()`. <span>P0</span>
`component.service.ts:27-29` says so explicitly:
> *"reject() is left out of this draft on purpose: a rejection reason has nowhere durable to live
> yet (DelayReason is keyed to processPlanId only)."*

A fabrication tracker with no failure path records only success. The shell fails RT/UT — nothing in
the system can express it. **This is the NCR gap in miniature, and it must be closed for
fabrication, not deferred to Phase 3.** Minimum viable: `ComponentOperationRejection`
(componentOperationId, reason, categoryId, rejectedBy, at) and a `REJECTED` state that returns the
op to IN_PROGRESS with the rejection retained.

### Gap F6 — the route library has not been reconciled against the spec. <span>Data question, not engineering</span>
End-to-end tracking means **every step the floor performs exists as a `RouteStep`** — none silently
folded into a neighbour, none invented. That reconciliation has never been done: the 25 seeded
routes came from a routing PDF, the 54 operations came from the floor, and nobody has diffed them.

Known discrepancies, offered as *examples of the class*, not as the list:

- `PLATE` — the spec tracks Rolling and Forming as two separately timed steps; the route has one
  combined `FORMING`. Flagged in the workbook's own Dev Notes.
- `EDGE_PREP`, `GRINDING` and `INSPECTION` each carry
  `"GAP": "No dedicated column in the live CSV — confirm with production."` in
  `seed/component-routes.json`. Three operations the routing document names and the tracker never
  recorded.

Diff the whole spec against the whole route library and settle every difference with the floor.
Each fix is one `OperationRef` and/or `RouteStep` change. **Do not guess — an invented operation is
worse than a missing one**, because it will sit NOT_STARTED forever and block the sequence.

### Gap F7 — tag mangling.
`Component.@@unique([equipmentId, tag])` sits at equipment grain while `unitId` sits at serial
grain, so the seed writes `SHELL-320SR01`. Your workbook uses `SHELL-01`. Change to
`@@unique([unitId, tag])` for serialised components — do it now, while there are zero rows.

---

## 2. Assembly — the real gap

**Assembly is not fabrication at a different scale. It is a different grain, and it has no home in
the schema.**

And its scope is larger than the name suggests. Your A–Q sequence is not a weld checklist — it is
**the vessel's whole life from document gate to MDR**:

| Groups | Covers |
|---|---|
| A–B | Document and procedure gates; material inspection and traceability; weld plan / weld map |
| C–D | Shell and head prep; head sub-assembly; simulation heat treatment of the test coupon |
| **E–L** | **Every weld on the vessel** — LS-1, nozzle-to-flange, CS-2, nozzle-to-shell, CS-1, lifting lugs, nameplate bracket, skirt — each as set-up → weld → visual → NDT |
| M–N | Pre-PWHT clearance gate; heat treatment; post-PWHT visual, MPT and RT/PAUT on all joints |
| O | Hydrostatic test — clearance, test, post-hydro MPT/LPT |
| P | Cleaning, surface preparation, painting |
| Q | Nameplate verification and attachment; documentation / MDR |

So this is **the back half of the vessel's life** — heat treatment, hydro, paint and final
documentation included — and it is where the QCP's hold and witness points actually bite. Treating
it as "the welding feature" would under-scope it by two thirds.

The weld groups specifically:

```
E. Shell Sub-Assembly (LS-1)     4.5   edge prep → LS-1 set-up → weld LS-1 → visual → PAUT/TOFD
G. Shell + Bottom Head (CS-2)    4.7   CS-2 set-up → weld → visual → PAUT/TOFD
H. Nozzle & Manway               4.8   marking → set-up → weld → visual → UT
J. Shell + Top Head (CS-1)      4.10   CS-1 set-up → weld → visual → PAUT/TOFD
K. Attachments                  4.11   lug + nameplate bracket set-up → weld
L. Skirt                        4.13   skirt set-up → weld
```

There is no `Component` called "the vessel". The 11 components are the *inputs* to this sequence.
So today, assembly is representable only as:

1. QCP checkpoints being recorded (`QcpExecution`) — **which already works well**, and
2. `JobProcess` #24 "Final Assembly" being marked COMPLETE — a single manual assertion.

### What's missing, precisely

- **Assembly work has no record.** "Weld Circ Seam Of Bottom Dishend To Shell (CS-2)" is a real
  job with a welder, a start, an end and a WPS. In the system it is a checkbox on an inspection plan.
- **`WeldJoint` is the right home and is half-built.** It has `jointNo` (LS-1, CS-1, CS-2),
  `jointType`, `weldSize`, `wpsRef`, welders, and `NdtResult` children. What it lacks: a sequence,
  a state machine, a link to the `Component`s it joins, and a link to the `QcpItem`s that inspect it.
- **No consumption.** Nothing records that SHELL-01, TOP-HEAD-01 and BOTTOM-HEAD-01 were consumed
  into unit 320SR01. There is no as-built record.
- **No gate.** Assembly can be marked complete with every sub-assembly untouched, and every
  sub-assembly can be COMPLETE without assembly moving. (Main audit §V2.)
- **Your checklist conflates work and inspection**, as every QAP does — 4.5 contains both
  *"Weld Long Seam Of Shell"* (work) and *"Weld Visual Of LS-1"* (inspection). The system needs
  both, distinguished.

### Recommended model — one new table

```prisma
model AssemblyStep {
  id          Int      @id @default(autoincrement())
  unitId      Int
  seq         Int                    // 1..N, the A–Q sequence
  groupCode   String                 // "E", "G", "H", "J", "K", "L"
  groupName   String                 // "Shell Sub-Assembly (LS-1)"
  activity    String                 // "Weld Long Seam Of Shell (LS-1)"
  kind        AssemblyStepKind       // WORK | INSPECTION
  weldJointId Int?                   // links the weld steps to the joint + its welders + NDT
  qcpItemId   Int?                   // links the inspection steps to the checkpoint that governs
  status      OperationStatus        // reuse the ComponentOperation state machine
  startedAt   DateTime?              // SERVER CLOCK ONLY
  finishedAt  DateTime?              // SERVER CLOCK ONLY
  performedBy Int?
  submittedBy Int?
  verifiedBy  Int?
  remarks     String?

  @@unique([unitId, seq])
}
```

Why this shape:
- It is a **direct transcription of your own checklist**, so it needs no invention and no
  confirmation from DESPL.
- It reuses `ComponentOperation`'s state machine, gating pattern and maker–checker verbatim —
  one generic `assertTransition<S>()` serves both.
- `weldJointId` makes the existing welding module load-bearing instead of an empty side page:
  logging LS-1 and recording its PAUT/TOFD becomes part of assembly, and per-welder repair rate
  finally has real data behind it.
- `qcpItemId` links the inspection steps to the hold points that already block completion, so
  `assertNoOpenHoldPoint` needs no change.

**Alternatives considered and rejected:** (a) a `Component` of type VESSEL whose route is the
assembly sequence — cheapest, but abuses the component grain and still can't express consumption;
(b) promoting `WeldJoint` itself to a work record — works for the six weld groups, but has nowhere
to put set-up, marking, clearance gates or the document/procedure groups A–D.

### Consumption (defer, but leave room)
`ComponentConsumption(assemblyStepId, componentId, unitId)` gives the as-built record and the gate
*"CS-2 set-up cannot start until BOTTOM-HEAD-01 is COMPLETE."* Not required for the first
deliverable; required before you can claim traceability. Do not paint over it.

---

## 3. The rollup — what makes it one system

This is the change that turns two trackers into a production system, and it is small:

```
ComponentOperation.status ─┐
                           ├─▶ OperationRef.leadTimeProcessSeq ─▶ JobProcess (36-spine) ─▶ 25-stage spine
AssemblyStep.status ───────┘
```

`leadTimeProcessSeq` already exists on `OperationRef` and already carries the right values
(`CUTTING → 12`, `WELDING → 16`, `NDT → 17`, `PAINTING → 30`). Today its only consumer decorates
the BOM panel with tooltips. Two changes make it load-bearing:

1. **`JobProcess` percent-complete becomes a projection**: for a process with mapped operations,
   `% = complete ops / total ops` across that unit, instead of a binary plan status.
2. **`submitProcess` gains a gate**: refuse with `COMPONENT_OPS_INCOMPLETE` if any mapped operation
   on that (process, unit) is not COMPLETE. This is PRD FR-C2's stated purpose and the half that
   did not ship.

Do these together. Either alone leaves the disconnect.

---

## 4. Revised phase order

The main audit's §9 put BOM hierarchy in Phase 1. **For a fabrication-and-assembly-first
deliverable that is wrong** — fabrication tracking needs the *component register*, which you already
have as JSON, not the BOM tree. BOM hierarchy and materials move to Phase 2.

| Phase | Contents | Why here |
|---|---|---|
| **0 — Safety** *(unchanged, ~1 wk)* | Reschedule actual-loss fix · 3 cross-tenant writes · login throttle · logging + `/api/health` + `error.tsx` · PITR + restore drill · delete demo scaffolding · parameterise `/workspace` · IST business-day helper · fix `CLAUDE.md` | The reschedule bug destroys `ProcessPlan` actuals — which is exactly where the rollup will write. Fix it before stage data means anything. |
| **1 — Fabrication tracking** *(~1.5 wks)* | F2 (unitId filter + unit selector) → F1 (seed 99 components) → F3 (operator + remarks) → F4 (quantities) → F5 (reject) → F7 (tag uniqueness) → F6 (confirm Rolling/Forming) | Everything here is additive to a mechanism that already works. **This is your demonstrable deliverable.** |
| **2 — Assembly tracking** *(~2 wks)* | `AssemblyStep` + seed the 54-step sequence per unit · link `WeldJoint` · link `QcpItem` · reuse the state machine · welder registry CRUD (currently no write path exists at all) | Needs Phase 1's state-machine generalisation. Makes the welding module real. |
| **3 — The rollup** *(~1 wk)* | Percent-complete as projection · `submitProcess` component gate · StageSheet shows contributing operations | Small, and it is what makes the two trackers one system. |
| **4 — BOM + materials** | BOM hierarchy, numeric qty, revisions, explosion, procurement events, stock, kit readiness | Now unblocked, and now genuinely needed — this is what makes `bomItemId` non-null and material gating true. |
| **5 — NCR, paint, packing, dispatch** | Promote F5's rejection into a full NCR with disposition; DFT; packing; dispatch execution | — |
| **6+ — Enterprise UX, intelligence, performance** | As per main audit §9 | — |

**Phase 0 → 1 → 2 → 3 is roughly six weeks to a system that answers "what is being made, what
operation is it on, who is doing it, how much is done, what failed, and what is it blocking."**
That is production tracking. Everything after it is breadth.

---

## 5. Open questions to put to the floor before Phase 1

| # | Question | Blocks |
|---|---|---|
| F-a | **Reconcile all 25 seeded routes against the 54 operations in the spec** — every step the floor performs must exist as a `RouteStep`, none silently folded into a neighbour. Known discrepancies, as examples not as the list: Rolling vs Forming on `PLATE` (spec = two timed steps, route = one combined), and `EDGE_PREP` / `GRINDING` / `INSPECTION`, all three flagged `GAP` in `component-routes.json`. Diff the whole spec against the whole route library. | Route definitions; changes the operation count |
| F-b | For each reconciled difference: is it a real timed step the floor starts and ends, or a sub-activity of its neighbour? | Whether it becomes a `RouteStep` or a remark |
| F-c | For multi-piece components (24 gussets, 6 nozzles) — does the floor want a count, or is "done/not done" enough for v1? | Whether F4 is P0 or P1 |
| F-d | Who records an operation — the welder, the supervisor, or the QC engineer? Is the "Operator/Welder" column the person who *did* it or who *reported* it? | F3's field shape and the maker–checker boundary |
| F-e | On a fabrication rejection, does the operation restart from that step, or from an earlier one? | F5's state machine |
| F-f | The welder list and employee codes — still outstanding since before the pilot | Blocks Phase 2 entirely; the registry has no write path *and* no data |
