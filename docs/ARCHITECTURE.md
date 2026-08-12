# ARCHITECTURE.md — Production-Grade System Design

> Companion to `docs/BUILD-SPEC-v2.md` (the *what/why*), `docs/IMPLEMENTATION-GUIDE.md` (the *how, in order*), and `CLAUDE.md` (the *invariants*). This document covers a fourth dimension none of the others do: **how the system stays correct and available once it's carrying real production load**, not just once it's functionally complete. Written before Step 5 (Prisma schema) deliberately — every decision here changes table shape, and retrofitting after data exists is disruptive or breaking.

---

## 0. Why this document exists

`docs/PRD.md` §7 and `docs/TRD.md` §10 target **≤50 concurrent users, ~500 units (50 jobs × 10 units), on a ~$10–25/month Railway budget**, reasoning "Postgres on Railway's base plan is comfortably 100× this load; no premature optimization (no sharding, no microservices)."

That reasoning is correct about *what not to build* (see §7) but understates *what changes as the system runs for years, not a pilot*. Two different axes are being conflated under one "100×" figure:

- **Concurrent users** — genuinely close to fixed: 50 → 100 is not an order-of-magnitude change, and neither number stresses a well-run Postgres instance.
- **Row count over time** — genuinely grows to "lakhs" (100,000s+) as jobs accumulate, and this is the axis every scaling failure mode below actually comes from.

Nothing in §7 (no microservices, no Kubernetes, no multi-region) needs to change for the higher row-count target. What needs to change is indexing, partitioning, dashboard-query strategy, connection pooling, and transaction discipline in the gating engine — all decisions inside the existing single-Next.js-app architecture, not additions to it.

---

## 1. Scale Reconciliation — Where the Current Design Would Break First

Given the domain data volumes established in `seed/*.json` (36 processes, 13 departments, ~27 BOM items/job average, ~54 QCP checkpoints/template, `operation_instance` projected as the largest table at `bom_item_count × ~4.3 avg route length`), the naive version of this design — built without the decisions in §2–§6 — would break in this order:

1. **The company dashboard aggregate query.** Already flagged in TRD §10 as "worst-case ~10k `unit_stages` aggregate," mitigated there with "indexed queries + 60s cache." At lakhs of `operation_instance`/`bom_item` rows, a live `GROUP BY` across `job → equipment → unit → stage → operation_instance` degrades from slow to a sequential-scan timeout once table sizes cross the point where a handful of indexes can no longer carry the query planner. A bigger cache TTL treats the symptom; §2.4 fixes the cause.
2. **N+1 queries in the stage-completion roll-up.** Stage completion is *derived* from component-operation completion (BUILD-SPEC-v2 decision #2 / CLAUDE.md invariant #2), not entered directly. If that derivation is implemented as "load the stage, then loop over its operations in application code," every completion check becomes O(operations-per-stage) queries. At ~25 operations feeding one stage × 100 concurrent supervisors submitting at shift boundaries, this is where the p95 <500ms target (TRD §10) dies first — from query *count*, not data volume. It must be a single SQL aggregate inside the same transaction as the gate check.
3. **Unbounded, unpartitioned `audit_log` growth.** Append-only by invariant #5, one row per mutation. At a conservative 2,000 mutations/day, that's ~700K rows/year — not large for Postgres by itself, but without time-based partitioning, `VACUUM` and index maintenance on one monolithic table degrade linearly forever, and "show me this user's actions in Q3" becomes an unindexed full-table scan. This is a near-certain first-year problem, not a hypothetical.
4. **Connection pool exhaustion at shift-start/shift-end.** 100 users on a manufacturing floor don't arrive uniformly — they converge within a 15–30 minute window at shift change (the same burst pattern that makes §6's concurrency correctness matter). A long-running Node server with Prisma's default pool (`num_cpus*2+1`, often ~10–13) will queue or reject once burst concurrency exceeds it, and Postgres itself has a hard `max_connections` ceiling on Railway's managed plans. This can happen on day one of pilot, not at "10× load."
5. **Missing composite/partial indexes on the actual hot predicates.** "Today" priority lists, `DepartmentScopeGuard`-scoped queries, overdue detection, and the gating engine's predecessor-completion check all filter by `(department, status, due_date)` or `(stage, predecessor_status)` combinations that Prisma's default PK/FK-only indexes don't cover. These become sequential scans within the first month of real usage, well before "lakhs."

