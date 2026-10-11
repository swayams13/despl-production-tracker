# AUDIT — Architecture & Scalability (v1)

**Date:** 2026-08-19 · **Question asked:** should the full-stack app be split into separate frontend / backend / database services, so failures are easier to trace and fix?
**Scope:** whole codebase — 12,161 LOC of services, 55 Prisma models, 15 migrations, 26 service test files.
**Read with:** `docs/ARCHITECTURE.md` §7, `docs/ADR-mobile-and-architecture-v1.md` §3, `docs/BUILD-SPEC-v2.md` decision #5

---

## 0. The short answer

**No — and the reason is specific to this product, not a general preference.**

The goal behind the question is right: *when something breaks, I want to find it fast.* The proposed mechanism is the wrong one. Splitting into separate deployed services makes failures **harder** to trace, not easier, because a single logical failure becomes two stack traces in two log streams that you have to correlate by hand across a network hop.

What actually delivers "trace it in 30 seconds" is **observability**. This codebase currently has:

- **0** error-tracking or APM dependencies
- **0** structured loggers — 2 `console.error` and 1 `console.warn` in the entire `src/`
- **0** `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx` boundaries
- **0** health endpoints — `middleware.ts:14` whitelists `/api/health`, but **the route does not exist**
- **0** CI/CD — no `.github/` directory, despite `CLAUDE.md` and `TRD.md` §8 both claiming a GitHub Actions pipeline

So the honest framing is: **you are considering an expensive, risky change to solve a problem that a cheap, safe change solves better — and the cheap change hasn't been done yet.**

There is also a correctness argument that makes the split not merely unnecessary but actively harmful. See §2.

---

## 1. The boundary you want already exists — and it is unusually clean

The valuable boundary is *logical*: business rules isolated from presentation. I tested whether it actually holds rather than taking the docs' word for it.

| Check | Result |
|---|---|
| `next/*` imports in `lib/services`, `lib/schedule`, `lib/shared`, `lib/authz` | **Zero** |
| `react` imports anywhere in `lib/` | **Zero** |
| Prisma imported in any component | **Zero** |
| Prisma in any `"use client"` file | **Zero** |
| `revalidatePath` outside `src/app/` | **Zero** — all 52 live in `app/actions/*` |
| Server actions, 14 files | **706 lines total** — genuinely thin |
| Route handlers, 5 files | **49 lines total** |
| Service test files / source files | **26 / 33** |

The entire business-logic layer has **exactly one** Next.js dependency in the whole tree: `cookies()` in `src/lib/auth/session.ts`, at three call sites.

**Read that again, because it is the crux of the answer.** Your service layer is *already* framework-portable. If you ever genuinely need a standalone backend, the migration is: copy `lib/`, replace one file (`session.ts`) with a token reader, put Fastify or NestJS in front of it. That is days of work, not a rewrite.

You are already holding the option. **Splitting now spends the option to buy nothing** — you would add a network boundary, not a logical one, because the logical one is already there.

This is the modular-monolith pattern executed correctly. It is not a compromise or a "we'll fix it later" state.

---

## 2. Why splitting would break the product's core guarantees

This is the argument that should settle it, and it is not a generic microservices caveat — it is about *your* invariants.

`CLAUDE.md` lists twelve non-negotiable invariants. Four of them are enforced **by a single Postgres transaction**:

- **#2 hard sequential gating** — "Enforced in `StageService` inside a transaction"
- **#3 maker–checker** — actor check and state transition must be atomic with the read that proves them
- **#4 hold points block** — checked against live rows in the same transaction as the completion
- **#5 append-only audit** — "writes `audit_log` in the same transaction; if the audit insert fails, roll back"

`src/lib/audit/index.ts` implements exactly this: `audited()` takes a `Tx`, runs the mutation and writes the audit row inside it, so "every mutation is audited" is true *by construction* rather than by convention. `withTenant()` (`src/lib/db.ts:57`) wraps every operation in a transaction that sets `app.tenant_id` for Postgres RLS, transaction-locally so it cannot leak across pooled connections.

**Split the app and every one of those becomes a distributed transaction.** "Verify this stage, write the audit row, emit the domain event" stops being one ACID unit and becomes a saga with compensating actions. You would be choosing, deliberately, to make it possible for a stage to be verified without its audit row — which is the precise failure that invariant #5 exists to make impossible.

