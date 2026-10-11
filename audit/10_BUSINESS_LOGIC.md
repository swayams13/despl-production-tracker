# 10 — BUSINESS LOGIC AUDIT

*Tracing Project → Unit → Stage → Activity → Assignment → Dependency → Dates →
Forecast → Status → Completion, and enumerating the states the system permits
that the business forbids.*

---

## 1. Sources of truth

Progress, status, forecast, delay and ownership must each have **one**
authoritative value. Five of the seven do not.

| Concept | Authoritative location | Also computed at | Conflict risk |
|---|---|---|---|
| **Stage / plan status** | `ProcessPlan.status`, written only by `process.service.ts` under a row lock | `v_unit_stage_status.fill_status` (the 25-stage ladder); `spine.read.ts:157-192` cross-unit collapse; **`job-detail.read.ts:79-88` — a third, hand-written copy of the same ladder** | **High.** A change to the ladder in one place silently diverges. The view additionally counts excluded processes (AUD-030) and both current runs (AUD-034) |
| **Percent complete** | `v_process_plan_percent` — duration-weighted, mapped-ops-aware | `jobs.read.ts:110-114` per job; `client-snapshot.service.ts:46-53` per unit; **`client-snapshot.read.ts:91-94` — a flat mean of unit percentages**; the S-curve's unweighted count; `ProgressSnapshot.overallPct` (frozen copy) | **Medium.** Internal is duration-weighted, the client's is a flat mean. They agree only when every unit has identical weight |
| **Forecast dispatch** | **Nothing. There is no forecast.** | `jobs.read.ts:103` `max(planned_finish)`; `job-detail.read.ts:90-91`; `workspace.read.ts:820-821`; `client-snapshot.read.ts:161` `= committedDeliveryDate` | **Critical.** Three are the *plan*, one is the *promise*, none is a forecast — AUD-031 |
| **Overdue** | **Two definitions, both live** | Gate: `plannedFinish < istCalendarDayMarker()`. Every UI surface: `planned_finish < now() AT TIME ZONE 'UTC'` | **Critical.** ~5.5h / one working day apart — AUD-027 |
| **Delay** | `DelayReason` rows, append-only, server clock | "Is a delay outstanding" is *derived* and satisfied by any historical reason; `reviewStatus` has **no writer** | **Medium** — AUD-074 |
| **Ownership (department)** | `ProcessPlan.ownerDepartmentId` — what all authz reads | `JobProcess.departmentId`, snapshotted at generation and read directly for display | **Low today, latent.** Two stored copies, no constraint keeping them equal |
| **Ownership (person)** | `ProcessPlan.assigneeUserId`, written only by `assignment.service.ts` under a row lock | `submittedBy`/`verifiedBy` (who acted); `performedByUserId`/`performedByWelderId` (who did the work) | **Low.** Cleanly separated and documented |
| **Hold-point state** | Latest `QcpExecution` by `attemptNo` per `(qcpItem, unit)` | **Six independent implementations** of "latest attempt wins" | **Medium** — AUD-041 |
| **Dispatch batch status** | Derived from `releaseApprovedAt`/`actualDispatchDate`, deliberately not stored | nothing | **None.** This one is done right |
| **Schedule "current"** | `ScheduleRun.isCurrent` | — | **High.** Not unique per job; readers disagree about the grain key — AUD-034 |

---

## 2. The four defects that puncture the hold-point engine

These are the most serious findings in the audit. Each is independently
sufficient to let a vessel ship without the inspection the system exists to
enforce.

### AUD-003 (P0) — any QC user clears a blocking hold point with `NA`

```ts
// schemas.ts:217-224 — any caller may submit NA
result: z.enum(["ACCEPTED", "REJECTED", "NA"]),

// qcp.service.ts:64 — the only authorisation
requireRole(actor, ROLES.QC);

// _shared.ts:554-557 — NA is treated as cleared
return r !== "ACCEPTED" && r !== "NA";
```

