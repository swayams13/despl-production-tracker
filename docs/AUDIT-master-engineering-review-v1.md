# AUDIT — Master engineering & product review v1

**Date:** 25 Aug 2026 · **Commit:** `4f07ac1` · **Scope:** whole repository — code, schema, product, docs
**Method:** read-only. Every finding carries file:line evidence. No code was modified.
**Full narrative report (25 sections):** https://claude.ai/code/artifact/54e94413-4d54-45e3-8282-2cf5447e567f

> This audit was commissioned on the premise that the app "feels like a rookie dashboard."
> That premise is half wrong. Read §1 before acting on anything else.

---

## 1. Executive verdict

**The integrity core is genuinely senior-level and must not be rewritten.** Transactional gating
behind `SELECT … FOR UPDATE` with a tenant-anchored re-read; maker–checker with no admin exemption;
append-only audit made structural (`audited()` in the caller's tx + DB `REVOKE` + boot guard that
crashes the server on a wrong role); fail-closed RLS; optimistic locking with the correct
lock-before-staleness-read ordering; a CPM engine that reproduces DESPL's printed 119-day envelope
exactly at all 36 processes, tested against the real seed file.

**The "rookie" feeling is real and has four causes, none of which is code quality:**

| # | Cause | Evidence |
|---|---|---|
| V1 | **It models the schedule and the signature, not the material and the parts.** No quantity arithmetic exists anywhere. `BomItem.qty` is a `String` read in 4 places, the last being a `<dd>`. `ComponentOperation` has no qty column. No stock, GRN, issue, shortage, scrap, yield, NCR, rework, work centre, capacity, or cost field in 1,497 schema lines. | `schema.prisma:877`, `bom-panel.tsx:213`, `schema.prisma:1023` |
| V2 | **The part-level and job-level worlds are disconnected.** Component ops roll up into nothing; `submitProcess` has no component check; `v_unit_stage_status` never touches `components`. `leadTimeProcessSeq` — the only link — resolves tooltips. All 99 DESPL-320 components can reach COMPLETE without the spine moving. | `component.service.ts`, `process.service.ts:152`, `bom.read.ts:139` |
| V3 | **No job exercises the full data chain.** DESPL-320 = 9 units, 0 BOM items. DE0467 = full BOM, 0 units. Welder registry empty **and has no write path**. `Procurement` has zero writes in `src/`. `DispatchBatch` and `WeldLog` are dead models. | `scripts/seed-despl320-*.ts` |
| V4 | **Visible credibility seams.** `/workspace` hardcoded to `jobNumber: "DESPL-320"`. ⌘K button toasts *"wires up in a later session"*. 3 of 4 mobile nav destinations are "coming in R2" stubs. | `workspace/page.tsx:8-13`, `app-shell.tsx:436`, `app-shell.tsx:120-125` |

**Diagnosis:** this is a *production schedule and accountability system* of unusually high integrity,
mistaken for a *production execution system*. The gap between them is exactly the material,
quantity and traceability layer.

**Decision: keep the spine, redesign the material half.** ~6 new tables, 2 column-type changes,
2 constraint changes — mostly additive. **Do not rebuild.**

---

## 2. Maturity

**Product maturity: 41/100.** Classification: **Internal MVP** (production-grade in design, not
production-*operable*).

