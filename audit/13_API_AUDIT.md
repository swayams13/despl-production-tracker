# 13 — API & SERVER ACTION SURFACE AUDIT

*The mutation surface is Server Actions; `/api/*` is nine GET-only reads plus two
cron POSTs. This document covers the contract, not the authorization (that is
`12_SECURITY_RBAC.md`) and not the query cost (that is `14_PERFORMANCE.md`).*

---

## 1. Shape of the surface

| | Count | Notes |
|---|---|---|
| Server Action modules | 20 + `_action.ts` | Every mutation in the product |
| Exported actions | ~70 | |
| API route handlers | 9 | 7 GET reads, 2 cron POSTs |
| Stable error codes | **63** | One mapping to HTTP, one to user-facing messages |
| Zod schemas | 86, of which **84 `.strict()`** | Single source of validation truth |

**The architecture is right.** Actions are thin callers; rules live in
`src/lib/services/`. There is no separate API client to drift from the server's
validation, because there is no client data layer at all — server components plus
Server Actions.

---

## 2. `_action.ts` — the funnel, and what it does not do

Every action module routes through one wrapper. It:

- catches `AppError` and maps it to `{ ok: false, code, message }`
- maps Prisma `P2002` to a domain error — **and the reasoning is careful**: it
  discovered that RLS withholds constraint detail from a non-owner role and
  therefore keys on model rather than field
- logs refusals at `info` and unexpected errors at `error`, correlated to the
  `x-request-id` that `middleware.ts` stamps on every request

**Two gaps:**

**AUD-062 (P1) — `UNAUTHENTICATED` is modelled as a domain refusal.** On session
expiry, `toActionError` returns `{ ok:false, code:"UNAUTHENTICATED" }` — a normal
result the client renders as a toast. A supervisor whose shift crosses the
12-hour boundary taps "Submit for QC", gets a toast reading "Please sign in.",
**stays on the page**, and every subsequent tap does the same. The page still
shows stale server-rendered data, so it looks like the app is working. Shop-floor
work goes unrecorded for the rest of a shift and the user believes it was
recorded. The same bump happens on `sessionVersion` mismatch, so an admin
resetting a password silently bricks that user's open tabs.

Middleware handles this correctly for *navigations*; Server Actions are the gap.

**Fix.** Special-case `UNAUTHENTICATED` and `MUST_CHANGE_PASSWORD` in
`toActionError` and `redirect("/login?next=…")` from the action. Next's
`redirect()` throws a control-flow signal, so every surrounding `catch` must
re-throw `isRedirectError(e)`.

**Timeouts are not mapped.** `transactionOptions.timeout: 20_000` means a slow
mutation throws a raw Prisma `P2028`, which is not an `AppError`, so
`toActionError` rethrows and the user gets a bare 500 with no stable code. Map it
to a `TIMEOUT` code with a "try again" message.

---

## 3. `revalidatePath` correctness — a real, untested defect

`process.ts:10-11` revalidates only `/workspace` and `/dashboard` for single
actions — **not `/my-day`** — even though `startBulkAction` at `:58-61` *does*
revalidate it, and `my-day/_client.tsx:90` carries a comment noting this exact
asymmetry for `assignment.ts`.

**A supervisor who starts a plan from `/my-day` sees a stale row.** No test would
catch it: `revalidatePath` correctness after a mutation has zero coverage at any
level (`16_TESTING.md` §3).

This becomes more important, not less, once `/team` exists and `/workspace`
retires — the revalidate targets must be re-derived from the new IA, not
inherited.

---

## 4. API route contract

| Route | Contract issues |
|---|---|
| `GET /api/health` | **Public.** Leaks pending migration names (AUD-107). Otherwise the right check, and the *only* thing that detects deploy-time schema skew — see `15_FAILURE_MODES.md` §2 |
| `GET /api/jobs` | Correct: `pageSize` clamped to 200, `clientId` filtered for client actors |
| `GET /api/events` | **AUD-023 (P0)** — see §5 |
| `GET /api/jobs/[id]/spine` | `intParam` rejects non-ints; `assertClientScope` applied. Cost is the problem, not the contract |
| `GET /api/jobs/[id]/stage` | Correct — verifies the unit belongs to the job |
| `GET /api/welding/joints` | Correct |
| `GET /api/jobs/[id]/qcp/export` | **Bypasses the shared `route()` wrapper** and replicates `requireActor` + `assertNotClientUser` by hand, with a comment naming the reason. Works, but it is the one place where the deny-by-default guarantee is by convention rather than by construction. It also applies **no department scope** — any staff user can export any job's full QCP |
| `POST /api/cron/*` | Correct auth, fails closed. Idempotency is the issue (AUD-089) |

---

## 5. AUD-023 (P0) — the activity feed limits after the union

```sql
SELECT … FROM domain_events de
LEFT JOIN process_plans pp ON pp.id = de.aggregate_id::int
…
WHERE de.aggregate_type = 'ProcessPlan'
  AND ($1::int IS NULL OR jp.job_id = $1::int)
UNION ALL
SELECT … FROM domain_events de JOIN delay_reasons dr ON dr.id = de.aggregate_id::int …
ORDER BY at DESC, id DESC
LIMIT $2          -- ← applies AFTER the union
```