Grep across `src/` excluding generated code: `waiverApprovedBy` — **zero**
references. `clearedByPartyRef` — **zero**. `callGivenOn` / `callAttendedOn` —
**zero**. `QcpCodeRef.waivable` is read only for display, never in a gate.

CLAUDE.md invariant #4 states *"W-waivers require Production Head approval and
are audited."* **Half of that invariant does not exist.** Any single QC user can
dismiss a non-waivable `H` hold — hydrotest witness, final inspection — by
clicking "N/A", and `verifyProcess` then lets the stage complete. There is no
waiver record, no Production Head signature, no party reference, and the MDR will
contain no evidence of the decision.

**Fix.** In `recordQcpExecution`, load the item's party codes; if any
`QcpCodeRef.blocksCompletion` is set, refuse `NA` unless that code is `waivable`
**and** the actor holds `PRODUCTION_HEAD`, stamping `waiverApprovedBy`. Change
`assertNoOpenHoldPoint` / `assertUnitHasNoOpenHoldPoint` to accept `NA` only when
`waiverApprovedBy IS NOT NULL`. Add the DB CHECK:
`result <> 'NA' OR waiver_approved_by IS NOT NULL`.

### AUD-004 (P0) — internal verification auto-stamps external inspectors' hold points

```ts
// assembly.service.ts:257-272
if (step.templateStep.kind === "INSPECTION" && step.qcpItemId != null) {
  const exec = await recordQcpExecutionTx(tx, actor, {
    qcpItemId: step.qcpItemId, unitId: step.unitId,
    result: "ACCEPTED", jobId: step.jobId,
  });
```

`recordQcpExecutionTx` sets `clearedBy: actor.userId` and nothing else. There is
**no read of `QcpItem.partyCodes`, `QcpCodeRef.requiresCall`, or
`blocksCompletion` anywhere on this path**. The only upstream gate is
`assertMakerChecker`, which requires two different *internal DESPL* users.

The real QCP for DESPL-320 carries party codes for `BUYER_TPI` and `EIL_TPIA`. A
checkpoint whose code is `H` for the third-party inspector is recorded ACCEPTED
the moment an internal QC user verifies the corresponding assembly step, with
`clearedBy` naming a DESPL employee and `clearedByPartyRef` null.
`assertNoOpenHoldPoint` then passes, the stage completes, and packing and
dispatch's `assertUnitHasNoOpenHoldPoint` pass too.

**This does not merely fail to prevent something — it manufactures positive
evidence that an inspection happened.** For an ASME/TPI documentation review that
is materially worse than a missing record.

**Fix.** Resolve the linked item's party codes before the auto-record.
Auto-`ACCEPTED` only when every blocking party code belongs to the in-house
party. When any external party has a blocking code, record `PENDING` (or nothing)
and require the explicit path carrying `clearedByPartyRef` and `callAttendedOn`.

### AUD-005 (P0) — dispatch release and recording re-check nothing

The quality gates exist only on `addUnitToBatch`:

```ts
// dispatch.service.ts:151-152
await assertUnitHasNoOpenHoldPoint(tx, unit.id, unit.equipment.jobId);
await assertUnitHasNoOpenNcr(tx, unit.id, unit.equipment.jobId);
```

`approveDispatchRelease` (`:178-224`) and `recordDispatch` (`:233-262`) contain
**neither call**. Their entire gate is `assertDispatchBatchTransition` on the
derived PLANNED → RELEASED → DISPATCHED status.

Two distinct failures:

1. A unit batched on Monday that fails PAUT on Wednesday — NCR opened, hold point
   flipped REJECTED — is still released and dispatched on Friday. **The gate ran
   three days before the defect existed.**
2. Neither `assignUnitToPackage` nor `addUnitToBatch` reads `ProcessPlan.status`
   at all. **A unit with all 36 stages `NOT_STARTED` can be packed, released and
   dispatched**, producing a gate pass and LR number. The only
   production-completeness linkage in the codebase runs the *other* way —
   `assertEvidenceSatisfied` stops the DISPATCH *stage* from verifying until
   dispatch has happened.

