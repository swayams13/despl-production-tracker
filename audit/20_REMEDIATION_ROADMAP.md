# 20 — REMEDIATION ROADMAP

*Eleven phases, 114 findings, sequenced for one developer working with Claude
Code — and mapped onto the Gate 0–4 structure already in
`docs/DESPL_MOS_TRANSFORMATION_PLAN.md`, which stays the governing document for
delivery milestones.*

---

## Relationship to the existing plan

| This audit's phases | Existing gate | Relationship |
|---|---|---|
| Phase 0–1 | **Gate 0 — Deployable & safe** | Extends it. AUD-024 is the same deploy-skew risk the runbook documents, still open |
| Phase 1 | **Gate 1 — DESPL-320 ships on it** | **Blocks it.** AUD-003/004/005 mean a dispatch release through the product is not yet compliance evidence |
| Phase 2–8 | Gate 2 / Gate 4 adoption work | The UX and IA layer the existing plan defers to "cutover per department" |
| Phase 9–10 | Gate 4 | Testing, observability, scale |

Where the two disagree, the existing plan wins on *what ships to DESPL when*.
This roadmap governs *what must be true before each of those ships*.

---

## Two decisions blocking Phase 1

| # | Decision | Owner | Why it blocks |
|---|---|---|---|
| **D-1** | **C1 — working days vs calendar days.** Still PROVISIONAL in `seed/lead-time-model.json` | DESPL (SJ) | Every computed date depends on it. AUD-071 cannot be fixed without it, and until it is, no date on any screen means anything |
| **D-2** | **What a client may see.** The portal shows the promised date labelled "Forecast dispatch" (AUD-031) | DESPL commercial | Either populate a real forecast or rename the field. This is a contractual question, not an engineering one |

Send both now. Neither blocks Phase 0.

---

## PHASE 0 — Audit + architecture decisions · *complete*

This audit, plus four decisions to take before writing code:

| # | Decision | Recommendation |
|---|---|---|
| A-1 | Do we add `OPERATOR` and `PLANNER` roles, or overload department membership further? | **Add the roles.** `02` §7 has the migration path. Everything in Phases 2–4 depends on it |
| A-2 | Does `/workspace` retire into `/team`, or do both survive? | **Retire.** `03` §3. Keeping both guarantees the numbers keep disagreeing |
| A-3 | Do we ship a real forecast, or rename the field? | Blocked on D-2 |
| A-4 | Frozen baseline for the S-curve — persist run v1's `baselineFinish`, or add a `ProjectBaseline` snapshot at contract signature? | **`ProjectBaseline`.** Cleaner semantics, and `baselineFinish` is currently read by nothing |

---

## PHASE 1 — Security, data integrity, business logic

**Nothing else starts until this phase exits.** These are the findings that let
the system ship a wrong vessel or leak a competitor's data.

### 1a — Ship this week

| # | Finding | Cx | Note |
|---|---|---|---|
| 1 | **AUD-024** — set Healthcheck Path and Pre-Deploy Command in the Railway dashboard | S | **A settings change. Highest value-per-effort in the audit.** Turns the existing `/api/health` probe into a real deploy gate |
| 2 | **AUD-005** — move the two quality assertions into `approveDispatchRelease` and `recordDispatch`; add `UNIT_NOT_COMPLETE` | S | Closes the "ships with an open NCR" hole |
| 3 | **AUD-002** — add the tenant predicate inside `v_unit_stage_status`'s body | S | Interim, shippable today, independent of the full RLS work |
| 4 | **AUD-007** — propagate `job=` in all seven dashboard drill-down links; delete the `"DESPL-320"` literal | S | Stops management acting on the wrong project |
| 5 | **AUD-027** — one `ist_day_marker(ts)` IMMUTABLE function used by both TS and SQL | S | Reconciles the two "overdue" definitions |
| 6 | **AUD-090** — `computeCpmSafe` in the Command Center loop | S | One-line, prevents a six-department outage |
| 7 | **AUD-100** — grant to `despl_app` instead of `despl_web` in the three view migrations | S | Makes DR rebuilds possible |

### 1b — The hold-point engine

| # | Finding | Cx |
|---|---|---|
| 8 | **AUD-003** — refuse `NA` on a blocking code unless waivable **and** the actor is PH; stamp `waiverApprovedBy`; accept `NA` in the gates only when it is set | M |
| 9 | **AUD-004** — resolve party codes before the auto-record; never auto-accept an external party's blocking checkpoint | M |
| 10 | **AUD-026** — remove `OPEN` from `close.from`; refuse verify with `NCR_NOT_DISPOSITIONED` | S |
| 11 | **AUD-029** — either ship the paint/DFT write path, or disable `requires_dft_gate` until it lands. **Do not leave a gate enabled whose evidence cannot be produced** | S / M |
| 12 | **AUD-033** — refuse excluding a non-optional template process | S |

