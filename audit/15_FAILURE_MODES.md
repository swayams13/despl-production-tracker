# 15 — FAILURE MODES

*The system must fail safely. Where it does, that is stated. Where it does not,
the required behaviour is specified.*

---

## 1. Failure mode matrix

| Scenario | What happens today | Safe? | Required |
|---|---|---|---|
| **Double-click Start/Submit/Verify** | DB: `lockProcessPlanForUpdate` takes `SELECT … FOR UPDATE`, re-reads status, `assertTransition` rejects the second with `INVALID_STATE_TRANSITION`. UI: 168 `disabled={pending}` bindings across 24 `useTransition` components | ✅ | As-is; optionally suppress the second toast |
| **Double-click Claim, two users, same plan** | Row lock serialises; loser gets `ALREADY_ASSIGNED` | ✅ | As-is |
| **Concurrent assign by two supervisors** | Both lock in turn; last write wins, both audited with before/after | ✅ (last-write-wins is correct for reassignment) | As-is |
| **Network drop mid-mutation** | The whole transition is one transaction — status + actuals + `AuditLog` + `DomainEvent` + `Notification` commit together or not at all. Client shows no result; a retry is refused as an illegal transition if the first committed | ✅ at the DB, ⚠️ at the UI | The retry should say "already done", not raise a state-machine error |
| **Action timeout (>20s)** | Prisma throws raw `P2028`, not an `AppError` → rethrown → bare 500, no stable code | ❌ | Map `P2028` to a `TIMEOUT` code |
| **Database unavailable** | `/api/health` → correct 503 `{db:"unreachable"}`. `(app)/*` → `error.tsx` with a digest, inside the shell. **`/login`, `/portal`, `/account/password` → unstyled Next error page, no boundary** | ⚠️ | A boundary on every segment, with distinct "service unavailable" copy |
| **Refresh during a mutation** | The Server Action completes independently of the browser; `revalidatePath` fires | ✅ | As-is |
| **Lost update — two users edit the same record** | Prevented for *status transitions* by `FOR UPDATE` + re-read. **No version column and no `updatedAt` precondition on any record.** Free-text edits (job details, job dates, BOM rows) are last-write-wins with no detection | ❌ for field edits | Optimistic concurrency: send `updatedAt`, `WHERE updated_at = $expected`, map 0 rows to the existing `STALE_WRITE` code |
| **Expired session mid-action** | `UNAUTHENTICATED` → toast "Please sign in.", **no redirect**, stale page, every further tap fails identically | ❌ | Redirect to `/login?next=…` |
| **Password changed / session invalidated elsewhere** | `sessionVersion` mismatch → same dead toast | ❌ | Same fix |
| **Partial multi-step write** | Every service mutation runs inside one transaction; `audited()` writes in the same tx; `notify()` is called inside it by design | ✅ **genuinely well done** | As-is |
| **Cron runs twice (retry / overlap)** | Guarded by a `findMany` existence check then insert — **not atomic, no unique constraint**. Serial re-runs are idempotent; overlapping runs double-notify | ⚠️ | Unique index + `createMany({skipDuplicates:true})` |
| **Cron never runs** | Overdue and aged-hold notifications **silently stop** — nothing else writes them since they moved out of the layout. **No heartbeat, no alert, no UI indication** | ❌ | Heartbeat surfaced on `/api/health` |
| **Cron partially fails** | Per-tenant try/catch; one tenant's failure does not block others; failures returned in the JSON response and logged | ✅ **good design** | Also alert, not just log |
| **Deploy without migrations** | Code ships; schema does not; Railway ignores `railway.json`; `/api/health` detects it and returns 503 but **nothing calls it**. Precedent: 2 Sep, 20 migrations, one day of production breakage | ❌ **top reliability risk** | Healthcheck path + pre-deploy migrate, set in the Railway dashboard |
| **Migration edited after being applied** | Caught in CI by `prisma migrate diff --exit-code` | ✅ **a genuinely good control** | As-is |
| **Malformed spine on one job** | `/my-day`: skipped, page renders (`computeCpmSafe`). **`/command/[dept]`: throws, whole page 500s.** Single-job pages: explainable `SCHEDULE_GRAPH_INVALID` refusal | ⚠️ | `computeCpmSafe` in the cross-job loop |
| **Client user hits an internal API** | `route()` calls `assertNotClientUser` by default; opt-in `allowClient` unused. E2E-verified | ✅ deny-by-default | As-is |
| **Cross-tenant read** | RLS fail-closed via transaction-local `set_config`; non-owner role; boot-asserted | ✅ **on the 24 tables that have it** — see AUD-001 for the other 28 | |
| **Cross-job read within a tenant** | `withJob` sets `app.job_id`; the policy is fail-open when unset, by design, DB-tested | ✅ with the documented caveat | As-is |

---

## 2. AUD-024 (P0) — the deploy pipeline does not apply migrations