**Fix.** Move both assertions into a loop over the batch's units inside
`approveDispatchRelease` **and** `recordDispatch` (keep the `addUnitToBatch`
check as early feedback). Add a third assertion that every `ProcessPlan` for the
unit under the current run is `COMPLETE` or explicitly excluded, refusing with a
new `UNIT_NOT_COMPLETE` code.

### AUD-026 (P1) — NCRs auto-close from OPEN, skipping disposition entirely

```ts
// ncr.service.ts:25 — close permits OPEN as a source state
close: { from: ["OPEN", "DISPOSITIONED", "REWORK_IN_PROGRESS"], to: "CLOSED" },

// component.service.ts:398-409 — every non-CLOSED NCR closed unconditionally
const openNcrs = await tx.ncr.findMany({ where: { status: { not: "CLOSED" }, … } });
for (const ncr of openNcrs) { await closeNcr(tx, actor, { ncrId: ncr.id, jobId: ncr.jobId }); }
```

Identical block in `assembly.service.ts:240-251`. `dispositionNcr` is the only
writer of `disposition` / `dispositionedBy` / `dispositionNotes` and is **not on
this path**.

The normal floor flow is reject → rework → resubmit → verify. That flow closes
the NCR with all three fields NULL. **The manufacturing record then contains a
non-conformance raised and closed with no recorded engineering decision** — no
REPAIR vs REWORK vs USE_AS_IS vs CONCESSION. A TPI asking "what was decided about
this NCR and who decided it" gets nothing.

**Fix.** Remove `OPEN` from `NCR_TRANSITIONS.close.from`. In the two verify
paths, filter to `status: { in: ["DISPOSITIONED", "REWORK_IN_PROGRESS"] }` and
refuse the verify with `NCR_NOT_DISPOSITIONED` when an OPEN NCR still exists.

---

## 3. Impossible state matrix

For each forbidden state: prevented by a **DB** constraint, by **txn code**
(application code inside a transaction), by **non-txn code** (a race), or by
**nothing**.