Both branches are unbounded. With no `job` param the predicate is a no-op, so the
first branch is *every `ProcessPlan` event ever*, joined four ways. `LIMIT` after
`UNION ALL` cannot be pushed into the branches when an `ORDER BY` spans both.

At the assumed millions of event rows this becomes a multi-minute query holding a
pooled connection — **an authenticated self-inflicted DoS**, reachable by any
staff user.

**Fix.** Add `ORDER BY de.at DESC, de.id DESC LIMIT $2` inside each branch as a
subquery, union the two bounded sets, then order and limit again.

This route also carries **AUD-028**: the `de.aggregate_id::int` cast in the join
will raise `invalid input syntax for type integer` the day a non-numeric
`aggregate_id` is written under either aggregate type — and
`client-snapshot.service.ts` **already writes** `` `${jobId}:${asOf.toISOString()}` ``
as an `entityId`. See `10_BUSINESS_LOGIC.md` §5.

---

## 6. Mass assignment and input validation — clean

Every mutating service function begins with `<name>Schema.parse(input)`; this was
confirmed for all 26 service files. 84 of 86 schemas are `.strict()`, so an
unexpected key is a parse error rather than a silent write.

There is **exactly one** spread into a Prisma `data:` —
`bom.service.ts:110`, `{ ...parsed, jobId: equipment.job.id }` — and it is safe:
the schema is strict, contains no `jobId`/`tenantId`/`status`/`role`, and the
server-controlled `jobId` is written *after* the spread.

**No request schema anywhere accepts an `actual_*` or `*_at` field.** Timestamps
are stamped from `new Date()` or DB defaults inside the transaction. Invariant #1
holds.

---

## 7. Error semantics — a genuine product feature

63 stable codes with one mapping to HTTP status and one to user-facing messages,
applied uniformly across Server Actions and API routes. Refusals log at `info`,
unexpected errors at `error` — **the distinction between "the system correctly
said no" and "the system broke" is modelled, not blurred.** That distinction is
what makes `USER-GUIDE-WHY-WAS-I-REFUSED.md` possible and what makes the demo's
"deliberately attempt a violation and show the refusal" script work.

Codes in active use include `GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`,
`REASON_REQUIRED`, `HOLD_POINT_OPEN`, `MATERIAL_NOT_AVAILABLE`,
`DRAWING_NOT_RELEASED`, `NCR_OPEN`, `CROSS_JOB_ASSIGNMENT`, `STALE_WRITE`,
`ALREADY_ASSIGNED`, `NOT_IN_DEPARTMENT`, `UNIT_NOT_PACKED`,
`SNAPSHOT_ALREADY_VERIFIED`, `DFT_NOT_ACCEPTED`.

**Codes this audit recommends adding:**

| Code | For |
|---|---|
| `UNIT_NOT_COMPLETE` | AUD-005 — dispatch with incomplete production |
| `NCR_NOT_DISPOSITIONED` | AUD-026 — verify with an OPEN NCR |
| `WAIVER_NOT_APPROVED` | AUD-003 — `NA` on a blocking hold point without PH approval |
| `EXTERNAL_PARTY_HOLD` | AUD-004 — internal verify cannot clear a third-party checkpoint |
| `PROCESS_NOT_OPTIONAL` | AUD-033 — excluding a non-optional template process |
| `SCHEDULE_DATA_MISSING` | AUD-035 — `checkFeasibility` currently throws a bare `Error` |
| `TIMEOUT` | §2 — Prisma `P2028` |

---

## 8. Dead service functions

Documented in CLAUDE.md's known state and re-confirmed. These have **zero callers
outside their own tests**:

| Function | Consequence |
|---|---|
| `dispatch.service.ts`, `packing.service.ts` | Had no UI; Gate 1 work is closing this |
| `override.service.ts` `applyDurationOverride` | Exported and reachable; carries AUD-035 |
| `ncr.service.ts` `dispositionNcr` | **This is why AUD-026 bites** — the only writer of `disposition` is unreachable from the UI, so every NCR closes with it NULL |
| `component.service.ts` `recordPaintRecord` / `recordDftReading` | **This is why AUD-029 bites** — the DFT gate is on by default and its evidence cannot be produced |

**The pattern worth naming:** a gate was shipped enabled before its evidence
writer existed. Add a CI assertion — for every `OperationRef.requiresDftGate =
true`, a writer for `PaintRecord` must be reachable from `src/app/` — so this
class of defect cannot recur. The prior roadmap's exit gate for Phase W says the
same thing in general form: *"No service function in `src/lib/services/` has zero
callers outside its own test file."*

---

## 9. Recommendations

1. **Redirect on `UNAUTHENTICATED`** (AUD-062) — small, high user impact.
2. **Bound both branches of the events UNION** (AUD-023) — small, removes a DoS.
3. **Normalise the `aggregate_id` cast direction** everywhere (AUD-028, AUD-059) —
   pure query-text change, identical results, removes both a correctness landmine
   and an index-defeating pattern. `myday.read.ts:351` is the reference
   implementation.
4. **Map `P2028` to a `TIMEOUT` code.**
5. **Re-derive every `revalidatePath` target** from the new IA when `/team` lands,
   and add the E2E freshness test in `16_TESTING.md` §5 scenario 21.
6. **Fold the QCP export route into `route()`** so deny-by-default is structural
   rather than replicated, and add a department scope to it.
7. **Add the seven error codes** in §7 as the gate fixes land.
