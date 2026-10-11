# 21 — DESPL MOS Maturity Scorecard & Next Actions

**As of:** 2026-08-31, branch `demo`, HEAD `28d7f2f`. Scores are this blueprint's own judgment, derived from direct code inspection plus the forensic audit — not self-reported by the team.

## 1. Scoring scale

| Score | Means |
|---|---|
| 0–2 | Absent, or schema/scaffold only — nobody can use it |
| 3–4 | Exists but materially incomplete — not usable end-to-end |
| 5–6 | Works for the pilot case; breaks or blanks out for the general case |
| 7–8 | Production-quality with named, bounded gaps |
| 9–10 | Exemplary — nothing material outstanding |

**Two denominators matter, and conflating them is how this system gets misjudged in both directions:**

| Judged as… | Overall score |
|---|---|
| A production tracker for pressure vessels | **8.1 / 10** — genuinely strong, near-complete |
| A company-wide, multi-family MOS | **5.4 / 10** — the hard half is done, the *company-wide* half is not |

---

## 2. Field-by-field scores

### Platform & data foundation

| Field | Now | Target | Gap | Effort to close |
|---|---|---|---|---|
| Audit trail (append-only, DB-grant-enforced) | **9** | 9 | — | Done |
| Domain model depth & normalization | **8** | 9 | Numeric-code join needs an FK | M |
| Maintainability (service boundary, error codes) | **8** | 9 | — | — |
| RBAC / authentication / session | **8** | 9 | Enforcement scattered by convention, not structural | S |
| Reliability (transactions, per-row failure, locking) | **7** | 8 | — | — |
| Data architecture overall | **7** | 9 | Job-level isolation has no DB backstop | M |
| Tenant isolation (RLS) | **6** | 9 | Covers under half the schema by table count | M |
| Testing | **6** | 8 | Cross-tenant suite is 4 hand-picked functions | S–M |
| Security hardening (CSP/HSTS/rate limiting) | **4** | 8 | No security headers at all | S |
| Scalability (N+1, pagination) | **4** | 7 | 9+ list services with zero pagination | M |
| Job-level data isolation | **3** | 8 | App discipline only, no schema/RLS enforcement | M |
| Observability | **1** | 7 | Zero logging/tracing/error-tracking | S |

### Operational framework

| Field | Now | Target | Gap | Effort to close |
|---|---|---|---|---|
| Cross-department dependency engine | **9** | 9 | — | Done — the system's crown jewel |
| Workflow / gating engine | **9** | 9 | — | Done |
| Scheduling (CPM, envelope-verified) | **8** | 9 | Not capacity-aware | M |
| Process templates & versioning | **8** | 9 | — | — |
| Product-family abstraction | **6** | 9 | Mechanism real; **bootstrap needs a developer** | **L** |
| Route templates | **5** | 9 | Zero authoring path — seed script only | **L** |
| Alerts / notifications | **5** | 8 | Delay + NCR trigger nothing; overdue scan is lazy | S |
| Delay propagation | **4** | 8 | Real engine, no automatic trigger | S–M |
| KPI architecture | **4** | 8 | Same calculation duplicated 4× , no registry | S–M |
| Operating rhythm (scheduled jobs) | **2** | 8 | No cron/queue exists anywhere | S–M |

### Departments & execution

| Field | Now | Target | Gap | Effort to close |
|---|---|---|---|---|
| Production tracking | **9** | 9 | — | Done — strongest area |
| QC / NCR / rework | **8** | 9 | W-waiver gate is schema-only | S |
| Job intake / projects | **8** | 9 | — | — |
| BOM ingestion (Excel) | **7** | 9 | No dedup, first-sheet-only, free-text UoM | S |
| Material / stores | **6** | 8 | No required-by date, no allocation model | M |
| Engineering | **6** | 8 | No file storage, no drawing deadline | M (blocked on docs) |
| Painting / finishing | **6** | 8 | DFT self-attested, string-keyed rule | S |
| Procurement | **3** | 8 | No vendor, no PO model, no due date | M |
| Dispatch | **3** | 8 | Service layer real, **zero UI**, inactive on pilot job | M |
| Documentation / MDR | **1** | 7 | No dedicated model at all | M |
| Document / file storage | **0** | 8 | Does not exist anywhere in the app | **M–L** |