| Forbidden state | Prevented by | Evidence |
|---|---|---|
| Stage COMPLETE before its predecessor | **txn code** | `assertCanComplete` in `verifyProcess`, after the row lock. Requires COMPLETE on every edge regardless of lag sign |
| Stage IN_PROGRESS before its predecessor started | **txn code** | `assertCanStart`. Note: for 23 of the 39 real edges the requirement is only "predecessor started" — correct per invariant #11, but the spine is not strictly sequential at start |
| Excluded predecessor deadlocks its successor | **txn code** | `loadGate` calls `bypassExcluded` first. **This is fixed — the known-issue list is out of date here** |
| Stage COMPLETE with an open hold point | **txn code (weak)** | `assertNoOpenHoldPoint` — but pre-clearable via `NA` (AUD-003) or assembly verify (AUD-004), and the check is unlocked (AUD-072) |
| Stage COMPLETE with an open NCR | **txn code (weak)** | `assertNoOpenNcr` — bypassed by the auto-close (AUD-026); unlocked |
| Stage COMPLETE with incomplete component/assembly ops | **txn code** | `assertComponentOpsComplete` at submit. Fails open when `unitId` is null or the family has no `OperationRefFamilySeq` mapping — a documented seam |
| Component op started with no material | **txn code (wrong basis)** | `assertKitReady` — present, but uses an equipment-wide quantity and ignores consumption (AUD-032) |
| Component op started against an unreleased drawing | **txn code** | `assertDrawingReleased`, CUTTING only. No-op when `governingDrawingId` is null — now writable |
| **Unit dispatched with an NCR opened after batching** | **nothing** | AUD-005 |
| **Unit dispatched with production incomplete** | **nothing** | AUD-005 |
| Unit added to a batch while unpacked | **txn code** | `UNIT_NOT_PACKED` |
| Unit added to another job's batch/package | **txn code** | `CROSS_JOB_ASSIGNMENT` in both services |
| **NCR closed with no disposition** | **nothing** | AUD-026 |
| Same person submits and verifies | **txn code** | `assertMakerChecker` on all four verify paths plus snapshot verify/reject. No ADMIN branch |
| Two users claim the same activity | **txn code** | `SELECT … FOR UPDATE` before the assignee check. **Genuinely race-free** |
| Two users transition the same plan concurrently | **txn code** | Same row lock before the status re-read |
| Two schedule generations race to the same version | **txn code** | `SELECT id FROM jobs … FOR UPDATE` before read-max-version → demote → insert |
| Stock issued below zero *(through the service)* | **txn code** | `pg_advisory_xact_lock(stockLotId)` then a guard. Correct, and the reasoning for advisory-over-row-lock is sound |
| Writing against a superseded schedule run | **txn code** | `STALE_WRITE` |
| Duplicate `ProcessPlan` for (run, process, unit) | **DB** | Two partial unique indexes, correctly handling PostgreSQL's NULL-distinct behaviour |
| Duplicate `QcpExecution` attempt | **DB** | `@@unique([qcpItemId, unitId, attemptNo])` — but `attemptNo` is computed by an unlocked `MAX+1`, so concurrent records collide and one caller gets a raw P2002 rather than a retry |
| Duplicate BOM item number in a revision | **DB** | `@@unique([bomRevisionId, itemNo])` |
| Duplicate component tag | **DB** | `@@unique([unitId, tag])` + a partial unique for the equipment grain |
| **Two `isCurrent` schedule runs for one job** | **nothing** | AUD-034 — proven live |
| NCR linked to both a component and an assembly rejection | **DB** | The one CHECK constraint, plus an app-level assert |
| **`actualEnd` before `actualStart`** | **nothing** | No CHECK on any of the three tables. Proven live: `-9 days` |
| **Negative or zero duration** | **nothing** | Plain nullable `Int`, no CHECK. Proven live: `min=-5, max=-10, override=0`, and `min=99 > max=1` |
| **`durationMin > durationMax`, `envelopeFinishByMin > …Max`** | **nothing** | AUD-035 actively creates the second case |
| **Progress > 100% or < 0%** | **nothing** | Proven live: `overall_pct = 250` and `= -40` on a **client-facing** `ProgressSnapshot` |
| **Progress goes backwards** | **nothing** | Live denominator in `v_process_plan_percent` — AUD-075 |
| **Forecast earlier than a dependency's completion** | **nothing** | No forecast exists to check |
| **Delay measured against the wrong baseline** | **partially** | Every overdue KPI compares `plannedFinish`, not `baselineFinish`. After an OVERRIDE run, `plannedFinish` moves and "overdue" silently re-baselines against the overridden plan. **Nothing reads `baselineFinish` anywhere in `src/`** |
| Cross-tenant read of a job-child row | **non-txn code only** | No RLS on 28 job-grain tables — AUD-001 |
| **Cross-job `QcpExecution`** | **nothing** | AUD-077 |
| Audit row missing for a mutation | **txn code + DB** | `audited()` in the same transaction; grants revoked |

**Summary: 7 of 8 states probed by direct insert as the app's own role were
reachable.** Only the audit-log tamper was stopped. Full transcripts in
`11_DATABASE_AUDIT.md` §6.

---

## 4. Scheduling engine

### What is correct

- **The two-layer model is implemented as specified.** `computeEnvelope` reads
  `envelopeStartBy*Days` / `envelopeFinishBy*Days` straight off the row and adds
  them to the project start — **no accumulation over predecessors anywhere**. The
  comment explains that `startBy` is seeded pre-computed precisely so it cannot
  drift. CPM is a genuinely separate module used for float, critical path and
  replanning. **Nothing sums durations to build a schedule anywhere in
  `lib/schedule/`.**