**Exit test for 1b:** a QC user attempting each of the five bypasses is refused
with the correct stable code, proven by the E2E scenarios 18–22 in `16` §5.

### 1c — Data integrity

| # | Finding | Cx |
|---|---|---|
| 13 | **AUD-001** — backfill `tenant_id` onto the 28 job-grain tables (mirroring the working `h1_job_id_backstop` pattern), add a fail-closed tenant policy, recreate `job_isolation` `AS RESTRICTIVE` | **L** |
| 14 | **AUD-080** + **AUD-069** — enrol the nine omitted tables; add `tenantId` to `QcpTemplate`; change the four `SET NULL` FKs | M |
| 15 | **AUD-006** — the CHECK constraint migration, `11` §10 items 1–7, each `NOT VALID` then `VALIDATE` | M |
| 16 | **AUD-034** — `CREATE UNIQUE INDEX … (job_id, COALESCE(equipment_id,-1)) WHERE is_current` | S |
| 17 | **AUD-030** — `AND jp.included = true` in the view | S |
| 18 | **AUD-028** + **AUD-059** — normalise every `aggregate_id` cast to the parameter side | S |
| 19 | **AUD-077**, **AUD-078** — validate `qcpItemId` against the unit's job | S |
| 20 | **AUD-032** — correct `assertKitReady`'s quantity basis | M |
| 21 | **AUD-035** — stop writing to `envelope*Days`; make `checkFeasibility` throw an `AppError` | M |
| 22 | **AUD-073**, **AUD-072** — conditional publish write; `RepeatableRead` on transition services | M |
| 23 | **AUD-079** — audit the target's roles on password reset; alert on QC targets | M |
| 24 | **AUD-025** — move the client guard into `(app)/layout.tsx` | S |

**Extend `rls-coverage.test.ts` with the `job_id` query in the same PR as #13** —
that is what makes the next omission fail CI.

**Exit gate:** cross-tenant read and write both refused on a live two-tenant
database; the five hold-point bypasses all refused; all 50 migrations still apply
clean from scratch.

---

## PHASE 2 — Information architecture + role model

| # | Finding | Cx |
|---|---|---|
| 25 | **AUD-013** — add `OPERATOR` and `PLANNER`; split `SUPERVISOR`'s UI privileges; re-grant existing accounts | M |
| 26 | **AUD-014** — `archetypeOf(actor)` in `src/lib/authz` (presentation only — the authz layer is untouched) | M |
| 27 | **AUD-011** + **AUD-012** — one `NAV_ITEMS` registry, one `visibleNav(actor)`, rendered into all three chrome variants | M |
| 28 | **AUD-040** — delete `/board` and `/profile` | S |
| 29 | **AUD-037** — gate `/qc` to QC and above | S |
| 30 | **AUD-070** — thread `canAct` into the worklist client | S |
| 31 | **AUD-039** — global `?job=` context; `useProjectContext()`; kill the four local filters | L |
| 32 | **AUD-111** — "See all alerts →" in the bell dropdown | S |

**Exit gate:** each of the six archetypes lands on the right page, sees only
relevant navigation, and the role × surface × action matrix test from `16` §4
passes.

---

## PHASE 3 — My Day redesign

| # | Finding | Cx |
|---|---|---|
| 33 | **AUD-008** — split `loadMyDay` into `loadMyDay` + `loadTeamBoard` | M |
| 34 | **AUD-042** — workload summary line under the title; demote the four KPI tiles | S |
| 35 | **AUD-043** — a BLOCKED bucket, rendering the already-computed `reasonText` | S |
| 36 | **AUD-036** — split the count into `loadMyOverdueCount` and `loadDeptOverdueCount`; **rewrite the parity fixture so they diverge** | S |
| 37 | **AUD-045** — one row renderer per section; delete the nested breakpoint fork | M |
| 38 | **AUD-044** — `loading.tsx` with `.skel` chrome | S |
| 39 | Add `submittedBy` to `MyDayRow` so a checker can see the maker | S |

**Do Phase 4 before Phase 3 lands in production** — if the pool leaves My Day
before `/team` exists, the floor loses its only way to pick up work.

**Exit gate:** My Day shows only `assigneeUserId === actor.userId`, in the six
sections of `04` §11, on one row renderer, with the summary line above the fold.

---

## PHASE 4 — Team surface