`railway.json` declares `healthcheckPath: "/api/health"`, `builder: "NIXPACKS"`,
`restartPolicyType: "ON_FAILURE"`. `MERGE-RUNBOOK.md §1.2` records the actual
deployment list: `preDeploy: None | builder: RAILPACK`, and CLAUDE.md states
*"every deployment on record shows `preDeployCommand: None` … `healthcheckPath:
null`."*

**Railway does not honour the file. Its dashboard settings win, and they were
never updated.**

`MERGE-RUNBOOK.md §1.1` documents the outcome: PR #6 carried 20 migrations onto
`main`; **production ran the new code against the 24 Aug schema for a full day.**

The pieces that would catch this all exist but are not connected:

- `src/app/api/health/route.ts:45-72` **genuinely detects it** — it compares
  `prisma/migrations/` on disk against `_prisma_migrations` and returns 503 with
  the pending list. This is the right check.
- **Nothing calls it.** Railway's healthcheck is `null`, so a 503 does not block
  or roll back a deploy, and no external monitor polls it.
- CI's `migration-pr` job requires only a **label**. The label acknowledges that a
  manual procedure is *owed*; nothing verifies it was performed.

**With RLS in play, a partially-migrated schema does not fail loudly — reads
return zero rows.**

**Fix, in order:**

1. **Set Healthcheck Path = `/api/health` in the Railway service settings by
   hand.** This alone turns the existing probe into a deploy gate: a container
   with pending migrations fails its healthcheck and Railway keeps the previous
   deployment serving. **This is the single highest-value action in this
   document and it is a settings change.**
2. **Set Pre-Deploy Command = `pnpm exec prisma migrate deploy`** with
   `DIRECT_URL` bound in the service env. Railway honours the dashboard value
   even though it ignores the file.
3. Keep the manual runbook for **destructive** migrations only (the
   `procurement_event_drop_procurements` class), and mark those with a
   `-- DESTRUCTIVE` header so the runbook has a machine-checkable trigger.
4. Add a post-deploy CI step that curls `/api/health` and fails on non-200.
5. Add a comment at the top of `railway.json` stating which keys are actually
   honoured, so it stops reading as truth.

---

## 3. AUD-091 (P2) — error boundary coverage

| Route segment | `error.tsx` | `loading.tsx` | `not-found.tsx` |
|---|---|---|---|
| `src/app/` (root) | **No** (and no `global-error.tsx`) | No | No |
| `src/app/(app)/` | ✅ — surfaces `error.digest` for log correlation | No | ✅ |
| `(app)/dashboard` | inherited | **No** ← heaviest page | inherited |
| `(app)/my-day` | inherited | **No** | inherited |
| `(app)/workspace` | inherited | **No** | inherited |
| `(app)/qc` | inherited | **No** | inherited |
| `(app)/departments`, `/[id]` | inherited | **No** | inherited |
| `(app)/command/[dept]` | inherited | **No** | inherited |
| `(app)/reports` | inherited | **No** | inherited |
| `(app)/jobs` | inherited | **No** | inherited |
| `(app)/jobs/[id]`, `/new` | inherited | ✅ | inherited |
| `(app)/admin/templates`, `/[versionId]` | inherited | ✅ | inherited |
| `(app)/admin`, `/routes`, `/families`, `/equipment-types`, `/qcp-templates` | inherited | **No** | inherited |
| `(app)/{alerts,board,profile,welding}` | inherited | **No** | inherited |
| `src/app/login` | **No** | **No** | **No** |
| `src/app/portal` | **No** | **No** | **No** |
| `src/app/account/password` | **No** | **No** | **No** |
| `src/app/api/*` | n/a — `route()` catches and returns 500 JSON with `x-request-id` | n/a | n/a |

**1 of 2 route groups has an error boundary. The unauthenticated group has none.
There is no `global-error.tsx`, so a root-layout failure — and the root layout
loads two Google fonts — is unhandled. 4 of 26 pages have a loading state, and
none of them are the six slow pages.**

During an outage, `/login` — the one place users go to check whether the system is
up — is the one page that renders a raw unstyled error shell.

**Fix.** Add `src/app/global-error.tsx` (must render its own `<html>/<body>`) and
`src/app/error.tsx`. Detect Prisma `P1001`/`P1017` and render a distinct "service
unavailable" state — that prompts a different user action than "something went
wrong". Add `loading.tsx` to the six heaviest routes;
`globals.css:1005` already ships a `.skel` shimmer with `prefers-reduced-motion`
support that nothing on those routes uses.

---

## 4. AUD-089 (P2) — the cron notification guard is not atomic, and silence is invisible

```ts
// notifications.service.ts:149-155
const already = await tx.notification.findMany({
  where: { type: "STAGE_OVERDUE", entityType: "ProcessPlan", entityId: { in: overduePlans.map(p => p.id) } },
  select: { entityId: true },
});
const pending = overduePlans.filter(p => !notifiedIds.has(p.id));
```

Read-then-write with no unique constraint on
`(recipientId, type, entityType, entityId)`. The route has no in-flight lock and
returns per-tenant results after doing the work, so a Railway retry on timeout,
or two overlapping hourly fires, both pass the check and both insert.

**The worse half is silence.** `syncOverdueStageNotifications` is the *only*
writer of `STAGE_OVERDUE` since it moved out of the layout. If the cron never
runs, alerts silently stop, with nothing surfacing the gap — and **the
overdue-escalation path is what the MOS depends on**.

**Fix.** `@@unique([recipientId, type, entityType, entityId])` +
`createMany({ skipDuplicates: true })`, which makes the guard atomic and the job
genuinely idempotent. Separately, record `lastRunAt` per job — a
`CRON_HEARTBEAT` notification, or a small table — and surface staleness on
`/api/health` so "never ran" is detectable.

---

## 5. AUD-063 (P1) — there is no observability stack

`package.json` contains no Sentry, no OpenTelemetry SDK, no pino, no winston, no
metrics client. Total logging in `src/`: **4 `console.error`, 2 `console.warn`,
1 `console.info`**, plus the `log()` helper in `_action.ts`.

**What does exist, and is good:** `middleware.ts` stamps `x-request-id` on every
request, and `_action.ts` and `api/_lib.ts` correlate refusals and errors to it
with `userId`, `tenantId`, `path` and `actionId`. **That is a real, deliberate
tracing spine.**

**Where it stops short:** the emitted line is
`console.error("[action] unhandled", {…})` — Node's `util.inspect` of an object,
**not JSON**. Railway's log drain cannot index `requestId` or `code` from it, so
"find this failure by request id within two minutes" requires a full-text scrape.
There is no error aggregation (no way to know a refusal rate spiked), no latency
or query-count metrics, and no alert on a 503 from `/api/health`.

**Every finding in `14_PERFORMANCE.md` is invisible until a user complains. The
2 Sep migration incident ran for a full day undetected for exactly this reason.**

**Fix, in increasing cost:**

1. Change `console[level](tag, payload)` to
   `console[level](JSON.stringify({ level, tag, ts: new Date().toISOString(), ...payload }))`
   — **one line, makes every existing log queryable.**
2. Add `@sentry/nextjs` wired through `src/instrumentation.ts`, which already
   exists and is the correct hook, with `error.digest` propagated so the
   `(app)/error.tsx` reference is clickable in Sentry. Note `next.config.ts`'s
   CSP `connect-src 'self'` needs the ingest origin added.
3. Add a Prisma `$on('query')` middleware behind an env flag that logs statements
   over 200 ms with the request id. **That alone would have surfaced AUD-021,
   AUD-022 and AUD-056 on the pilot data**, and it is the only way to confirm the
   performance fixes landed.

---

## 6. AUD-090 (P2) — one bad spine 500s the Command Center

```ts
// command-center.read.ts:243 — inside `for (const job of jobs)`
const cpm = computeCpm(spine.processes, spine.edges);
```

`computeCpm` throws on a cycle or a missing duration. `myday.read.ts:201-202` —
the same loop, written for the same reason — uses the safe variant:

```ts
const cpm = computeCpmSafe(spine.processes, spine.edges);
if (!cpm) continue;
```

with the explicit comment: *"A batch omission … or a malformed spine … on ANY one
job must not 500 My Day for the whole tenant."*

**A single bad template edit blanks the Command Center for procurement, design,
planning, QA/QC, stores and dispatch simultaneously**, with an unexplained error
boundary and no indication which job is at fault.

`loadPrioritizedJob`, `loadWorkspaceView` and `loadJobKpis` correctly use
`computeOrRefuse` — single-job reads where an explainable refusal is right. Only
this cross-job loop is wrong.

---

## 7. What is solid

- **Transactional integrity is genuinely well done.** Every service mutation is
  one transaction; the audit row and domain event are written inside it; a failed
  audit insert rolls the mutation back. This is the part most systems of this
  kind get wrong.
- **Row locking on transitions is real** — `FOR UPDATE` before the status
  re-read in all four `lock*ForUpdate` helpers, plus a `pg_advisory_xact_lock` on
  stock lots where table grants preclude `FOR UPDATE`, with the reasoning
  written down. The `STALE_WRITE` check closes the "old browser tab writing to a
  superseded run" hole. `verifySnapshot`/`rejectSnapshot` use count-checked
  `updateMany` as genuine optimistic concurrency control.
- **`computeOrRefuse` / `computeCpmSafe`** convert engine errors into stable
  refusals for single-job paths and per-job skips for cross-job loops — the right
  distinction, applied in all but one place.
- **Cron failure isolation** — per-tenant try/catch so one tenant cannot block
  the rest, with failures returned in the response.
- **`prisma migrate diff --exit-code` in CI** proves the migrations produce the
  schema `schema.prisma` describes. Most teams do not have this.
- **`assertDbRole` at boot** makes a misconfigured `DATABASE_URL` a crash rather
  than a silent loss of RLS and append-only protection.
- **The request-id spine already exists.** Making the logs JSON is one line away
  from turning a good design into a usable one.