- **Negative lags relax scheduling, not completion gating** — confirmed by
  construction: `gating.ts` imports no date code and `assertCanComplete` ignores
  `type` entirely.
- **`bypassExcluded` composes `lagPX + duration(X) + lagXS`** rather than dropping
  the duration, which is the arithmetically correct splice.
- **Terminal-node selection is deterministic** — true DAG sinks after splicing,
  tie-broken on max envelope then `seq`.
- **`computeOrRefuse` / `computeCpmSafe`** convert bare engine errors into stable
  `AppError` codes for single-job paths and per-job skips for tenant-wide loops.

### AUD-035 (P1) — a duration override destructively overwrites the printed envelope

```ts
// override.service.ts:117-139 — rewrites the authoritative Layer-1 columns in place
await tx.jobProcess.update({ where: { id: p.id }, data: {
  envelopeStartByMaxDays: mx.earlyStart, envelopeFinishByMaxDays: mx.earlyFinish, … } });
```

MIN offsets are deliberately left untouched. Two problems:

1. Invariant #10 says the printed envelope is authoritative and never derived.
   This path **derives it from CPM and overwrites the printed values**,
   recoverable only by parsing an audit-log JSON blob — which also violates
   invariant #6's "corrections create versions, never destructive edits."
2. A shortening override drives `envelopeFinishByMaxDays` below the untouched
   MIN. The next `generateSchedule` then throws a **bare `Error`**, not an
   `AppError`, from `checkFeasibility` — so it surfaces as an unexplained 500 and
   **the job can never be rescheduled again without a manual DB edit**.

Currently latent — `applyDurationOverride` has no UI caller — but it is exported
and reachable.

**Fix.** Do not write to `envelope*Days`. Store the recomputed Layer-2 dates on
the new run's `ProcessPlan` rows, where Layer 2 already lives, and leave Layer 1
as the immutable printed record. Independently, make `checkFeasibility` throw a
`SCHEDULE_DATA_MISSING` `AppError`.

### AUD-030 (P1) — the view ignores `JobProcess.included`

`v_unit_stage_status` joins every `job_processes` row with no `included` filter.
Excluded processes never receive a `ProcessPlan`, so they contribute a row with
`status = NULL` — and `NULL IS DISTINCT FROM 'COMPLETE'` is TRUE, so the
completion arm never fires.

**A job that legitimately skips PWHT can never show any work-order stage that
PWHT maps to as complete, however much work is finished.** If the excluded
process is the only one in a stage, that stage reads `idle` forever, and the
job-level rollup inherits it, so the job never reaches 100% on the spine.

`v_process_plan_percent` is built from `process_plans` and therefore *does*
exclude them correctly — **so the percentage and the spine disagree on the same
job, permanently.**

**Fix.** Add `AND jp.included = true` to the join in the `exploded` CTE.

### AUD-034 (P1) — two `isCurrent` runs per job

Demotion is scoped to the `(jobId, equipmentId)` pair, and `generateSchedule`
accepts an optional `equipmentId`, so a job-grain run (`equipment_id = NULL`) and
an equipment-grain run can both be current. Proven live. Every consumer assumes
one:

- `v_unit_stage_status` joins `sr.job_id = e.job_id AND sr.is_current` with no
  equipment predicate — `exploded` fans out across both runs.
- `v_process_plan_percent` sums both runs' plans.
- `jobs.read.ts` and `portfolio.read.ts` double `totalPlans`/`completePlans`/`overduePlans`.
- `getCurrentScheduleRun` silently returns only the job-grain one.

Result: roughly double the plan counts, a blended percentage, **and — because the
second run's plans are all `NOT_STARTED` — a spine in which no stage can ever
reach complete.** Two operators are each shown the same operation on the same
unit as their own task.

**Fix.** The DB-native constraint the code comment already proposes:
`CREATE UNIQUE INDEX ON schedule_runs (job_id, COALESCE(equipment_id, -1)) WHERE is_current;`

