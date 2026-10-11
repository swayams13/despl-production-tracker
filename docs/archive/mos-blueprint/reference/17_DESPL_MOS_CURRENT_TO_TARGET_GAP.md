# 17 — DESPL MOS Current → Target Gap Matrix

## 1. Gap matrix

| Domain | Current State | Target State | Gap | Severity | Recommended Action |
|---|---|---|---|---|---|
| Branch/deploy state | `demo` is 77 commits ahead of `main`; `railway.json`/CLAUDE.md say production auto-deploys from `main` (verified: `git rev-list --left-right --count main...demo` → `0 77`) | Deploy state matches what's described as "built" | Unknown whether the last two weeks of work (Phases 0–5) are actually live | **P0** | Verify Railway's current deploy branch and reconcile immediately — this is a decision-blocking prerequisite, not engineering work |
| Product family bootstrap | `ProductFamily`/`RouteTemplate`/first `QcpTemplate` creatable only via `prisma/seed.ts` | Self-serve admin UI for all three | The actual MOS gate (`06`) | **P1** | Build family/route/QCP bootstrap UI |
| Document/file storage | None — exhaustive search found zero blob-storage client | S3-compatible object store, `Document` model (`12`) | Total | **P1** | Add object storage + `Document` model, wire to Engineering/QC/MTC |
| Job-level isolation | App-discipline only, no RLS/schema backstop (44 of 71 models reach tenant via FK chain) | Job-scoped RLS/view backstop | Real, unverified-by-automation-beyond-4-functions | **P2** | Add job-level RLS policy; widen cross-tenant test sweep |
| Scheduled operating rhythm | Daily digest = manual button; alerts = lazy page-load scan | Cron-driven digest delivery + alert reconciliation | No cron/queue infra exists at all | **P1/P2** | Add lightweight scheduler (BullMQ/Redis per CLAUDE.md's own named fallback) |
| Delay propagation | Manual `applyDurationOverride` only; `fileDelayReason` has zero scheduling imports | Auto-suggested reschedule with human confirmation | Real engine, no auto-trigger | **P3** | Wire delay-filing to a reschedule-preview + one-click apply |
| Dispatch UI | Zero UI, service layer real (Phase 5), inactive on pilot job | Full dispatch UI, DESPL-320 (or next job) re-pinned to gate on it | UI-only gap, but blocks end-to-end proof | **P3** | Ship Phase 5 dispatch/NCR/paint UI |
| Literal family/job/dept couplings | 4 found: `workspace/page.tsx` (DESPL-320 fallback), `admin.read.ts:63` (PRESSURE_VESSEL literal), `stage-names.ts` (25-stage table), `welding.service.ts` (FABRICATION literal) | Zero literals in `src/` outside seed/test fixtures (the codebase's own standing rule) | Narrow, call-site-level | **P0/P1** | Close all four — see `20` decision D1 |
| Security headers / rate limiting | Login/password-change only; no CSP/HSTS/X-Frame-Options | Full header set + general rate limiting | Real, bounded | **P2** | Add `headers()` block to `next.config.ts`; extend rate limiter |
| KPI framework | 4x-duplicated calculation logic, no registry | One shared function per metric shape | Correctness-neutral, maintainability gap | **P3** | Consolidate into shared KPI functions |
| Witness (W) waiver gate | `waiverApprovedBy` schema column never written | Real approval action + `blocksCompletion` check | Schema-ready, not wired | **P1** | Wire waiver approval into QC service |
| Procurement vendor/PO/due-date | No vendor field, no PO model, no due date anywhere | Lightweight `PurchaseOrder`/vendor model | Real | **P2** | Add vendor + expected-delivery-date fields |
| Observability | Zero structured logging, no error tracker, no APM; only a `/api/health` liveness probe | Structured logs + error tracking (Sentry-equivalent) | Total, beyond health check | **P2** | Add before scaling past pilot |
| Scalability (N+1, pagination) | Real N+1 in job-list read path; 9+ list-shaped services with zero pagination | Batched reads, `take`/`skip` on list queries | Bounded, self-admitted "hundreds not thousands" ceiling | **P2/P3** | Fix the named N+1; add pagination to the 9 identified services |
| Fabrication/assembly/spine join | Numeric-string equality (`leadTimeProcessSeq == Number(jobProcess.code)`), no FK | Real FK or DB-enforced invariant | Single point of silent-break risk on renumbering | **P1** | Add FK or CHECK-backed invariant + migration/backfill |
| Equipment-level dashboard | None — equipment only a filter dimension | Dedicated equipment-grain view | Real, narrow | **P3** | Add equipment dashboard reusing existing per-job KPI queries |
| Portfolio due-this-week/month, blocked-projects bucket | Not computable at portfolio grain today | Portfolio-grain rollup | Additive query work | **P3** | Add to `portfolio.read.ts` |
| Dept dashboard-tier routing | Hardcoded `OFFICE_DEPT_CODES` array | `Department.dashboardTier` field | Narrow | **P2** | Migration + read-path change |
| DFT acceptance range | Self-attested, no spec'd range | Validated against a spec'd micron range | Real, narrow | **P3** | Add range field + validation |
| BOM dedup/multi-sheet/UoM | Missing on all three | Dedup check, sheet selector, UoM canonicalization table | Real, bounded | **P2** | Additive to existing import pipeline |
| CLAUDE.md invariant #2 drift | Text says material gating "not implemented"; code implements it at component grain | Text matches code | Documentation-only | **P0** | One-line correction |

## 2. Severity legend

- **P0 — Architectural blocker.** Must be resolved before further feature development is trustworthy.
- **P1 — Core MOS capability.** Required for meaningful MOS operation (the family-bootstrap gate, document storage, the numeric-join risk, the waiver gate).
- **P2 — Important operational capability.** Needed for production maturity at scale.
- **P3 — Enhancement.** Quality-of-life and correctness, not a blocker.

## 3. Preserve / Refactor / Extend / Rebuild classification

| Subsystem | Classification | Why |
|---|---|---|
| Service-layer/thin-Server-Action boundary | **PRESERVE** | Zero direct Prisma calls in Server Actions, verified across every file sampled |
| `withTenant` transaction+RLS pattern | **PRESERVE** | Transactionality and tenant isolation are structurally the same code path |
| Versioned-template-with-immutable-publish design | **PRESERVE** | Correctly implements invariant #9, verified real |
| CPM scheduling engine | **PRESERVE** | Verified to reproduce the printed 119-day envelope exactly at all 36 processes |
| Maker-checker / hold-point gating | **PRESERVE** | No admin bypass, verified directly |
| Append-only audit trail | **PRESERVE** | DB-grant-enforced, not just convention |
| Reference-table-not-enum pattern | **PRESERVE** | Correctly applied with no exception found across 71 models |
| Dept dashboard-tier routing (hardcoded array) | **REFACTOR** | Correct concept (data-driven departments), wrong implementation (hardcoded array) |
| Family/dept literal couplings (4 call sites) | **REFACTOR** | Narrow, call-site-level fixes |
| KPI calculation (4x duplicated) | **REFACTOR** | Correct numbers, wrong organization |
| Fabrication/assembly/spine numeric join | **REFACTOR** | Add FK/invariant, don't redesign the three-track model |
| Procurement (vendor/PO/due-date) | **EXTEND** | Good foundation (event ledger), missing fields |
| Document/file storage | **EXTEND** (schema/metadata layer already correct) + **new object-store integration** | Metadata discipline exists; the file layer does not |
| Alert/notification triggers | **EXTEND** | Real model, two missing trigger call sites |
| Family/route/QCP bootstrap | **EXTEND** (new UI on top of a real, already-correct mechanism) | The mechanism works; the on-ramp doesn't exist |
| Observability | **EXTEND** (new capability, additive) | Nothing to refactor — it doesn't exist yet |
| — | **REBUILD** | **Nothing found in this audit rises to "incremental fixes are unlikely to work."** Even the weakest areas (procurement, observability, document storage, delay propagation) are additive gaps on a sound structure. |

**Being conservative with REBUILD, as instructed:** this blueprint classifies zero subsystems as REBUILD. The one candidate for genuine redesign (the fabrication/assembly/spine join) is "add a real FK and a migration to backfill it" — a refactor, not a rebuild.

---
*Sources: consolidated from `01`–`16`, `docs/DESPL_MOS_FORENSIC_AUDIT.md` §41–§47, verified git state (`git rev-list --left-right --count main...demo`).*