| # | Finding | Cx |
|---|---|---|
| 40 | **AUD-010** — build `/team` and `/team/[deptId]` by promoting `/command/[dept]`; drop the `isOfficeDept` redirect | L |
| 41 | Workload-by-employee, from `admin.read.ts`'s existing `groupBy` lifted into `loadAssigneeOpenCounts` | M |
| 42 | **AUD-038** — move the pool, assign, release and bulk assign to `/team`; extend `deptMembers` with open/overdue counts | M |
| 43 | My Day keeps one "Claim next" button, top-ranked by `compareRankedPlans` | S |
| 44 | **AUD-019** + **AUD-084** — absorb `/workspace`'s per-process grouping and bulk toolbar; redirect `/workspace` → `/team` | M |
| 45 | **AUD-081** — collapse the six pipeline cards into one grouped table; make `+N more` a real filter link | M |
| 46 | **AUD-083** — extract `useRun`/`RefusalNote`; adopt on every surface | S |

**Exit gate:** a fabrication supervisor can answer all four of their questions —
who is overloaded, who is idle, who is blocked, what is unclaimed — from one
screen, and reassign in bulk with load visible.

---

## PHASE 5 — Dashboard redesign

| # | Finding | Cx |
|---|---|---|
| 47 | **AUD-015** — move the entire `loadJobKpis` block to `/jobs/[id]?tab=overview` | L |
| 48 | **AUD-016** — `loadPortfolioExceptions`, deep-linking to the StageSheet | L |
| 49 | **AUD-048** — `loadPortfolioBottlenecks`; promote the ageing bar, delete the status matrix | M |
| 50 | **AUD-047** — `plannedPercentToDate` on `JobListItem`; bullet chart in the Complete cell | M |
| 51 | **AUD-050** — reduce to 6 columns, sticky Job, sortable, drawer for the rest | M |
| 52 | **AUD-049** + **AUD-086** — remove the Sunburst | S |
| 53 | **AUD-017** — defer the S-curve; ship the one-line slip summary. Real S-curve moves to Reports once A-4's baseline exists | M |
| 54 | **AUD-085** — adopt or delete the five dead `viz/` components | M |

**Exit gate:** an MD can name the projects needing intervention, and what to do
about each, within ten seconds, above the fold, without scrolling into a project
they did not select.

---

## PHASE 6 — Project control centre

| # | Finding | Cx |
|---|---|---|
| 55 | **AUD-053** — surface the four header numbers (free); regroup into the nine-tab model of `07` §3 | L |
| 56 | New Engineering tab (drawings) and Documentation tab (MTC) — services exist, surfaces do not | L |
| 57 | **AUD-031** — rename to `plannedDispatch`; add a real forecast from CPM re-anchored on actuals *(gated on D-2)* | L |
| 58 | **AUD-071** — route every variance through `workingDaysBetween` *(gated on D-1)* | M |
| 59 | **AUD-088** — scope the Gantt to the expanded unit | M |
| 60 | **AUD-051** — checkpoint × unit matrix using `viz/MatrixHeatmap` | M |

---

## PHASE 7 — QC, Departments, Welding workflows

| # | Finding | Cx |
|---|---|---|
| 61 | **AUD-018** — filters, pagination, hold-point-first order, project→unit grouping | L |
| 62 | **AUD-041** — one `resolveHoldPointStatus`; `/qc` owns hold points; counts elsewhere | M |
| 63 | Add "Upcoming inspections" and "Documentation pending" sections; per-job NCR view | M |
| 64 | **AUD-052** + **AUD-101** — department cards gain blocked/rework/workload; detail leads with exceptions | M |
| 65 | **AUD-082** — render the four discarded fields, or delete them | S |
| 66 | **AUD-087** — Reports gains a Portfolio Analysis section; the moved charts land here | M |
| 67 | **AUD-112** — welding: sort flagged first, delete the sparkline, hoist `max` | S |

---

## PHASE 8 — Tables and design system

| # | Finding | Cx |
|---|---|---|
| 68 | **AUD-066** + **AUD-102** — the three token values | **S** *(can ship in Phase 1 — it is two hex values)* |
| 69 | Apply the column classifications from `04`–`09` to every table | M |
| 70 | **AUD-054** — typography floor; replace the 69 inline `fontSize` literals with utility classes | M |
| 71 | **AUD-067** — touch targets via inset pseudo-elements; close the two disclosed gaps; resolve the `test.fail` | M |
| 72 | **AUD-064** — real `<button>` in each row's primary cell | M |
| 73 | **AUD-097** — `<main>`, skip link, `scope="col"`, `aria-sort`, `aria-expanded` | M |
| 74 | **AUD-065** — labels + the ESLint rule, landed as `warn` | M |
| 75 | **AUD-098**, **AUD-103** — spine roles; `CountUp` reduced motion | S |
| 76 | Copy: delete "demo bootstrap" from production UI | S |

---

## PHASE 9 — Testing and observability