### AUD-110 (P3) — `bypassExcluded` re-derives edge type from the composed lag's sign

```ts
type: lag >= 0 ? "FINISH_TO_START" : "START_TO_START_WITH_OVERLAP",
```

`gating.ts` keys the start gate on exactly that `type`, so a FINISH_TO_START edge
that composes to a negative lag becomes an overlap edge — the successor may start
once the predecessor has merely *started*. That is the one thing invariant #11
forbids.

**Honest scope:** every single-node exclusion was enumerated against the real seed
graph (36 processes, 39 edges, 23 overlap, 16 FTS) and **zero** cases compose to a
negative lag. Not reachable with today's data; becomes reachable with a second
family, an edited route, or chained exclusions. Completion gating is unaffected.

**Fix.** Preserve the incoming edge's gating semantics — a finish-to-start
predecessor stays finish-to-start whatever the composed lag. Better: split `type`
(gating) from `lagDays` (scheduling) into separate fields so the splice cannot
conflate them.

---

## 5. Other business-logic findings

**AUD-027 (P1) — two definitions of "overdue".** The gate uses the IST calendar
day marker; every read model uses the raw UTC instant. `business-day.ts` opens by
naming this exact bug — *"flips a plan overdue at 00:00 UTC = 05:30 IST on its own
due date, a full working day early"* — and the fix was applied only to
`job-health.ts`, never to the plan-level SQL. From 05:30 IST on the due date the
spine turns red, `overduePlans` increments, the job flips AT_RISK, and department
on-time percentages count it — while `assertNoUnfiledDelayBlock` correctly does
**not** block the department. **Supervisors are shown "OVERDUE — file a delay
reason" for work that is not late.** Fix: one shared `ist_day_marker(ts)` IMMUTABLE
SQL function used by both sides, plus a test asserting they agree at 06:00 IST.

**AUD-029 (P1) — PAINTING is permanently un-verifiable.** `requiresDftGate` is on
by default for PAINTING via migration, and the gate refuses without a
`PaintRecord` with enough distinct accepted coats. Grep of `src/app/` and
`src/components/` for `recordPaintRecord`, `recordDftReading`, `paintRecord`,
`dftReading`: **zero matches**. No action, no UI, no route. Every PAINTING
operation can be started and submitted but never verified; it sits SUBMITTED
forever; `assertComponentOpsComplete` then blocks the process stage; its
successors never start. **A hard production stop no floor user can clear.** Fix:
ship the write path, or `UPDATE operation_refs SET requires_dft_gate = false`
until it lands. Add a CI assertion that every enabled gate has a reachable
producer.

**AUD-032 (P1) — `assertKitReady` uses the wrong quantity basis.** It computes
`explodeBomItem(item, unitCount, …)` — the **whole equipment's** kit — and
compares it against available, then never deducts `ISSUE`. On DE0463 (40 units),
starting the *first* cutting operation on unit 1 requires 40 units' worth of that
BOM item on hand, which blocks staged material delivery — normal on a 17-week
vessel job. Simultaneously it is too weak: because ISSUE is not deducted, once
enough was received once the gate passes forever. **It blocks legitimate work
early in a job and permits material-less work late in it.** Fix: compute the
requirement for the component being started, and compare against
available-to-issue (received − issued − scrapped + returned).

**AUD-074 (P2) — the delay-reason block covers 2 of 8 progress paths.**
`assertNoUnfiledDelayBlock` is called only from `startProcess` and
`submitProcess`. It is absent from `verifyProcess` and from every
`ComponentOperation` and `AssemblyStep` transition. And the predicate
`delayReasons: { none: {} }` is satisfied **forever** by the first reason ever
filed. `DelayReason.reviewStatus`/`reviewedBy` have no writer at all. Invariant #7
is largely inert.