Your own `ARCHITECTURE.md` §7 already says this, and I agree with it verbatim:

> **No microservices.** Splitting the gating engine, QCP engine, and dashboards into separate services would fragment the exact transactional boundary §6 depends on for correctness.

For a product whose entire pitch to DESPL's MD is *"you cannot fake an entry"*, trading transactional integrity for deployment topology is a bad trade at any team size.

---

## 3. What you'd actually be signing up for

For a solo developer, permanently, per feature:

CORS config · a second auth mechanism (tokens, not cookies) · duplicated DTOs and types on both sides · two deploy pipelines · two test setups · two secret stores · network latency where there was a function call · version-skew bugs when the two deploy out of step · and distributed tracing infrastructure you'd now *need* rather than merely want.

And you lose: Server Components fetching straight from Postgres with no round trip, and Server Actions giving type-safe mutations with no hand-written endpoints. Both would be rebuilt by hand in exchange for nothing.

The usual justifications for splitting — independent scaling profiles, multiple client apps owned by different teams, separate release cadences, merge contention — **none apply.** One developer, one database, one deployment, and per the mobile ADR, one client.

**Note on "separate database":** Postgres already *is* a separate service. It runs in its own Railway container, with its own credentials, its own scaling, and — unusually well done here — its own security boundary: the app connects as a non-owner role (`despl_web`), RLS policies apply to every query, `audit_log` has no UPDATE/DELETE grant, and `src/instrumentation.ts` crashes the server at boot if the role is wrong. That is a properly separated data tier already.

---

## 4. What is actually fragile — and none of it is fixed by splitting

Here is where the real risk is. Every item below would exist identically, or be worse, in a split architecture.

### 4.1 P0 — you are flying blind in production

No error tracking, no structured logging, no request IDs, no health check, no CI. If a supervisor says "it didn't work this morning", there is currently **no way to find out what happened**. This is exactly the pain that prompted your question, and it has nothing to do with service topology.

### 4.2 P0 — no error boundaries anywhere

There is not a single `error.tsx`, `global-error.tsx`, or `loading.tsx` in `src/app`. A thrown `AppError`, or a Prisma `P2024` pool timeout, in any server component renders Next's default error page and takes the **whole route** down. Note that `DESIGN_SPEC` mandates loading skeletons and error states on every page — the design contract already requires this and it was never built.

### 4.3 P0 — no CI, despite the docs claiming one

`CLAUDE.md` and `TRD.md` §8 both describe a GitHub Actions pipeline (lint → typecheck → test → build → migrate → deploy). **It does not exist.** There is no automated gate of any kind between a local edit and production. `ARCHITECTURE.md` §3/§4/§8 already flags this three times as "currently aspirational" — including the `audit_log` grant check that is supposed to *fail the deploy* if invariant #5's DB protection is missing.

With 26 service test files already written, you are getting a small fraction of the value they could give you.

### 4.4 P0 — `loadJobs` fans out `2J` concurrent transactions

`src/lib/services/jobs.read.ts:135` — `base.map(async …)` fires `loadOpenHoldPoints` *and* `loadJobSpines` per job, each opening its own `withTenant` transaction, all launched simultaneously by `Promise.all`.

`DATABASE_URL` in `.env.example` sets **no `connection_limit`**, so Prisma defaults to `cpus×2+1`. One user opening `/dashboard` with 20 jobs requests **40 simultaneous connections**. That is a `P2024` pool timeout for a *single user*, before any concurrency.

Worse, `loadJobs` is called **twice per page load** — once in `(app)/layout.tsx:46` and again inside `loadMyDay` / `loadPortfolio` / `loadCommandCenter`. Projected transaction counts per page load: `/dashboard` ≈ **10 + 4J**, `/my-day` ≈ **9 + 4J**. At 20 jobs that is ~90 transactions and ~450 queries for one page view.

### 4.5 P0 — `syncNotifications` runs on every authenticated page load

`(app)/layout.tsx:41` calls it on every page load, described in the code as "lazy reconciliation… rather than a cron." Its own comment admits "a full table scan of current plans/hold-points per call," and it internally runs a full `loadQcCockpit()` with a correlated `max(de.at)` subquery per row.