| # | Finding | Cx |
|---|---|---|
| 77 | **AUD-063** step 1 — `JSON.stringify` the log payloads. **One line; makes every existing log queryable** | S |
| 78 | **AUD-063** step 3 — Prisma slow-query log behind an env flag. **Do this before Phase 10** — it is the only way to confirm the fixes landed | S |
| 79 | **AUD-068** — the 30-scenario E2E plan; add QC and second-supervisor identities to `auth.setup.ts` | M |
| 80 | **AUD-095** — the structural authz guard and the client-actor table test | M |
| 81 | Regression tests for every Phase 1 fix (`16` §6) | M |
| 82 | **AUD-063** step 2 — Sentry via `instrumentation.ts`; add the ingest origin to CSP | M |
| 83 | **AUD-089** — cron unique index + heartbeat surfaced on `/api/health` | S |
| 84 | **AUD-091** — `global-error.tsx`, `error.tsx` outside `(app)`, `loading.tsx` on the six slow routes | S |
| 85 | **AUD-062** — redirect on `UNAUTHENTICATED`; map `P2028` to `TIMEOUT` | S |
| 86 | Convert the two `test.fixme` and one `test.fail` into assertions | S |

---

## PHASE 10 — Performance and production hardening

Measure first — #78 must be in place.

| # | Finding | Cx |
|---|---|---|
| 87 | **AUD-061** — `cache()` on `getActor`. **One line, removes 2–4 transactions per request** | **S** |
| 88 | **AUD-020** — `loadJobSwitcherOptions` | **S** |
| 89 | **AUD-023** — bound both UNION branches | **S** |
| 90 | **AUD-055** + **AUD-113** + **AUD-114** — the index migration, `CONCURRENTLY` | S |
| 91 | **AUD-058** — `loadMappedOpsBatch` | S |
| 92 | **AUD-056** — QC yield range filter | S |
| 93 | **AUD-022** — department rollups in SQL | M |
| 94 | **AUD-057** — bound and de-quadratic `/qc` | M |
| 95 | **AUD-060** — grouped portfolio aggregates | M |
| 96 | **AUD-021** — rewrite `v_unit_stage_status`. **Highest multiplier; do it last, with `EXPLAIN` verification** | M |
| 97 | **AUD-092**, **AUD-093** — payload scoping | M |
| 98 | **AUD-094** — pool sizing asserted at boot | S |
| 99 | **AUD-096** — optimistic concurrency on field edits | M |
| 100 | **AUD-076** — timestamps on the ten core tables | M |
| 101 | **AUD-104** — CI grep for unqualified DDL on high-volume tables | S |
| 102 | P3 cleanup: **AUD-105–110**, **AUD-099** | S each |

---

## Critical path

```
D-1, D-2 sent ──────────────────────────────────────────────┐
                                                             │
Phase 1a (7 items, ~1 week) ─────────────────────────────────┤
   └── Phase 1b hold-point engine ── Phase 1c integrity ─────┤
          │                                                  │
          └── GATE 1 can proceed: a dispatch release          │
              through the product is now evidence            │
                                                             │
Phase 2 role model + nav ────┬── Phase 4 Team ──┬─ Phase 3 My Day
                             │                   │
                             └── Phase 5 Dashboard
                                   └── Phase 6 Projects
                                         └── Phase 7 QC/Dept/Welding
                                               └── Phase 8 design system
Phase 9 (77, 78) ───────────── start early, in parallel ─────┐
                                                              │
Phase 10 ─── after 78 is measuring ───────────────────────────┘
```

**Three things can start immediately and in parallel with anything:**
AUD-024 (a settings change), AUD-066 (two hex values), and Phase 9 #77
(one `JSON.stringify`).

---

## Do-not-do list

Carried forward from the existing plan and reaffirmed by this audit:

| | Why |
|---|---|
| **A rewrite of anything** | Nothing in this codebase classifies as REBUILD. This audit checked, independently, and agrees |
| **A second product family before AUD-001 lands** | The `ComponentOperation ↔ JobProcess` join is numeric-string equality with no FK, and would silently pull pressure-vessel mappings |
| **A second tenant before Phase 1c** | AUD-001 is proven, not theoretical |
| **Treating a dispatch release as compliance evidence before Phase 1b** | AUD-003/004/005 |
| **Building the S-curve before A-4's frozen baseline** | AUD-017 — it is worse than showing nothing |
| **Adding a chart without a stated business question** | `18` §4.5 |
| **Solving any density problem with a smaller font** | `18` §1 |
| **Shipping a gate before its evidence writer exists** | AUD-029 is the live example; add the CI assertion |

---

## The four questions, re-asked at the end

| | Answered by |
|---|---|
| Can a new employee understand what they need to do? | **Phase 3** |
| Can an experienced employee complete it quickly? | **Phases 3, 8, 10** |
| Can a supervisor understand team problems without seeing everyone's task list? | **Phase 4** |
| Can management understand project health without reading operational tables? | **Phase 5** |

Phase 1 does not answer any of them. It is what makes the answers worth trusting.
