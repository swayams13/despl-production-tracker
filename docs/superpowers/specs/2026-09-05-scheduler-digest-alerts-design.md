# Scheduler + digest + alert reconciliation — design

**Date:** 5 Sep 2026
**Status:** approved, pending implementation plan
**Gate:** Gate 4 ("the company operates on it") — corresponds to `docs/mos-blueprint/PROMPTS.md` §9 Phase E, items E1–E3, E9

## Problem

Two real gaps, both already documented and now confirmed against current code:

1. **Overdue-stage and aged-hold-point alerts are computed on every authenticated page load.** `syncNotifications(actor)` (`src/lib/services/notifications.service.ts:125`) runs from `src/app/(app)/layout.tsx:42` on every request — a tenant-wide `ProcessPlan` scan plus per-row context lookups, on the request path of every page view. The function's own comment already flags this as a `ponytail:`-marked shortcut needing a real cron once row counts made it slow; H1's session (5 Sep) confirmed it already contributes to real page-load cost.
2. **The daily digest is a manual button.** `publishDigest` (`src/lib/services/reports.service.ts:17`) only runs when a PRODUCTION_HEAD/ADMIN clicks "Send now" (`src/app/(app)/reports/_client.tsx:36`). Nothing runs it on a schedule. The digest content itself is computed live on every read (`loadDailyDigest`, `reports.read.ts:48`) and was never persisted as a "digest" record — the "email-ready jsonb" framing in `docs/mos-blueprint/reference/14_DESPL_MOS_MANAGEMENT_KPI_ALERT_MODEL.md` overstates what exists: the actual `Notification.payload` for a digest is just `{date}`.

No cron, queue, or scheduled-job infrastructure exists anywhere in the repo today (confirmed: no BullMQ/Redis/node-cron, no `/api/cron/*` route, no `railway.json` cron config, no bearer-secret auth pattern for an internal-only route).

## Decisions locked in before this design

- **Delivery channel: in-app only.** No email/WhatsApp/SMS integration in this phase — external delivery (E9) is deferred until a provider and real supervisor contact info exist. This phase only fixes *when* alerts/digests are generated, not how they leave the app.
- **Scheduler mechanism: Railway Cron Schedule → protected HTTP route.** No new dependency (no Redis/BullMQ), matches CLAUDE.md's own stated fallback ("Background jobs via Next.js route + cron... BullMQ/Redis only if load demands it").
- **Alert reconciliation frequency: hourly**, every day including Sundays/holidays (a stage can go overdue on a non-working day; reconciliation should still catch up).
- **Digest: keep the manual "Send now" button AND add an automatic daily run** at **6:30 AM IST (01:00 UTC)**, skipped on Sundays and seeded national holidays per each tenant's `WorkCalendar`.
- **No manual "run alert reconciliation now" trigger** — hourly is considered fresh enough; the cron route itself can always be curled by hand if someone needs an out-of-band run.

## Architecture

Two new route handlers, no new infrastructure dependency:

```
Railway Cron Schedule (hourly)  --curl+secret-->  POST /api/cron/alerts
Railway Cron Schedule (daily, 01:00 UTC)  --curl+secret-->  POST /api/cron/digest
```

Both routes:
- Added to `middleware.ts`'s `PUBLIC_PATHS` (bypasses the session-cookie gate — a cron caller has no browser session, same reasoning as `/api/health`).
- Self-enforce a new `CRON_SECRET` env var: request must carry `Authorization: Bearer <CRON_SECRET>`; missing or mismatched → `401` before any DB work, matching this codebase's existing "deny by default" posture (invariant #8) even though this is route-level, not role-level.
- `export const dynamic = "force-dynamic"`, matching `/api/health`'s convention.
- Return `200` with a per-tenant summary array (`{ tenantId, ok, count | error }[]`) even when individual tenants fail — one tenant's bad data must not block another tenant's alerts/digest. Failures are `console.error`-logged (matching the app's existing convention; no new observability infra, per Gate 4's separate "observability and scale" item being explicitly out of scope here).

### New service: `src/lib/services/cron.service.ts`

Two entry points, each looping every `Organization`:

- `runAlertReconciliation(): Promise<TenantRunResult[]>` — for each org, calls the two reconciliation functions (below) inside a try/catch, collects per-org result.
- `runDailyDigest(date: string): Promise<TenantRunResult[]>` — for each org, loads that org's default `WorkCalendar` (+ holidays), skips via `isWorkingDay()` (`lib/schedule/calendar.ts:24`) if not a working day, otherwise resolves a system actor and calls `publishDigest(actor, date, { auto: true })`.

### Changes to existing code