It is also **not idempotent under concurrency**: dedup is read-then-write under READ COMMITTED, and the `notifications` table has **no unique constraint** on `(type, entity_type, entity_id, recipient_id)`. Two users landing at the same moment both read "not yet notified" and both insert — duplicate bell entries. At 50 users that is 50× the same scan plus 50 concurrent writers to one table.

### 4.6 P0 — a known-slow view sits on the hot path

`progress.md` already measured `v_unit_stage_status` at **1.69s per call** at 132K `process_plans` rows, breaching the transaction-acquisition timeout. The cause is documented: the `governing` CTE's `DISTINCT ON` blocks predicate pushdown, so the `WHERE v.job_id = $1` filter is applied *after* a `units × job_processes × unnest(stages)` explosion across the whole tenant.

`loadJobs` calls it **once per job**, and runs twice per page load. That is **O(J²)** work per page view. The connection-pool fix was applied to the test suite; the view's non-pushdown was left in place.

### 4.7 P1 — zero caching, with proven duplicate work inside one request

No `unstable_cache`, no React `cache()`. Confirmed duplication within a single request:

- `getActor()` runs in `layout.tsx:36` **and again** in every `page.tsx`
- `loadJobs()` — the most expensive read in the app — runs twice
- `loadOpenHoldPoints(jobId)` runs three times on `/workspace`

Wrapping `getActor` and `loadJobs` in React `cache()` roughly **halves** `/dashboard` and `/my-day` transaction counts, with zero behaviour change. Both are per-request-idempotent reads.

### 4.8 P1 — login has no rate limit

`RATE_LIMITED` exists in `errors.ts:53` and is mapped to HTTP 429 in `api/_lib.ts:29`, and the attempt-counting pattern is already implemented in `lib/auth/change-password.ts:58` (5 failures / 15 min, derived from audit rows). **`login()` uses none of it.** Online brute-force is unmitigated. Already logged in `progress.md` as an open finding.

### 4.9 P1 — possible invariant #5 gap in notifications

`notifications.service.ts` performs **3 write operations and makes 0 `audited()` / `recordAudit()` calls**. Every other service file with writes has matching audit calls. Either notifications are deliberately exempt as non-domain data — in which case say so in a comment — or invariant #5 has a hole.

### 4.10 P1 — multi-tenancy is half-built

Migration `20260813051500_rls_and_app_role` states it plainly: child tables (`units`, `job_processes`, `bom_items`, `qcp_executions`) have **no `tenant_id` column and no RLS**, relying on reachability plus service-layer scoping. Cross-tenant reads therefore fail **open**, not closed. Harmless at one tenant; a data-leak class of bug the day a second one exists.

### 4.11 Also open, from the project's own log

Gating keys off lag *sign* rather than edge *type* (`gating.ts:44`) · duration override desyncs the two schedule layers · `schemas.ts` is a stub, so the "reject `actual_*`/`*_at`" validation truth doesn't actually exist · Railway Postgres session timezone unconfirmed · `ProgressSnapshot` has zero rows and nothing writes to it · 34 leaked test-fixture rows still in the `Organization` table.

---

## 5. What "a proper scalable platform" means here

There are three independent scaling axes. You have solved roughly one.

| Axis | State | Gap |
|---|---|---|
| **Data scale** — more jobs, units, events | Good foundation: RLS, tenant isolation, forward-only migrations, append-only audit | Child tables lack `tenant_id`; `v_unit_stage_status` is O(J²); `domain_events` gets seq-scanned by an `::int` cast that defeats its own index (`jobs.read.ts:84`) |
| **Load scale** — more users, more concurrency | **Weakest.** No connection limit, no caching, `2J` transaction fan-out, per-pageload full scans | §4.4–4.7 |
| **Change scale** — shipping safely over years | Strong service layer, 26 test files, pure `lib/schedule/`, documented decisions | **No CI, no observability, no error boundaries** |

Splitting the app addresses **none** of these three. Every fix in §4 is a change *inside* the monolith.

---

## 6. Recommended plan

### Round A — see what's happening (~2 days). Do this first.