**AUD-075 (P2) — percent-complete goes backwards.** `v_process_plan_percent`
computes `mapped.complete / mapped.total` where `total` is a live `count(*)`.
`importBomItems` materialises new components and operations after intake, each
adding NOT_STARTED rows to that denominator. Adding a revised BOM line reduces
the reported percent of stages already finished — and the client portal reads the
same view, so a client who saw 62% yesterday sees 58% today with no explanation.
**Progress that moves backwards is the fastest way to lose trust in a tracker.**

**AUD-072 (P2) — every quality gate is a check-then-act read with no lock.**
`withTenant` passes no isolation level, so all transactions are READ COMMITTED.
Row locks exist for the *subject* of each mutation but **no lock is taken on the
rows the gates read**: `assertNoOpenHoldPoint` reads `qcp_executions`,
`assertNoOpenNcr` reads `ncrs`, `assertComponentOpsComplete` reads
`component_operations` — all plain `findMany`. T1 `verifyProcess` reads "no open
NCR" and proceeds while T2 commits a rejection; both succeed; a stage is COMPLETE
with an open NCR. Low probability per event, but a QC user rejecting while a
supervisor verifies is a realistic shift-change pattern. Fix: run the transition
services at `RepeatableRead` and retry on serialization failure.

**AUD-073 (P2) — a VERIFIED client snapshot can be reverted to PUBLISHED** by a
concurrent publish. `verifySnapshot` protects itself with a count-checked
`updateMany`; nothing protects the publish side against a verify landing between
its read and its write. `schema.prisma:2288` states *"Once VERIFIED a row is
frozen forever."*

**AUD-028 (P1) — `de.aggregate_id::int` will throw once a snapshot event exists.**
Six call sites cast the free-text polymorphic column to int inside a join.
`client-snapshot.service.ts` already writes non-numeric ids
(`` `${jobId}:${asOf.toISOString()}` ``). The `WHERE aggregate_type = 'ProcessPlan'`
filter is a *planner hint*, not a guarantee — PostgreSQL may evaluate the cast
before the qualifier, aborting with `invalid input syntax for type integer`.
**A 500 on `/jobs`, the dashboard, the events feed and the StageSheet, for the
whole tenant, non-deterministically.** This is the exact failure mode the team
already hit and fixed once at the RLS layer, reintroduced in six places. Fix:
join the other way — `de.aggregate_id = pp.id::text` — and stop writing composite
ids.

---

## 6. Invariants: verified vs falsified

| # | Invariant | Verdict |
|---|---|---|
| 1 | No client timestamps | ✅ **Holds.** Every actual is `new Date()` server-side inside the transaction; every mutation schema is `.strict()`; `withTenant` pins `TimeZone=UTC` per transaction |
| 2 | Hard sequential gating | ✅ **Holds** for completion. `bypassExcluded` is spliced correctly — the known-issue list is out of date |
| 3 | Maker–checker | ✅ **Holds** at the transition layer. ⚠️ Undermined by AUD-079 (admin password reset) |
| 4 | Hold points block; W-waivers need PH approval | ❌ **First half holds, second half does not exist** — AUD-003, AUD-004 |
| 5 | Append-only audit in the same transaction | ✅ **Holds,** proven live at three layers |
| 6 | No destructive edits | ⚠️ **Mostly holds.** One real exception: `applyDurationOverride`'s envelope restamp — AUD-035 |
| 7 | Mandatory delay reasons block progress | ❌ **Largely inert** — AUD-074 |
| 8 | RBAC deny-by-default | ✅ **Holds** |
| 9 | Templates versioned and pinned | ✅ **Holds.** `JobProcess` rows are materialised copies |
| 10 | Never sum durations | ✅ **Holds** — verified by reading the whole engine |
| 11 | Lags never relax gating | ✅ **Holds** by construction. ⚠️ One latent path — AUD-110 |
| 12 | Refusals explainable via stable codes | ✅ **Holds.** 63 codes, one mapping to HTTP and to user messages |

**Eight of twelve hold. One is half-implemented and that half is the compliance
one.**