- **`notifications.service.ts`**: `syncOverdueStageNotifications` and `syncHoldPointAgedNotifications` change signature from `(actor: Actor)` to `(tenantId: number)`. Neither function uses anything else from `Actor` today (confirmed by reading both bodies — no `audited()` call, no role check, no `actor.userId`/`actor.name` use) — this removes the need to fabricate or impersonate a user actor for a system-triggered call.
- **`notifications.service.ts`**: delete `syncNotifications(actor)` (the two-line `Promise.all` wrapper) — its only caller is removed in the same change.
- **`src/app/(app)/layout.tsx`**: delete the `syncNotifications(actor)` call at line 42. Alerts no longer compute on page load at all; the hourly cron is the only path now. This also removes a full tenant-wide `ProcessPlan` scan from every authenticated request — a direct win against Gate 4's separate "page-load N+1s" backlog item, though that item's other two N+1s remain untouched (out of scope here).
- **`reports.service.ts`**: `publishDigest(actor: Actor, date: string)` gains a third optional parameter: `publishDigest(actor: Actor, date: string, opts?: { auto?: boolean })`. Only effect: the notification `body` reads `"Sent automatically"` instead of `"Sent by {actor.name}"` when `opts?.auto` is true. No other behavior changes — the manual "Send now" button's existing call site is untouched (omits the third arg, defaults to manual wording).
- **System actor for the automated digest's audit trail**: `publishDigest` calls `audited()`, which requires a real `Actor` with a valid `userId` (FK'd into `audit_log.actor_id`) — there is no "system"/null-actor concept in this schema and adding one is out of scope (YAGNI: one new column/FK relaxation for a single caller). Instead, `cron.service.ts` resolves each org's system actor as **the first active `ADMIN`-role user, ordered by id** and constructs a real `Actor` object for them (same shape `getActor()` produces) — the audit trail reads "the org's admin published this," which is accurate: an admin's account is executing the scheduled action on the org's behalf, same framing as any other automated script in this codebase running under a named account (e.g. `SEED_PASSWORD`-based seeding). If an org has no active ADMIN user, that org's digest run fails loudly (per-tenant, logged, doesn't block others) rather than silently skipping or inventing a fallback actor.

## Data flow

**Alert reconciliation (hourly):**
```
Railway cron → POST /api/cron/alerts (secret checked)
  → runAlertReconciliation()
    → for each Organization:
      → syncOverdueStageNotifications(tenantId)   [existing logic, tenantId-scoped]
      → syncHoldPointAgedNotifications(tenantId)  [existing logic, tenantId-scoped]
  → 200 { results: [{tenantId, ok, count}] }
```

**Daily digest (once/day, working days only):**
```
Railway cron → POST /api/cron/digest (secret checked)
  → runDailyDigest(todayIST)
    → for each Organization:
      → load org's default WorkCalendar + holidays
      → isWorkingDay(today, calendar)?
        no  → skip, result: {tenantId, ok: true, skipped: true}
        yes → resolve system actor (first active ADMIN)
              → publishDigest(actor, date, {auto: true})  [existing logic, unchanged except body text]
  → 200 { results: [...] }
```

## Error handling

- Wrong/missing `CRON_SECRET` → `401`, no DB access attempted, no per-tenant loop entered.
- A single tenant's reconciliation or digest throwing (e.g. no active ADMIN user, a DB error) is caught within that tenant's iteration, logged via `console.error` with enough context to find it (tenantId, which job, the error), and recorded as `{ok: false, error: <message>}` in that tenant's slot of the response array. Other tenants still run.
- The route itself always returns `200` if the secret check passes, even with partial per-tenant failures — a monitoring/alerting layer on the per-tenant failure array is out of scope (Gate 4's "observability and scale" item, separately tracked, not this one).

## Testing

DB-gated (`pnpm test:db`), no new e2e coverage:

1. **Secret guard**: missing header → 401; wrong secret → 401; correct secret → 200, proceeds to run.
2. **`runAlertReconciliation` multi-tenant isolation**: two tenants each with an overdue plan → both get notified, no cross-tenant leakage (reuses this repo's existing multi-tenant DB-test fixture convention).
3. **`runDailyDigest` holiday skip**: a tenant whose `WorkCalendar` marks "today" as a holiday → no digest sent, result marked `skipped: true`; a tenant with today as a working day → digest sent normally.
4. **`publishDigest`'s `auto` flag**: `auto: true` → notification body is "Sent automatically"; omitted/`false` → unchanged "Sent by {actor.name}" (regression test on the existing manual path).
5. **No active ADMIN user**: a tenant with zero active ADMIN users → that tenant's digest run fails and is logged, other tenants unaffected, existing digest test fixtures untouched.

## Out of scope (named, not silently dropped)

- **E9 external delivery** (email/WhatsApp/SMS) — deferred, no provider or per-user contact field exists yet (confirmed: no phone/WhatsApp field on `User` or `Department`). Revisit once a channel and contact data are decided.
- **Persisting a `Digest` record** — the digest content stays computed live from `loadDailyDigest()` on every read, as it is today. This design only changes *when* the publish-and-notify step runs, not whether the digest body itself is stored. If audit/historical "what did the 6:30 AM digest actually say" becomes a real need, that's a separate, later item.
- **Manual "run reconciliation now" trigger** — explicitly declined; the cron route can be curled by hand if ever needed.
- **The other two Gate 4 page-load N+1s** (`loadJobs`'s per-job transaction fan-out flagged in the H1 session, `portfolio.read.ts`'s 2N+3-query pattern) — untouched here; this design only removes the `syncNotifications` scan from the request path.
- **Creating the actual Railway Cron Schedule services** — infrastructure action outside this codebase, done manually (like migrations) once the routes exist and are deployed. The implementation will hand over the exact `curl` command and secret-header format needed.