| Category | /10 | One-line evidence |
|---|---:|---|
| Architecture | 7 | Service boundary genuinely enforced; no caching, no pagination |
| Backend | 7 | Compile-checked error taxonomy, correct locking; 3 cross-tenant write holes |
| Frontend | 5 | Zero `any` in 8,499 LOC; ~33 bespoke tables, no form layer, no error boundaries |
| Database | 6 | Excellent craft on what it models; material half absent; 35/56 tables un-RLS'd |
| UX | 5 | Real work surfaces; 34 keyboard-unreachable rows, no search, dead mobile |
| UI design | 6 | Coherent token system; broken `CountUp`, 2 disclosed AA failures |
| Manufacturing workflow | 3 | Spine correct; no material issue, release, rework, packing, dispatch |
| BOM | 2 | Flat, no `parentId`; "tree" is `GROUP BY componentType.name` |
| Production tracking | 4 | Tracks task states, never part counts |
| QC | 7 | Best subsystem; no NCR/disposition/rework |
| Security | 5 | 100% auth coverage, zero SQLi; no login throttle, 3 cross-tenant writes |
| Testing | 6 | 436 cases, real fixtures; Playwright never runs in CI |
| Performance | 3 | 2N transactions/page load, zero caching, zero pagination |
| Reliability | 2 | 3 `console.error` calls total; no health route, no backups |
| Maintainability | 6 | Best comment quality I've seen at this age; 5 copies of the hold-point rule |
| Scalability | 4 | Half-built tenancy, no pagination, infinite-capacity scheduling |
| Documentation | 5 | High volume, low accuracy; `CLAUDE.md` stale in 7 places |

---

## 3. Critical findings (fix before anything else)

### C1 — Re-scheduling silently destroys all in-flight actuals
`persistScheduleRun` writes `status: "NOT_STARTED"` unconditionally and carries forward **no**
`actualStart` / `actualFinish` / `submittedBy` / `verifiedBy`. The old run is flipped
`isCurrent: false` and every read filters `isCurrent = true`, so the actuals become orphaned and
unreachable. Triggered by the **"Set dispatch date…"** button → `updateJobDatesAction` →
auto-`scheduleNewJobAction`. On DESPL-320 mid-build: 324 plans reset to grey, every completion
signature detached, every department KPI zeroed. The audit row records only
`{version, mode, planCount}`.

Aggravator: `process.service.ts` never checks `scheduleRun.isCurrent`, so a stale tab can still
Start/Submit/Verify against a superseded run — writes that pass gating and are invisible everywhere.

Untested: the only reschedule test runs on a job with no units and no actuals.

*`_shared.ts:194-221` · `actions/job-intake.ts:98-100` · `process.service.ts:98,120,163`*

### C2 — A duration override permanently corrupts the min-envelope, disabling the feasibility demo
`applyDurationOverride` restamps `envelope*MinDays` from a min-space CPM. The lags were fitted
against **max** durations only. In min space, terminal P36 = **36 days instead of 119**; 31 of 36
processes diverge. After one override on any process, `checkFeasibility` reads
`requiredMinDays ≈ 36`, so **INFEASIBLE becomes unreachable** — and DE0467's "infeasible, 22 days
short" is described in BUILD-SPEC as *"the single best demo of the tracker's value."*
The test verifies max-space only, so the corruption is invisible.

*`override.service.ts:92-98, 128-150` · `override.service.test.ts:140-145`*

### C3 — Three cross-tenant write holes on RLS-free tables
- `recordQcpExecution` takes `qcpItemId`/`unitId` raw with no ownership check. Neither
  `qcp_items`, `units` nor `qcp_executions` carry `tenant_id`, so RLS does not apply. A QC user can
  post `ACCEPTED` against another tenant's unit and **clear their blocking hold point** — invariant
  #4 defeated, with a valid audit row. (`qcp.service.ts:25-44`)
- `recordMtc` has the same hole behind a guard that only looks like one: `assertClientScope`
  returns immediately when `actor.clientId === null`, which is every internal user.
  (`mtc.service.ts:24-29` · `authz/index.ts:124-128`)
- `nudgeQc` imports **no** authz functions and writes **no** audit row — a `CLIENT_VIEWER` can
  create notifications untraceably. (`notifications.service.ts:236`)

The codebase already knows the pattern (`_shared.ts:264-268` explains it). These three didn't follow it.

### C4 — No login rate limiting, and failed logins are audited nowhere
The pattern exists (`change-password.ts:44-59` counts failed-attempt audit rows in a 15-min window)
and was never applied to the internet-facing action. Seed accounts use predictable identifiers and
a committed demo password (`prisma/seed.ts:1348`). Brute force is unthrottled **and leaves no trace
at all.** `TRD.md:214` lists this as a requirement. (`actions/auth.ts:14-64`)