### Management & experience

| Field | Now | Target | Gap | Effort to close |
|---|---|---|---|---|
| Project/job dashboard | **8** | 9 | — | — |
| Department dashboard | **8** | 9 | — | — |
| Company/portfolio dashboard | **7** | 9 | No due-this-week, no blocked-projects bucket | S |
| Shop-floor UX | **6** | 8 | 4 open cross-device P0s from a prior audit | S–M |
| Frontend information architecture | **6** | 8 | 2 stub pages, DESPL-320 landing fallback | S |
| Admin / self-serve configuration | **4** | 9 | Cannot create family, route, or first QCP | **L** |
| Equipment-grain view | **0** | 7 | No such view exists | S |

### Delivery process

| Field | Now | Target | Gap | Effort to close |
|---|---|---|---|---|
| Documentation accuracy | **6** | 9 | 2 stale claims contradict the code | **XS** |
| Deploy pipeline / branch hygiene | **3** | 8 | `demo` 77 commits ahead of `main`; no staging env | XS to verify, S to fix |

**Effort key:** XS = hours · S = 1–3 days · M = 1–2 weeks · L = 2–4 weeks (single developer).

---

## 3. How much is left

Counting the remaining items above: **2 XS, 13 S, 12 M, 3 L** ≈ **12–16 focused engineering weeks** for one developer to close every P0–P2 item and land a second product family. Two developers working in parallel on non-overlapping tracks (UI/admin vs. platform/data) compresses this to roughly **6–9 weeks**.

Framed differently: **the system is ~85% of an excellent single-family production tracker and ~45% of a company-wide MOS.** The remaining 55% is not evenly distributed — roughly half of it is concentrated in three items (family bootstrap UI, document storage, scheduled operating rhythm).

---

## 4. What to do next — in order

### This week (hours, not days)
1. **Verify which branch Railway actually deploys.** Everything else is guesswork until this is known. If it is still `main`, the last two weeks of work is not live.
2. **Fix the two stale documentation claims** — CLAUDE.md invariant #2 (says material gating "is not implemented"; it is, at component grain) and PHASE-PROMPTS.md §0 (claims the `workspace/page.tsx` DESPL-320 literal was removed in Phase 0; it was not). Standing rules built on false premises quietly erode the discipline that makes them valuable.

### Next 1–2 weeks
3. **Close the four literal couplings** — `workspace/page.tsx` pilot fallback, `admin.read.ts:63` PRESSURE_VESSEL literal, `welding.service.ts:24` FABRICATION literal, and `stage-names.ts`'s 25-stage table (derive from the job's own `TemplateProcess` rows instead). After this, grep for those literals in `src/` returns nothing.
4. **Add the security headers block** and general rate limiting — one afternoon, closes a whole risk category.

### Next 4–8 weeks — the two that actually decide whether this is a MOS
5. **Family / route / QCP self-serve bootstrap UI.** This is *the* gate. Until an engineer can author a new family's template, route, and first QCP as data, the platform cannot prove the claim its own ADR makes.
6. **Document / file storage.** A QC-heavy manufacturing system that cannot hold a certificate, drawing, or photo will hit this wall the moment anyone relies on it for compliance.

### Then
7. Scheduler (unblocks digest delivery, alert reconciliation, future KPI snapshots — one piece of infrastructure, three gaps closed).
8. Job-level RLS backstop + widen the cross-tenant test sweep.
9. Observability, then the named scalability fixes.
10. **Pipe Spool as the second family** — the real proof that step 5 worked.

---

## 5. The one decision that changes this order

**If a management demo is imminent**, reorder: ship the Phase-5 dispatch/NCR/paint UI and fix the Stage Spine first — they are what a viewer *sees*, and dispatch currently has no UI at all despite the logic being built and tested.

**If the goal is proving the MOS thesis**, keep the order above — bootstrap UI first, and treat any friction found while onboarding Pipe Spool as a first-class architectural finding, not a bug to quietly patch.

These are genuinely different two-month plans. Picking one deliberately beats drifting between them.