**What is already right-sized and should not change:** single Next.js app on a long-running process, single Postgres 16 instance, no sharding, no read replicas by default. Keep all of it — see §7 for why.

---

## 2. Data Architecture

### 2.1 Tracking granularity — resolved (was C-series-adjacent, now locked)

BUILD-SPEC-v2 decision #2 already states "per BOM item, with serial roll-up at assembly." This document makes the row-count consequence of that decision explicit, because the seed data shows `qty` per BOM line running up to 160 physical pieces — if that were ever misread as "track every physical piece individually from receipt," the largest table in the system would multiply by up to 160×.

**Locked interpretation — hybrid, not full-serial:**
- **Pre-assembly** (procurement, component fabrication): track at BOM-line/batch granularity. `bom_item`, `procurement`, `material_identification`, `item_operation`, `item_test` all key off `bom_item_id`. This matches DESPL's actual legacy trackers, which never tracked individual pieces, and avoids inventing serial identity for stock that's genuinely fungible until assembly.
- **From Final Assembly (P24) onward:** records attach to `unit` (the serial-tracked vessel — DESPL-320's 320SR01–09), because from that point the domain has real per-serial identity and QCP/MDR traceability requires it.
- **The junction must be a real table, not an implied relationship:** an explicit consumption/allocation record (which units drew from which batch) is the join key the stage-completion roll-up needs. Without it, "is this unit's shell-fabrication stage done" has no way to trace back to which batch of plate stock fed it.

Row-count consequence to keep in mind for every future schema change: `operation_instance` growth is bounded by `bom_item_count × avg_route_length (~4.3)` under this hybrid model. Under a mistaken full-serial model it would instead be bounded by `Σ(qty per line) × avg_route_length` — up to 160× larger for high-quantity lines, for no traceability benefit pre-assembly.

### 2.2 Growth-driver table design

| Table | Design decision | Reason |
|---|---|---|
| `operation_instance` (projected largest) | Unique on `(bom_item_id, route_step_id)`; status as a Postgres enum, not a string; `department_id` denormalized onto the row | Enum keeps index selectivity high and avoids typo-class bugs. Denormalized `department_id` is a deliberate, documented exception so "my work today" queries skip a 3-way join through `route_step → canonical_operation → department` on the hottest read path in the system. |
| `qcp_checkpoint_instance` | Same hybrid split as §2.1: pre-assembly checkpoints instantiate per BOM-line, hold-point/post-assembly checkpoints instantiate per unit | Keeps the ~54-checkpoint template from multiplying by qty for high-count lines, while still giving per-serial hold-point traceability where it's contractually required. |
| `audit_log` | Monthly range partitioning on `created_at`, from the first migration | Partitioning changes the primary key shape (must include the partition key — `(id, created_at)` or similar). Adding this after data exists is a breaking change; deciding it now is free. |
| `test_record` | Index `(bom_item_id or unit_id, test_type, status)` designed now even though the table is 0% populated in the seed data | Retrofitting indexes on a table already receiving hundreds of writes/day is disruptive; doing it while empty is free. Don't treat "currently empty" as "low priority." |

### 2.3 Indexing strategy

- Composite index on every FK that's also a department/status/date filter predicate: e.g. `(department_id, status, planned_finish)` on `project_process_plan`, `(department_id, status)` on `operation_instance`.
- Partial indexes for the two hottest narrow queries: `WHERE status = 'OVERDUE' AND delay_reason_id IS NULL` (invariant #7's blocking check) and `WHERE code = 'H' AND cleared_at IS NULL` (invariant #4's hold-point check). Both stay cheap regardless of total table size because they index a small, frequently-hit subset.
- `audit_log`: `(actor_id, created_at)` and `(entity_type, entity_id, created_at)`, applied per-partition — audit lookups are almost always "this actor" or "this record's history," never a full scan.

### 2.4 Dashboards: incremental summary tables, not a TTL cache

TRD §10's "60s cache" mitigation caches the *symptom* (a slow aggregate query), not the *cause* (recomputing across a growing table on every request) — and a cache can serve a stale number to exactly the at-risk-job situation the MD/CEO dashboard exists to catch.

Replace with a small number of incrementally-maintained summary tables (`department_kpi_daily`, `company_dashboard_snapshot`):
- For anything gating-adjacent or SLA-bearing (overdue counts, OTD%): update via a same-transaction increment/decrement on the status-transition write path. Cheap, always correct, no batch job needed.
- For genuinely staleness-tolerant advisory widgets (trend lines): a scheduled recompute every few minutes is acceptable.

Live computation is still fine for anything scoped to one job/unit (a supervisor's "today" list, a single unit's stage board) — these stay small regardless of total system size and don't need pre-aggregation.

### 2.5 Connection pooling

The app is a long-running Node process on Railway, not serverless — the correct pattern is one shared Prisma client per process with a deliberately bounded pool (never a new client per request, which exhausts Postgres connections fast). Size the pool explicitly against Railway's actual `max_connections` for the chosen plan, with headroom for admin/migration access, and verify the fit before go-live rather than discovering it under a shift-start burst. If the app ever scales to multiple Railway instances, add PgBouncer (transaction-mode pooling) in front of Postgres rather than letting each instance hold its own large direct pool — a Step 14+ concern, not a Step 5 one, but the service layer should not assume session-level state (e.g. session-scoped advisory locks) that would break under a pooler.

---

## 3. Security Architecture

The baseline already specified in PRD/TRD/CLAUDE.md is genuinely solid and should not be diluted: TLS everywhere, deny-by-default RBAC (`JwtGuard → RolesGuard → DepartmentScopeGuard → service-level gating`), argon2id password hashing, httpOnly/Secure/SameSite cookies with JWT refresh rotation, rate-limited login, zod validation shared client+server, no client-supplied `actual_*`/`*_at` fields ever, and the DB-role-level (not just application-level) append-only guarantee on `audit_log`. What follows is hardening on top of that baseline for MNC-grade rigor, not a replacement for it.

- **Encryption at rest.** Not currently documented as verified. Confirm Railway managed Postgres's default explicitly and record the fact — a compliance-adjacent system carrying QCP/MTC/heat-number traceability that feeds client-facing MDRs will eventually be asked this by a client's TPI/quality team, and "we assume so" is not an acceptable answer at go-live.
- **Secrets management.** Beyond "never commit env vars": rotate the JWT signing secret and DB credentials on a schedule, invalidate old refresh tokens on rotation (a rotated secret must not leave a window where the old value still works), and keep staging and production secrets fully distinct — a staging compromise must never compromise production auth.
- **Race conditions in the gating/maker-checker invariants are the sharpest risk in this system, and they are a security control, not just a correctness bug.** A race here isn't a generic bug — per CLAUDE.md's own framing, it's a fabrication-integrity violation the product's credibility rests on. Full design and testing approach in §6; treated here as a security requirement: the three-gate check (predecessor DAG, roll-up completion, hold-point clearance) plus maker-checker (`actor != submitted_by`) must be evaluated and enforced inside a single transaction with row-level locking, and verified with adversarial concurrent-request tests, not just sequential ones.
- **Rate limiting beyond login.** Extend to all mutation endpoints, especially submit/verify given their integrity sensitivity — tuned to tolerate a legitimate shift-start retry burst from flaky shop-floor 4G (an explicitly real usage pattern here) without treating it as an attack, while still bounding retries against the three-gate transaction.
- **No client-supplied *derived* field is ever trusted** — a generalization of invariant #1, not a new rule: the server always independently re-verifies gating state from source tables, never trusts a client-asserted "predecessors satisfied" flag even if the client's own zod validation passed.
- **Dependency/supply-chain security.** Wire `pnpm audit` or Dependabot/Renovate into the CI pipeline (currently aspirational — see §4). Cheap now; becomes a real perimeter concern once the TPI/VIEWER portal (Phase 2) externalizes the app beyond DESPL's own network.
- **TPI/VIEWER-portal readiness (Phase 2, design the shape now, build nothing yet).** Today, RBAC only has to hold up against DESPL's own employees on DESPL's own network. When VIEWER lands, the threat model changes materially: it must be read-only enforced at the query level (not just hidden in the UI), rate-limited more aggressively than internal roles, use a separate session/cookie domain from internal auth, and be scoped to only the specific job(s)/client the TPI party is associated with — a TPI for Client A must never be able to enumerate Client B's jobs. **Design consequence for Step 8:** `DepartmentScopeGuard` should be shaped from the start as "scope by department OR by client-association," not hardcoded to department-only, so Phase 2 doesn't require re-architecting the guard layer.
- **Audit-log integrity needs an active monitoring counterpart**, not just the DB grant restriction. The "no UPDATE/DELETE" grant is exactly the kind of control that can quietly regress — a future migration, a "just this once" manual grant during an incident, an ORM tool resetting grants — without anyone noticing until an audit row is found altered. Add a scheduled and CI-gated check (`SELECT has_table_privilege(...)` or equivalent) that **fails the deploy pipeline**, not just logs a warning, if the grant ever reappears.

---

## 4. Reliability & Availability

- **Backup/DR needs actual numbers, not just "daily backups."** This is compliance-adjacent manufacturing data (QCP holds, MTC/heat-number traceability feeding client MDRs) — losing a shift's floor entries is a contractual risk, not an inconvenience. Target: **RPO ≤15 minutes** via continuous WAL archiving / point-in-time recovery (not just a daily `pg_dump`, which caps RPO at up to 24 hours) and **RTO ≤4 hours** during working hours. **This likely requires a higher Railway Postgres tier than the ~$10–25/month budget in PRD §9 assumes — a real cost tradeoff to confirm with the business before pilot go-live, not something to absorb silently.**
- **The restore drill already required before pilot (TRD/PRD) needs a pass/fail criterion**, not just "do a drill": restore to a fresh instance, replay the DE0467 regression scenario against it, confirm the numbers match.
- **Migration safety.** Forward-only + PR-reviewed (already the stated convention) is correct. Add: every migration touching a production-shaped table must be tested against a prod-sized staging dataset (a realistic multiple of the pilot's row counts, not the tiny seed fixtures) before promotion — index-adding and enum-changing migrations behave very differently at 500 rows vs. 50,000 (lock duration, table rewrite). Every migration PR should answer "what's the rollback plan" as a checklist item — "forward-only" means the rollback is itself a new forward migration, not that no rollback plan is needed.
- **Deployment strategy — the actual gap.** `IMPLEMENTATION-GUIDE.md` Step 14 stops at Railway staging. There is no production-promotion step, no security-review gate, no load-test gate anywhere in the current build plan despite this being the explicit target. See the new **Step 15** added to `IMPLEMENTATION-GUIDE.md` for the concrete checklist.
- **Load/concurrency testing is currently entirely absent from the build plan.** The system's actual peak load shape is not a smooth 100 concurrent users but ~100 users converging within a 15–30 minute shift-change window — this needs a real k6/Artillery script simulating N supervisors submitting + M QC users verifying concurrently on overlapping units, checking (a) p95 latency holds, (b) zero gating/maker-checker invariant violations under concurrency (doubles as the concurrency-correctness test in §6), (c) the connection pool doesn't exhaust. Belongs after Step 13 (dashboards, so realistic data volume exists), before Step 14/15.
- **Retry/backoff only where justified.** Given BullMQ/Redis is optional-if-load-demands-it (CLAUDE.md stack section), retry logic only earns its complexity for genuinely fire-and-forget background work — escalation payload generation, daily brief generation, notification sweep. **Do not** add retry/circuit-breaker logic to the synchronous submit/verify/gating request path — a silently-retried-and-succeeded gating check after a partial first-attempt failure is exactly the kind of ambiguity the "no offline writes, integrity > convenience" stance (TRD §13) exists to avoid. That path must fail fast and clearly instead.

---

## 5. Observability

**Build in from Step 8 onward, not bolted on later:**
- Structured logging (pino) with a correlation/request ID threaded through every request, and specifically through every gating decision and audit-log write — so "why was this stage blocked" is answerable by following one ID across the request log and the resulting audit row.
- Sentry (already named in TRD), wired at Step 8 alongside auth/RBAC, since that's when the first real error paths (401/403/gating refusals) exist to monitor.
- Postgres slow-query logging (`log_min_duration_statement`, e.g. 200ms) enabled at DB provisioning time, not added reactively after users complain. This is the mechanism that turns "the dashboard feels slow" into "here's the exact query and its plan," and directly targets §1's failure mode #1.
- The already-specified stable error codes (`GATING_BLOCKED`, `MAKER_CHECKER_VIOLATION`, `REASON_REQUIRED`, `HOLD_POINT_OPEN`, …) double as an observability signal: log the code + context on every refusal so "how often are supervisors hitting REASON_REQUIRED" becomes an answerable operational question.

**Can genuinely wait:** distributed tracing (one process; correlation IDs in logs cover the debugging need), dedicated APM/metrics dashboards beyond Sentry's built-in performance monitoring — adding a metrics stack before there's a demonstrated need is exactly the kind of premature infrastructure §7 argues against.

**Alerting tied to the specific failure modes in §1, not generic thresholds:** connection-pool saturation (a realistic first-week risk, not hypothetical), p95 latency specifically on the gating/submit/verify endpoints (a regression here is a business-invariant risk, not just UX), audit-log write failures (if the transaction rolls back per invariant #5 more than a handful of times, that's blocking legitimate mutations and worth paging on), and failed-login/rate-limit spikes (thresholds tuned post-pilot once real shift-start-burst patterns are observed, so legitimate bursts aren't mistaken for credential-stuffing).

---

## 6. Concurrency Correctness — The Gating Engine Under Real Shift Bursts

This is the one place in the whole design where the fix is **correct transaction design, not more infrastructure.**

**The concrete race scenario:** shift-start/shift-end is when ~100 users converge into a ~15–30 minute window, all touching a comparatively small working set of "active today" stages/units. Two supervisors in the same department — or a supervisor and a QC verifier, or a retried request from one user's own flaky 4G connection — can issue near-simultaneous requests against the *same* stage/unit row.

**Where it breaks without explicit locking:** if the three-gate check (predecessor DAG completion, component-operation roll-up, hold-point clearance) is implemented as "read current state, evaluate in application code, then write" — even nominally inside a transaction — Postgres's default `READ COMMITTED` isolation allows two concurrent transactions to both read the pre-transition state, both independently conclude the gates pass, and both write a "completed" transition (a classic check-then-act race). The maker-checker invariant is equally exposed: `actor != submitted_by` is a fine check against a single request, but doesn't by itself stop two concurrent "verify" requests from both evaluating against the same "not yet verified" state before either commits.

**The required pattern for every stage/unit state transition (submit, verify, complete, hold-clear):**
1. Take a row-level lock on the target row at the start of the transaction (`SELECT ... FOR UPDATE`) — a second concurrent transaction on the *same* row blocks until the first commits or rolls back. This alone eliminates the check-then-act race for the realistic shift-burst case (contention is on shared rows, not the whole table, so this doesn't create a global bottleneck).
2. Re-evaluate all three gates **after** acquiring the lock, never trust a pre-lock read.
3. Write the audit-log entry in the same transaction (already invariant #5) — lock-scoped correctness and audit atomicity become one guarantee, not two that could drift apart.
4. Default to `READ COMMITTED` + explicit row locking on the specific rows being mutated — cheap and sufficient for same-row contention. Reserve `SERIALIZABLE` only for genuine cross-row invariants (e.g. a roll-up check spanning multiple `component_operations` rows that no single row lock covers); don't default to it everywhere, or contention/retry overhead spreads across the whole burst window for no benefit on rows that aren't actually contended.

**Testing requirement — this is a required addition to the test scope already planned for Steps 7/8, not a separate later step:** table-driven concurrency tests that fire N simultaneous requests (`Promise.all` against a real test DB, not mocked) at the same stage/unit — two "submit" calls, a "submit" racing a "verify," or two roll-up-affecting operation completions racing a stage-completion check — and assert exactly one succeeds while the other receives a well-defined conflict/refusal, never a silent duplicate, a corrupted intermediate state, or a hang. The gating and maker-checker violation-case tests already planned for Steps 7/8 check *logical* correctness; this adds the *concurrent* dimension, which is a distinct failure class those step descriptions didn't originally call for.

---

## 7. Explicit Pushback — What NOT to Build at This Scale

"MNC-grade" here means *rigor* (security, auditability, data integrity, operational discipline) — not infrastructure footprint. At 100 concurrent users and low-single-digit-millions of rows over the system's lifetime, the following would add real failure surface and operational burden with no corresponding benefit:

- **No microservices.** The single-Next.js-app decision (BUILD-SPEC-v2 decision #5) is correct and should not be revisited under scale pressure. Splitting the gating engine, QCP engine, and dashboards into separate services would fragment the exact transactional boundary §6 depends on for correctness — those invariants are *easiest* to guarantee inside one process with one connection pool and real ACID transactions. Microservices would make the hardest correctness problem in this system harder, for zero throughput benefit at 100 users.
- **No Kubernetes.** Railway (or an equivalent single-region PaaS) is the right operational fit. A long-running Node process with a handful of instances behind managed load balancing meets 100-concurrent-user availability needs without the operational overhead a cluster brings for no benefit at this scale.
- **No event sourcing.** The append-only `audit_log` already gives full before/after history for every mutation — the actual requirement (traceability, compliance-adjacent record-keeping). Event sourcing would solve a problem this system doesn't have (deriving current state by replaying history) while complicating every read path.
- **No multi-region / cross-region failover.** Single company, India-based, no stated global-availability requirement, 99.5%-during-working-hours target (TRD §10). A single well-backed-up region with the RPO/RTO in §4 meets this; multi-region adds latency-routing complexity, data-residency questions, and cost with nothing pulling for it.
- **No Redis-as-cache for correctness-sensitive reads.** The dashboard problem (§1, §2.4) is better solved with incrementally-maintained summary tables than a cache with a TTL — a cache can serve a stale, gating-adjacent number to an MD/CEO dashboard during exactly the at-risk-job situation it exists to surface. Reach for Redis only for genuinely staleness-tolerant data, not as a blanket performance fix.
- **No premature read replicas.** A single well-indexed Postgres instance handles lakhs of rows and 100 concurrent users comfortably. A read replica adds replication-lag correctness questions (a supervisor who just submitted a stage must see it reflected immediately, not after lag) for a throughput problem this system doesn't have. Revisit only if a specific, *measured* bottleneck demonstrates the single instance is saturated — and even then, §2.4's summary tables are likely to resolve it first.

Every item above would be justified at 10,000+ concurrent users or genuinely massive write throughput. At this system's actual scale, the real risks are the ones in §1 and §6 — missing indexes, unbounded audit growth, N+1 roll-ups, connection pool sizing, and gating-engine race conditions — and every one is fixed by disciplined schema/index/transaction design inside the existing architecture, not by adding services.

---

## 8. Prioritized Roadmap — Tied to `IMPLEMENTATION-GUIDE.md` Steps

**Before Step 5 (Prisma schema)** — because these change table shape, and retrofitting after data exists is disruptive or breaking:
- Batch-vs-serial granularity locked as hybrid (§2.1), including the consumption/allocation join table.
- `audit_log` monthly partitioning scheme decided, composite PK including the partition key.
- Hot-path index plan (§2.3) written into the initial migration, not a follow-up one.
- `DepartmentScopeGuard` scoping shape designed as "department OR client-association" (§3) so Phase 2's VIEWER role doesn't require a redesign.
- `department_id` denormalization on `operation_instance` (§2.2) decided as a schema decision, not deferred to the service layer.

**Before Step 8 (auth/RBAC/audit)**:
- Row-level locking convention (§6) documented and applied in `StageService` *before* its violation-case tests are written — otherwise those tests validate logical correctness without validating concurrent correctness, which gives false confidence.
- Audit-log DB-grant verification check (§3) added in the same step the grant is first applied via migration.
- Secrets rotation policy and staging/production separation in place as soon as auth exists.
- Rate limiting extended from login-only to all mutation endpoints.

**Before Step 14/15 (production promotion — see the new Step 15 below)**:
- Summary tables for dashboards (§2.4) live before Step 13's output reaches production.
- Connection pool sized and verified against Railway's actual `max_connections` (§2.5).
- PITR-capable backup configured with a defined RPO/RTO and a completed, pass/fail restore drill (§4).
- Load/concurrency test suite (§4, §6) executed and passing against prod-sized data.
- Dependency/SCA scan wired into the CI pipeline (building the actual pipeline, currently only aspirational per CLAUDE.md, is itself a prerequisite here).
- Encryption-at-rest confirmed for the hosting provider (§3).
- GitHub Actions environment-protection rule requiring named-approver sign-off on production deploys.

**Can genuinely wait (post-pilot / Phase 2)**:
- BullMQ/Redis — only if a specific background job demonstrably needs retry/backoff semantics a transactional cron job can't give.
- Distributed tracing, dedicated metrics dashboards.
- Read replicas, sharding, multi-region.
- The TPI/VIEWER portal build-out itself (only its RBAC *scoping shape* needs deciding now, per §3).
- File/blob storage for MTCs, inspection reports, geo-tagged photos — schema already correctly keeps these as text refs; no infra needed until Phase 2.

---

## Open confirmations

Three points in this document were defaulted rather than confirmed with the business and should be revisited:

1. **Backup/DR budget tradeoff** (§4) — PITR (RPO ≤15min) likely costs more than the current Railway budget envelope assumes. Confirm before locking the hosting tier.
2. **Granularity** (§2.1) — hybrid batch-then-serial is recommended and matches BUILD-SPEC-v2's existing decision #2, but this is ultimately a domain question DESPL/SJ should confirm, in the same spirit as the C1–C12 open questions in BUILD-SPEC-v2 §7.
3. **This document's own scope** — it was written directly into the repo as the requested deliverable; if that wasn't the intended workflow, treat it as a draft for review rather than a locked spec.