### C5 — No observability, no backups, no rollback
Three `console.error` calls in the entire application. No structured logging, no error tracking, no
request ids. Every `AppError` refusal — including the violations the demo script deliberately
triggers — is logged nowhere. `/api/health` is whitelisted in `middleware.ts:14` and **does not
exist**. Zero `error.tsx`/`global-error.tsx`/`not-found.tsx`. No backup, no PITR, no restore drill,
despite `ARCHITECTURE.md:169` making a passing drill a go-live gate. `prisma migrate deploy` runs at
container boot using `directUrl` = the **table owner**, putting a role that bypasses RLS *and* the
audit REVOKE into the runtime environment.

---

## 4. High-severity findings

| ID | Finding | Evidence |
|---|---|---|
| H1 | **"Overdue" fires a full working day early; every on-time finish scores as late.** `plannedFinish` is midnight UTC = 05:30 IST on the due date; 8 sites compare it to `now()` as a raw timestamp. The on-time KPI does `actualFinish <= plannedFinish`, so a process verified at 10:00 IST *on its due date* counts late. Every dept OTD % is a day pessimistic. `job-health.ts:62-66` gets it right and says so, then consumes the wrong value 4 lines later. | 8 call sites; no IST-business-day primitive exists |
| H2 | **Read-path CPM is unguarded.** A job created with an excluded provisional process schedules fine then 500s every read. `myday.read.ts:179` and `command-center.read.ts:225` call `computeCpm` inside a job loop — one bad job takes down My Day for the whole tenant. | `envelope.ts:64` vs `exclude.ts:41-46` |
| H3 | **Client users can read internal APIs directly.** The schema says client users see *"snapshots only — never live tables."* `assertClientScope` checks *which client*, not *which surface*. A client user can `curl` `/api/jobs/:id/stage` and get planned-vs-actual variance, **internal delay-reason history**, submitter identities, and the raw domain-event stream. | `stage-detail.read.ts:100-103`, `spine.read.ts:30-33`, `events.read.ts:48-52` |
| H4 | **`loadWeldJointOptions` has no tenant or client scope**, exposed at `GET /api/welding/joints?job=N`. Any authenticated user, including a client user, enumerates every weld joint, WPS ref and unit serial in the DB. | `welding.read.ts:216-220` |
| H5 | **`rls-coverage.test.ts` cannot detect the actual risk** — it asserts tables that *have* `tenant_id` have RLS. Tables with none (which is how `process_plans`, `qcp_executions`, `weld_joints` are shaped) pass trivially. C3 and H4 pass every existing test. | `rls-coverage.test.ts:11-45` |
| H6 | **Performance.** `loadJobs` opens 2N transactions per call and backs both `GET /api/jobs` and the app-shell job switcher. `syncNotifications` full-scans on every authenticated page load. `domain_events` joined via `de.aggregate_id::int` — a functional cast defeating every index, twice per job-list load. Zero `skip`/`cursor`/`unstable_cache`/`React.cache` anywhere. | `jobs.read.ts:139-145`, `:85-102`; `notifications.service.ts:138-146` |
| H7 | **`applyDurationOverride` is dead code one wire-up from bricking a job.** Writes `unitId: null` plans that become `isCurrent`, superseding the per-unit run; every per-unit plan then has a stale `scheduleRunId`, predecessor lookup finds nothing and defaults to `NOT_STARTED` — gating fails closed everywhere, silently, for the whole job. Its own comment names the trap. | `override.service.ts:173-177` |
| H8 | **Snapshot verify/reject records a falsehood.** Concurrent verify + reject: the second's `updateMany` matches 0 rows, but the code still writes the audit row, emits the domain event and notifies the publisher. The append-only trail records a rejection that never happened. Fix: check `count`. | `client-snapshot.service.ts:155-235` |