1. **Sentry** (or equivalent) for server + client. Ten minutes of setup buys you the stack trace, the user, the release, and the breadcrumbs for every production error. **This is the direct answer to "trace it back and rectify it easily."**
2. **A request-scoped structured logger.** Generate a request ID in `middleware.ts`, attach it to every log line and to the Sentry scope, and return it in the `AppError` response body. Then a supervisor's screenshot of an error code is enough to find the exact request.
3. **`src/app/api/health/route.ts`** doing `SELECT 1` — `middleware.ts:14` already whitelists the path. Point Railway's healthcheck at it.
4. **`error.tsx` per route group + `global-error.tsx` + `loading.tsx`.** Render `AppError.code` as the human-readable refusal the UI is supposed to show (invariant #12), and the request ID underneath.

### Round B — a gate before production (~1 day)

5. **GitHub Actions**: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` on every PR; `pnpm test:db` against an ephemeral Postgres; `pnpm e2e` on merge to `main`.
6. Add `ARCHITECTURE.md` §3's **`audit_log` grant check as a deploy-blocking step** — the invariant that most needs a machine watching it.
7. `prisma migrate deploy` as a Railway pre-deploy step, and a manual promote to production.
8. Delete the CI claims from `CLAUDE.md`/`TRD.md` or make them true — right now the docs assert a safety net that isn't there, which is worse than admitting the gap.

### Round C — the load cliffs (~2 days)

9. Set `connection_limit` and `pool_timeout` explicitly in `DATABASE_URL`.
10. Wrap `getActor` and `loadJobs` in React `cache()`. Biggest win per line of code in this entire audit.
11. Replace the `2J` fan-out at `jobs.read.ts:135` with two batched cross-job queries inside one transaction.
12. Add a unique index on `notifications(type, entity_type, entity_id, recipient_id)` and switch to `createMany({ skipDuplicates: true })` — this makes the sync idempotent and lets you stop worrying about concurrent writers.
13. Move `syncNotifications` off the page-load path onto a scheduled route (Railway cron), or gate it behind a per-tenant "last synced" timestamp.
14. Fix `v_unit_stage_status` predicate pushdown, and the `::int` cast at `jobs.read.ts:84` that defeats the `domain_events` index.
15. Apply the existing `change-password` rate-limit pattern to `login()`.

### Round D — keep the option open, don't spend it

16. Build `src/app/api/v1/*` route handlers calling the **same** `lib/services/` functions (ADR §1.4). An API surface inside the monolith. Roughly a day, and it means "we need a separate backend" is forever a client swap rather than a rewrite.
17. Write down the revisit triggers and **only** revisit when one is true:
    - team grows past ~4–5 developers and merge contention actually hurts
    - a second, independently-owned client app appears
    - one subsystem develops a genuinely different scaling profile
    - a non-JavaScript service becomes necessary — which would be a **sidecar**, still not a split

### When the time does come, extract these — in this order

Not a split; targeted extractions, each justified independently:

1. **The notification/schedule sync** into a real worker. It is already the wrong shape as a page-load side effect (§4.5), so this one is justified *today* on its own merits.
2. **`lib/schedule/`** — already pure by project rule: no Prisma, no clock, no writes, 1,711 lines, fully unit-tested. The single most extractable piece in the codebase, and the natural home if CPM ever needs a different runtime.
3. **Photo/image processing**, when D20's storage vendor is chosen. CPU-heavy, latency-tolerant, zero transactional coupling — the textbook case for a worker.
4. **An agent layer reading `domain_events`.** The schema comment already names this intent. It reads an append-only stream and never participates in the write transaction, so it is a sidecar by nature.

Every one of those is additive. None requires touching the transactional core — which is exactly the property that makes the current architecture the right one to keep.

---

## 7. What is already done well

Stated plainly, because it is unusual and should not be accidentally undone:

- **`lib/services/` is a real boundary, verified, not aspirational** — zero framework imports, thin callers, 26 test files.
- **`lib/schedule/` is pure** — no Prisma, no clock, no writes. Rare discipline, and it is what makes it extractable later.
- **`audited()`** makes "every mutation is audited" true by construction rather than by convention.
- **`withTenant()`** uses transaction-local `set_config`, so RLS cannot leak across pooled connections — a mistake most teams make and don't notice.
- **Non-owner DB role + boot-time `assertDbRole()`** that crashes the server rather than running with protections silently disabled.
- **Stable error codes** mapped to HTTP status, so refusals are explainable (invariant #12).
- **Decisions are written down with their reasoning**, including the ones that were reversed. This audit took hours instead of days because of that.