---

## 5. Domain verdicts (MES perspective)

| Area | Verdict | Note |
|---|---|---|
| 36-process spine / 25-stage crosswalk | **ADEQUATE** | Correct backbone. Missing: release-to-shop, material issue, rework loop, subcontract out/return |
| BOM hierarchy | **REDESIGN** | Flat list; no `parentId` on `BomItem` or `Component`; tree is `GROUP BY componentType.name` |
| Quantities | **REDESIGN** | One `String` field, read by one `<dd>`. Produced/accepted/rejected/rework/scrap/shortage all unrepresentable |
| Materials / inventory | **ABSENT** | No stock/GRN/issue/allocation. `Procurement` is one mutable row; `PARTIALLY_RECEIVED` carries no number |
| Work order / operation | **REDESIGN** | `ProcessPlan` is a Gantt cell + signature. No qty, work centre, operator, setup/run time, labour |
| Work centre / capacity | **ABSENT** | CPM is infinite-capacity by construction |
| QC execution | **ADEQUATE** | Genuinely good — dynamic parties, `attemptNo`, fail-closed hold points |
| NCR / rework / disposition | **ABSENT** | A rejection produces a red pip and an age counter. TRD §3.4 specified `rework_items`; never built |
| Traceability (heat → serial) | **REDESIGN** | `MaterialIdentification` at BOM grain = one level above the serial. For DE0463 that is one plate line covering **40 vessels**. `WeldJoint` has no `componentId` |
| Paint / surface | **EXTEND** | Stage exists; no coating system, coats or DFT readings |
| Packing / dispatch | **ABSENT** | `DispatchBatch` has no unit link, no actual date, zero readers, zero writers |
| Drawings | **REDESIGN** | Dead table; revision mutated in place (destroys Rev A); `RELEASED` gates nothing |
| Component ↔ job dependency | **REDESIGN** | Two disconnected worlds. This is the crux |
| Grain coherence | **REDESIGN** | `BomItem` above `Unit`, `Component.unitId` below it; `bom.read.ts:209` missing `unitId` filter renders all 99 parts of all 9 serials as one list; `Component.@@unique([equipmentId, tag])` forces mangled tags |

**Also entirely absent:** routing alternates, scrap, yield, WIP-as-inventory, batch/lot, real
subcontracting (`Sourcing` is written by seed and read by nothing), tooling, consumables, labour
beyond welder day-totals, and **cost — not one currency/rate/price field in 1,497 schema lines.**

**A documented invariant is factually false:** `CLAUDE.md` #2 and `errors.ts:12` both claim gating
on "material deps satisfied." `startProcess` runs three gates and no fourth. `Procurement`,
`MaterialReceivedStatus`, `MaterialIdentification` and `BomItem` are read by zero services outside
`bom.read.ts` and `mtc.service.ts`. TRD §3.5's `stage_material_deps` was never built. **Correct the
doc before someone demos it.**

---

## 6. Docs vs code conflicts

`CLAUDE.md` — read first by every contributor — is stale in seven places:

| Doc claims | Code reality |
|---|---|
| `/api/v1` route handlers (5 docs) | Zero exist. 6 handlers, all GET, all reads. Every mutation is a Server Action |
| `packages/shared` is the validation source of truth | No `packages/` dir. It's `src/lib/shared/` |
| NestJS module-per-domain conventions | No NestJS, no controllers (superseded by BUILD-SPEC #5, but TRD.md carries no banner) |
| i18n string table `packages/shared/strings` | No strings module anywhere; every label is a TSX literal |
| TanStack Query v5 for caching + optimistic updates | Dependency with **zero imports**. No `QueryClientProvider` |
| Staging auto-deploys, production is manual promote | One environment, named `production`, auto-deploying from `main` |
| `pnpm db:migrate`, `pnpm dev` on ports 3000+4000 | No such script; one port |
| PWA, installable, offline | No `public/`, no manifest, no service worker |
| "Every page ships loading/error/empty states" | 3 `loading.tsx` for 24 routes; **zero** `error.tsx` |
| "No dead controls, never a 'coming soon' toast" | `app-shell.tsx:436` is exactly that, in the permanent top bar |
| "No mock data inside components" | `_demo.ts` → `/kit`; `/component-gallery` prints "sample data, not live" into the UI |
| ADR D22: 30-day rolling session | `session.ts:5` — 12 hours |

Also: all four `docs/superpowers/specs/*` still read *"approved design, not yet implemented"* for
work that shipped. `README.md` is untouched `create-next-app` boilerplate. `progress.md` has two
single physical lines of ~12,000 words each — not readable by a human or a tool.

---

## 7. Keep / refactor / redesign / delete

**KEEP** — auth/session/RBAC/authz · audit + domain events · process state machine + gating ·
QCP/ITP engine · template versioning · envelope + calendar + feasibility · the CSS design language.

**REFACTOR** — `persistScheduleRun` (carry actuals) · CPM + override service (stop the min restamp,
honour SS, deterministic terminal) · the 21 read models (extract shared invariant primitives, add
pagination + caching) · frontend component layer (`<DataTable>`, `<Form>`, one `statusView()`,
error boundaries).

**REDESIGN** — BOM model · material/procurement · work order/operation · traceability grain ·
drawings.

**DELETE** — `DispatchBatch`, `WeldLog`, `/kit`, `/component-gallery`, `_demo.ts`,
`components/ui/button.tsx`, the ⌘K button, and 5 dead dependencies (`@tanstack/react-query`,
`lucide-react`, `@base-ui/react`, `class-variance-authority`, the `shadcn` CLI under
`dependencies`). Also `xlsx@0.18.5` is the terminal npm release with unpatched advisories.

**REBUILD: nothing.** No subsystem here is too flawed to salvage.

---

## 8. Top 10 immediate actions

| # | Action | Why now | Size |
|---:|---|---|---:|
| 1 | Carry actuals forward in `persistScheduleRun`; add `isCurrent` guard to `process.service.ts`; regression-test on a job **with** actuals | Silent data loss behind a one-click button | 1 d |
| 2 | Negative cross-tenant test over every child table, then close the 3 holes it finds | Kills the class, not 3 instances | 1 d |
| 3 | Login rate limiting + failed-login audit rows (reuse the `changeOwnPassword` pattern) | Unthrottled and untraceable | ½ d |
| 4 | Structured logging w/ request id, error tracking, real `/api/health`, `error.tsx` per route group | You cannot currently see a failure after it happens | 2 d |
| 5 | PITR on + one restore drill; move `migrate deploy` out of boot; drop `DIRECT_URL` from runtime | Compliance-adjacent data with no backup and owner creds in the app tier | 1 d |
| 6 | Delete the ⌘K toast, `/kit`, `/component-gallery`, `_demo.ts`, dead models/deps; parameterise `/workspace` by job | Highest credibility-per-hour; unlocks every dashboard cross-filter link | 1 d |
| 7 | One IST-business-day helper; route all overdue + on-time comparisons through it | Every dept's OTD % is a day pessimistic — the first number SJ will dispute | 1 d |
| 8 | Stop the min-envelope restamp; block `applyDurationOverride` on jobs with units | One override disables the INFEASIBLE verdict your own spec calls the best demo | ½ d |
| 9 | `BomItem.qty` → `Decimal` + `uom`; add `parentBomItemId`, `parentComponentId`, qty columns | Everything in Phases 1–2 is downstream. Do it while the data is small | 2 d |
| 10 | Correct `CLAUDE.md` (7 claims), invariant #2, the 4 stale specs; split `progress.md` | Stale guidance actively produces wrong work | ½ d |

### Top 10 to NOT work on yet
Visual redesign · command palette · PWA/offline/photo evidence · work centres & finite capacity ·
cost & job costing · i18n · the `/api/v1` write API · more dashboard charts · additional product
families · any structural rewrite.

---

## 9. Roadmap

- **Phase 0 — Stop the bleeding (~1 wk):** items 1–10 above. No features.
- **Phase 1 — Domain foundation (~3 wks):** numeric qty + UoM; BOM hierarchy + revisions + per-unit
  explosion; qty columns on `Component`/`ComponentOperation`; `MaterialIdentification` → `componentId`;
  `WeldJoint.componentId`; `Ncr` + disposition gating stage completion; **the rollup** (operation
  good-qty → component → `leadTimeProcessSeq` → stage % and submit gate); actor FKs; partial unique
  index for null-grain `ProcessPlan`; drawing revisions as rows.
- **Phase 2 — Production workflow (~4 wks):** work order with `RELEASED` state, work centre,
  operator, partial confirmations; procurement events with qty; `StockLot`/`StockTxn`; kit readiness
  gating release (**this is what finally makes invariant #2 true**); BOM authoring + import; welder
  CRUD; packing + dispatch (batch↔unit, dispatch note, gate pass, actual date); paint DFT; assembly
  consumption + as-built.
- **Phase 3 — Enterprise UX (~3 wks):** `<DataTable>`, `<Form>`, one `statusView()`, one IST date
  formatter; keyboard access on all 34 clickable rows; global search; per-unit route; BOM tree UI;
  real mobile nav; fix the 1024px tablet collision.
- **Phase 4 — Operational intelligence (~2 wks):** duration-weighted % complete (one definition for
  internal and client); exception-first dashboard band; predictive at-risk; full escalation ladder
  (T-3 / T-0 / T+1 / T+3 / T+7 — today there is one flat notification and no MD/CEO tier);
  delay-reason review; FPY; audit viewer; correction workflow.
- **Phase 5 — Reliability & scale:** cursor pagination; request-level caching; kill the 2N fan-out
  and the `::int` cast join; Playwright in CI; security headers/CSP/key rotation; finish RLS or lint
  the parent-join convention; work centres and finite capacity.

---

## 10. Open questions that block correctness

From `BUILD-SPEC-v2 §7` and later specs. These are the ones that change computed dates or gating:

| # | Question | Default in use | Blocks |
|---|---|---|---|
| **C1** | Working or calendar days? Holiday list? | Calendar, 6-day week, Sun off | **Every computed date.** Moves DE0467 from 22 days short to ~6 |
| **C2** | Confirm implied concurrency (nozzle fab during shell NDE) | Fitted from printed table | Layer-2 lags → gating |
| **C7** | What do RW and R&A mean; which block production? | RW≈Witness, R&A≈blocking | **Sets `QcpCodeRef.blocksCompletion`** — literally what hold-point blocking keys on |
| **C9** | Department supervisors and **representatives** | 13 drafted depts | Notification routing. **The `representative` column does not exist** — answering C9 needs a migration, not data entry |
| **C21** | Dispatch date given as a window — earliest or latest? | Earliest | Feasibility verdicts. Worth 8 working days on DE0467 |
| **C22** | Revised order date — does the clock restart? | Original PO date | Schedule anchor. DE0467 is 38 days short against the revised date, not 22 |
| **C23** | Which processes are optional per client? | All 36 included | **Nothing is flagged `optional`**, so `bypassExcluded()` never fires — a job skipping PWHT will deadlock or carry a phantom process |
| **C27** | Which 25 stage names are canonical — seed or mockup? | Seed list | Every stage label SJ reads on screen |

---

## 11. Definition of industry grade — where you stand

- **Integrity: ~80%.** Remaining: three ownership checks + a correction workflow.
- **Domain completeness: ~30%.** Process half done, material half not started.
- **Operability: ~5%.** Cheapest gap on this page; will hurt first in a real pilot.
- **Usability: ~50%** on desktop, near zero on a phone.

Close them in the order they will embarrass you: **operability → credibility seams → material layer
→ mobile.** That is Phase 0 → 1 → 2 → 3.
